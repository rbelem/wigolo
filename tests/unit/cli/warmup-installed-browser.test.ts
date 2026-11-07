import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `wigolo init`/`warmup` must use a browser the host already provides instead of
 * downloading Playwright's. The tier ranks an installed build above the bundled
 * one (browserChannel=auto), so downloading first is wasted work — and on a host
 * without the distro libs Playwright's browsers want, the optional engine
 * launches fail red in the middle of an otherwise fine setup.
 *
 * The probe itself is covered in tests/unit/fetch/browser-probe.test.ts; these
 * tests cover the WARMUP DECISION: detect, report, skip the downloads.
 */

const flatpakChrome = {
  path: '/home/u/.local/share/flatpak/app/com.google.Chrome/current/active/export/bin/com.google.Chrome',
  id: 'flatpak:com.google.Chrome',
  origin: 'flatpak' as const,
};

const chromiumLaunch = vi.fn();
const installedCandidates = vi.fn<() => Array<typeof flatpakChrome>>(() => []);
let browserChannel: 'auto' | 'chrome' | 'chromium' = 'auto';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    // Both the candidate filter and Playwright's own executable check go through
    // existsSync; the fake paths are not real files.
    existsSync: vi.fn().mockReturnValue(true),
  };
});

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({
    dataDir: '/tmp/test-wigolo-installed-browser',
    searchBackend: null,
    searxngUrl: null,
    reranker: 'none',
    localLlm: 'off',
    get browserChannel() {
      return browserChannel;
    },
  })),
}));

vi.mock('../../../src/fetch/browser-engine.js', () => ({
  getBrowserEngine: () => ({
    resolveAuthenticChromiumPath: () => installedCandidates()[0]?.path ?? null,
    installedCandidates: () => installedCandidates(),
  }),
}));

vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: () => '/fake/playwright/chromium/chrome', launch: (...a: unknown[]) => chromiumLaunch(...a) },
    firefox: { executablePath: () => '/fake/playwright/firefox/firefox', launch: vi.fn(okLaunch) },
    webkit: { executablePath: () => '/fake/playwright/webkit/webkit', launch: vi.fn(okLaunch) },
  };
});

vi.mock('../../../src/cli/tui/run-command.js', () => ({ runCommand: vi.fn() }));
vi.mock('../../../src/searxng/bootstrap.js', () => ({
  getBootstrapState: vi.fn().mockReturnValue({ status: 'ready' }),
  checkPythonAvailable: vi.fn().mockReturnValue(true),
  bootstrapNativeSearxng: vi.fn(),
}));
vi.mock('../../../src/python-env.js', () => ({ checkVenvModule: vi.fn(() => ({ available: true })) }));
vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'test/reranker',
    rerank: vi.fn(async () => [{ id: '0', score: 1 }]),
  })),
}));
vi.mock('../../../src/search/rerank-mode.js', () => ({ rerankerIsHosted: () => true }));
vi.mock('../../../src/embedding/fastembed-provider.js', () => ({
  FastembedEmbedProvider: class {
    readonly modelId = 'BGE-small-en-v1.5';
    readonly dim = 384;
    async warmup(): Promise<void> {}
    async embed(): Promise<Float32Array[]> {
      return [new Float32Array(384)];
    }
  },
}));

import { runCommand } from '../../../src/cli/tui/run-command.js';
import { runWarmup } from '../../../src/cli/warmup.js';
import type { WarmupReporter } from '../../../src/cli/tui/reporter.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };

function fakeReporter(): WarmupReporter & { success: ReturnType<typeof vi.fn>; note: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(),
    update: vi.fn(),
    progress: vi.fn(),
    success: vi.fn(),
    fail: vi.fn(),
    note: vi.fn(),
    finish: vi.fn(),
  } as never;
}

const installCalls = (): string[][] =>
  vi
    .mocked(runCommand)
    .mock.calls.map((c) => (c[1] as string[]) ?? [])
    .filter((args) => args.includes('install'));

describe('warmup browser detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    chromiumLaunch.mockResolvedValue({ close: () => Promise.resolve() });
    installedCandidates.mockReturnValue([]);
    browserChannel = 'auto';
  });

  it('uses an installed browser and skips every Playwright download', async () => {
    installedCandidates.mockReturnValue([flatpakChrome]);

    const result = await runWarmup([], fakeReporter());

    expect(result.playwright).toBe('ok');
    expect(result.playwrightOrigin).toBe('installed');
    expect(result.playwrightPath).toBe(flatpakChrome.path);
    // The tier's probe launched the installed build, not the bundled one.
    expect(chromiumLaunch).toHaveBeenCalledWith({
      headless: true,
      executablePath: flatpakChrome.path,
    });
    // No chromium download.
    expect(installCalls()).toEqual([]);
  });

  it('skips the optional firefox/webkit downloads under --all', async () => {
    installedCandidates.mockReturnValue([flatpakChrome]);

    const result = await runWarmup(['--all', '--skip-verify'], fakeReporter());

    expect(result.playwrightOrigin).toBe('installed');
    expect(result.firefox).toBeUndefined();
    expect(result.webkit).toBeUndefined();
    expect(installCalls().some((a) => a.includes('firefox') || a.includes('webkit'))).toBe(false);
  });

  it('still honours an explicit --firefox next to an installed browser', async () => {
    installedCandidates.mockReturnValue([flatpakChrome]);

    await runWarmup(['--firefox', '--skip-verify'], fakeReporter());

    expect(installCalls().some((a) => a.includes('firefox'))).toBe(true);
  });

  it('downloads the bundled engine when the channel pins it', async () => {
    browserChannel = 'chromium';
    installedCandidates.mockReturnValue([flatpakChrome]);

    const result = await runWarmup([], fakeReporter());

    expect(result.playwright).toBe('ok');
    expect(result.playwrightOrigin).toBe('bundled');
    expect(installedCandidates).not.toHaveBeenCalled();
    expect(installCalls()).toHaveLength(1);
    expect(installCalls()[0]).toContain('chromium');
  });

  it('falls back to the download when the installed probe finds nothing launchable', async () => {
    // Candidates exist but launch fails (missing OS libs) and the bundled build
    // works: probeBrowser reports the bundled one, so warmup installs it.
    installedCandidates.mockReturnValue([flatpakChrome]);
    chromiumLaunch.mockImplementation(async (opts: { executablePath?: string }) => {
      if (opts.executablePath) throw new Error('missing libnss3.so');
      return { close: () => Promise.resolve() };
    });

    const result = await runWarmup([], fakeReporter());

    expect(result.playwrightOrigin).not.toBe('installed');
  });
});
