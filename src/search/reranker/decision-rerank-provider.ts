/**
 * Decision-model reranker (`WIGOLO_RERANKER=decision`).
 *
 * Reranking is a judgement — "how relevant is document D to query Q?" — so it
 * can run on a decision model instead of a local cross-encoder, dropping the
 * ~500 MB resident ONNX session to zero.
 *
 * NOT LOCKED TO ONE VENDOR. This speaks the "Jev-API compatible" wire format,
 * which as of Oct 2026 is the de-facto standard across the category:
 *
 *   TypeSafe Jev          hosted, closed
 *   OpenCode Zen          hosted, /inference/systemone/v1/systemone  (jev-1.13[-free])
 *   Clef / Clef-flash     Cloudflare Workers AI, or self-hosted (Apache-2.0)
 *   Kev                   self-hosted (Apache-2.0)
 *   Decision Models       decisionmodels.io
 *   Ollaya                serves Laya/Kev/Clef and others LOCALLY on Jev's endpoint
 *
 * Switching vendors is three env vars (`BASE_URL`, `MODEL`, `API_KEY`) — no code
 * change. `pplx-decider` and `Laya` expose their own endpoints with the same
 * question types; they need a thin adapter, not a new provider.
 *
 *   POST {baseUrl}
 *   Authorization: Bearer {apiKey}          (omitted for unauthenticated self-hosts)
 *   { model, state, questions: { <id>: { type, instructions, criteria } } }
 *
 * All candidate scores are asked as PARALLEL `score` questions in ONE call —
 * `state` is a single string, so one-call-per-candidate would be N round-trips.
 *
 * SCORE SEMANTICS — this is not a logit. Decision models answer with a
 * probability per allowed option, so this provider returns an expected bucket
 * position in [0, 1]. `RERANK_RELEVANCE_THRESHOLD` and `RERANK_TIER_MARGIN` in
 * `search/core/rerank-fold.ts` are calibrated against cross-encoder logits and
 * MUST be re-derived before tier-1 results are trusted.
 *
 * RESPONSE SHAPE is parsed defensively: the docs describe "an answer with
 * probability for every allowed option" but not the field names, and vendors
 * differ. Several envelope and option encodings are accepted; an unrecognised
 * shape throws with the observed keys rather than scoring everything 0.
 */
import type { RerankCandidate, RerankProvider, RerankResult } from '../../providers/rerank-provider.js';
import { assertHostedUrl, postJsonCapped } from '../../providers/hosted-http.js';
import { getConfig } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('reranker');

/** Self-hosted models can be slow on CPU; read the knob so it stays tunable. */
const decisionTimeoutMs = () => getConfig().rerankerRequestTimeoutMs;

/** Hard bounds per gateway call. */
const MAX_CANDIDATES_PER_CALL = 25;
const MAX_STATE_CHARS = 12_000;
/** Per-document cap, so one huge page cannot crowd out the rest. */
const MAX_DOC_CHARS = 2_000;

