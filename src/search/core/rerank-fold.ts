import type { RawSearchResult, EvidenceScore } from '../../types.js';
import { getConfig } from '../../config.js';
import { rerankerModeSpec } from '../rerank-mode.js';
import { getRerankProvider } from '../../providers/rerank-provider.js';
import { detectRareTerms, isRareTermMiss } from './rare-terms.js';
import { lexicalAlignment } from './lexical-alignment.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

export const RERANK_WINDOW = 20;
export const RERANK_RELEVANCE_THRESHOLD = 0;
// A cross-encoder logit at ~0 is the sigmoid midpoint (p≈0.5) — the model is
// UNCERTAIN, not confidently relevant. Tier-1 (the [0.5,1.0] confidently-
// relevant band) requires a logit meaningfully ABOVE zero by this margin, so a
// bare-zero/near-zero logit falls to tier-0 instead of being promoted. Without
// this, an all-near-zero (all-junk) batch — where the normaliser returns the
// neutral 0.5 — mapped every result to 0.5 + 0.5*0.5 = 0.75 (junk saturation).
export const RERANK_TIER_MARGIN = 0.5;
export const RERANK_BLEND_COMPOSITE = 0.5;
export const RERANK_BLEND_RERANK = 0.5;
// Blend-inflation calibration floor. A cross-encoder logit at/above 0 is the
// sigmoid midpoint or better — the model is at least uncertain-leaning-relevant.
// When the WHOLE batch's best logit is strictly below this floor, every member
// is confidently-irrelevant junk: the intra-tier min-max stretch would still
// award the least-bad junk a normalised rerank of 1.0 and spread the batch
// across the tier-0 band. In that all-junk case the stretch is meaningless, so
// the rerank normaliser collapses to a neutral 0.5. Tier assignment (from raw
// logits vs RERANK_RELEVANCE_THRESHOLD + RERANK_TIER_MARGIN) is unchanged.
export const RERANK_CALIBRATION_FLOOR = RERANK_RELEVANCE_THRESHOLD;
// The same all-junk idea expressed on a hosted reranker's scale. A Cohere- or
// Workers-AI-shaped host returns a relevance probability, so the logit floor
// above can never fire (every score is >= 0) and an all-junk batch kept getting
// min-max stretched — precisely the saturation RERANK_CALIBRATION_FLOOR exists
// to prevent. 0.5 is the sigmoid midpoint expressed as a probability: nothing
// in a batch whose BEST member is below it is more likely relevant than not.
// Re-derive if a host's scale turns out not to be centred there.
export const RERANK_PROBABILITY_FLOOR = 0.5;
// Ceiling on the time one fold may spend calling a hosted reranker. The fold
// issues one request per query variant, sequentially, and an unresponsive
// endpoint costs a full request timeout each; without a budget a four-variant
// query can stall for minutes before falling back to composite ordering. On
// expiry the batch keeps the scores already gathered and the remaining variants
// are dropped — the hedge degrades, the search does not hang.
export const RERANK_FOLD_BUDGET_MS = 8_000;

// Build the cross-encoder input for one result. Title + snippet ALONE let a
// short off-topic snippet game the reranker into a high logit (the junk-
// saturation bug); appending the host gives the model the domain as an extra
// relevance signal (a dictionary/glossary host reads differently from a docs
// host). Shared by the fold path and the legacy path so both encode identically.
export function rerankInputText(title: string, snippet: string | undefined, url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  const parts = [title ?? '', snippet ?? ''];
  if (host) parts.push(host);
  return parts.join('\n').trim();
}

/** Injectable: given a query + candidates, return id -> raw logit. */
export type RerankFn = (
  query: string,
  candidates: { id: string; text: string }[],
) => Promise<Map<string, number>>;

export interface FoldOptions {
  queries: string[];
  deep?: boolean;
  maxResults?: number;
  rerank?: RerankFn;
  /** Override the per-fold time budget (tests use a tiny one). */
  budgetMs?: number;
  /** Clock seam so the budget is testable without sleeping. */
  now?: () => number;
}

function defaultRerankFn(): RerankFn {
  return async (query, candidates) => {
    const provider = await getRerankProvider();
    const scored = await provider.rerank(query, candidates, candidates.length);
    const m = new Map<string, number>();
    for (const s of scored) m.set(s.id, s.score);
    return m;
  };
}

