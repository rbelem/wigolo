import { describe, it, expect } from 'vitest';
import { cacheCategory } from '../../../../../src/cli/tui/schema/cache.js';

describe('cacheCategory', () => {
  it('has id cache and three fields', () => {
    expect(cacheCategory.id).toBe('cache');
    expect(cacheCategory.fields.length).toBe(3);
    const keys = cacheCategory.fields.map((f) => f.key);
    expect(keys).toEqual([
      'WIGOLO_DATA_DIR',
      'CACHE_TTL_SEARCH',
      'CACHE_TTL_CONTENT',
    ]);
  });

  it('WIGOLO_DATA_DIR is a path field that explicitly does NOT propagate to agents', () => {
    const f = cacheCategory.fields.find((x) => x.key === 'WIGOLO_DATA_DIR');
    expect(f?.kind).toBe('path');
    expect(f?.propagateToAgents).toBe(false);
  });

  it('WIGOLO_CACHE_TTL_SEARCH defaults to 86400 with min 60 / max 604800', () => {
    const f = cacheCategory.fields.find((x) => x.key === 'CACHE_TTL_SEARCH');
    expect(f?.kind).toBe('number');
    expect(f?.default).toBe(86400);
    expect(f?.min).toBe(60);
    expect(f?.max).toBe(604800);
  });

  it('WIGOLO_CACHE_TTL_CONTENT defaults to 604800 with min 60 / max 2592000', () => {
    const f = cacheCategory.fields.find((x) => x.key === 'CACHE_TTL_CONTENT');
    expect(f?.kind).toBe('number');
    expect(f?.default).toBe(604800);
    expect(f?.min).toBe(60);
    expect(f?.max).toBe(2592000);
  });

  it('every field has settingsPath + label', () => {
    for (const f of cacheCategory.fields) {
      expect(f.settingsPath, `field ${f.key} missing settingsPath`).toBeTruthy();
      expect(f.label, `field ${f.key} missing label`).toBeTruthy();
    }
  });
});
