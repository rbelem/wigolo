/**
 * Shared HTTP client for the hosted inference providers.
 *
 * Three providers (embeddings, Workers-AI rerank, Jev-compatible decision
 * rerank) all POST JSON to a user-configured endpoint. Centralising it here
 * keeps one set of safety properties instead of three drifting copies:
 *
 *  - a hard timeout, so a wedged endpoint cannot hang a fetch/crawl;
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

export async function postJsonCapped<T>(req: HostedJsonRequest): Promise<T> {
  const maxBytes = req.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  // One retry by default: these are read-only computations, so retrying is
  // safe, but the timeout multiplies with attempts — 2 keeps the worst case
  // bounded while still absorbing a single transient blip or cold self-host.
  const attempts = req.attempts ?? 2;

  return withFetchRetry(() => once<T>(req, maxBytes), { attempts });
}

async function once<T>(req: HostedJsonRequest, maxBytes: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
      },
      body: JSON.stringify(req.body),
      signal: controller.signal,
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
  } finally {
    clearTimeout(timer);
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