// min-max normaliser; degenerate (size<=1 or flat) -> neutral 0.5 so a flat
// batch falls back to composite ordering instead of dividing by zero.
function makeNormaliser(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (!Number.isFinite(range) || range === 0) return () => 0.5;
  return (v: number) => (v - min) / range;
}

export async function foldRerankIntoOrdering(
  results: RawSearchResult[],
  opts: FoldOptions,
): Promise<RawSearchResult[]> {
  if (results.length <= 1) return results;
  const queries = opts.queries.filter((q) => typeof q === 'string' && q.trim().length > 0);
  if (queries.length === 0) return results;

  const effectiveMax = opts.maxResults ?? results.length;
  const windowSize = opts.deep
    ? results.length
    : Math.min(results.length, Math.max(effectiveMax, RERANK_WINDOW));

  const windowResults = results.slice(0, windowSize);
  const tail = results.slice(windowSize);

  const candidates = windowResults.map((res, i) => ({
    id: String(i),
    text: rerankInputText(res.title, res.snippet, res.url),
  }));

  const rerankFn = opts.rerank ?? defaultRerankFn();

  // max logit per candidate across all queries -> preserves multi-query hedge.
  const logits = new Array<number>(windowResults.length).fill(-Infinity);
  const budgetMs = opts.budgetMs ?? RERANK_FOLD_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  try {
    for (let qi = 0; qi < queries.length; qi++) {
      // Check between variants, never before the first: one slow call should
      // not void the whole hedge, but the remaining ones must not stack up.
      if (qi > 0 && now() - startedAt > budgetMs) {
        log.debug('rerank-fold budget exhausted, keeping the variants already scored', {
          queries: queries.length,
          completed: qi,
          budgetMs,
        });
        break;
      }
      const scoreMap = await rerankFn(queries[qi], candidates);
      for (let i = 0; i < windowResults.length; i++) {
        const s = scoreMap.get(String(i));
        if (typeof s === 'number' && s > logits[i]) logits[i] = s;
      }
    }
  } catch (err) {
    // warn, not debug: a hosted reranker that cannot be constructed (a moved
    // mode, a missing base URL) degrades every search to unranked ordering, and
    // at debug nobody ever sees why relevance got worse.
    log.warn('rerank-fold failed, keeping composite ordering', { error: String(err) });
    return results;
  }
  // candidates the provider never scored -> treat as irrelevant (below the
  // tier threshold), not relevant. Only bites a misbehaving injected rerank
  // fn; the default provider scores every candidate (topK = candidates.length).
  for (let i = 0; i < logits.length; i++) {
    if (!Number.isFinite(logits[i])) logits[i] = RERANK_RELEVANCE_THRESHOLD - 1;
  }

  const normComposite = makeNormaliser(windowResults.map((res) => res.relevance_score));
  // Blend-inflation guard (gate b): if the batch's best score is strictly below
  // the floor for the adapter's score domain, every member is confident junk —
  // the min-max stretch is meaningless and would only inflate the least-bad
  // junk. Use a neutral 0.5 rerank blend for the whole batch instead. The floor
  // is per-domain: a hosted reranker reports a probability, so the logit floor
  // (< 0) could never fire on it and the guard was dead for every hosted mode.
  const junkFloor =
    rerankerModeSpec(getConfig().reranker)?.scoreDomain === 'probability'
      ? RERANK_PROBABILITY_FLOOR
      : RERANK_CALIBRATION_FLOOR;
  const maxLogit = Math.max(...logits);
  const normRerank =
    Number.isFinite(maxLogit) && maxLogit < junkFloor
      ? () => 0.5
      : makeNormaliser(logits);

  // Junk-floor guard: a result that shares NONE of the query's rare COMPOUND
  // terms cannot ride the cross-encoder ALONE into the confidently-relevant
  // tier-1 band. Reranker logits are miscalibrated per-query, so a short junk
  // snippet can game a high logit; without a shared high-IDF compound token
  // (hyphenated / snake_case / digit-suffixed — genuinely rare by shape) that
  // logit is not trustworthy evidence of relevance. Per-result (keyed on the
  // rare-term hit/miss predicate) and expressed on the relative TIER band, not
  // an absolute logit cut (reranker logits are miscalibrated per-query).
  //
  // COMPOUND-only on purpose: the concept-phrase branch fires for nearly every
  // multi-word query and a legitimate paraphrased result shares none of its
  // literal tokens — gating on it would suppress exactly the semantic-match
  // cases the cross-encoder exists to catch. Compound tokens are high-precision:
  // a result lacking the query's compound is almost certainly off-topic. A
  // no-op when no query variant carries a compound token, so ordinary queries
  // are untouched. Detected per-variant + unioned: a result matching ANY
  // variant's compound is a HIT and stays ungated.
  const rareCompoundPerQuery = queries.map((q) => {
    const rare = detectRareTerms(q);
    // Zero out the concept phrase so isRareTermMiss keys ONLY on compounds.
    return { compoundTokens: rare.compoundTokens, conceptPhrase: null };
  });
  const queryHasCompound = rareCompoundPerQuery.some((r) => r.compoundTokens.length > 0);

  // Lexical gate (gate a): force tier-0 for a result with ZERO lexical overlap
  // against every query variant AND single-engine consensus (seen by exactly
  // one engine). Zero overlap with a single-engine consensus is the live-
  // incident junk shape (a degraded pool's lone survivor returns an off-topic
  // page sharing NO query token). The consensus conjunct protects a healthy
  // multi-engine zero-lexical (synonym/paraphrase) result, which several
  // engines agreeing on is trustworthy. Inert on empty/stopword-only queries:
  // when NO variant carries a content token, lexicalAlignment is 0 for every
  // result by construction, so the gate would demote everything — we skip it.
  const queryHasContentToken = queries.some(
    (q) => lexicalAlignment(q, q, '') > 0,
  );

  const scored = windowResults.map((res, i) => {
    const logitTier = logits[i] > RERANK_RELEVANCE_THRESHOLD + RERANK_TIER_MARGIN ? 1 : 0;
    // Guarded to tier-0 only when the query carries a compound token AND this
    // result matches NONE of them across every query variant (a true miss).
    const rareMiss =
      queryHasCompound && rareCompoundPerQuery.every((r) => isRareTermMiss(res, r));
    // Zero lexical overlap against ALL query variants -> lexicalMiss. Max over
    // variants: a result aligned with ANY variant is not a miss.
    const maxLexical = queryHasContentToken
      ? Math.max(...queries.map((q) => lexicalAlignment(q, res.title, res.snippet)))
      : 1;
    // engine_consensus is only trustworthy when the evidence components carry
    // it; without it the gate fails open (cannot assert single-engine).
    const consensus = res.evidence_score?.components.engine_consensus;
    const singleEngine = consensus === 1;
    const lexicalMiss = queryHasContentToken && maxLexical === 0 && singleEngine;
    const tier = rareMiss || lexicalMiss ? 0 : logitTier;
    const nr = normRerank(logits[i]);
    const blend =
      RERANK_BLEND_COMPOSITE * normComposite(res.relevance_score) +
      RERANK_BLEND_RERANK * nr;
    return { res, tier, blend, nr };
  });

  scored.sort((a, b) => b.tier - a.tier || b.blend - a.blend);

  const reordered = scored.map((s) => {
    // tier-encoded so relevance_score is monotonic with row order: tier-1 maps
    // to [0.5,1], tier-0 to [0,0.5]. A caller re-sorting by score can't undo
    // the fold.
    const finalScore = s.tier === 1 ? 0.5 + 0.5 * s.blend : 0.5 * s.blend;
    const prev = s.res.evidence_score;
    const evidence_score: EvidenceScore | undefined = prev
      ? {
          ...prev,
          final: finalScore,
          components: { ...prev.components, cross_encoder: s.nr },
          explanation: `${prev.explanation}, xenc=${s.nr.toFixed(2)}`,
        }
      : prev;
    return {
      ...s.res,
      relevance_score: finalScore,
      ...(evidence_score ? { evidence_score } : {}),
    };
  });

  // tail keeps composite order + scores; it never ships because windowSize is
  // always >= the slice ship-count (effectiveMax). Kept for non-slicing callers.
  return [...reordered, ...tail];
}
