import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetConfig, type Config } from '../../../src/config.js';
import { RERANKER_MODES, rerankerActive, rerankerIsHosted } from '../../../src/search/rerank-mode.js';

/** Every value of `Config['reranker']`, spelled out so a shrink is visible here. */
const ALL_MODES = ['onnx', 'none', 'remote', 'workers-ai', 'decision', 'jev'] as const;
/** Modes backed by something that returns relevance scores. */
const SCORING_MODES = ['onnx', 'remote', 'workers-ai', 'decision', 'jev'] as const;
/** Modes served by a hosted endpoint — nothing to download or warm. */
const HOSTED_MODES = ['remote', 'workers-ai', 'decision', 'jev'] as const;

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
    // Regression guard: these were added one at a time after the call sites
    // already tested `=== 'onnx'`, so `remote`, `workers-ai`, `decision` and
    // then `jev` silently skipped reranking until the table existed.
    for (const mode of SCORING_MODES) {
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

describe('rerankerIsHosted', () => {
  it('is true for every hosted mode', () => {
    // Every one of these makes `warmup`/`doctor`/`status` skip the on-device
    // model check; missing one reports a working setup as broken.
    for (const mode of HOSTED_MODES) {
      expect(rerankerIsHosted(mode), `${mode} is hosted`).toBe(true);
    }
  });

  it('is false for the on-device and disabled modes', () => {
    expect(rerankerIsHosted('onnx')).toBe(false);
    expect(rerankerIsHosted('none')).toBe(false);
  });

  it('is false for a value outside the union', () => {
    // getConfig() casts (and config.ts now rejects) the raw env string, so an
    // unknown value can still arrive here unvalidated — it is not an endpoint.
    expect(rerankerIsHosted('custom' as Config['reranker'])).toBe(false);
  });
});

describe('RERANKER_MODES', () => {
  it('classifies every mode in the union', () => {
    // The `satisfies Record<Config['reranker'], …>` in rerank-mode.ts fails
    // compilation when a mode is added unclassified; this catches the other
    // direction — a mode quietly dropped from the table at runtime.
    expect(Object.keys(RERANKER_MODES).sort()).toEqual([...ALL_MODES].sort());
  });

  it('agrees with the predicates for every mode', () => {
    for (const mode of ALL_MODES) {
      expect(RERANKER_MODES[mode].scores, `${mode}.scores`).toBe(
        (SCORING_MODES as readonly string[]).includes(mode),
      );
      expect(RERANKER_MODES[mode].hosted, `${mode}.hosted`).toBe(
        (HOSTED_MODES as readonly string[]).includes(mode),
      );
      expect(RERANKER_MODES[mode].label.length, `${mode}.label`).toBeGreaterThan(0);
    }
  });
});
