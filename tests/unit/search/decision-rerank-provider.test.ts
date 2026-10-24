import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetConfig } from '../../../src/config.js';

const { DecisionRerankProvider } = await import(
  '../../../src/search/reranker/decision-rerank-provider.js'
);

let server: http.Server;
let baseUrl: string;
let captured: Array<{ body: Record<string, unknown>; auth: string | undefined }> = [];
let reply: unknown = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c.toString(); });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      captured.push({ body, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const candidates = [
  { id: 'alpha', text: 'first document' },
  { id: 'beta', text: 'second document' },
  { id: 'gamma', text: 'third document' },
];

describe('DecisionRerankProvider', () => {
  const originalEnv = process.env;

  const use = (env: Record<string, string> = {}) => {
    process.env = {
      ...originalEnv,
      WIGOLO_RERANKER: 'decision',
      WIGOLO_RERANKER_API_KEY: 'dm-key',
      WIGOLO_RERANKER_BASE_URL: baseUrl,
      WIGOLO_RERANKER_MODEL: 'jev-1.13',
      ...env,
    };
    resetConfig();
  };

  beforeEach(() => {
    captured = [];
    reply = null;
    // Default config for every test; individual tests override via use({...}).
    use();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('asks all candidate scores as parallel questions in ONE call', async () => {
    reply = { answers: { r0: { label: 'Relevant', probability: 0.9 } } };
    await new DecisionRerankProvider().rerank('q', candidates);

    expect(captured).toHaveLength(1);
    expect(captured[0].auth).toBe('Bearer dm-key');
    expect(captured[0].body.model).toBe('jev-1.13');

    const qs = captured[0].body.questions as Record<string, { type: string; criteria: string[] }>;
    expect(Object.keys(qs)).toEqual(['r0', 'r1', 'r2']);
    expect(qs.r0.type).toBe('score');
    expect(qs.r0.criteria).toHaveLength(4);

    // One `state` string carries the query and every candidate.
    expect(String(captured[0].body.state)).toContain('Query: q');
    expect(String(captured[0].body.state)).toContain('[2] third document');
  });

  it('maps an ordinal bucket + probability onto a monotone score', async () => {
    reply = {
      answers: {
        r0: { label: 'Irrelevant', probability: 0.9 },
        r1: { label: 'Marginal', probability: 0.9 },
        r2: { label: 'Highly relevant', probability: 0.9 },
      },
    };
    const out = await new DecisionRerankProvider().rerank('q', candidates);

    expect(out.map((r) => r.id)).toEqual(['gamma', 'beta', 'alpha']);
    expect(out[0].score).toBeGreaterThan(out[1].score);
    expect(out[1].score).toBeGreaterThan(out[2].score);
    for (const r of out) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('scores a probability-per-option MAP as an expected bucket', async () => {
    // The shape the docs describe: a probability for EVERY allowed option.
    reply = {
      answers: {
        r0: {
          scores: {
            Irrelevant: 0.7, Marginal: 0.2, Relevant: 0.08, 'Highly relevant': 0.02,
          },
        },
        r1: {
          scores: {
            Irrelevant: 0.02, Marginal: 0.08, Relevant: 0.2, 'Highly relevant': 0.7,
          },
        },
      },
    };
    const out = await new DecisionRerankProvider().rerank('q', [
      { id: 'low', text: 'x' },
      { id: 'high', text: 'y' },
    ]);
    expect(out.map((r) => r.id)).toEqual(['high', 'low']);
    expect(out[0].score).toBeGreaterThan(0.6);
    expect(out[1].score).toBeLessThan(0.4);
  });

  it('scores a probability-per-option LIST the same way', async () => {
    reply = {
      answers: {
        r0: {
          options: [
            { option: 'Irrelevant', probability: 0.05 },
            { option: 'Highly relevant', probability: 0.95 },
          ],
        },
      },
    };
    const out = await new DecisionRerankProvider().rerank('q', [{ id: 'a', text: 'x' }]);
    expect(out[0].score).toBeGreaterThan(0.9);
  });

  it('accepts a bare numeric score', async () => {
    reply = { answers: { r0: { score: 0.8 }, r1: { score: 0.2 } } };
    const out = await new DecisionRerankProvider().rerank('q', [
      { id: 'a', text: 'x' },
      { id: 'b', text: 'y' },
    ]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('finds answers nested under a results envelope', async () => {
    reply = { results: { r0: { value: 'Highly relevant', probability: 0.5 } } };
    const out = await new DecisionRerankProvider().rerank('q', candidates);
    expect(out[0].id).toBe('alpha');
  });

  it('throws with observed keys rather than silently scoring zero', async () => {
    reply = { unexpected: 'shape' };
    await expect(new DecisionRerankProvider().rerank('q', candidates)).rejects.toThrow(
      /returned no usable scores/,
    );
  });

  it('requires a base URL', async () => {
    process.env = { ...originalEnv, WIGOLO_RERANKER: 'decision' };
    resetConfig();
    await expect(new DecisionRerankProvider().rerank('q', candidates)).rejects.toThrow(
      /WIGOLO_RERANKER=decision needs WIGOLO_RERANKER_BASE_URL/,
    );
  });

  it('refuses to send a key over plain http to a non-loopback host', async () => {
    use({ WIGOLO_RERANKER_BASE_URL: 'http://decision.example/v1', WIGOLO_RERANKER_API_KEY: 'k' });
    await expect(new DecisionRerankProvider().rerank('q', candidates)).rejects.toThrow(
      /requires HTTPS unless the endpoint is on loopback/,
    );
  });

  it('rejects a base URL carrying credentials or a query', async () => {
    use({ WIGOLO_RERANKER_BASE_URL: 'https://decision.example/v1?token=abc' });
    await expect(new DecisionRerankProvider().rerank('q', candidates)).rejects.toThrow(
      /without credentials, query, or fragment/,
    );
  });

  it('allows an unauthenticated self-host (no API key)', async () => {
    // Self-hosted Kev / Ollaya commonly run without auth; the key is optional
    // or those deployments cannot be used at all.
    reply = { answers: { r0: { score: 0.7 } } };
    process.env = {
      ...originalEnv,
      WIGOLO_RERANKER: 'decision',
      WIGOLO_RERANKER_BASE_URL: baseUrl,
      WIGOLO_RERANKER_MODEL: 'kev-local',
    };
    resetConfig();

    const out = await new DecisionRerankProvider().rerank('q', [{ id: 'a', text: 'x' }]);
    expect(out[0].id).toBe('a');
    expect(captured[0].auth).toBeUndefined();
  });

  it('returns nothing for no candidates without calling the network', async () => {
    expect(await new DecisionRerankProvider().rerank('q', [])).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it('splits a large batch into bounded calls and merges the ranking', async () => {
    // 60 candidates at MAX_CANDIDATES_PER_CALL=25 -> 25 + 25 + 10.
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, text: `doc ${i}` }));
    // Score by position within the chunk so the merge is predictable.
    reply = undefined;
    captured = [];
    const out = await (async () => {
      // Every answer scores mid-bucket; the point is call count + coverage.
      reply = {
        answers: Object.fromEntries(
          Array.from({ length: 25 }, (_, i) => [`r${i}`, { score: 0.5 }]),
        ),
      };
      return new DecisionRerankProvider().rerank('q', many);
    })();

    expect(captured.length).toBeGreaterThan(1);
    // No state string exceeds the budget by more than a single document.
    for (const c of captured) {
      const qs = Object.keys(c.body.questions as Record<string, unknown>).length;
      expect(qs).toBeLessThanOrEqual(25);
    }
    expect(out.length).toBe(60);
  });
});
