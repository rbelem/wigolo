import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../../src/config.js';

const modelDispose = vi.fn();

vi.mock('@huggingface/transformers', () => {
  const makeLogits = (values: number[]) => ({
    data: new Float32Array(values),
    dims: [values.length, 1],
  });
  const tokenizerCall = vi.fn((text: string | string[], opts?: { text_pair?: string | string[] }) => {
    const queries = Array.isArray(text) ? text : [text];
    const docs = Array.isArray(opts?.text_pair) ? (opts.text_pair as string[]) : [''];
    return {
      __pairs: queries.map((q, i) => ({ q, d: docs[i] ?? '' })),
      input_ids: { dims: [queries.length, 16] },
    };
  });
  const modelCall = vi.fn(async (inputs: { __pairs: { q: string; d: string }[] }) => {
    const scores = inputs.__pairs.map((p) => p.d.length / 1000);
    return { logits: makeLogits(scores) };
  });
  (modelCall as unknown as { dispose: () => Promise<void> }).dispose = modelDispose;

  return {
    AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizerCall) },
    AutoModelForSequenceClassification: { from_pretrained: vi.fn(async () => modelCall) },
    env: { cacheDir: '', allowRemoteModels: true, allowLocalModels: true },
  };
});

const { TransformersRerankProvider } = await import(
  '../../../../src/search/reranker/transformers-rerank-provider.js'
);

const candidates = [
  { id: 'a', text: 'short' },
  { id: 'b', text: 'a much longer document body' },
];

describe('TransformersRerankProvider idle eviction', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    modelDispose.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('releases the ONNX session after the idle window', async () => {
    process.env.WIGOLO_RERANKER_IDLE_TIMEOUT_MS = '100';
    resetConfig();
    const provider = new TransformersRerankProvider();

    await provider.rerank('query', candidates);
    expect(modelDispose).not.toHaveBeenCalled();

    await new Promise<void>((r) => setTimeout(r, 400));
    expect(modelDispose).toHaveBeenCalled();
  }, 10000);

  it('keeps the session resident when the idle window is disabled', async () => {
    process.env.WIGOLO_RERANKER_IDLE_TIMEOUT_MS = '0';
    resetConfig();
    const provider = new TransformersRerankProvider();

    await provider.rerank('query', candidates);
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(modelDispose).not.toHaveBeenCalled();
  }, 10000);

  it('reloads and still ranks after an idle eviction', async () => {
    process.env.WIGOLO_RERANKER_IDLE_TIMEOUT_MS = '100';
    resetConfig();
    const provider = new TransformersRerankProvider();

    const first = await provider.rerank('query', candidates);
    await new Promise<void>((r) => setTimeout(r, 400));
    expect(modelDispose).toHaveBeenCalled();

    // The provider instance survives eviction: the next rerank reloads the
    // model and produces the same ordering.
    const second = await provider.rerank('query', candidates);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  }, 10000);
});
