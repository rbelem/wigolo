/**
 * Hosted embedding provider (OpenAI-compatible `/embeddings`).
 *
 * Exists to let a memory-constrained install move embedding off the machine:
 * the local fastembed path holds a native ONNX session worth ~290 MB of
 * resident memory, this holds none. Costs a network round-trip and a
 * per-token charge instead.
 *
 * Provider coverage — anything speaking the OpenAI `/embeddings` shape:
 *   - Cloudflare Workers AI   https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1
 *                             (@cf/baai/bge-small-en-v1.5 — 384 dims, the SAME
 *                             model the local path runs, so no re-embedding)
 *   - OpenRouter              https://openrouter.ai/api/v1
 *                             (openai/text-embedding-3-small and friends)
 *   - OpenAI, Jina, Voyage, Together, DeepInfra, llama.cpp / LM Studio
 *
 * OpenCode Zen is NOT an option: its gateway exposes responses, chat
 * completions, messages, models, and systemone — no embeddings endpoint.
 */
import type { EmbedProvider } from '../providers/embed-provider.js';
import { assertHostedUrl, postJsonCapped } from '../providers/hosted-http.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('embedding');

/** Bound the request: embeddings sit on the fetch/crawl hot path. */
const EMBED_REQUEST_TIMEOUT_MS = 15_000;

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
  /** Cloudflare's native (non-OpenAI) shape. */
  result?: { data?: number[][] };
  errors?: Array<{ message?: string }>;
  error?: { message?: string };
}

export class OpenAICompatibleEmbedProvider implements EmbedProvider {
  readonly modelId: string;
  readonly dim: number;
  private baseUrl: string;
  private readonly rawBaseUrl: string | null;
  private readonly apiKey: string | null;
  private validated = false;
  /**
   * Set once the endpoint is known to need `dimensions` to hit the index width.
   * Without this the probe-then-adapt dance would run on EVERY embed call,
   * doubling cost and latency forever on the crawl hot path.
   */
  private needsDimensions = false;

  constructor() {
    const cfg = getConfig();
    this.modelId = cfg.embeddingModel;
    this.dim = cfg.embeddingDim;
    this.rawBaseUrl = cfg.embeddingBaseUrl;
    this.baseUrl = (cfg.embeddingBaseUrl ?? '').replace(/\/+$/, '');
    this.apiKey = cfg.embeddingApiKey;
  }

  /**
   * Validate configuration up front so a misconfiguration fails on first use
   * with an actionable message rather than as a 404 mid-fetch. No model is
   * loaded — that is the point of this provider.
   */
  async warmup(): Promise<void> {
    this.baseUrl = assertHostedUrl(
      this.rawBaseUrl,
      'WIGOLO_EMBEDDING_BASE_URL (WIGOLO_EMBEDDING_PROVIDER=openai-compatible)',
      this.apiKey,
      'WIGOLO_EMBEDDING_PROVIDER=openai-compatible requires WIGOLO_EMBEDDING_BASE_URL ' +
        '(e.g. https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1, or ' +
        'https://openrouter.ai/api/v1)',
    );
    this.validated = true;
    log.info('embed provider ready', {
      provider: 'embed',
      impl: 'openai-compatible',
      modelId: this.modelId,
      dim: this.dim,
      baseUrl: this.baseUrl,
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (!this.validated) await this.warmup();

    // Once the endpoint is known to need truncation, ask for the index width
    // directly — the probe below is a one-time discovery, not a per-call cost.
    if (this.needsDimensions) {
      const adapted = await this.request(texts, this.dim);
      assertWidth(adapted, this.dim, this.modelId);
      return toFloat32(adapted);
    }

    // First attempt omits `dimensions`: providers disagree about unknown
    // fields, so only send it when it is actually needed.
    const first = await this.request(texts, undefined);
    if (first.every((v) => v.length === this.dim)) return toFloat32(first);

    // The model's native width differs from the index width. OpenRouter and
    // OpenAI accept `dimensions` to truncate to a requested width, which
    // avoids a schema migration; ask for the width the index actually has.
    const adapted = await this.request(texts, this.dim);
    if (adapted.every((v) => v.length === this.dim)) {
      this.needsDimensions = true;
      log.info('embeddings adapted to index width via dimensions', {
        modelId: this.modelId,
        dim: this.dim,
      });
      return toFloat32(adapted);
    }

    throw new Error(dimMismatchMessage(adapted[0]?.length ?? 0, this.dim, this.modelId));
  }

  private async request(texts: string[], dimensions: number | undefined): Promise<number[][]> {
    // Cap each input. Hosted endpoints reject over-length input with a 400, and
    // `WIGOLO_EMBEDDING_MAX_TEXT_LENGTH` existed but had no consumer at all —
    // a whole fetched page would otherwise be sent verbatim.
    const maxChars = getConfig().embeddingMaxTextLength;
    const capped = maxChars > 0
      ? texts.map((t) => (t.length > maxChars ? t.slice(0, maxChars) : t))
      : texts;

    const payload = await postJsonCapped<EmbeddingsResponse>({
      url: `${this.baseUrl}/embeddings`,
      body: {
        model: this.modelId,
        input: capped,
        ...(dimensions !== undefined ? { dimensions } : {}),
      },
      apiKey: this.apiKey,
      timeoutMs: EMBED_REQUEST_TIMEOUT_MS,
      label: 'embeddings',
    });
    const vectors = extractVectors(payload);
    if (vectors.length !== texts.length) {
      throw new Error(
        `embeddings response returned ${vectors.length} vectors for ${texts.length} inputs`,
      );
    }
    return vectors;
  }
}

/**
 * Throw unless every vector matches the index width.
 *
 * The index is declared `float[384]` in DDL and `upsert` does not length-check,
 * so a differently-sized vector would corrupt nearest-neighbour results rather
 * than fail.
 */
function assertWidth(vectors: number[][], want: number, model: string): void {
  for (const v of vectors) {
    if (v.length !== want) throw new Error(dimMismatchMessage(v.length, want, model));
  }
}

function dimMismatchMessage(got: number, want: number, model: string): string {
  return (
    `embeddings model "${model}" returned ${got}-dim vectors but the vector index is fixed at ` +
    `${want}. Use a model that produces ${want} dims, or one that supports \`dimensions\` ` +
    `truncation (openai/text-embedding-3-*, or Cloudflare @cf/baai/bge-small-en-v1.5 which is ` +
    `natively ${want}). The index width is set by the schema, not by configuration.`
  );
}

function toFloat32(vectors: number[][]): Float32Array[] {
  return vectors.map((v) => Float32Array.from(v));
}

/**
 * Pull embeddings out of either supported response shape:
 *  - OpenAI-compatible: `{ data: [{ index, embedding: [...] }] }`
 *  - Cloudflare native: `{ result: { data: [[...], [...]] } }`
 * Ordered by `index` when present so a batched response cannot scramble the
 * input→vector correspondence.
 */
function extractVectors(payload: EmbeddingsResponse): number[][] {
  if (Array.isArray(payload.data)) {
    return [...payload.data]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((row) => row.embedding ?? []);
  }
  if (Array.isArray(payload.result?.data)) return payload.result.data;
  const detail = payload.errors?.map((e) => e.message).filter(Boolean).join('; ')
    ?? payload.error?.message;
  throw new Error(`unrecognised embeddings response shape${detail ? ` — ${detail}` : ''}`);
}
