/**
 * Shared HTTP client for the hosted inference providers.
 *
 * Three providers (embeddings, Workers-AI rerank, Jev-compatible decision
 * rerank) all POST JSON to a user-configured endpoint. Centralising it here
 * keeps one set of safety properties instead of three drifting copies:
 *
 *  - a hard timeout, so a wedged endpoint cannot hang a fetch/crawl;
 *  - `redirect: 'error'`, so a 3xx cannot forward the request body to a host
 *    the operator never configured;
 *  - a HARD RESPONSE SIZE CAP. A hosted endpoint is untrusted input — without
 *    a cap, `res.json()` on a broken or hostile server buffers an unbounded
 *    body straight into memory, which is exactly the failure this whole
 *    change set exists to prevent;
 *  - a bounded error excerpt, so a 500 with a huge HTML body cannot flood a
 *    log line or a tool response.
 *
 * Credentials are never logged: the Authorization header is only ever placed
 * on the outgoing request.
 */
import { withFetchRetry } from './rerank-provider.js';

export interface HostedJsonRequest {
  url: string;
  body: unknown;
  /** Bearer token. Omitted from the request entirely when null. */
  apiKey: string | null;
  timeoutMs: number;
  /** Cap on the response body in bytes. Defaults to 8 MB. */
  maxResponseBytes?: number;
  /** Short label for error messages ("embeddings", "rerank"). */
  label: string;
  /** Total attempts for transient failures (timeouts, 5xx). Default 2. */
  attempts?: number;
}

/** 8 MB is far above any sane embedding/rerank payload and far below OOM. */
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ERROR_EXCERPT_CHARS = 300;

/** A key sent to this machine never crosses a network, so plain http is fine there. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * Validate a user-configured hosted endpoint before a single byte is sent.
 *
 * The rules are the ones the Cohere `remote` reranker already enforces, and
 * they exist because `postJsonCapped` puts `apiKey` on the wire verbatim:
 *
 *  - http(s) only, so `file:`/`gopher:`/a typo cannot become a request;
 *  - no embedded credentials, query or fragment, because the URL is logged at
 *    warmup — an inline token would leak into `debug`/`info` output;
 *  - a keyed endpoint must be HTTPS unless it is loopback, otherwise the key
 *    travels in cleartext to a remote host.
 *
 * `missingHint` is the caller's actionable message for "not configured at all",
 * so each provider keeps its own env-var name and example in the error.
 * Returns the URL with trailing slashes trimmed, ready to be used as a base.
 */
export function assertHostedUrl(
  rawUrl: string | null | undefined,
  label: string,
  apiKey: string | null,
  missingHint: string,
): string {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) throw new Error(missingHint);

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be an http(s) URL`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be an http(s) URL without credentials, query, or fragment`);
  }
  if (apiKey && parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`${label} carries an API key, so it requires HTTPS unless the endpoint is on loopback`);
  }
  return trimmed.replace(/\/+$/, '');
}

export async function postJsonCapped<T>(req: HostedJsonRequest): Promise<T> {
  const maxBytes = req.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  // One retry by default: these are read-only computations, so retrying is
  // safe, but the timeout multiplies with attempts — 2 keeps the worst case
  // bounded while still absorbing a single transient blip or cold self-host.
  const attempts = req.attempts ?? 2;

  return withFetchRetry(() => once<T>(req, maxBytes), { attempts });
}

async function once<T>(req: HostedJsonRequest, maxBytes: number): Promise<T> {
  const res = await fetch(req.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
    },
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(req.timeoutMs),
    // Fail closed on a 3xx. The Fetch spec strips Authorization cross-origin,
    // but the request body (query text, page content) is not stripped — a
    // redirect would hand it to a host the operator never configured.
    redirect: 'error',
  });

  if (!res.ok) {
    const detail = await readCapped(res, 64 * 1024).catch(() => '');
    const err = new Error(
      `${req.label} request failed: HTTP ${res.status}` +
        (detail ? ` — ${detail.slice(0, ERROR_EXCERPT_CHARS)}` : ''),
    );
    // Surface the status so withFetchRetry can classify 502/503/504.
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const raw = await readCapped(res, maxBytes);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${req.label} returned a non-JSON body (${raw.length} bytes)`);
  }
}

/**
 * Read a response body, refusing to buffer more than `maxBytes`.
 *
 * Uses the stream when available so an unbounded (chunked, no content-length)
 * body is cut off mid-flight rather than after it has already been
 * materialised. Falls back to `text()` for responses without a body stream.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response declared ${declared} bytes, over the ${maxBytes}-byte cap`);
  }

  const body = res.body;
  if (!body) return res.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`response exceeded the ${maxBytes}-byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
