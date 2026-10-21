import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Guard: every env var the TUI propagates must be one `config.ts` actually
 * reads.
 *
 * Five fields used to write names nothing consumed — `WIGOLO_CACHE_TTL_*`,
 * `WIGOLO_BROWSER_IDLE_TIMEOUT_MS`, `WIGOLO_MAX_BROWSERS`, `WIGOLO_LOG_LEVEL` —
 * so toggling them in `wigolo config` silently did nothing, and the agents they
 * propagated to never saw a value config recognised.
 */
const HERE = dirname(new URL(import.meta.url).pathname);
const TUI_DIR = resolve(HERE, '../../../../../src/cli/tui/schema');
const CONFIG_SRC = readFileSync(resolve(HERE, '../../../../../src/config.ts'), 'utf8');

/**
 * Keys that are intentionally NOT config knobs:
 *  - WIGOLO_AGENTS       a TUI-only agent selection list, not a runtime setting
 *  - WIGOLO_LLM_API_KEY  resolved by src/security/key-store.ts, not config.ts
 */
const NOT_CONFIG_KNOBS = new Set(['WIGOLO_AGENTS', 'WIGOLO_LLM_API_KEY']);

const CATEGORY_FILES = [
  'advanced.ts',
  'agents.ts',
  'browser.ts',
  'cache.ts',
  'catalog.ts',
  'llm.ts',
  'migrate.ts',
  'search.ts',
];

/** `key:` values declared across every TUI schema category. */
function tuiKeys(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of CATEGORY_FILES) {
    let src: string;
    try {
      src = readFileSync(resolve(TUI_DIR, file), 'utf8');
    } catch {
      continue; // category not present in this build
    }
    for (const m of src.matchAll(/key:\s*'([A-Z][A-Z0-9_]+)'/g)) {
      if (!found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

describe('TUI schema env keys', () => {
  const keys = tuiKeys();

  it('parses a plausible number of keys', () => {
    // Sanity: if the file list drifts, fail loudly rather than silently pass.
    expect(keys.size).toBeGreaterThan(5);
  });

  it.each([...tuiKeys().keys()])('%s is read by config.ts (or is a known exception)', (key) => {
    if (NOT_CONFIG_KNOBS.has(key)) return;
    expect(
      CONFIG_SRC.includes(`'${key}'`),
      `${keys.get(key)} propagates ${key}, but src/config.ts never reads it — ` +
        'the setting would silently do nothing.',
    ).toBe(true);
  });
});