function truncateDoc(text: string): string {
  return text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}…` : text;
}

/**
 * Split candidates into groups that respect both the count and the state-size
 * budget. A single candidate always goes in its own chunk even if it alone
 * exceeds the budget, so the loop always makes progress.
 */
function chunkCandidates(candidates: RerankCandidate[]): RerankCandidate[][] {
  const chunks: RerankCandidate[][] = [];
  let current: RerankCandidate[] = [];
  let chars = 0;
  for (const c of candidates) {
    const cost = truncateDoc(c.text).length + 8;
    const full = current.length >= MAX_CANDIDATES_PER_CALL || chars + cost > MAX_STATE_CHARS;
    if (full && current.length > 0) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(c);
    chars += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Relevance ladder asked of the model. Index order = increasing relevance. */
const RELEVANCE_BUCKETS = [
  'Irrelevant: off topic or does not answer the query',
  'Marginal: touches the topic but adds little',
  'Relevant: answers part of the query',
  'Highly relevant: directly and completely answers the query',
];

export class DecisionRerankProvider implements RerankProvider {
  readonly modelId: string;
  private baseUrl: string;
  private readonly rawBaseUrl: string | null;
  private readonly apiKey: string | null;
  private validated = false;

  constructor() {
    const cfg = getConfig();
    this.modelId = cfg.rerankerModel;
    this.rawBaseUrl = cfg.rerankerBaseUrl;
    this.baseUrl = (cfg.rerankerBaseUrl ?? '').replace(/\/+$/, '');
    this.apiKey = cfg.rerankerApiKey;
  }

  async warmup(): Promise<void> {
    this.baseUrl = assertHostedUrl(
      this.rawBaseUrl,
      'WIGOLO_RERANKER_BASE_URL (WIGOLO_RERANKER=decision)',
      this.apiKey,
      'WIGOLO_RERANKER=decision needs WIGOLO_RERANKER_BASE_URL. Examples: ' +
        'https://opencode.ai/inference/systemone/v1/systemone (OpenCode Zen / Jev), ' +
        'a Cloudflare Workers AI Clef endpoint, or a self-hosted Kev/Ollaya URL.',
    );
    this.validated = true;
    if (!this.apiKey) {
      // Self-hosted Kev/Ollaya commonly run unauthenticated; do not reject.
      log.debug('decision reranker has no API key — assuming an unauthenticated self-host');
    }
    log.info('rerank provider ready', {
      provider: 'rerank',
      impl: 'decision',
      modelId: this.modelId,
      baseUrl: this.baseUrl,
    });
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK = candidates.length,
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    if (!this.validated) await this.warmup();

    // Bound each call by BOTH candidate count and state size. `state` is one
    // string, so an unbounded batch either blows a small self-hosted model's
    // context window or gets silently truncated vendor-side — and a document
    // the model never saw still comes back scored.
    const chunks = chunkCandidates(candidates);

    const all: RerankResult[] = [];
    for (const chunk of chunks) {
      all.push(...(await this.scoreChunk(query, chunk)));
    }
    return all.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** One gateway call for a bounded group of candidates. */
  private async scoreChunk(query: string, chunk: RerankCandidate[]): Promise<RerankResult[]> {
    const questions: Record<string, unknown> = {};
    const indexToId = new Map<number, string>();
    chunk.forEach((c, i) => {
      // Question ids must be stable and unambiguous; a candidate id may contain
      // characters a gateway rejects, so key by position.
      //
      // The instruction MUST name the document by its index. Questions are
      // evaluated in parallel and only the `r{i}` ↔ `[i]` id convention links
      // them; if the gateway does not surface question ids to the model, a
      // generic instruction makes every question identical and the model
      // returns near-identical distributions — silently destroying ordering.
      questions[`r${i}`] = {
        type: 'score',
        instructions: `How relevant is document [${i}] to the search query?`,
        criteria: RELEVANCE_BUCKETS,
      };
      indexToId.set(i, c.id);
    });

    const state = [
      `Query: ${query}`,
      '',
      'Documents:',
      ...chunk.map((c, i) => `[${i}] ${truncateDoc(c.text)}`),
    ].join('\n');

    const payload = await postJsonCapped<unknown>({
      url: this.baseUrl,
      body: { model: this.modelId, state, questions },
      apiKey: this.apiKey,
      timeoutMs: decisionTimeoutMs(),
      label: 'decision rerank',
      // ONE attempt, not the default two. A timeout is classified transient by
      // withFetchRetry, so the default spends two full
      // WIGOLO_RERANKER_REQUEST_TIMEOUT_MS periods before search falls back to
      // its pre-rerank ordering. Reranking is a quality optimisation, not
      // correctness — it must fail fast.
      attempts: 1,
    });

    const scored = interpret(payload, indexToId);
    if (scored.length === 0) {
      throw new Error(
        'decision rerank returned no usable scores — check the response shape ' +
          `(keys: ${Object.keys(asRecord(payload) ?? {}).join(', ') || 'none'})`,
      );
    }
    return scored;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Pull the per-question answers out of whichever envelope the vendor used. */
function findAnswers(payload: unknown): Record<string, unknown> | null {
  const root = asRecord(payload);
  if (!root) return null;
  for (const key of ['answers', 'results', 'questions', 'output', 'response', 'data']) {
    const inner = asRecord(root[key]);
    if (inner) return inner;
  }
  // Some shapes inline the answers at the root, keyed by question id.
  return Object.keys(root).some((k) => /^r\d+$/.test(k)) ? root : null;
}

/**
 * Score one answer into [0, 1].
 *
 * Preference order:
 *  1. A probability map over ALL options (the shape the docs describe) →
 *     expected bucket position, which is the smoothest signal.
 *  2. A chosen `{label|value|choice, probability}` → (index + prob) / count.
 *  3. An explicit `probability`/`confidence` field → used as-is; that field
 *     NAME is what makes it unambiguous (see numericScore()).
 *  4. A bare numeric `score`/`value`/answer → bucket index or probability,
 *     disambiguated by integrality.
 * An unrecognised label yields 0.5 rather than 0, so a parsing surprise
 * degrades ordering instead of inverting it.
 */
function toScore(answer: unknown): number | null {
  if (typeof answer === 'number') return numericScore(answer);
  const rec = asRecord(answer);
  if (!rec) return null;

  const distribution = optionDistribution(rec);
  if (distribution) return expectedBucket(distribution);

  const label = rec.label ?? rec.choice ?? rec.value;

  if (typeof label === 'string') {
    const idx = bucketIndex(label);
    if (idx < 0) return 0.5;
    // Same normalisation as expectedBucket(): position over the bucket range.
    // Dividing by length here (the previous form) scored a certain "Relevant"
    // 0.75 while the distribution path scored the same answer 0.667.
    return clamp01(idx / (RELEVANCE_BUCKETS.length - 1));
  }

  // A field literally named probability/confidence states its own scale, so it
  // escapes the bucket-index reading below — this is the escape hatch for a
  // vendor whose 0/1 really does mean no/yes certainty rather than buckets.
  const probability = rec.probability ?? rec.confidence;
  if (typeof probability === 'number') return clamp01(probability);

  const numeric = rec.score ?? rec.value;
  return typeof numeric === 'number' ? numericScore(numeric) : null;
}

/**
 * Interpret a bare numeric score.
 *
 * This wire format answers a `score` question with a BUCKET INDEX, so a whole
 * number in range is read as an index: `0` is Irrelevant (0.0), `1` is
 * Marginal (1/3), `3` is Highly relevant (1.0). Reading an integer as a
 * probability — the previous behaviour — scored a "bucket 1 = Marginal" answer
 * as certainty and destroyed the ordering, and it is indistinguishable from a
 * real probability 1 without a field name to go on.
 *
 * Only a NON-INTEGER value can be a probability, and only in [0,1]. A vendor
 * that means a probability should send it in `probability` (see toScore);
 * a vendor answering on a 0-100 scale still fails loudly here rather than
 * flattening every candidate to 1.0.
 */
function numericScore(n: number): number {
  if (!Number.isInteger(n)) {
    if (n >= 0 && n <= 1) return n;
    throw new Error(
      `decision rerank returned a non-integral score outside [0,1] (${n}); ` +
        `a bucket index must be a whole number in [0,${RELEVANCE_BUCKETS.length - 1}] ` +
        'and a probability must be in [0,1]',
    );
  }
  if (n >= 0 && n < RELEVANCE_BUCKETS.length) {
    return n / (RELEVANCE_BUCKETS.length - 1);
  }
  throw new Error(
    `decision rerank returned an out-of-range score (${n}); expected a bucket index ` +
      `in [0,${RELEVANCE_BUCKETS.length - 1}] or a probability in [0,1]`,
  );
}

/** Collect an option→probability map from the encodings vendors use. */
function optionDistribution(rec: Record<string, unknown>): Map<string, number> | null {
  for (const key of ['scores', 'probabilities', 'options', 'choices']) {
    const raw = rec[key];
    const asMap = asRecord(raw);
    if (asMap) {
      const out = new Map<string, number>();
      for (const [k, v] of Object.entries(asMap)) {
        if (typeof v === 'number') out.set(k, clamp01(v));
      }
      if (out.size > 0) return out;
    }
    if (Array.isArray(raw)) {
      const out = new Map<string, number>();
      for (const item of raw) {
        const r = asRecord(item);
        if (!r) continue;
        const opt = r.option ?? r.label ?? r.value ?? r.choice;
        const p = r.probability ?? r.score ?? r.confidence;
        if (typeof opt === 'string' && typeof p === 'number') out.set(opt, clamp01(p));
      }
      if (out.size > 0) return out;
    }
  }
  return null;
}

/** Expected bucket index normalised into [0, 1]. */
function expectedBucket(dist: Map<string, number>): number {
  let weight = 0;
  let acc = 0;
  for (const [option, prob] of dist) {
    const idx = bucketIndex(option);
    if (idx < 0) continue;
    weight += prob;
    acc += idx * prob;
  }
  if (weight <= 0) return 0.5;
  // Normalise by the mass on recognised options so a vendor adding an
  // "unknown" bucket with its own probability does not skew the result.
  return clamp01(acc / weight / (RELEVANCE_BUCKETS.length - 1));
}

function bucketIndex(label: string): number {
  const needle = label.trim().toLowerCase();
  return RELEVANCE_BUCKETS.findIndex((b) => b.toLowerCase().startsWith(needle.split(':')[0].trim()));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function interpret(payload: unknown, indexToId: Map<number, string>): RerankResult[] {
  const answers = findAnswers(payload);
  if (!answers) return [];

  const out: RerankResult[] = [];
  for (const [key, answer] of Object.entries(answers)) {
    const m = /^r(\d+)$/.exec(key);
    if (!m) continue;
    const id = indexToId.get(Number(m[1]));
    if (id === undefined) continue;
    const score = toScore(answer);
    if (score === null) continue;
    out.push({ id, score });
  }
  return out;
}

