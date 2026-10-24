/**
 * One classification of every reranker mode.
 *
 * Call sites used to keep their own hand-written mode lists (`=== 'onnx'`,
 * `!== 'none'`, a `<dataDir>/transformers` probe), and they disagreed: `remote`,
 * `workers-ai`, `decision` and `jev` are hosted endpoints that produce scores
 * with no on-disk model, yet several surfaces reported them as "reranking off"
 * or "model missing". The table below is the only list; every surface reads it.
 *
 * Lives in its own module rather than in `config.ts` on purpose: the suite
 * mocks `config.js` wholesale in many places, so a new export there resolves to
 * `undefined` under those mocks. Here the mocked `getConfig` is still used, so
 * the predicates behave identically in tests and in production.
 */
import { getConfig, type Config } from '../config.js';

export interface RerankerModeSpec {
  /** Talks to a hosted endpoint — nothing to download, warm, or probe on disk. */
  hosted: boolean;
  /** Returns relevance scores, so a caller must not skip reranking. */
  scores: boolean;
  /** User-facing name for status/dashboard output. */
  label: string;
  /**
   * The scale this MODE normally produces: a cross-encoder emits raw logits
   * centred on 0, a hosted reranker a relevance probability in [0,1].
   *
   * This is a FALLBACK, not the authority. An adapter declares the scale it
   * actually produces (`RerankProvider.scoreDomain`), because the mode names a
   * wire protocol and a self-hosted endpoint may answer with logits regardless.
   * `search/core/rerank-fold.ts` prefers the adapter's declaration, falls back
   * to this, and finally checks the numbers themselves against the claim.
   */
  scoreDomain: 'logit' | 'probability';
}

/**
 * The exhaustive mode table.
 *
 * `satisfies Record<Config['reranker'], RerankerModeSpec>` is the point: adding
 * a value to the `reranker` union in `config.ts` fails COMPILATION here until
 * the new mode is classified. That is what stops a new backend from silently
 * defaulting to "reranking off" (how `remote` and then `jev` were skipped) or to
 * "model missing" (how every hosted mode was reported).
 *
 * `jev` is a legacy alias of `decision` — same hosted endpoint, same shape.
 */
export const RERANKER_MODES = {
  onnx: { hosted: false, scores: true, label: 'On-device ONNX', scoreDomain: 'logit' },
  none: { hosted: false, scores: false, label: 'Disabled', scoreDomain: 'logit' },
  remote: { hosted: true, scores: true, label: 'Hosted (Cohere shape)', scoreDomain: 'probability' },
  'workers-ai': { hosted: true, scores: true, label: 'Hosted (Workers AI)', scoreDomain: 'probability' },
  decision: { hosted: true, scores: true, label: 'Jev-compatible judgement model', scoreDomain: 'probability' },
  jev: { hosted: true, scores: true, label: 'Jev-compatible judgement model', scoreDomain: 'probability' },
} satisfies Record<Config['reranker'], RerankerModeSpec>;

/**
 * Look up a mode, tolerating an unknown value.
 *
 * `getConfig()` casts the raw env/persisted string to `Config['reranker']`
 * without validating it, so `WIGOLO_RERANKER=typo` really does reach callers
 * typed as the union. An unknown mode answers `undefined` — never "scores" and
 * never "hosted" — so a typo cannot turn reranking on or masquerade as an
 * endpoint.
 */
export function rerankerModeSpec(mode: Config['reranker'] | string): RerankerModeSpec | undefined {
  return (RERANKER_MODES as Record<string, RerankerModeSpec | undefined>)[mode];
}

/** True when reranking should run (local ONNX or any hosted judgement model). */
export function rerankerActive(): boolean {
  return rerankerModeSpec(getConfig().reranker)?.scores ?? false;
}

/**
 * True when the mode talks to a hosted endpoint, so `warmup`/`doctor`/`status`
 * must not treat it as a missing on-device model and try to download or probe
 * one.
 */
export function rerankerIsHosted(mode: Config['reranker']): boolean {
  return rerankerModeSpec(mode)?.hosted ?? false;
}
