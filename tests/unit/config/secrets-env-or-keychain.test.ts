import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, resetConfig, _resetLegacySecretWarningsForTests } from '../../../src/config.js';
import {
  resetPersistedConfig,
  _setCredentialKeychainForTests,
} from '../../../src/persisted-config.js';

const originalEnv = process.env;
let dir: string;
let configPath: string;
let store: Map<string, string>;

/**
 * The four search/hosted-inference credentials that used to be readable from
 * config.json. Each resolves env > OS keychain, never settings, and the keychain
 * account is `credentialKeychainUser(settingsKey)` — `${settingsKey}-cred` —
 * the same convention the proxy/reddit secrets use.
 */
const CREDS = [
  { field: 'braveApiKey', env: 'BRAVE_API_KEY', account: 'braveApiKey-cred' },
  { field: 'deepseekApiKey', env: 'DEEPSEEK_API_KEY', account: 'deepseekApiKey-cred' },
  { field: 'githubToken', env: 'WIGOLO_GITHUB_TOKEN', account: 'githubToken-cred' },
  { field: 'embeddingApiKey', env: 'WIGOLO_EMBEDDING_API_KEY', account: 'embeddingApiKey-cred' },
] as const;

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify({ version: 1, settings }));
  resetPersistedConfig();
  resetConfig();
}

/**
 * Collect stderr lines. `vi.spyOn(process.stderr, 'write')` records nothing
 * here — vitest owns that stream's writer — so swap the function directly.
 */
function captureStderr(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof original;
  return { lines, restore: () => void (process.stderr.write = original) };
}

beforeEach(() => {
  process.env = { ...originalEnv };
  dir = mkdtempSync(join(tmpdir(), 'wigolo-secret-resolve-'));
  configPath = join(dir, 'config.json');
  process.env.WIGOLO_CONFIG_PATH = configPath;
  for (const c of CREDS) delete process.env[c.env];
  store = new Map();
  _setCredentialKeychainForTests({
    available: () => true,
    set: (u, v) => void store.set(u, v),
    get: (u) => store.get(u) ?? null,
    del: (u) => void store.delete(u),
  });
  _resetLegacySecretWarningsForTests();
  resetPersistedConfig();
  resetConfig();
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(dir, { recursive: true, force: true });
  _setCredentialKeychainForTests(null);
  _resetLegacySecretWarningsForTests();
  resetPersistedConfig();
  resetConfig();
});

describe('config — search/inference credentials are env-or-keychain only', () => {
  for (const { field, env, account } of CREDS) {
    it(`resolves ${field} from ${env}`, () => {
      process.env[env] = `env-${field}`;
      resetConfig();
      expect(getConfig()[field]).toBe(`env-${field}`);
    });

    it(`resolves ${field} from the keychain account ${account}`, () => {
      store.set(account, `keychain-${field}`);
      resetConfig();
      expect(getConfig()[field]).toBe(`keychain-${field}`);
    });

    it(`ignores a settings-supplied ${field} and warns once, naming ${env}`, () => {
      writeSettings({ [field]: 'legacy-cleartext' });
      const written = captureStderr();
      try {
        expect(getConfig()[field]).toBeNull();
        // A TUI re-init drops the config cache and re-resolves. The warning is
        // once per process, so a reload must not repeat it.
        resetConfig();
        expect(getConfig()[field]).toBeNull();
      } finally {
        written.restore();
      }

      const lines = written.lines.filter((l) => l.includes(`${field} in config.json is ignored`));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(env);
      expect(lines[0]).toContain('keychain');
    });

    it(`does not use a settings-supplied ${field} even when the keychain is empty`, () => {
      writeSettings({ [field]: 'legacy-cleartext' });
      expect(getConfig()[field]).toBeNull();
      // The user's value is NOT deleted from their file — only ignored.
      const onDisk = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        settings: Record<string, unknown>;
      };
      expect(onDisk.settings[field]).toBe('legacy-cleartext');
    });
  }

  it('env wins over a legacy settings value, and stays quiet about it', () => {
    // With the env var set the stored value was never authoritative, so
    // nothing broke and there is nothing to warn about.
    writeSettings({ braveApiKey: 'legacy-cleartext' });
    process.env.BRAVE_API_KEY = 'from-env';
    resetConfig();
    const written = captureStderr();
    try {
      expect(getConfig().braveApiKey).toBe('from-env');
    } finally {
      written.restore();
    }
    expect(written.lines.filter((l) => l.includes('in config.json is ignored'))).toHaveLength(0);
  });

  it('warns for each of the four, not just the first one seen', () => {
    writeSettings({
      braveApiKey: 'a',
      deepseekApiKey: 'b',
      githubToken: 'c',
      embeddingApiKey: 'd',
    });
    const written = captureStderr();
    try {
      const cfg = getConfig();
      expect([cfg.braveApiKey, cfg.deepseekApiKey, cfg.githubToken, cfg.embeddingApiKey]).toEqual([
        null,
        null,
        null,
        null,
      ]);
    } finally {
      written.restore();
    }
    const lines = written.lines.filter((l) => l.includes('in config.json is ignored'));
    expect(lines).toHaveLength(4);
  });
});
