import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { rerankerActive } from '../../../src/search/rerank-mode.js';

describe('rerankerActive', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_RERANKER;
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('is active for every backend that returns scores', () => {
    // Regression guard: each of these was added after the call sites already
    // tested `=== 'onnx'`, so `remote` and then `jev` silently skipped
    // reranking until the predicate was centralised.
    for (const mode of ['onnx', 'remote', 'jev']) {
      process.env.WIGOLO_RERANKER = mode;
      resetConfig();
      expect(rerankerActive(), `${mode} must rerank`).toBe(true);
    }
  });

  it('is inactive when reranking is off', () => {
    process.env.WIGOLO_RERANKER = 'none';
    resetConfig();
    expect(rerankerActive()).toBe(false);
  });

  it('is inactive for an unhandled mode', () => {
    // 'custom' has no implementation; it must not claim to score results.
    process.env.WIGOLO_RERANKER = 'custom';
    resetConfig();
    expect(rerankerActive()).toBe(false);
  });

  it('defaults to active (onnx)', () => {
    expect(rerankerActive()).toBe(true);
  });
});
