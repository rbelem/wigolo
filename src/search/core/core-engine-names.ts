// Authoritative reserved engine names for the core backend.
//
// WHY this module exists: every downstream consumer of a result's `engine` field
// keys off the engine NAME — `engineQualityTier()` (engine-quality.ts) picks an
// RRF weight by it, engine-health reports by it, and the orchestrator's
// per-engine bookkeeping (secondary demotion, engine warnings, `engines_used`)
// groups by it. A plugin search engine that claims a core name therefore does
// not crash: it silently produces results indistinguishable from core's. The
// plugin loader (src/plugins/loader.ts) must reject such a claim, and to do that
// it needs the reserved set at daemon-start time.
//
// WHY a plain string list and not `getXEngines()`: importing a vertical pool
// would construct every engine in it — HTTP clients, rate limiters and circuit
// breakers included — just to read `.name`, on the plugin-loading path. This
// module has no imports and no side effects, so reading it is free and cannot
// introduce a cycle (loader -> here).
//
// DRIFT: the list is grouped by the vertical pool that owns each engine, and
// every pool calls `assertPoolCoversCoreNames()` when it builds its entries. An
// engine wired into a pool without being declared here throws at pool
// construction instead of silently escaping the reserved set; a name declared
// here that no pool constructs is caught by
// tests/unit/plugins/core-engine-names.test.ts. Engines gated behind an API key
// (brave, deepseek, github-code, brave-image) or behind feed config (rss-feed)
// are declared too: their names stay reserved whether or not the gate is open,
// so a plugin cannot squat a name core starts using once the user adds a key.

export type CoreVertical = 'general' | 'code' | 'news' | 'papers' | 'images' | 'docs';

/**
 * Core engine names per owning vertical pool — exactly what the pools in
 * `src/search/core/verticals/*.ts` construct. Enforced by
 * `assertPoolCoversCoreNames()`.
 */
export const CORE_ENGINE_NAMES_BY_VERTICAL: Readonly<Record<CoreVertical, readonly string[]>> = {
  general: ['bing', 'duckduckgo', 'wikipedia', 'mojeek', 'marginalia', 'brave', 'deepseek'],
  code: ['github-code', 'stackoverflow', 'devdocs', 'duckduckgo', 'brave', 'deepseek', 'mdn', 'crates-io'],
  news: ['hn-algolia', 'lobsters', 'bing_news', 'duckduckgo', 'mojeek', 'rss-feed'],
  papers: ['arxiv', 'semantic-scholar', 'openalex', 'dblp', 'openreview'],
  images: ['ddg-image', 'brave-image'],
  docs: ['mdn', 'devdocs', 'bing', 'duckduckgo'],
};

/**
 * Engine names core owns at runtime without a vertical pool constructing them
 * unconditionally: `src/server.ts` inserts/removes the SearXNG client in the
 * core pool by matching `name === 'searxng'`, so a plugin claiming that name
 * would be spliced out (or hidden) by core's own health bookkeeping.
 */
export const RESERVED_PROVIDER_ENGINE_NAMES: readonly string[] = ['searxng'];

/** Flat reserved set consumed by the plugin loader. */
export const CORE_ENGINE_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(CORE_ENGINE_NAMES_BY_VERTICAL).flat(),
  ...RESERVED_PROVIDER_ENGINE_NAMES,
]);

/** True when `name` is owned by the core backend (pool engine or provider slot). */
export function isCoreEngineName(name: string): boolean {
  return CORE_ENGINE_NAMES.has(name);
}

/**
 * Guard called by each vertical pool at build time. Throws when a pool
 * constructs an engine whose name this module does not declare: the reserved set
 * would be incomplete, which is the bug this module exists to prevent. A
 * source-level inconsistency rather than a runtime condition — any test that
 * builds the pool trips it.
 */
export function assertPoolCoversCoreNames(
  vertical: CoreVertical,
  poolEngineNames: readonly string[],
): void {
  const declared = new Set(CORE_ENGINE_NAMES_BY_VERTICAL[vertical]);
  const undeclared = poolEngineNames.filter(name => !declared.has(name));
  if (undeclared.length > 0) {
    throw new Error(
      `core engine name drift: the ${vertical} vertical pool constructs ` +
        `${undeclared.join(', ')} which core-engine-names.ts does not declare. ` +
        `Add the name(s) to CORE_ENGINE_NAMES_BY_VERTICAL.${vertical}.`,
    );
  }
}
