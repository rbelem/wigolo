/**
 * Rerank provider interface.
 *
 * The default factory returns TransformersRerankProvider
 * (Transformers.js cross-encoder, in-process ONNX runtime). The legacy
 * Python FlashRank adapter still exists in `search/reranker/legacy-provider.ts`
 * but it is no longer wired in.
 */
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';

const log = createLogger('providers');
export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface RerankProvider {
  rerank(
    query: string,
    candidates: RerankCandidate[],
    topK?: number,
  ): Promise<RerankResult[]>;
  /** Model identifier (for cache invalidation / provenance). */
  readonly modelId: string;
}

let cached: Promise<RerankProvider> | null = null;

/**
 * True when an error looks like a transient network/fetch blip a retry can
 * recover — the field reranker "fetch failed" during model download, plus common
 * socket/DNS/gateway cousins. Deterministic errors (bad model, bad shape) must
 * NOT match, so they fail fast instead of retrying pointlessly.
 */
export function isTransientFetchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|502|503|504|gateway time-?out|request timed? ?out/i.test(
    msg,
  );
}

export interface FetchRetryOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run an async op, retrying ONLY transient fetch failures with a linear backoff.
 * A deterministic error, or exhausting the attempt budget, throws immediately.
 * `sleep` is injectable so the retry is tested without real delays.
 */
export async function withFetchRetry<T>(
  op: () => Promise<T>,
  opts: FetchRetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 400;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (i === attempts || !isTransientFetchError(err)) throw err;
      await sleep(delayMs * i);
    }
  }
  throw lastErr;
}

export function getRerankProvider(): Promise<RerankProvider> {
  if (cached) return cached;
  const cfg = getConfig();

  // Hosted path: no model is loaded, so there is nothing to warm beyond
  // config validation and no native session to release.
  if (cfg.reranker === 'remote' || cfg.reranker === 'decision' || cfg.reranker === 'jev') {
    // `jev` is a legacy alias for `decision` (Jev-compatible wire format), kept
    // so an existing WIGOLO_RERANKER=jev keeps working.
    const isDecision = cfg.reranker !== 'remote';
    cached = (isDecision
      ? import('../search/reranker/decision-rerank-provider.js').then(
          (m) => new m.DecisionRerankProvider(),
        )
      : import('../search/reranker/remote-rerank-provider.js').then(
          (m) => new m.RemoteRerankProvider(),
        )
    )
      .then(async (p) => {
        await p.warmup();
        return p;
      })
      .catch((err) => {
        cached = null;
        throw err;
      });
    return cached;
  }

  cached = import('../search/reranker/transformers-rerank-provider.js')
    .then(async (m) => {
      const p = new m.TransformersRerankProvider();
      await withFetchRetry(() => p.warmup());
      log.info('rerank provider ready', {
        provider: 'rerank',
        impl: 'transformers',
        modelId: p.modelId,
      });
      return p;
    })
    .catch((err) => {
      cached = null;
      throw err;
    });
  return cached;
}

export function _resetRerankProviderForTest(): void {
  cached = null;
}

// Best-effort disposal of the cached rerank provider's native resources.
// Called from CLI shutdown to release the ONNX session before process exit.
export async function disposeRerankProvider(): Promise<void> {
  if (!cached) return;
  try {
    const provider = await cached;
    const disposable = provider as unknown as { dispose?: () => Promise<void> };
    if (typeof disposable.dispose === 'function') await disposable.dispose();
  } catch (err) {
    log.debug('rerank dispose failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    cached = null;
  }
}
