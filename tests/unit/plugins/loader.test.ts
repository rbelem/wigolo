import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';
import { loadPlugins, type LoadedPlugin } from '../../../src/plugins/loader.js';

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'plugins');

// The loader's logger is module-scoped and level-filtered by config at import
// time, so asserting on stderr would depend on an ambient LOG_LEVEL. Mock the
// logger instead: the warn call and its payload are what the loader must emit.
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
  }),
}));

/** Write a one-engine plugin into `<parent>/<dirName>` under package name `pkgName`. */
function writeSearchPlugin(parent: string, dirName: string, pkgName: string, engineName: string): void {
  const dir = join(parent, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: pkgName,
    version: '1.0.0',
    main: 'index.mjs',
  }));
  writeFileSync(
    join(dir, 'index.mjs'),
    `export const searchEngine = { name: ${JSON.stringify(engineName)}, async search() { return []; } };`,
  );
}

describe('loadPlugins', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    warnMock.mockClear();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('returns empty arrays when plugins dir does not exist', async () => {
    process.env.WIGOLO_PLUGINS_DIR = '/tmp/nonexistent-plugins-dir-' + Date.now();
    resetConfig();
    const result = await loadPlugins();
    expect(result.extractors).toEqual([]);
    expect(result.searchEngines).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns empty arrays for an empty plugins directory', async () => {
    const { mkdtempSync, rmdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const emptyDir = mkdtempSync(join(tmpdir(), 'wigolo-test-empty-'));
    try {
      process.env.WIGOLO_PLUGINS_DIR = emptyDir;
      resetConfig();
      const result = await loadPlugins();
      expect(result.extractors).toEqual([]);
      expect(result.searchEngines).toEqual([]);
      expect(result.errors).toEqual([]);
    } finally {
      rmdirSync(emptyDir);
    }
  });

  it('loads a valid extractor plugin from fixtures', async () => {
    process.env.WIGOLO_PLUGINS_DIR = FIXTURES_DIR;
    resetConfig();
    const result = await loadPlugins();
    const names = result.extractors.map(e => e.name);
    expect(names).toContain('test-extractor');
  });

  it('loads a valid search engine plugin from fixtures', async () => {
    process.env.WIGOLO_PLUGINS_DIR = FIXTURES_DIR;
    resetConfig();
    const result = await loadPlugins();
    const names = result.searchEngines.map(e => e.name);
    expect(names).toContain('test-search');
  });

  it('loads both extractor and searchEngine from a combined plugin', async () => {
    process.env.WIGOLO_PLUGINS_DIR = FIXTURES_DIR;
    resetConfig();
    const result = await loadPlugins();
    const extractorNames = result.extractors.map(e => e.name);
    const engineNames = result.searchEngines.map(e => e.name);
    expect(extractorNames).toContain('both-extractor');
    expect(engineNames).toContain('both-search');
  });

  it('reports an error for a plugin with invalid shape', async () => {
    process.env.WIGOLO_PLUGINS_DIR = FIXTURES_DIR;
    resetConfig();
    const result = await loadPlugins();
    const invalidError = result.errors.find(e => e.pluginName === 'test-invalid-shape');
    expect(invalidError).toBeDefined();
    expect(invalidError!.message).toContain('extractor');
  });

  it('reports an error for a plugin that throws on import', async () => {
    process.env.WIGOLO_PLUGINS_DIR = FIXTURES_DIR;
    resetConfig();
    const result = await loadPlugins();
    const throwError = result.errors.find(e => e.pluginName === 'test-throws-on-load');
    expect(throwError).toBeDefined();
    expect(throwError!.message).toContain('failed to load');
  });

  it('reports an error for a plugin with no main field in package.json', async () => {
    process.env.WIGOLO_PLUGINS_DIR = FIXTURES_DIR;
    resetConfig();
    const result = await loadPlugins();
    const noMainError = result.errors.find(e => e.pluginName === 'test-no-main');
    expect(noMainError).toBeDefined();
    expect(noMainError!.message).toContain('main');
  });

  it('reports an error for a plugin with malformed package.json', async () => {
    process.env.WIGOLO_PLUGINS_DIR = FIXTURES_DIR;
    resetConfig();
    const result = await loadPlugins();
    const badJsonError = result.errors.find(e => e.pluginName === 'bad-json');
    expect(badJsonError).toBeDefined();
    expect(badJsonError!.message).toContain('package.json');
  });

  it('does not crash when plugins dir contains regular files alongside directories', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-test-mixeddir-'));
    try {
      writeFileSync(join(dir, 'stray-file.txt'), 'not a plugin');
      process.env.WIGOLO_PLUGINS_DIR = dir;
      resetConfig();
      const result = await loadPlugins();
      expect(result.extractors).toEqual([]);
      expect(result.searchEngines).toEqual([]);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not register duplicate extractor names', async () => {
    process.env.WIGOLO_PLUGINS_DIR = FIXTURES_DIR;
    resetConfig();
    const result = await loadPlugins();
    const names = result.extractors.map(e => e.name);
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });

  it('does not register duplicate search engine names', async () => {
    process.env.WIGOLO_PLUGINS_DIR = FIXTURES_DIR;
    resetConfig();
    const result = await loadPlugins();
    const names = result.searchEngines.map(e => e.name);
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });

  it('handles symlinked plugin directories gracefully', async () => {
    const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-test-symlink-'));
    try {
      symlinkSync(
        join(FIXTURES_DIR, 'valid-extractor'),
        join(dir, 'symlinked-extractor'),
      );
      process.env.WIGOLO_PLUGINS_DIR = dir;
      resetConfig();
      const result = await loadPlugins();
      expect(result.extractors.map(e => e.name)).toContain('test-extractor');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns typed LoadedPlugin metadata for each loaded plugin', async () => {
    process.env.WIGOLO_PLUGINS_DIR = FIXTURES_DIR;
    resetConfig();
    const result = await loadPlugins();
    expect(result.loaded.length).toBeGreaterThan(0);
    for (const p of result.loaded) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.version).toBe('string');
      expect(typeof p.path).toBe('string');
      expect(typeof p.hasExtractor).toBe('boolean');
      expect(typeof p.hasSearchEngine).toBe('boolean');
    }
  });

  it('includes unicode plugin directory names without error', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-test-unicode-'));
    const unicodeDir = join(dir, 'plugin-\u00e9\u00e8\u00ea');
    try {
      mkdirSync(unicodeDir);
      writeFileSync(join(unicodeDir, 'package.json'), JSON.stringify({
        name: 'unicode-plugin',
        version: '0.1.0',
        main: 'index.mjs',
      }));
      writeFileSync(join(unicodeDir, 'index.mjs'),
        'export const extractor = { name: "unicode-test", canHandle: () => false, extract: () => null };');
      process.env.WIGOLO_PLUGINS_DIR = dir;
      resetConfig();
      const result = await loadPlugins();
      expect(result.extractors.map(e => e.name)).toContain('unicode-test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a plugin search engine that claims a core engine name and warns with both names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-test-corename-'));
    try {
      writeSearchPlugin(dir, 'a-core-squatter', 'squatter-plugin', 'bing');
      process.env.WIGOLO_PLUGINS_DIR = dir;
      resetConfig();
      const result = await loadPlugins();

      expect(result.searchEngines.map(e => e.name)).not.toContain('bing');
      expect(result.loaded.map(p => p.name)).not.toContain('squatter-plugin');

      const warnings = warnMock.mock.calls.map(call => String(call[0]));
      const collisionWarning = warnings.find(w => w.includes('squatter-plugin') && w.includes('bing'));
      expect(collisionWarning).toBeDefined();
      expect(collisionWarning).toContain('skipped');
      expect(collisionWarning).toContain('reserved by a core engine');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still loads a plugin whose engine name is not reserved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-test-corename-unique-'));
    try {
      writeSearchPlugin(dir, 'a-core-squatter', 'squatter-plugin', 'bing');
      writeSearchPlugin(dir, 'b-unique', 'unique-plugin', 'plugin-unique-engine');
      process.env.WIGOLO_PLUGINS_DIR = dir;
      resetConfig();
      const result = await loadPlugins();

      const names = result.searchEngines.map(e => e.name);
      expect(names).toContain('plugin-unique-engine');
      expect(names).not.toContain('bing');
      expect(result.loaded.map(p => p.name)).toContain('unique-plugin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still skips plugin-vs-plugin duplicate engine names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-test-plugin-dup-'));
    try {
      writeSearchPlugin(dir, 'a-first', 'first-plugin', 'shared-engine');
      writeSearchPlugin(dir, 'b-second', 'second-plugin', 'shared-engine');
      process.env.WIGOLO_PLUGINS_DIR = dir;
      resetConfig();
      const result = await loadPlugins();

      expect(result.searchEngines.map(e => e.name)).toEqual(['shared-engine']);
      expect(result.loaded.map(p => p.name)).toEqual(['first-plugin']);
      const warnings = warnMock.mock.calls.map(call => String(call[0]));
      expect(warnings).toContain('duplicate search engine name, skipping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
