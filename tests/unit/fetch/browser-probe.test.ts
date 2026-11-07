import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  };
});

const chromiumLaunch = vi.fn();
const chromiumExec = vi.fn(() => '/fake/playwright/chromium/chrome');
const resolveAuthentic = vi.fn<() => string | null>(() => null);
const installedCandidates = vi.fn<
  () => Array<{ path: string; id: string; origin: 'override' | 'native' | 'flatpak' }>
>(() => []);
vi.mock('../../../src/fetch/browser-engine.js', () => ({
  getBrowserEngine: () => ({
    resolveAuthenticChromiumPath: () => resolveAuthentic(),
    installedCandidates: () => installedCandidates(),
  }),
}));
vi.mock('playwright', () => ({
  chromium: {
    executablePath: () => chromiumExec(),
    launch: (...args: unknown[]) => chromiumLaunch(...args),
  },
  firefox: {
    executablePath: () => '/fake/playwright/firefox/firefox',
    launch: vi.fn(),
  },
  webkit: {
    executablePath: () => '/fake/playwright/webkit/webkit',
    launch: vi.fn(),
  },
}));

import { existsSync } from 'node:fs';
import { probeBrowser } from '../../../src/fetch/browser-probe.js';

const fakeBrowser = { close: vi.fn().mockResolvedValue(undefined) };

describe('probeBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    chromiumExec.mockReturnValue('/fake/playwright/chromium/chrome');
    chromiumLaunch.mockResolvedValue(fakeBrowser);
  });

  it('reports launchable=true when the binary is on disk and launch succeeds', async () => {
    const r = await probeBrowser('chromium');

    expect(r.onDisk).toBe(true);
    expect(r.launchable).toBe(true);
    expect(r.execPath).toBe('/fake/playwright/chromium/chrome');
    expect(r.error).toBeUndefined();
    // Real smoke-test: launched headless, then closed.
    expect(chromiumLaunch).toHaveBeenCalledWith({ headless: true });
    expect(fakeBrowser.close).toHaveBeenCalled();
  });

  it('reports onDisk=false and never launches when the binary is missing', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const r = await probeBrowser('chromium');

    expect(r.onDisk).toBe(false);
    expect(r.launchable).toBe(false);
    expect(r.error).toContain('missing on disk');
    expect(chromiumLaunch).not.toHaveBeenCalled();
  });

  it('reports launchable=false when the binary is present but launch throws', async () => {
    // WHY: on bare Linux the binary lands on disk but launch fails because OS
    // shared libs (libnss3/libgbm) are missing. existsSync alone would lie.
    chromiumLaunch.mockRejectedValue(new Error('libnss3.so: cannot open shared object file'));

    const r = await probeBrowser('chromium');

    expect(r.onDisk).toBe(true);
    expect(r.launchable).toBe(false);
    expect(r.error).toContain('libnss3');
  });

  it('reports onDisk=false when executablePath() throws', async () => {
    chromiumExec.mockImplementation(() => {
      throw new Error('no executable');
    });

    const r = await probeBrowser('chromium');

    expect(r.onDisk).toBe(false);
    expect(r.launchable).toBe(false);
    expect(r.execPath).toBe('');
    expect(r.error).toContain('no executable');
  });

  it('treats a launch that never resolves as a failure (timeout)', async () => {
    chromiumLaunch.mockReturnValue(new Promise(() => {}));

    const r = await probeBrowser('chromium', { launchTimeoutMs: 20 });

    expect(r.onDisk).toBe(true);
    expect(r.launchable).toBe(false);
    expect(r.error).toContain('timed out');
  });

  it('still reports launchable=true even if close() throws', async () => {
    chromiumLaunch.mockResolvedValue({ close: vi.fn().mockRejectedValue(new Error('close fail')) });

    const r = await probeBrowser('chromium');

    expect(r.launchable).toBe(true);
    expect(r.error).toBeUndefined();
  });
});

