import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    dataDir: '/tmp/wigolo-test',
    embeddingModel: 'BAAI/bge-small-en-v1.5',
    browserChannel: 'chromium',
  }),
}));

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  getBootstrapState: vi.fn().mockReturnValue({ status: 'ready' }),
  checkPythonAvailable: vi.fn().mockReturnValue(true),
  bootstrapNativeSearxng: vi.fn(),
}));

vi.mock('../../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerank: vi.fn().mockResolvedValue([{ id: '0', score: 0.5 }]),
  })),
}));

const warmupMock = vi.fn().mockResolvedValue(undefined);
const embedMock = vi.fn().mockResolvedValue([new Float32Array(384).fill(0.1)]);
vi.mock('../../../src/embedding/fastembed-provider.js', () => {
  const FastembedEmbedProvider = vi.fn(function (this: Record<string, unknown>) {
    this.modelId = 'BGE-small-en-v1.5';
    this.dim = 384;
    this.warmup = warmupMock;
    this.embed = embedMock;
  });
  return { FastembedEmbedProvider };
});

import { runCommand } from '../../../src/cli/tui/run-command.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };

describe('warmup --embeddings flag (fastembed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    warmupMock.mockResolvedValue(undefined);
    embedMock.mockResolvedValue([new Float32Array(384).fill(0.1)]);
  });

  it('downloads the fastembed model when --embeddings is passed', async () => {
    const { runWarmup } = await import('../../../src/cli/warmup.js');
    const result = await runWarmup(['--embeddings']);

    expect(warmupMock).toHaveBeenCalled();
    expect(embedMock).toHaveBeenCalled();
    expect(result.embeddings).toBe('ok');
  });

  it('downloads the fastembed model with --all', async () => {
    const { runWarmup } = await import('../../../src/cli/warmup.js');
    await runWarmup(['--all']);

    expect(warmupMock).toHaveBeenCalled();
  });

  it('does not download embeddings model without --embeddings flag', async () => {
    const { runWarmup } = await import('../../../src/cli/warmup.js');
    await runWarmup([]);

    expect(warmupMock).not.toHaveBeenCalled();
  });

  it('reports embeddings status in WarmupResult', async () => {
    const { runWarmup } = await import('../../../src/cli/warmup.js');
    const result = await runWarmup(['--embeddings']);

    expect(result.embeddings).toBeDefined();
    expect(['ok', 'failed']).toContain(result.embeddings);
  });

  it('reports failure when fastembed warmup throws', async () => {
    warmupMock.mockRejectedValueOnce(new Error('ONNX download failed'));

    const { runWarmup } = await import('../../../src/cli/warmup.js');
    const result = await runWarmup(['--embeddings']);

    expect(result.embeddings).toBe('failed');
    expect(result.embeddingsError).toContain('ONNX download failed');
  });

  it('does not install sentence-transformers (Python package) anymore', async () => {
    const { runWarmup } = await import('../../../src/cli/warmup.js');
    await runWarmup(['--all']);

    const installedSentenceTransformers = vi.mocked(runCommand).mock.calls.some((c) =>
      (c[1] as string[]).some((a) => String(a).includes('sentence-transformers')),
    );
    expect(installedSentenceTransformers).toBe(false);
  });
});
