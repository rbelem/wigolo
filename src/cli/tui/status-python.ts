import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../../config.js';
import { rerankerModeSpec } from '../../search/rerank-mode.js';

export interface PythonProbeResult {
  /** 'hosted' = scores come from an endpoint, so no on-disk model is needed. */
  reranker: 'ok' | 'hosted' | 'disabled' | 'missing';
  embeddings: 'ok' | 'missing';
}

export function probePythonPackages(dataDir: string): PythonProbeResult {
  return {
    reranker: probeRerankerCache(dataDir),
    embeddings: probeFastembedCache(dataDir),
  };
}

function probeRerankerCache(dataDir: string): PythonProbeResult['reranker'] {
  const spec = rerankerModeSpec(getConfig().reranker);
  // A hosted mode needs no on-disk model: probing `<dataDir>/transformers` here
  // reported every hosted reranker (`remote`, `workers-ai`, `decision`, `jev`)
  // as "not installed".
  if (spec?.hosted) return 'hosted';
  // `none` — and any typo'd mode, which cannot score — is a configuration
  // choice, not a missing download.
  if (!spec?.scores) return 'disabled';
  // Transformers.js writes the cross-encoder model under
  // `<dataDir>/transformers/`. Presence of that directory with content
  // is a good proxy for "model has been downloaded at least once".
  const cacheDir = join(dataDir, 'transformers');
  if (!existsSync(cacheDir)) return 'missing';
  try {
    return readdirSync(cacheDir).length > 0 ? 'ok' : 'missing';
  } catch {
    return 'missing';
  }
}

function probeFastembedCache(dataDir: string): 'ok' | 'missing' {
  const cacheDir = join(dataDir, 'fastembed');
  if (!existsSync(cacheDir)) return 'missing';
  try {
    return readdirSync(cacheDir).length > 0 ? 'ok' : 'missing';
  } catch {
    return 'missing';
  }
}
