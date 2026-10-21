/**
 * Embed provider interface.
 *
 * Stable interface for embedding implementations. The default swapped the
 * sentence-transformers Python subprocess for fastembed (Rust ONNX via
 * Node bindings); the factory now returns FastembedEmbedProvider.
 */
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { FastembedEmbedProvider, releaseEmbedModel } from '../embedding/fastembed-provider.js';
import { OpenAICompatibleEmbedProvider } from '../embedding/openai-embed-provider.js';

const log = createLogger('providers');

export interface EmbedProvider {
  /** Embed a batch of strings; returns one Float32Array per input. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /**
   * Validate that the backend is usable. For the local backend this loads the
   * ONNX session; for a hosted backend it only checks configuration. Must be
   * safe to call more than once.
   */
  warmup(): Promise<void>;
  /** Dimensionality of embeddings produced by this provider. */
  readonly dim: number;
  /** Model identifier (for cache invalidation / provenance). */
  readonly modelId: string;
}

let cached: Promise<EmbedProvider> | null = null;

/**
 * Pick the embed backend WITHOUT loading anything.
 *
 * Both the `EmbeddingService` instance and the `getEmbedProvider()` factory go
 * through here, so `WIGOLO_EMBEDDING_PROVIDER` selects one backend for the
 * whole process. Loading stays lazy either way: the local class only creates
 * its native session on first `embed()` (fastembed itself is dynamically
 * imported there), and the hosted backend never loads a model at all.
 */
export function createEmbedProvider(): EmbedProvider {
  if (getConfig().embeddingProvider === 'openai-compatible') {
    return new OpenAICompatibleEmbedProvider();
  }
  return new FastembedEmbedProvider();
}

export function getEmbedProvider(): Promise<EmbedProvider> {
  if (cached) return cached;
  cached = Promise.resolve(createEmbedProvider())
    .then(async p => {
      await p.warmup();
      log.info('embed provider ready', {
        provider: 'embed',
        impl: getConfig().embeddingProvider,
        modelId: p.modelId,
        dim: p.dim,
      });
      return p;
    })
    .catch(err => {
      // Clear cache on any failure (import or warmup) so the next call retries.
      cached = null;
      throw err;
    });
  return cached;
}

export function _resetEmbedProviderForTest(): void {
  cached = null;
}

/**
 * Release the native embedding session and drop the cached provider.
 *
 * The session is the biggest single native allocation in the process
 * (~300 MB for BGE-small). It is released explicitly because dropping the
 * JS reference only frees the native memory when the GC happens to run.
 *
 * Idempotent.
 */
export async function disposeEmbedProvider(): Promise<void> {
  // No-op for the hosted backend (nothing native to release).
  releaseEmbedModel();
  cached = null;
}
