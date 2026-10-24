import { describe, expect, it, vi, beforeEach } from 'vitest';

const { existsSyncMock, readdirSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: existsSyncMock, readdirSync: readdirSyncMock };
});

import { probePythonPackages } from '../../../../src/cli/tui/status-python.js';
import { resetConfig } from '../../../../src/config.js';

beforeEach(() => {
  existsSyncMock.mockReset();
  readdirSyncMock.mockReset();
  // The probe classifies the configured mode, so pin it: a developer-exported
  // WIGOLO_RERANKER must not change what these cases assert.
  process.env.WIGOLO_RERANKER = 'onnx';
  resetConfig();
});

describe('probePythonPackages', () => {
  it('marks each package ok when every probe succeeds', () => {
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue(['model.onnx'] as unknown as ReturnType<typeof readdirSyncMock>);

    const result = probePythonPackages('/tmp/data');

    expect(result.reranker).toBe('ok');
    expect(result.embeddings).toBe('ok');
  });

  it('marks each package missing when its probe fails', () => {
    existsSyncMock.mockReturnValue(false);
    readdirSyncMock.mockReturnValue([] as unknown as ReturnType<typeof readdirSyncMock>);

    const result = probePythonPackages('/tmp/data');

    expect(result.reranker).toBe('missing');
    expect(result.embeddings).toBe('missing');
  });

  it('isolates per-package state — reranker cache present, embeddings cache absent', () => {
    existsSyncMock.mockImplementation((p) => String(p).endsWith('transformers'));
    readdirSyncMock.mockReturnValue(['model.onnx'] as unknown as ReturnType<typeof readdirSyncMock>);

    const result = probePythonPackages('/tmp/data');

    expect(result.reranker).toBe('ok');
    expect(result.embeddings).toBe('missing');
  });

  it('reports a hosted reranker as hosted, never missing, with no local model', () => {
    // Regression guard: the probe used to check `<dataDir>/transformers` for
    // every mode, so a working hosted setup printed "⊘ ML reranker not
    // installed".
    existsSyncMock.mockReturnValue(false);
    readdirSyncMock.mockReturnValue([] as unknown as ReturnType<typeof readdirSyncMock>);

    for (const mode of ['remote', 'workers-ai', 'decision', 'jev']) {
      process.env.WIGOLO_RERANKER = mode;
      resetConfig();
      expect(probePythonPackages('/tmp/data').reranker, mode).toBe('hosted');
    }
  });

  it('reports reranker: disabled when the mode is none', () => {
    existsSyncMock.mockReturnValue(false);
    process.env.WIGOLO_RERANKER = 'none';
    resetConfig();

    expect(probePythonPackages('/tmp/data').reranker).toBe('disabled');
  });
});
