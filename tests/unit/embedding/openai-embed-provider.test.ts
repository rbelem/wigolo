import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetConfig } from '../../../src/config.js';

const { OpenAICompatibleEmbedProvider } = await import(
  '../../../src/embedding/openai-embed-provider.js'
);

interface Captured {
  body: Record<string, unknown>;
  auth: string | undefined;
}

let server: http.Server;
let baseUrl: string;
let captured: Captured[] = [];
/** 384 = matches the index; 8 = a deliberate mismatch to force adaptation. */
let nativeDim = 384;
/** When true the fake honours `dimensions`, emulating OpenRouter/OpenAI. */
let honoursDimensions = true;
/** When true respond in Cloudflare's native `{result:{data}}` shape. */
let cloudflareShape = false;

const vector = (n: number, seed = 0.1) => Array.from({ length: n }, () => seed);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c.toString(); });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      captured.push({ body, auth: req.headers.authorization });

      const inputs = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input)];
      const requested = typeof body.dimensions === 'number' ? (body.dimensions as number) : undefined;
      const width = requested !== undefined && honoursDimensions ? requested : nativeDim;
      const vectors = inputs.map((_, i) => vector(width, i / 10));

      if (cloudflareShape) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { data: vectors }, success: true }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: vectors.map((embedding, index) => ({ index, embedding })),
        model: body.model,
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('OpenAICompatibleEmbedProvider', () => {
  const originalEnv = process.env;

  const use = (env: Record<string, string>) => {
    process.env = { ...originalEnv, ...env };
    resetConfig();
  };

  beforeEach(() => {
    captured = [];
    nativeDim = 384;
    honoursDimensions = true;
    cloudflareShape = false;
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('embeds a batch and returns Float32Arrays', async () => {
    use({
      WIGOLO_EMBEDDING_PROVIDER: 'openai-compatible',
      WIGOLO_EMBEDDING_BASE_URL: baseUrl,
      WIGOLO_EMBEDDING_API_KEY: 'test-key',
      WIGOLO_EMBEDDING_MODEL: '@cf/baai/bge-small-en-v1.5',
    });
    const p = new OpenAICompatibleEmbedProvider();
    const out = await p.embed(['one', 'two']);

    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0]).toHaveLength(384);
    expect(captured[0].auth).toBe('Bearer test-key');
    expect(captured[0].body.model).toBe('@cf/baai/bge-small-en-v1.5');
    // Native width already matches the index: no `dimensions` needed.
    expect(captured[0].body.dimensions).toBeUndefined();
    expect(captured).toHaveLength(1);
  });

  it('honours the Cloudflare native response shape', async () => {
    cloudflareShape = true;
    use({
      WIGOLO_EMBEDDING_PROVIDER: 'openai-compatible',
      WIGOLO_EMBEDDING_BASE_URL: baseUrl,
      WIGOLO_EMBEDDING_MODEL: '@cf/baai/bge-small-en-v1.5',
    });
    const out = await new OpenAICompatibleEmbedProvider().embed(['x']);
    expect(out[0]).toHaveLength(384);
  });

  it('adapts a wider model to the index width via `dimensions`', async () => {
    // Emulates openai/text-embedding-3-small: natively 1536, truncatable.
    nativeDim = 1536;
    use({
      WIGOLO_EMBEDDING_PROVIDER: 'openai-compatible',
      WIGOLO_EMBEDDING_BASE_URL: baseUrl,
      WIGOLO_EMBEDDING_MODEL: 'openai/text-embedding-3-small',
      WIGOLO_EMBEDDING_DIM: '384',
    });
    const out = await new OpenAICompatibleEmbedProvider().embed(['x']);

    expect(out[0]).toHaveLength(384);
    // Two requests: probe, then adapt.
    expect(captured).toHaveLength(2);
    expect(captured[0].body.dimensions).toBeUndefined();
    expect(captured[1].body.dimensions).toBe(384);
  });

  it('fails loudly when the model cannot be truncated to the index width', async () => {
    nativeDim = 1536;
    honoursDimensions = false;
    use({
      WIGOLO_EMBEDDING_PROVIDER: 'openai-compatible',
      WIGOLO_EMBEDDING_BASE_URL: baseUrl,
      WIGOLO_EMBEDDING_MODEL: 'some/fixed-1536-model',
      WIGOLO_EMBEDDING_DIM: '384',
    });

    await expect(new OpenAICompatibleEmbedProvider().embed(['x'])).rejects.toThrow(
      /1536-dim vectors but the vector index is fixed at 384/,
    );
  });

  it('fails with an actionable error when the base URL is missing', async () => {
    use({
      WIGOLO_EMBEDDING_PROVIDER: 'openai-compatible',
      WIGOLO_EMBEDDING_MODEL: 'x',
    });
    await expect(new OpenAICompatibleEmbedProvider().embed(['x'])).rejects.toThrow(
      /requires WIGOLO_EMBEDDING_BASE_URL/,
    );
  });

  it('returns no vectors for an empty batch without calling the network', async () => {
    use({
      WIGOLO_EMBEDDING_PROVIDER: 'openai-compatible',
      WIGOLO_EMBEDDING_BASE_URL: baseUrl,
      WIGOLO_EMBEDDING_MODEL: 'x',
    });
    expect(await new OpenAICompatibleEmbedProvider().embed([])).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it('serves the OpenRouter URL shape (baseUrl + /embeddings)', async () => {
    use({
      WIGOLO_EMBEDDING_PROVIDER: 'openai-compatible',
      WIGOLO_EMBEDDING_BASE_URL: `${baseUrl}/`,
      WIGOLO_EMBEDDING_MODEL: 'openai/text-embedding-3-small',
      WIGOLO_EMBEDDING_DIM: '384',
    });
    // Trailing slash is trimmed, so the request still lands on /embeddings.
    const out = await new OpenAICompatibleEmbedProvider().embed(['x']);
    expect(out[0]).toHaveLength(384);
  });
});
