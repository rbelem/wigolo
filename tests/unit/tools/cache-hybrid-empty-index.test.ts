import { describe, it, expect, vi, beforeEach } from 'vitest';

const getEmbedProvider = vi.fn();
const getVectorStore = vi.fn();

vi.mock('../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: () => getEmbedProvider(),
}));

vi.mock('../../../src/providers/vector-store.js', () => ({
  getVectorStore: () => getVectorStore(),
}));

vi.mock('../../../src/cache/store.js', () => ({
  searchCacheFiltered: vi.fn(() => []),
  getCacheStats: vi.fn(() => ({ total: 0, totalBytes: 0, newest: null })),
  clearCacheEntries: vi.fn(() => 0),
  ftsSearchRanked: vi.fn(() => []),
  getCachedContentByNormalizedUrl: vi.fn(() => null),
}));

vi.mock('../../../src/cache/change-detector.js', () => ({
  detectChange: vi.fn(),
}));

vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(),
}));

const { handleCache } = await import('../../../src/tools/cache.js');

describe('cache hybrid search: empty vector index', () => {
  beforeEach(() => {
    getEmbedProvider.mockReset();
    getVectorStore.mockReset();
  });

  it('does NOT load the embedding model when the vector index is empty', async () => {
    // The embed provider loads the native ONNX session (~290 MB resident).
    // An empty index cannot produce a hybrid result, so resolving the provider
    // first would pay that cost for nothing.
    getVectorStore.mockResolvedValue({ size: async () => 0 });
    getEmbedProvider.mockResolvedValue({ embed: vi.fn() });

    const out = await handleCache({ mode: 'hybrid', query: 'memory' } as never);

    expect(getEmbedProvider).not.toHaveBeenCalled();
    expect(out).toBeDefined();
  });

  it('loads the embedding model when the index is non-empty', async () => {
    getVectorStore.mockResolvedValue({ size: async () => 12 });
    getEmbedProvider.mockResolvedValue({ embed: vi.fn(async () => [new Float32Array([0.1])]) });

    await handleCache({ mode: 'hybrid', query: 'memory' } as never);

    expect(getEmbedProvider).toHaveBeenCalledTimes(1);
  });
});
