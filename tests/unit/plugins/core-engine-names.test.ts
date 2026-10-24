import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import {
  CORE_ENGINE_NAMES,
  CORE_ENGINE_NAMES_BY_VERTICAL,
  assertPoolCoversCoreNames,
  isCoreEngineName,
  type CoreVertical,
} from '../../../src/search/core/core-engine-names.js';
import { getGeneralEngines, _resetGeneralEnginesForTest } from '../../../src/search/core/verticals/general.js';
import { getCodeEngines, _resetCodeEnginesForTest } from '../../../src/search/core/verticals/code.js';
import { getNewsEngines, _resetNewsEnginesForTest } from '../../../src/search/core/verticals/news.js';
import { getPapersEngines, _resetPapersEnginesForTest } from '../../../src/search/core/verticals/papers.js';
import { getImageEngines, _resetImageEnginesForTest } from '../../../src/search/core/verticals/images.js';
import { getDocsEngines, _resetDocsEnginesForTest } from '../../../src/search/core/verticals/docs.js';
import type { EngineEntry } from '../../../src/search/core/engine-base.js';

// The plugin loader refuses reserved engine names by consulting a
// side-effect-free list instead of the vertical pools. These tests are the tie
// between the two: they build the real pools and compare them to the list, so
// the list cannot fall behind a newly wired engine (and a stale name cannot
// linger as reserved-without-an-engine).

const POOLS: Record<CoreVertical, () => EngineEntry[]> = {
  general: getGeneralEngines,
  code: getCodeEngines,
  news: getNewsEngines,
  papers: getPapersEngines,
  images: getImageEngines,
  docs: getDocsEngines,
};

const RESETS: ReadonlyArray<() => void> = [
  _resetGeneralEnginesForTest,
  _resetCodeEnginesForTest,
  _resetNewsEnginesForTest,
  _resetPapersEnginesForTest,
  _resetImageEnginesForTest,
  _resetDocsEnginesForTest,
];

/** Names a pool actually constructs. */
function constructedNames(vertical: CoreVertical): string[] {
  return POOLS[vertical]().map(entry => entry.engine.name).sort();
}

/** Declared names minus `rss-feed`, which only joins when a feed is configured. */
function declaredNames(vertical: CoreVertical): string[] {
  return CORE_ENGINE_NAMES_BY_VERTICAL[vertical]
    .filter(name => !(vertical === 'news' && name === 'rss-feed'))
    .sort();
}

describe('core engine reserved names', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Open every key gate so the pools build the engines that are normally
    // conditional — their names must be reserved for key-less users too.
    process.env.BRAVE_API_KEY = 'test-brave-key';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
    process.env.WIGOLO_GITHUB_TOKEN = 'test-github-token';
    resetConfig();
    for (const reset of RESETS) reset();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    for (const reset of RESETS) reset();
  });

  it('declares exactly the engines each vertical pool constructs', () => {
    for (const vertical of Object.keys(POOLS) as CoreVertical[]) {
      expect(constructedNames(vertical)).toEqual(declaredNames(vertical));
    }
  });

  it('still reserves the feed-gated rss-feed engine', () => {
    expect(isCoreEngineName('rss-feed')).toBe(true);
  });

  it('exposes one flat set covering pool engines and the searxng provider slot', () => {
    expect(isCoreEngineName('bing')).toBe(true);
    expect(isCoreEngineName('searxng')).toBe(true);
    expect(isCoreEngineName('some-plugin-engine')).toBe(false);
    // The flat set is exactly the per-vertical declarations plus provider slots.
    expect([...CORE_ENGINE_NAMES].sort()).toEqual(
      [...new Set([...Object.values(CORE_ENGINE_NAMES_BY_VERTICAL).flat(), 'searxng'])].sort(),
    );
  });

  it('throws when a pool would construct an undeclared engine name', () => {
    expect(() => assertPoolCoversCoreNames('general', ['bing', 'not-a-core-engine'])).toThrow(
      /core engine name drift.*general.*not-a-core-engine/,
    );
    expect(() => assertPoolCoversCoreNames('general', ['bing', 'wikipedia'])).not.toThrow();
  });
});
