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
  onnx: { hosted: false, scores: true, label: 'On-device ONNX' },
  none: { hosted: false, scores: false, label: 'Disabled' },
  remote: { hosted: true, scores: true, label: 'Hosted (Cohere shape)' },
  'workers-ai': { hosted: true, scores: true, label: 'Hosted (Workers AI)' },
  decision: { hosted: true, scores: true, label: 'Jev-compatible judgement model' },
  jev: { hosted: true, scores: true, label: 'Jev-compatible judgement model' },
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
