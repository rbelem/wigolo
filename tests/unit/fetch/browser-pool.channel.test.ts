import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { sanitizedChildEnv } from '../../../src/util/child-env.js';

/**
 * The engine's host is a FAKE: no filesystem is touched, so the installed
 * builds are exactly the paths each test lists. `engineState.engine` is reset
 * between tests so the engine's failure memo never leaks across them.
 */
const engineState = vi.hoisted(() => ({
  existing: [] as string[],
  existsCalls: [] as string[],
  engine: null as unknown,
}));

vi.mock('../../../src/fetch/browser-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fetch/browser-engine.js')>();
  return {
    ...actual,
    getBrowserEngine: () => {
      if (!engineState.engine) {
        engineState.engine = actual.createBrowserEngine({
          platform: 'linux',
          env: process.env,
          home: '/home/tester',
          exists: (path) => {
            engineState.existsCalls.push(path);
            return engineState.existing.includes(path);
          },
        });
      }
      return engineState.engine;
    },
  };
});

// A flatpak-installed Chrome, as the engine resolves it.
const INSTALLED_CHROME =
  '/home/tester/.local/share/flatpak/app/com.google.Chrome/current/active/export/bin/com.google.Chrome';

// Shared mock state. Captures EVERY launch option object so the tests can
// assert the exact executablePath + headless flags the launch paths pass, and
// can simulate a machine whose installed build cannot start.
interface LaunchState {
  launchCalls: Array<Record<string, unknown>>;
  // When true, a launch that names an executablePath rejects (the installed
  // build is broken); a launch WITHOUT one succeeds.
  installedUnavailable: boolean;
  // Version string the launched browser reports (drives the coherence contract).
  browserVersion: string;
}

const state: LaunchState = {
  launchCalls: [],
  installedUnavailable: false,
  browserVersion: '142.0.7444.0',
};

function makePage() {
  return {
    goto: vi.fn().mockResolvedValue({
      status: () => 200,
      url: () => 'https://example.com',
      headers: () => ({ 'content-type': 'text/html' }),
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation((src: string) =>
      typeof src === 'string' && src.includes('hasContent')
        ? Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false })
        : Promise.resolve({ textLen: 1000, nodes: 8 })),
    content: vi.fn().mockResolvedValue('<html><body>ok</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

let lastContextOptions: Record<string, unknown> | undefined;

function makeContext() {
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockResolvedValue([]),
  };
}

function makeBrowser() {
  return {
    version: vi.fn().mockImplementation(() => state.browserVersion),
    newContext: vi.fn().mockImplementation((opts?: Record<string, unknown>) => {
      lastContextOptions = opts;
      return Promise.resolve(makeContext());
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    state.launchCalls.push(opts);
    if (state.installedUnavailable && opts.executablePath !== undefined) {
      return Promise.reject(new Error('executable does not exist'));
    }
    return Promise.resolve(makeBrowser());
  });
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

function installedLaunches(): Array<Record<string, unknown>> {
  return state.launchCalls.filter((o) => o.executablePath !== undefined);
}

function resetState() {
  state.launchCalls = [];
  state.installedUnavailable = false;
  state.browserVersion = '142.0.7444.0';
  lastContextOptions = undefined;
  engineState.existing = [];
  engineState.existsCalls = [];
  engineState.engine = null;
}

describe('dedicated stealth launch: installed browser build (T1-A)', () => {
  beforeEach(() => {
    resetState();
    // Probing for an installed browser is OPT-IN — the default is the pinned
    // bundled engine so behaviour does not vary per host. This describe covers
    // the opted-in path; the chromium-pin test below overrides it back.
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
  });
  afterEach(() => {
    delete process.env.WIGOLO_BROWSER_CHANNEL;
    delete process.env.WIGOLO_BROWSER_HEADFUL;
    resetConfig();
  });

  it('prefers the installed build, then falls back to bundled when it cannot start', async () => {
    engineState.existing = [INSTALLED_CHROME];
    state.installedUnavailable = true;
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://blocked.example', { stealth: true });
    expect(result.method).toBe('browser');

    // It attempted the installed build first...
    expect(installedLaunches().length).toBe(1);
    expect(installedLaunches()[0].executablePath).toBe(INSTALLED_CHROME);
    // ...then relaunched WITHOUT an executablePath (bundled engine) after the failure.
    const bundled = state.launchCalls.filter((o) => o.executablePath === undefined);
    expect(bundled.length).toBe(1);

    await pool.shutdown();
  });

  it('attempts the failed installed build ONCE across two fetches', async () => {
    engineState.existing = [INSTALLED_CHROME];
    state.installedUnavailable = true;
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });
    await pool.fetchWithBrowser('https://b.example', { stealth: true });

    // The failed installed build is not repaid on the second fetch.
    expect(installedLaunches().length).toBe(1);
    // Both fetches still launched (each via the cached bundled decision).
    expect(state.launchCalls.length).toBe(3); // 1 installed-attempt + 2 bundled

    await pool.shutdown();
  });

  it('keeps using the installed build on the second fetch (no bundled relaunch)', async () => {
    engineState.existing = [INSTALLED_CHROME];
    state.installedUnavailable = false; // the installed build launches
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });
    await pool.fetchWithBrowser('https://b.example', { stealth: true });

    // Both fetches used the installed build; no bundled launch ever happened.
    expect(installedLaunches().length).toBe(2);
    expect(state.launchCalls.every((o) => o.executablePath === INSTALLED_CHROME)).toBe(true);

    await pool.shutdown();
  });

  it('WIGOLO_BROWSER_CHANNEL=chromium NEVER probes the host', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'chromium';
    resetConfig();
    engineState.existing = [INSTALLED_CHROME];
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });

    expect(installedLaunches().length).toBe(0);
    expect(state.launchCalls.length).toBe(1);
    expect(state.launchCalls[0].executablePath).toBeUndefined();
    // The host was never probed for a candidate binary.
    expect(engineState.existsCalls).toEqual([]);

    await pool.shutdown();
  });
});