describe('probeBrowser preferInstalled', () => {
  const flatpak = {
    path: '/flatpak/export/bin/com.google.Chrome',
    id: 'flatpak:com.google.Chrome',
    origin: 'flatpak' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    chromiumExec.mockReturnValue('/fake/playwright/chromium/chrome');
    chromiumLaunch.mockResolvedValue(fakeBrowser);
    resolveAuthentic.mockReturnValue(null);
    installedCandidates.mockReturnValue([]);
  });

  it('probes the first installed build the tier would really launch', async () => {
    installedCandidates.mockReturnValue([flatpak]);

    const r = await probeBrowser('chromium', { preferInstalled: true });

    expect(r.origin).toBe('installed');
    expect(r.execPath).toBe(flatpak.path);
    expect(r.launchable).toBe(true);
    expect(chromiumLaunch).toHaveBeenCalledWith({
      headless: true,
      executablePath: flatpak.path,
    });
  });

  it('walks past an installed build that is on disk but will not launch', async () => {
    // WHY: /usr/bin/chromium can pass existsSync/access yet be rejected by
    // Playwright's stat-based launch check (an envfs name, a dangling link, a
    // build missing OS libs). The working Flatpak behind it must win.
    const phantom = { path: '/usr/bin/chromium', id: '/usr/bin/chromium', origin: 'native' as const };
    installedCandidates.mockReturnValue([phantom, flatpak]);
    chromiumLaunch.mockImplementation(async (opts: { executablePath?: string }) => {
      if (opts.executablePath === phantom.path) {
        throw new Error("Failed to launch chromium because executable doesn't exist");
      }
      return fakeBrowser;
    });

    const r = await probeBrowser('chromium', { preferInstalled: true });

    expect(r.origin).toBe('installed');
    expect(r.execPath).toBe(flatpak.path);
    expect(r.launchable).toBe(true);
  });

  it('falls back to the bundled build when the installed ones all fail', async () => {
    installedCandidates.mockReturnValue([flatpak]);
    chromiumLaunch.mockImplementation(async (opts: { executablePath?: string }) => {
      if (opts.executablePath) throw new Error('missing libnss3.so');
      return fakeBrowser;
    });

    const r = await probeBrowser('chromium', { preferInstalled: true });

    expect(r.origin).toBe('bundled');
    expect(r.execPath).toBe('/fake/playwright/chromium/chrome');
    expect(r.launchable).toBe(true);
  });

  it('reports the installed failure when nothing launches', async () => {
    installedCandidates.mockReturnValue([flatpak]);
    chromiumLaunch.mockRejectedValue(new Error('missing libnss3.so'));

    const r = await probeBrowser('chromium', { preferInstalled: true });

    expect(r.origin).toBe('installed');
    expect(r.execPath).toBe(flatpak.path);
    expect(r.launchable).toBe(false);
    expect(r.error).toContain('libnss3');
  });

  it('falls back to the bundled build when no installed one is selected', async () => {
    const r = await probeBrowser('chromium', { preferInstalled: true });

    expect(r.origin).toBe('bundled');
    expect(r.execPath).toBe('/fake/playwright/chromium/chrome');
    expect(chromiumLaunch.mock.calls[0][0]).toEqual({ headless: true });
  });

  it('never consults the engine for a non-chromium family', async () => {
    installedCandidates.mockReturnValue([flatpak]);

    const r = await probeBrowser('firefox', { preferInstalled: true });

    expect(r.origin).toBe('bundled');
    expect(installedCandidates).not.toHaveBeenCalled();
  });

  it('skips a candidate missing on disk and launches the next', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === flatpak.path);
    const gone = { path: '/gone/chrome', id: '/gone/chrome', origin: 'native' as const };
    installedCandidates.mockReturnValue([gone, flatpak]);

    const r = await probeBrowser('chromium', { preferInstalled: true });

    expect(r.execPath).toBe(flatpak.path);
    expect(chromiumLaunch).toHaveBeenCalledTimes(1);
    expect(chromiumLaunch).toHaveBeenCalledWith({ headless: true, executablePath: flatpak.path });
  });
});
