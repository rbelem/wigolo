import { describe, it, expect } from 'vitest';
import { searchCategory } from '../../../../../src/cli/tui/schema/search.js';

describe('searchCategory', () => {
  it('has id search and the expected fields', () => {
    expect(searchCategory.id).toBe('search');
    expect(searchCategory.fields.length).toBe(6);
    const keys = searchCategory.fields.map((f) => f.key);
    expect(keys).toEqual([
      'WIGOLO_SEARCH',
      'WIGOLO_RERANKER',
      'WIGOLO_RERANKER_MODEL',
      'WIGOLO_RERANK_API_BASE',
      'WIGOLO_RERANKER_BASE_URL',
      'WIGOLO_EMBEDDING_MODEL',
    ]);
  });

  it('WIGOLO_SEARCH offers core/searxng/hybrid with core default', () => {
    const f = searchCategory.fields.find((x) => x.key === 'WIGOLO_SEARCH');
    expect(f?.kind).toBe('select');
    expect(f?.default).toBe('core');
    expect(f?.options?.map((o) => o.value)).toEqual(['core', 'searxng', 'hybrid']);
  });

  it('WIGOLO_RERANKER offers every scoring mode (jev folds into decision)', () => {
    const f = searchCategory.fields.find((x) => x.key === 'WIGOLO_RERANKER');
    expect(f?.kind).toBe('select');
    expect(f?.default).toBe('onnx');
    expect(f?.options?.map((o) => o.value)).toEqual([
      'onnx',
      'remote',
      'workers-ai',
      'decision',
      'none',
    ]);
    // WHY: `jev` is a legacy alias of `decision` — same endpoint, same table
    // label — so offering it would render a duplicate row. Env keeps accepting
    // it; the TUI offers the canonical name only.
    expect(f?.options?.map((o) => o.value)).not.toContain('jev');
  });

  it('WIGOLO_RERANKER_MODEL defaults to bge-reranker-v2-m3', () => {
    const f = searchCategory.fields.find((x) => x.key === 'WIGOLO_RERANKER_MODEL');
    expect(f?.kind).toBe('text');
    expect(f?.default).toBe('bge-reranker-v2-m3');
  });

  it('WIGOLO_EMBEDDING_MODEL defaults to all-MiniLM-L6-v2', () => {
    const f = searchCategory.fields.find((x) => x.key === 'WIGOLO_EMBEDDING_MODEL');
    expect(f?.kind).toBe('text');
    expect(f?.default).toBe('all-MiniLM-L6-v2');
  });

  it('WIGOLO_RERANK_API_BASE shows only for the remote mode (rule unchanged)', () => {
    const f = searchCategory.fields.find((x) => x.key === 'WIGOLO_RERANK_API_BASE');
    expect(typeof f?.visible).toBe('function');
    expect(f?.visible?.({ current: {}, pending: { reranker: 'remote' } })).toBe(true);
    expect(f?.visible?.({ current: { reranker: 'remote' }, pending: {} })).toBe(true);
    for (const mode of ['onnx', 'none', 'workers-ai', 'decision', 'jev']) {
      expect(f?.visible?.({ current: {}, pending: { reranker: mode } }), `mode ${mode}`).toBe(false);
    }
  });

  it('WIGOLO_RERANKER_BASE_URL shows for the hosted modes that read it', () => {
    // WHY: workers-ai / decision / jev all consume WIGOLO_RERANKER_BASE_URL
    // (remote reads WIGOLO_RERANK_API_BASE instead), so the field must appear
    // exactly when the selected mode needs it — including `jev`, which is only
    // reachable via persisted/env values, never via the select.
    const f = searchCategory.fields.find((x) => x.key === 'WIGOLO_RERANKER_BASE_URL');
    expect(f?.kind).toBe('text');
    expect(f?.settingsPath).toBe('rerankerBaseUrl');
    expect(typeof f?.visible).toBe('function');
    for (const mode of ['workers-ai', 'decision', 'jev']) {
      expect(f?.visible?.({ current: {}, pending: { reranker: mode } }), `pending ${mode}`).toBe(true);
      expect(f?.visible?.({ current: { reranker: mode }, pending: {} }), `current ${mode}`).toBe(true);
    }
    for (const mode of ['onnx', 'none', 'remote']) {
      expect(f?.visible?.({ current: {}, pending: { reranker: mode } }), `pending ${mode}`).toBe(false);
      expect(f?.visible?.({ current: { reranker: mode }, pending: {} }), `current ${mode}`).toBe(false);
    }
  });

  it('every field has settingsPath + label', () => {
    for (const f of searchCategory.fields) {
      expect(f.settingsPath, `field ${f.key} missing settingsPath`).toBeTruthy();
      expect(f.label, `field ${f.key} missing label`).toBeTruthy();
    }
  });
});
