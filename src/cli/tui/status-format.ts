import type { ConnectedAgent } from './status-agents.js';

export interface StatusBag {
  version: string;
  searxng: 'ready' | 'failed' | 'pending';
  reranker: 'ok' | 'hosted' | 'disabled' | 'missing';
  embeddings: 'ok' | 'missing';
  cache: { pages: number; bytes: number };
  agents: ConnectedAgent[];
}

export function formatStatus(bag: StatusBag): string {
  const lines: string[] = [];
  lines.push(`wigolo v${bag.version}`);

  switch (bag.searxng) {
    case 'ready':
      lines.push('✓ Search engine ready (not running — starts on demand)');
      break;
    case 'failed':
      lines.push('✗ Search engine: failed (see `wigolo doctor`)');
      break;
    case 'pending':
      lines.push('⊘ Search engine: not installed (run `wigolo warmup`)');
      break;
  }

  lines.push(line('ML reranker',      bag.reranker));
  lines.push(line('Embeddings',  bag.embeddings));
  lines.push(`  Cache: ${bag.cache.pages} pages, ${formatBytes(bag.cache.bytes)}`);

  lines.push('');
  lines.push('Connected agents:');
  const connected = bag.agents.filter(a => a.configured);
  if (connected.length === 0) {
    lines.push('  (none)');
  } else {
    for (const a of connected) lines.push(`  ✓ ${a.displayName}`);
  }

  return lines.join('\n') + '\n';
}

function line(label: string, state: StatusBag['reranker']): string {
  if (state === 'ok') return `✓ ${label} installed`;
  // A hosted mode is configured without any local model — "not installed"
  // would be wrong. `disabled` is the explicit `reranker: 'none'` choice.
  if (state === 'hosted') return `✓ ${label} configured (hosted)`;
  if (state === 'disabled') return `⊘ ${label} disabled`;
  return `⊘ ${label} not installed`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
