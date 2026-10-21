/**
 * Which reranker modes actually produce scores.
 *
 * Three call sites need this answer (`search/rerank.ts`,
 * `search/highlights.ts`, `search/core/core-provider.ts`). Each used to test
 * `=== 'onnx'` inline, which silently treated every newly added backend as
 * "reranking disabled" — `remote` was skipped, and then `jev` was skipped the
 * same way. Keeping the list in one place is what stops that repeating.
 *
 * Lives in its own module rather than in `config.ts` on purpose: the suite
 * mocks `config.js` wholesale in many places, so a new export there resolves to
 * `undefined` under those mocks. Here the mocked `getConfig` is still used, so
 * the predicate behaves identically in tests and in production.
 */
import { getConfig } from '../config.js';

/** Modes backed by a component that returns relevance scores. */
const SCORING_MODES = new Set(['onnx', 'remote', 'decision', 'jev']);

/** True when reranking should run (local ONNX or any hosted judgement model). */
export function rerankerActive(): boolean {
  return SCORING_MODES.has(getConfig().reranker);
}
