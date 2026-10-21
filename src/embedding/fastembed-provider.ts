import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// Type-only: the runtime module is dynamic-imported inside getModel() so the
// native ONNX runtime is NOT mapped into the process at boot (D2 idle-footprint
// contract) — a static import loads the native binding the moment any file in
// the boot chain touches this module.
import type { FlagEmbedding } from 'fastembed';
import type { EmbedProvider } from '../providers/embed-provider.js';
import { IdleEvictor } from '../providers/idle-evictor.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('embedding');

/**
 * Ensure the fastembed model cache dir (and any missing parents) exists, then
 * return it. fastembed's own `retrieveModel` does a NON-recursive
 * `mkdirSync(cacheDir)`, so on a fresh machine where `${dataDir}` (e.g.
 * `~/.wigolo`) does not exist yet the download throws
 * `ENOENT: mkdir '...\.wigolo\fastembed'` (seen on Windows). Pre-creating the
 * dir recursively makes fastembed's own `existsSync` check pass and skips its
 * broken mkdir.
 */
export function ensureFastembedCacheDir(dataDir: string): string {
  const cacheDir = join(dataDir, 'fastembed');
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

/**
 * Remove the fastembed cache dir and recreate it empty — used to clear a
 * partial/corrupt model download (a leftover `.tar.gz` that fastembed will not
 * re-fetch) before retrying.
 */
export function resetFastembedCacheDir(dataDir: string): string {
  rmSync(join(dataDir, 'fastembed'), { recursive: true, force: true });
  return ensureFastembedCacheDir(dataDir);
}

/**
 * True when an error looks like a truncated/corrupt model archive — the field
 * `TAR_BAD_ARCHIVE: Unrecognized archive format` and its decompress cousins.
 * These recover by wiping the partial file and re-downloading; unrelated errors
 * (e.g. a missing native tokenizer binary) do NOT, so they must not match.
 */
export function isCorruptArchiveError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /TAR_BAD_ARCHIVE|Unrecognized archive format|unexpected end of (file|data)|incorrect header check|invalid (tar|gzip)|zlib/i.test(
    msg,
  );
}

/**
 * Run a model init; on a corrupt-archive failure ONLY, reset the cache and try
 * exactly once more. Any other error propagates immediately (a re-download would
 * not fix it). Pure over its injected `init`/`resetCache`, so the retry is tested
 * without touching the network or the native runtime.
 */
export async function initModelWithArchiveRetry<T>(
  init: () => Promise<T>,
  resetCache: () => void,
): Promise<T> {
  try {
    return await init();
  } catch (err) {
    if (!isCorruptArchiveError(err)) throw err;
    resetCache();
    return await init();
  }
}

/**
 * ONE native ONNX session per process.
 *
 * The session used to live in instance fields, so the two independent
 * providers that exist in this codebase — EmbeddingService's own instance
 * and the `getEmbedProvider()` factory — each created their own
 * FlagEmbedding. A process that touched both held two copies of the model
 * (~290 MB of native memory each). Hoisting the session to module scope
 * makes the second provider reuse the first.
 */
let sharedModel: FlagEmbedding | null = null;
let sharedModelPromise: Promise<FlagEmbedding> | null = null;

/** Number of embeds currently running — eviction defers while non-zero. */
let inFlightEmbeds = 0;

/** True while the native embedding session is resident in this process. */
export function isEmbedModelResident(): boolean {
  return sharedModel !== null;
}

/**
 * Release the native ONNX session.
 *
 * The session's weights live in native memory that the JS heap does not
 * own, so an explicit release is the only deterministic way to reclaim it
 * (~300 MB resident for BGE-small). Dropping the reference alone frees the
 * memory only when the GC happens to run.
 *
 * Idempotent: safe to call when nothing is loaded, and safe to call twice.
 */
export function releaseEmbedModel(): void {
  // Never release the session while an inference is running — the native
  // runtime gives no guarantee about release() racing an in-flight run().
  if (inFlightEmbeds > 0) {
    log.debug('embedding release deferred — an embed is in flight');
    return;
  }
  const model = sharedModel;
  sharedModel = null;
  sharedModelPromise = null;
  if (!model) return;
  const session = (model as unknown as { session?: { release?: () => void } }).session;
  try {
    session?.release?.();
  } catch (err) {
    log.debug('embedding session release failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  log.info('Embedding model released');
}

/**
 * Idle eviction for the embedding session. The window is read at arm time so
 * a config change takes effect on the next use. `embeddingIdleTimeoutMs` of 0
 * disables eviction entirely.
 */
const embedEvictor = new IdleEvictor({
  idleMs: () => getConfig().embeddingIdleTimeoutMs,
  isBusy: () => inFlightEmbeds > 0,
  onEvict: () => releaseEmbedModel(),
});

/**
 * Native ONNX embedding provider using fastembed-rs Node bindings.
 *
 * Model: BGE-small-en-v1.5 (384-dim). First call to `warmup()` downloads
 * the ONNX model to `${dataDir}/fastembed`. Subsequent runs reuse the cache.
 * Replaces the legacy sentence-transformers Python subprocess.
 */
export class FastembedEmbedProvider implements EmbedProvider {
  readonly modelId: string;
  readonly dim: number;

  constructor() {
    this.modelId = 'BGE-small-en-v1.5';
    this.dim = 384;
  }

  async warmup(): Promise<void> {
    await this.getModel();
  }

  private getModel(): Promise<FlagEmbedding> {
    if (sharedModel) return Promise.resolve(sharedModel);
    if (sharedModelPromise) return sharedModelPromise;
    log.info('Loading embedding model', { modelId: this.modelId });
    const dataDir = getConfig().dataDir;
    const cacheDir = ensureFastembedCacheDir(dataDir);
    sharedModelPromise = import('fastembed')
      .then(({ FlagEmbedding, EmbeddingModel }) =>
        initModelWithArchiveRetry(
          () => FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir }),
          () => resetFastembedCacheDir(dataDir),
        ),
      )
      .then(m => {
      sharedModel = m;
      log.info('Embedding model ready', { modelId: this.modelId, dim: this.dim });
      embedEvictor.touch();
      return m;
    }).catch(err => {
      sharedModelPromise = null;
      throw err;
    });
    return sharedModelPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    // Count the embed as in-flight BEFORE loading: a concurrent idle
    // eviction must not release the session while a load is pending.
    inFlightEmbeds++;
    try {
      const model = await this.getModel();
      const out: Float32Array[] = [];
      for await (const batch of model.embed(texts, texts.length)) {
        for (const vec of batch) {
          out.push(Float32Array.from(vec));
        }
      }
      return out;
    } finally {
      inFlightEmbeds--;
      embedEvictor.touch();
    }
  }
}
