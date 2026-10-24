/**
 * Hosted reranker, Cloudflare Workers AI wire shape (`WIGOLO_RERANKER=workers-ai`).
 *
 * Sibling of `remote-rerank-provider.ts` (Cohere shape, `WIGOLO_RERANKER=remote`).
 * The two hosts differ in both the request body and the response envelope, so
 * they cannot share one adapter.
 *
 * The local path holds a Transformers.js cross-encoder worth ~500 MB of
 * resident memory. This holds none, at the cost of a network round-trip.
 *
 * Wire format is Cloudflare Workers AI's reranker shape:
 *   POST {baseUrl}   body { query, contexts: [{ text }], top_k? }
 *   → { response: [{ id, score }, ...] }
 * where `id` is the index into `contexts`.
 *
 * IMPORTANT — this is a MODEL change, not just a transport change. The local
 * reranker is `Xenova/ms-marco-MiniLM-L-6-v2`; a hosted one is typically
 * `bge-reranker-base`. Scores come from a different model, so the tier
 * thresholds in `search/core/rerank-fold.ts` (RERANK_RELEVANCE_THRESHOLD,
 * RERANK_TIER_MARGIN) are calibrated against the WRONG distribution after the
 * switch. Re-derive them before trusting `relevance_score` or tier-1 results.
 */
import type { RerankCandidate, RerankProvider, RerankResult } from '../../providers/rerank-provider.js';
import { assertHostedUrl, postJsonCapped } from '../../providers/hosted-http.js';
import { getConfig } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('reranker');

/** Read from WIGOLO_RERANKER_REQUEST_TIMEOUT_MS at call time, not hardcoded. */
const rerankTimeoutMs = () => getConfig().rerankerRequestTimeoutMs;

interface RerankResponse {
  response?: unknown;
  result?: unknown;
  errors?: Array<{ message?: string }>;
}

export class WorkersAiRerankProvider implements RerankProvider {
  readonly modelId: string;
  private baseUrl: string;
  private readonly rawBaseUrl: string | null;
  private readonly apiKey: string | null;
  private validated = false;

  constructor() {
    const cfg = getConfig();
    // Never the base URL: it carries the account id, and this value is
    // printed by warmup/verify/doctor.
    this.modelId = cfg.rerankerModel;
    this.rawBaseUrl = cfg.rerankerBaseUrl;
    this.baseUrl = (cfg.rerankerBaseUrl ?? '').replace(/\/+$/, '');
    this.apiKey = cfg.rerankerApiKey;
  }

  async warmup(): Promise<void> {
    this.baseUrl = assertHostedUrl(
      this.rawBaseUrl,
      'WIGOLO_RERANKER_BASE_URL (WIGOLO_RERANKER=workers-ai)',
      this.apiKey,
      'WIGOLO_RERANKER=workers-ai requires WIGOLO_RERANKER_BASE_URL (e.g. ' +
        'https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/@cf/baai/bge-reranker-base)',
    );
    this.validated = true;
    log.info('rerank provider ready', { provider: 'rerank', impl: 'workers-ai', baseUrl: this.baseUrl });
  }

  /** Validate once, lazily: the factory warms up, but `rerank` must too. */
  private async ready(): Promise<void> {
    if (!this.validated) await this.warmup();
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK = candidates.length,
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    await this.ready();

    const payload = await postJsonCapped<RerankResponse>({
      url: this.baseUrl,
      body: {
        query,
        contexts: candidates.map((c) => ({ text: c.text })),
        top_k: candidates.length,
      },
      apiKey: this.apiKey,
      timeoutMs: rerankTimeoutMs(),
      // One attempt: a timed-out rerank must degrade to composite ordering, not
      // spend a second full timeout before the search returns.
      attempts: 1,
      label: 'rerank',
    });

    const scored = interpret(payload, candidates);
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

/**
 * Map a host-specific response onto candidate ids.
 *
 * The shape is parsed defensively because the published schema documents
 * `response[]` without its subfields; a wrong guess would silently score every
 * candidate 0 and quietly destroy result ordering. Anything unparseable throws
 * with the observed keys so the mismatch is diagnosable instead of silent.
 */
function interpret(payload: RerankResponse, candidates: RerankCandidate[]): RerankResult[] {
  const rows = Array.isArray(payload.response)
    ? payload.response
    : Array.isArray(payload.result)
      ? payload.result
      : null;

  if (!rows) {
    const detail = payload.errors?.map((e) => e.message).filter(Boolean).join('; ');
    throw new Error(
      `unrecognised rerank response shape (keys: ${Object.keys(payload).join(', ') || 'none'})` +
        (detail ? ` — ${detail}` : ''),
    );
  }

  const out: RerankResult[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as { id?: number; index?: number; score?: number; relevance_score?: number };
    const idx = r.id ?? r.index;
    const score = r.score ?? r.relevance_score;
    if (typeof score !== 'number') continue;
    // `id` is the index into the contexts we sent. A row without a numeric id
    // is skipped rather than guessed: assigning it a position would score the
    // wrong document and silently reorder results.
    const candidate = typeof idx === 'number' ? candidates[idx] : undefined;
    if (!candidate) continue;
    out.push({ id: candidate.id, score });
  }

  if (out.length === 0) {
    throw new Error(
      'rerank response contained no usable {id, score} rows — check the provider shape ' +
        `(first row keys: ${firstRowKeys(rows)})`,
    );
  }
  return out;
}

function firstRowKeys(rows: unknown[]): string {
  const first = rows[0];
  return typeof first === 'object' && first !== null
    ? Object.keys(first as Record<string, unknown>).join(', ') || 'none'
    : typeof first;
}
