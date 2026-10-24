/**
 * Cooldown after a rerank call blows its deadline.
 *
 * A hosted reranker that stops answering does not fail once: every subsequent
 * search and every fetched page would pay the fold's deadline again before
 * falling back to the ordering it was always going to fall back to. One timeout
 * is evidence the endpoint is unwell, so skip reranking entirely for a while
 * instead of re-learning that per query.
 *
 * Deliberately in-memory and process-local, like the engine breakers: a daemon
 * restart is a cheap way to retry, and a cluster does not need to agree.
 */
const COOLDOWN_MS = 60_000;

let coolingUntil = 0;

/** Record that reranking just failed to answer in time. */
export function recordRerankTimeout(nowMs: number = Date.now()): void {
  coolingUntil = nowMs + COOLDOWN_MS;
}

/** True while a recent timeout says the reranker is not worth waiting for. */
export function rerankCoolingDown(nowMs: number = Date.now()): boolean {
  return nowMs < coolingUntil;
}

/** Test hook: forget any recorded timeout. */
export function _resetRerankCooldownForTest(): void {
  coolingUntil = 0;
}
