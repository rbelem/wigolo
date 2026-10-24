import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetConfig } from '../../../src/config.js';

const { WorkersAiRerankProvider } = await import(
  '../../../src/search/reranker/workers-ai-rerank-provider.js'
);

let server: http.Server;
let baseUrl: string;
let captured: Array<Record<string, unknown>> = [];
/** Swap the response shape to prove the listener fails loudly, not silently. */
let shape: 'ok' | 'unusable' | 'unknown' = 'ok';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c.toString(); });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      captured.push(body);
      const n = Array.isArray(body.contexts) ? body.contexts.length : 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (shape === 'unknown') {
        res.end(JSON.stringify({ totally: 'different' }));
        return;
      }
      if (shape === 'unusable') {
        // Rows exist but carry no score field — the silent-zero trap.
        res.end(JSON.stringify({ response: Array.from({ length: n }, (_, i) => ({ id: i })) }));
        return;
      }
      // Higher index = higher score, so ordering is predictable: last wins.
      res.end(JSON.stringify({
        response: Array.from({ length: n }, (_, i) => ({ id: i, score: i / 10 })),
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const candidates = [
  { id: 'a', text: 'first document' },
  { id: 'b', text: 'second document' },
  { id: 'c', text: 'third document' },
];

describe('WorkersAiRerankProvider', () => {
  const originalEnv = process.env;

  const use = (env: Record<string, string>) => {
    process.env = { ...originalEnv, WIGOLO_RERANKER: 'workers-ai', ...env };
    resetConfig();
  };

  beforeEach(() => {
    captured = [];
    shape = 'ok';
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('sends the Workers AI request shape and maps scores back to candidate ids', async () => {
    use({ WIGOLO_RERANKER_BASE_URL: baseUrl, WIGOLO_RERANKER_API_KEY: 'rk' });
    const out = await new WorkersAiRerankProvider().rerank('q', candidates);

    expect(captured[0].query).toBe('q');
    expect(captured[0].top_k).toBe(3);
    expect(captured[0].contexts).toEqual([
      { text: 'first document' },
      { text: 'second document' },
      { text: 'third document' },
    ]);

    // Descending by score, ids preserved from the candidate list.
    expect(out.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(out[0].score).toBeGreaterThan(out[2].score);
  });

  it('respects topK', async () => {
    use({ WIGOLO_RERANKER_BASE_URL: baseUrl });
    const out = await new WorkersAiRerankProvider().rerank('q', candidates, 2);
    expect(out).toHaveLength(2);
  });

  it('throws instead of silently scoring zero when rows carry no score', async () => {
    shape = 'unusable';
    use({ WIGOLO_RERANKER_BASE_URL: baseUrl });
    await expect(new WorkersAiRerankProvider().rerank('q', candidates)).rejects.toThrow(
      /no usable \{id, score\} rows/,
    );
  });

  it('throws with the observed keys on an unknown shape', async () => {
    shape = 'unknown';
    use({ WIGOLO_RERANKER_BASE_URL: baseUrl });
    await expect(new WorkersAiRerankProvider().rerank('q', candidates)).rejects.toThrow(
      /unrecognised rerank response shape \(keys: totally\)/,
    );
  });

  it('requires a base URL', async () => {
    use({});
    await expect(new WorkersAiRerankProvider().rerank('q', candidates)).rejects.toThrow(
      /WIGOLO_RERANKER=workers-ai requires WIGOLO_RERANKER_BASE_URL/,
    );
  });

  it('refuses to send a key over plain http to a non-loopback host', async () => {
    use({ WIGOLO_RERANKER_BASE_URL: 'http://rerank.example/v1', WIGOLO_RERANKER_API_KEY: 'rk' });
    await expect(new WorkersAiRerankProvider().rerank('q', candidates)).rejects.toThrow(
      /requires HTTPS unless the endpoint is on loopback/,
    );
    expect(captured).toHaveLength(0);
  });

  it('rejects a base URL carrying credentials or a query', async () => {
    use({ WIGOLO_RERANKER_BASE_URL: 'https://token@rerank.example/v1' });
    await expect(new WorkersAiRerankProvider().rerank('q', candidates)).rejects.toThrow(
      /without credentials, query, or fragment/,
    );
  });

  it('returns an empty list for no candidates without calling the network', async () => {
    use({ WIGOLO_RERANKER_BASE_URL: baseUrl });
    expect(await new WorkersAiRerankProvider().rerank('q', [])).toEqual([]);
    expect(captured).toHaveLength(0);
  });
});
