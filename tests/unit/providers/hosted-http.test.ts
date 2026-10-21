import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { postJsonCapped } from '../../../src/providers/hosted-http.js';

let server: http.Server;
let baseUrl: string;
/** What the fake endpoint should do for the next request. */
let mode: 'ok' | 'error' | 'busy' | 'bad' | 'huge-declared' | 'huge-streamed' | 'non-json' = 'ok';
let lastAuth: string | undefined;
let requests = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests++;
    lastAuth = req.headers.authorization;
    req.on('data', () => {});
    req.on('end', () => {
      if (mode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hello: 'world' }));
        return;
      }
      if (mode === 'non-json') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>not json</html>');
        return;
      }
      if (mode === 'busy') {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('unavailable');
        return;
      }
      if (mode === 'bad') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad request');
        return;
      }
      if (mode === 'error') {
        res.writeHead(500, { 'content-type': 'text/html' });
        res.end('<html>' + 'x'.repeat(5000) + '</html>');
        return;
      }
      if (mode === 'huge-declared') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(50 * 1024 * 1024),
        });
        res.end('{}');
        return;
      }
      // huge-streamed: no content-length, dribble past the cap.
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = 'x'.repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        if (sent > 4 * 1024 * 1024) { res.end(); return; }
        sent += chunk.length;
        if (res.write(chunk)) setImmediate(pump);
        else res.once('drain', pump);
      };
      pump();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const call = (over: Partial<Parameters<typeof postJsonCapped>[0]> = {}) =>
  postJsonCapped<{ hello?: string }>({
    url: baseUrl,
    body: { ping: true },
    apiKey: 'secret-token',
    timeoutMs: 5000,
    label: 'test',
    ...over,
  });

describe('postJsonCapped', () => {
  beforeEach(() => {
    requests = 0;
  });

  it('returns parsed JSON and sends the bearer token', async () => {
    mode = 'ok';
    expect(await call()).toEqual({ hello: 'world' });
    expect(lastAuth).toBe('Bearer secret-token');
  });

  it('omits Authorization entirely when no key is configured', async () => {
    mode = 'ok';
    lastAuth = 'sentinel';
    await call({ apiKey: null });
    expect(lastAuth).toBeUndefined();
  });

  it('rejects a declared body larger than the cap without buffering it', async () => {
    mode = 'huge-declared';
    await expect(call({ maxResponseBytes: 1024 })).rejects.toThrow(/over the 1024-byte cap/);
  });

  it('cuts off a streamed body that exceeds the cap mid-flight', async () => {
    // The important case: no content-length, so only the stream can bound it.
    mode = 'huge-streamed';
    await expect(call({ maxResponseBytes: 256 * 1024 })).rejects.toThrow(
      /exceeded the 262144-byte cap/,
    );
  });

  it('truncates the error excerpt instead of echoing a huge body', async () => {
    mode = 'error';
    const err = await call().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 500/);
    // 5000-byte body must not land in the message.
    expect((err as Error).message.length).toBeLessThan(400);
  });

  it('reports a non-JSON body rather than throwing a parse error', async () => {
    mode = 'non-json';
    await expect(call()).rejects.toThrow(/non-JSON body/);
  });

  it('never leaks the API key into the error message', async () => {
    mode = 'error';
    const err = await call().catch((e: Error) => e);
    expect((err as Error).message).not.toContain('secret-token');
  });

  it('aborts a request that outlives its timeout', async () => {
    mode = 'huge-streamed';
    await expect(call({ timeoutMs: 50, maxResponseBytes: 10 * 1024 * 1024 })).rejects.toThrow();
  });

  it('retries a transient 503, then surfaces the failure', async () => {
    mode = 'busy';
    await expect(call()).rejects.toThrow(/HTTP 503/);
    // Default is 2 attempts: the timeout/5xx path is retried once.
    expect(requests).toBe(2);
  });

  it('does NOT retry a client error (400)', async () => {
    mode = 'bad';
    await expect(call()).rejects.toThrow(/HTTP 400/);
    expect(requests).toBe(1);
  });

  it('does NOT retry a non-2xx 500', async () => {
    // 500 is not in the transient set; retrying it just doubles the wait.
    mode = 'error';
    await expect(call()).rejects.toThrow(/HTTP 500/);
    expect(requests).toBe(1);
  });
});
