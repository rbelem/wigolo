/**
 * SettingsHome search-row preview must stay truthful when the reranker mode
 * comes from the environment: the store only carries persisted values, so an
 * env-only configuration (e.g. WIGOLO_RERANKER=workers-ai with nothing saved)
 * would otherwise fall back to the schema default and read as the default
 * mode. The preview resolves the effective mode and renders the shared
 * classification-table label (rerankerModeSpec), never the raw default.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { SettingsHome } from '../../../../../src/cli/tui/components/SettingsHome.js';
import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';
import { searchCategory } from '../../../../../src/cli/tui/schema/search.js';
import { resetConfig } from '../../../../../src/config.js';

const savedReranker = process.env.WIGOLO_RERANKER;

afterEach(() => {
  cleanup();
  if (savedReranker === undefined) delete process.env.WIGOLO_RERANKER;
  else process.env.WIGOLO_RERANKER = savedReranker;
  resetConfig();
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Focused catalog: only the search row renders, so the frame is unambiguous.
const SEARCH_CATALOG = [searchCategory];

function searchLine(frame: string): string {
  const line = frame.split('\n').find((l) => l.includes('Search'));
  expect(line).toBeDefined();
  return line ?? '';
}

async function renderSearchRow(env: string | undefined, storeValues: Record<string, unknown> = {}): Promise<string> {
  if (env === undefined) delete process.env.WIGOLO_RERANKER;
  else process.env.WIGOLO_RERANKER = env;
  resetConfig();
  const store = createSettingsStore(storeValues);
  const { lastFrame } = render(
    <SettingsHome
      store={store}
      catalog={SEARCH_CATALOG}
      onSelectCategory={() => {}}
      onAction={() => {}}
      onQuit={() => {}}
    />,
  );
  await wait(30);
  return lastFrame() ?? '';
}

describe('SettingsHome search-row reranker preview', () => {
  it('reads an env-selected hosted mode instead of the onnx default', async () => {
    const frame = await renderSearchRow('workers-ai');
    expect(searchLine(frame)).toContain('Hosted (Workers AI)');
    expect(searchLine(frame)).not.toContain('On-device ONNX');
  });

  it('reads an env-selected decision mode with its table label', async () => {
    const frame = await renderSearchRow('decision');
    expect(searchLine(frame)).toContain('Jev-compatible judgement model');
  });

  it('reads the jev legacy alias as the same decision label', async () => {
    const frame = await renderSearchRow('jev');
    expect(searchLine(frame)).toContain('Jev-compatible judgement model');
  });

  it('prefers env over a conflicting persisted value (env wins at runtime)', async () => {
    const frame = await renderSearchRow('workers-ai', { reranker: 'onnx' });
    expect(searchLine(frame)).toContain('Hosted (Workers AI)');
  });

  it('uses the persisted value when no env var is set', async () => {
    const frame = await renderSearchRow(undefined, { reranker: 'none' });
    expect(searchLine(frame)).toContain('Disabled');
  });

  it('falls back to the onnx default label when nothing is set', async () => {
    const frame = await renderSearchRow('onnx');
    expect(searchLine(frame)).toContain('On-device ONNX');
  });
});
