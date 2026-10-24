import type { BackendStatus } from '../server/backend-status.js';
import type { MultiBrowserPool } from '../fetch/browser-pool.js';
import { getConfig } from '../config.js';
import type { Config } from '../config.js';
import { isEmbedModelResident } from '../embedding/fastembed-provider.js';

export interface HealthProbeInput {
  backendStatus: BackendStatus | null;
  browserPool: MultiBrowserPool | null;
  startedAt: number;
  /**
   * Whether the search-engine sidecar is opted into (searxng/hybrid backend or
   * external URL). D1: when false, the default core backend is in use — the
   * sidecar is intentionally absent, so it reports `not_configured` and overall
   * health derives from the browser pool + cache, not from the sidecar.
   */
  searxngConfigured: boolean;
}

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'down';
  searxng: 'active' | 'unavailable' | 'not_initialized' | 'not_configured';
  browsers: 'ready' | 'not_initialized';
  cache: 'active' | 'not_initialized';
  /** Which inference backends are live, and whether a model is resident.
   *
   * The daemon can run two very different memory profiles (local ONNX vs
   * hosted, ~880 MB vs ~280 MB). Without this an operator cannot tell which one
   * is in force, or whether an idle eviction has actually happened. */
  inference: {
    embedding: 'local' | 'hosted';
    reranker: 'onnx' | 'none' | 'remote' | 'workers-ai' | 'decision';
    /** True only when the local fastembed ONNX session is loaded. */
    embed_model_resident: boolean;
  };
  uptime_seconds: number;
}

/** Snapshot of the inference backends. Never throws. */
function inferenceStatus(): HealthReport['inference'] {
  try {
    const cfg = getConfig();
    const mode = cfg.reranker;
    return {
      embedding: cfg.embeddingProvider === 'openai-compatible' ? 'hosted' : 'local',
      reranker: reportedReranker(mode),
      embed_model_resident: isEmbedModelResident(),
    };
  } catch {
    return { embedding: 'local', reranker: 'onnx', embed_model_resident: false };
  }
}

/**
 * Configured mode → the backend health reports.
 *
 * The point is fidelity: an operator reading `remote`/`workers-ai` must see the
 * backend that actually serves their scores, not a collapsed label, or they
 * debug the wrong endpoint. `jev` is the one deliberate collapse — it is a
 * legacy alias of `decision`, never a fourth hosted backend.
 */
function reportedReranker(mode: Config['reranker']): HealthReport['inference']['reranker'] {
  switch (mode) {
    case 'onnx':
      return 'onnx';
    case 'none':
      return 'none';
    case 'remote':
      return 'remote';
    case 'workers-ai':
      return 'workers-ai';
    case 'decision':
    case 'jev':
      return 'decision';
  }
}

export function probeHealth(input: HealthProbeInput): HealthReport {
  const uptimeMs = Date.now() - input.startedAt;
  const uptimeSeconds = Math.round(uptimeMs / 1000);

  const browsers: HealthReport['browsers'] = input.browserPool
    ? 'ready'
    : 'not_initialized';

  const cache: HealthReport['cache'] = 'active';

  // D1: on the default core backend the sidecar is intentionally absent —
  // health derives entirely from the browser pool + cache. A default daemon
  // with browsers ready is healthy; with no browser pool it is down.
  if (!input.searxngConfigured) {
    const status: HealthReport['status'] = browsers === 'ready' ? 'healthy' : 'down';
    return {
      status,
      searxng: 'not_configured',
      browsers,
      cache,
      inference: inferenceStatus(),
      uptime_seconds: uptimeSeconds,
    };
  }

  let searxng: HealthReport['searxng'];
  if (input.backendStatus === null) {
    searxng = 'not_initialized';
  } else if (input.backendStatus.isActive) {
    searxng = 'active';
  } else {
    searxng = 'unavailable';
  }

  let status: HealthReport['status'];
  if (searxng === 'active' && browsers === 'ready') {
    status = 'healthy';
  } else if (browsers === 'not_initialized' && searxng !== 'active') {
    status = 'down';
  } else {
    status = 'degraded';
  }

  return {
    status,
    searxng,
    browsers,
    cache,
    inference: inferenceStatus(),
    uptime_seconds: uptimeSeconds,
  };
}