describe('dedicated stealth launch: headful escape (T1-B)', () => {
  beforeEach(() => {
    resetState();
    resetConfig();
  });
  afterEach(() => {
    delete process.env.WIGOLO_BROWSER_HEADFUL;
    resetConfig();
  });

  it('default (browserHeadful=false) launches WITHOUT a visible window (headless:true)', async () => {
    delete process.env.WIGOLO_BROWSER_HEADFUL;
    resetConfig();
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });

    // Every stealth launch must be headless — a background server never pops a
    // window by default.
    expect(state.launchCalls.length).toBeGreaterThan(0);
    for (const opts of state.launchCalls) {
      expect(opts.headless).toBe(true);
    }

    await pool.shutdown();
  });

  it('WIGOLO_BROWSER_HEADFUL=1 launches with headless:false (visible window)', async () => {
    process.env.WIGOLO_BROWSER_HEADFUL = '1';
    resetConfig();
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });

    expect(state.launchCalls.length).toBeGreaterThan(0);
    for (const opts of state.launchCalls) {
      expect(opts.headless).toBe(false);
    }

    await pool.shutdown();
  });
});

describe('pooled (non-stealth) path is byte-unchanged (MUST-NOT-REGRESS)', () => {
  beforeEach(() => {
    resetState();
    resetConfig();
  });
  afterEach(() => {
    delete process.env.WIGOLO_BROWSER_CHANNEL;
    delete process.env.WIGOLO_BROWSER_HEADFUL;
    resetConfig();
  });

  it('under the pin the pooled launch receives exactly today\'s options object', async () => {
    // Even with knobs that would change the stealth path, the pooled fast path
    // must be unaffected: it launches headless, bundled, no executablePath.
    process.env.WIGOLO_BROWSER_CHANNEL = 'chromium';
    process.env.WIGOLO_BROWSER_HEADFUL = '1';
    resetConfig();
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://plain.example', {}); // no stealth
    expect(result.method).toBe('browser');

    expect(state.launchCalls.length).toBe(1);
    expect(state.launchCalls[0]).toEqual({
      headless: true,
      env: sanitizedChildEnv({ stripProxy: true }),
    });
    // No executablePath key at all, and no stealth hardening args.
    expect(Object.keys(state.launchCalls[0])).toEqual(['headless', 'env']);
    // The host was never probed for a candidate binary.
    expect(engineState.existsCalls).toEqual([]);

    await pool.shutdown();
  });

  it('the pooled launch receives the installed build\'s executablePath when opted in', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    engineState.existing = [INSTALLED_CHROME];
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://plain.example', {}); // no stealth
    expect(result.method).toBe('browser');

    expect(state.launchCalls.length).toBe(1);
    expect(state.launchCalls[0].executablePath).toBe(INSTALLED_CHROME);
    expect(state.launchCalls[0].headless).toBe(true);

    await pool.shutdown();
  });
});

describe('dedicated stealth launch: UA/platform coherence (T1-C)', () => {
  beforeEach(() => {
    resetState();
    resetConfig();
  });
  afterEach(() => {
    resetConfig();
  });

  it('advertises a UA whose platform token matches the runtime OS and whose major equals browser.version()', async () => {
    state.browserVersion = '137.0.1234.5';
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });

    expect(lastContextOptions).toBeDefined();
    const ua = String((lastContextOptions as Record<string, unknown>).userAgent);
    // Major MUST reflect the ACTUALLY launched browser, not a hardcoded pin.
    expect(ua).toContain('Chrome/137.');
    // Platform token MUST reflect the real runtime OS (the top cross-layer tell).
    const expectedToken =
      process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X'
        : process.platform === 'win32'
          ? 'Windows NT 10.0; Win64; x64'
          : 'X11; Linux x86_64';
    expect(ua).toContain(expectedToken);
    // Never a headless tell.
    expect(ua).not.toContain('HeadlessChrome');

    await pool.shutdown();
  });

  it('falls back to the pinned major when browser.version() is unparseable', async () => {
    state.browserVersion = 'unknown';
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });

    const ua = String((lastContextOptions as Record<string, unknown>).userAgent);
    expect(ua).toContain('Chrome/142.');

    await pool.shutdown();
  });
});
