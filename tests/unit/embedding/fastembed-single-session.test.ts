import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

const init = vi.fn();
const release = vi.fn();

vi.mock('fastembed', () => {
  class FlagEmbedding {
    session = { release };
    static async init() {
      init();
      return new FlagEmbedding();
    }
    async *embed() {
      yield [new Float32Array([0.1, 0.2, 0.3])];
    }
  }
  return {
    FlagEmbedding,
    EmbeddingModel: { BGESmallENV15: 'BGE-small-en-v1.5' },
  };
});

const { FastembedEmbedProvider, releaseEmbedModel, isEmbedModelResident } = await import(
  '../../../src/embedding/fastembed-provider.js'
);

describe('FastembedEmbedProvider single-session invariant', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    init.mockClear();
    release.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    releaseEmbedModel();
  });

  it('creates ONE native session for two independent provider instances', async () => {
    // The two providers are the EmbeddingService instance and the
    // getEmbedProvider() factory. Before the fix each created its own
    // FlagEmbedding, so a process touching both held two copies of the
    // model (~290 MB of native memory each).
    const a = new FastembedEmbedProvider();
    const b = new FastembedEmbedProvider();

    await a.embed(['one']);
    await b.embed(['two']);

    expect(init).toHaveBeenCalledTimes(1);
  });

  it('reports residency and releases the native session', async () => {
    expect(isEmbedModelResident()).toBe(false);
    const provider = new FastembedEmbedProvider();
    await provider.embed(['one']);
    expect(isEmbedModelResident()).toBe(true);

    releaseEmbedModel();
    expect(isEmbedModelResident()).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('release is idempotent', async () => {
    const provider = new FastembedEmbedProvider();
    await provider.embed(['one']);
    releaseEmbedModel();
    releaseEmbedModel();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('reloads the model after a release', async () => {
    const provider = new FastembedEmbedProvider();
    await provider.embed(['one']);
    releaseEmbedModel();
    expect(init).toHaveBeenCalledTimes(1);

    await provider.embed(['two']);
    expect(init).toHaveBeenCalledTimes(2);
    expect(isEmbedModelResident()).toBe(true);
  });
});
