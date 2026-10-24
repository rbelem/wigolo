import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../../../src/config.js';
import { RemoteRerankProvider } from '../../../src/search/reranker/remote-rerank-provider.js';

const candidates = [
  { id: 'first', text: 'document one' },
  { id: 'second', text: 'document two' },
];
const config = (over: Partial<Config> = {}) => ({
  rerankApiBase: 'http://127.0.0.1:8082/v1///',
  rerankApiKey: null,
  rerankerModel: 'test-model',
  rerankerRequestTimeoutMs: 1234,
  ...over,
}) as Config;
const reply = (results: unknown) => new Response(JSON.stringify({ results }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('RemoteRerankProvider', () => {
  it('sends the ordered documents and maps sorted indexes back to IDs', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue(reply([
      { index: 0, score: 0.2 },
      { index: 1, relevance_score: 0.9 },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new RemoteRerankProvider(config()).rerank('query', candidates);
    expect(result).toEqual([{ id: 'second', score: 0.9 }, { id: 'first', score: 0.2 }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8082/v1/rerank');
    expect(options.method).toBe('POST');
    expect(options.redirect).toBe('error');
    expect(options.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({
      model: 'test-model', query: 'query', documents: ['document one', 'document two'], top_n: 2,
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(1234);
    timeout.mockRestore();
  });

  it('sends top_n and optional Bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply([{ index: 1, relevance_score: 0.8 }]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new RemoteRerankProvider(config({ rerankApiBase: 'https://rerank.example/v1', rerankApiKey: 'secret' })).rerank('q', candidates, 1))
      .toEqual([{ id: 'second', score: 0.8 }]);
    const options = fetchMock.mock.calls[0][1];
    expect(options.headers.authorization).toBe('Bearer secret');
    expect(JSON.parse(options.body).top_n).toBe(1);
  });

  it('returns immediately for empty candidates', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await new RemoteRerankProvider(config()).rerank('q', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a valid configured base URL', () => {
    expect(() => new RemoteRerankProvider(config({ rerankApiBase: null }))).toThrow('WIGOLO_RERANK_API_BASE');
    expect(() => new RemoteRerankProvider(config({ rerankApiBase: 'file:///tmp/x' }))).toThrow('http(s)');
  });

  it('requires HTTPS for credentials off loopback while allowing keyless HTTP', () => {
    const remote = { rerankApiBase: 'http://192.168.1.20:8082/v1' };
    expect(() => new RemoteRerankProvider(config({ ...remote, rerankApiKey: 'secret' }))).toThrow('requires HTTPS');
    expect(() => new RemoteRerankProvider(config(remote))).not.toThrow();
    expect(() => new RemoteRerankProvider(config({ rerankApiBase: 'https://rerank.example/v1', rerankApiKey: 'secret' }))).not.toThrow();
  });

  it('allows credentials over plain HTTP to a loopback endpoint', () => {
    for (const base of ['http://127.0.0.1:8082/v1', 'http://localhost:8082/v1', 'http://[::1]:8082/v1']) {
      expect(() => new RemoteRerankProvider(config({ rerankApiBase: base, rerankApiKey: 'secret' }))).not.toThrow();
    }
  });

  it('keeps the top_n best when a service ignores top_n and scores every document', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply([
      { index: 0, score: 0.2 },
      { index: 1, score: 0.9 },
    ])));
    expect(await new RemoteRerankProvider(config()).rerank('q', candidates, 1)).toEqual([{ id: 'second', score: 0.9 }]);
  });

  it('reports HTTP status without leaking the key or echoing the body', async () => {
    // The shared client reads a bounded excerpt of an error body for its own
    // message; this provider's mapping must not surface it.
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response('upstream boom at https://internal.example/', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await new RemoteRerankProvider(config({ rerankApiBase: 'https://rerank.example/v1', rerankApiKey: 'secret' })).rerank('q', candidates)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Remote rerank HTTP 502');
    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).message).not.toContain('upstream boom');
    // 502 is in the shared transient set, so it is retried once before throwing.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a 3xx instead of following it to another host', async () => {
    // `redirect: 'error'` is the property under test: following a redirect
    // would replay the query and page text at whatever host Location names.
    // The target here WOULD answer a valid rerank, so a followed redirect
    // would make this call succeed instead of throwing.
    const hits: string[] = [];
    let base = '';
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/rerank') {
        res.writeHead(302, { location: `${base}/elsewhere` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ index: 0, score: 0.9 }, { index: 1, score: 0.1 }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }));
    try {
      await expect(new RemoteRerankProvider(config({ rerankApiBase: base })).rerank('q', candidates))
        .rejects.toThrow('request failed');
      expect(hits).toContain('/rerank');
      expect(hits).not.toContain('/elsewhere');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects invalid JSON and malformed or ambiguous results', async () => {
    const provider = new RemoteRerankProvider(config());
    const cases: Array<[Response, string]> = [
      [new Response('{invalid'), 'non-JSON body'],
      [new Response('{}'), 'results array'],
      [reply([{ index: 0, score: 0.9 }]), 'fewer results'],
      [reply([{ index: 0, score: 0.9 }, { index: 0, score: 0.8 }]), 'duplicate index'],
      [reply([{ index: 2, score: 0.9 }, { index: 1, score: 0.8 }]), 'out-of-range index'],
      [reply([{ index: 0.5, score: 0.9 }, { index: 1, score: 0.8 }]), 'out-of-range index'],
      [reply([{ index: 0, score: '0.9' }, { index: 1, score: 0.8 }]), 'missing score'],
    ];
    for (const [response, message] of cases) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(provider.rerank('q', candidates)).rejects.toThrow(message);
    }
  });

  it('rejects non-finite scores even if a service returns them', async () => {
    // `1e999` parses to Infinity — the only way JSON can carry a non-finite.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      '{"results":[{"index":0,"score":1e999},{"index":1,"score":0.8}]}',
      { status: 200 },
    )));
    await expect(new RemoteRerankProvider(config()).rerank('q', candidates)).rejects.toThrow('non-finite');
  });
});
