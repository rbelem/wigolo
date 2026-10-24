import type { Config } from '../../config.js';
import type { RerankCandidate, RerankProvider, RerankResult } from '../../providers/rerank-provider.js';
import { assertHostedUrl, postJsonCapped } from '../../providers/hosted-http.js';

type RemoteResult = { index?: unknown; relevance_score?: unknown; score?: unknown };

/**
 * Resolve and validate `WIGOLO_RERANK_API_BASE` into the `/rerank` URL.
 *
 * The rules are the shared ones (`assertHostedUrl`): http(s) only, no embedded
 * credentials/query/fragment, and a keyed endpoint must be HTTPS off loopback.
 * Split out of the constructor so the migration case (a carry-over Workers AI
 * config) can be named on its own.
 */
function resolveRerankUrl(config: Config): string {
  const base = assertHostedUrl(
    config.rerankApiBase,
    'WIGOLO_RERANK_API_BASE',
    config.rerankApiKey,
    missingBaseMessage(config),
  );
  return `${base}/rerank`;
}

/**
 * The fork spelled its Workers AI reranker `remote` before the rebase onto
 * upstream v0.3.0. Say so instead of the bare "requires WIGOLO_RERANK_API_BASE":
 * otherwise a carry-over config looks like a missing setting and search quietly
 * falls back to passthrough.
 */
function missingBaseMessage(config: Config): string {
  if (!config.rerankerBaseUrl) return 'Remote reranker requires WIGOLO_RERANK_API_BASE';
  return (
    'WIGOLO_RERANKER=remote now means the Cohere-shape endpoint and reads ' +
    'WIGOLO_RERANK_API_BASE. Your WIGOLO_RERANKER_BASE_URL is the Workers AI ' +
    'adapter: set WIGOLO_RERANKER=workers-ai to keep it, or point ' +
    'WIGOLO_RERANK_API_BASE at a Cohere /rerank service.'
  );
}

/** Map a shared-client failure onto this provider's established error surface. */
function rerankError(err: unknown, apiKey: string | null): Error {
  const status = (err as { status?: number }).status;
  // The shared client puts the status on the error; keep reporting it verbatim
  // (and keep its bounded body excerpt out of the message).
  if (typeof status === 'number') return new Error(`Remote rerank HTTP ${status}`);
  const reason = (err instanceof Error ? err.message : 'unknown network error')
    .replaceAll(apiKey || '\0', '[redacted]');
  return new Error(`Remote rerank request failed: ${reason}`);
}

/** Cohere-style POST /rerank adapter for a configured model service. */
export class RemoteRerankProvider implements RerankProvider {
  readonly modelId: string;
  private readonly url: string;

  constructor(private readonly config: Config) {
    this.url = resolveRerankUrl(config);
    this.modelId = config.rerankerModel;
  }

  async rerank(query: string, candidates: RerankCandidate[], topK = candidates.length): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    if (!Number.isInteger(topK) || topK < 0) throw new Error('Remote rerank topK must be a non-negative integer');
    if (topK === 0) return [];
    const topN = Math.min(topK, candidates.length);

    // Shared transport: bounded response size, shared transient-failure
    // classification, and `redirect: 'error'` (assertHostedUrl has already
    // vetted the URL). A hostile host can no longer buffer forever.
    let payload: unknown;
    try {
      payload = await postJsonCapped<unknown>({
        url: this.url,
        body: { model: this.modelId, query, documents: candidates.map((c) => c.text), top_n: topN },
        apiKey: this.config.rerankApiKey,
        timeoutMs: this.config.rerankerRequestTimeoutMs,
        label: 'Remote rerank',
      });
    } catch (err) {
      throw rerankError(err, this.config.rerankApiKey);
    }
    if (!payload || typeof payload !== 'object' || !('results' in payload) || !Array.isArray(payload.results)) {
      throw new Error('Remote rerank response must contain a results array');
    }
    // Some servers ignore top_n and score every document, so only too few results is an error.
    if (payload.results.length < topN) throw new Error('Remote rerank returned fewer results than requested');
    const seen = new Set<number>();
    const scored = payload.results.map((item: unknown): RerankResult => {
      if (!item || typeof item !== 'object') throw new Error('Remote rerank result must be an object');
      const { index, relevance_score, score } = item as RemoteResult;
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= candidates.length) {
        throw new Error('Remote rerank returned an out-of-range index');
      }
      const i = index as number;
      if (seen.has(i)) throw new Error('Remote rerank returned a duplicate index');
      seen.add(i);
      const value = relevance_score ?? score;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('Remote rerank returned a non-finite or missing score');
      }
      return { id: candidates[i].id, score: value };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, topN);
  }
}
