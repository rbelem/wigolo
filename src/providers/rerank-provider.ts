/**
 * Rerank provider interface.
 *
 * The default factory returns TransformersRerankProvider
 * (Transformers.js cross-encoder, in-process ONNX runtime). Hosted modes are
 * dispatched by `getRerankProvider` below; the old Python FlashRank adapter is
 * gone, and `WIGOLO_RERANKER=flashrank` is accepted only as an alias for onnx.
 */
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import type { Config } from '../config.js';
import { rerankerIsHosted } from '../search/rerank-mode.js';

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
  /**
   * What `score` means, when the adapter knows.
   *
   * A cross-encoder emits raw logits centred on 0; a hosted relevance model
   * returns a probability in [0,1]. The all-junk guard in
   * `search/core/rerank-fold.ts` compares the batch's best score against the
   * midpoint of the scale, so it has to know which one it is looking at.
   *
   * Declared by the ADAPTER, not by the config mode: the mode names the wire
   * protocol, but what a host puts in the `score` field is a property of that
   * host, and a self-hosted Cohere-shaped endpoint is free to return logits.
   * Undefined means "this adapter does not promise a scale" — the fold then
   * falls back to the mode's declaration and treats the batch adaptively.
   */
  readonly scoreDomain?: 'logit' | 'probability';
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
  const name = err instanceof Error ? err.name : '';
  // `AbortError` is what a timeout surfaces as. Treating it as deterministic
  // (the previous behaviour) meant the MOST likely transient failure of a slow
  // self-hosted endpoint — a timeout — was never retried.
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|aborted|502|503|504|gateway time-?out|request timed? ?out|timeout/i.test(
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

/**
 * Instantiate a hosted reranker for `mode`. Three wire shapes live behind the
 * one "hosted" idea, so the caller picks by mode rather than sniffing config.
 */
async function loadHostedRerankProvider(mode: Config['reranker']): Promise<RerankProvider> {
  if (mode === 'remote') {
    const { RemoteRerankProvider } = await import('../search/reranker/remote-rerank-provider.js');
    return new RemoteRerankProvider(getConfig());
  }
  if (mode === 'workers-ai') {
    const { WorkersAiRerankProvider } = await import(
      '../search/reranker/workers-ai-rerank-provider.js'
    );
    return new WorkersAiRerankProvider();
  }
  // `jev` is a legacy alias for `decision` (Jev-compatible wire format), kept
  // so an existing WIGOLO_RERANKER=jev keeps working.
  const { DecisionRerankProvider } = await import('../search/reranker/decision-rerank-provider.js');
  return new DecisionRerankProvider();
}

/** Providers that validate their config in a `warmup()` hook opt in by having one. */
async function warmupIfSupported(provider: RerankProvider): Promise<void> {
  const warmup = (provider as { warmup?: () => Promise<void> }).warmup;
  if (typeof warmup === 'function') await warmup.call(provider);
}

export function getRerankProvider(): Promise<RerankProvider> {
  if (cached) return cached;
  const config = getConfig();

  // Hosted path: no model is loaded, so there is nothing to warm beyond
  // config validation and no native session to release.
  if (rerankerIsHosted(config.reranker)) {
    cached = loadHostedRerankProvider(config.reranker)
      .then(async (provider) => {
        await warmupIfSupported(provider);
        return provider;
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
