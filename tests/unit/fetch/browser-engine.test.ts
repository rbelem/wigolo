import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';
import {
  createBrowserEngine,
  type HostProbe,
} from '../../../src/fetch/browser-engine.js';
import type { Browser } from 'playwright';

const HOME = '/home/tester';
const USER_FLATPAK_CHROME = join(
  HOME,
  '.local',
  'share',
  'flatpak',
  'app',
  'com.google.Chrome',
  'current',
  'active',
  'export',
  'bin',
  'com.google.Chrome',
);
const USER_FLATPAK_BRAVE = join(
  HOME,
  '.local',
  'share',
  'flatpak',
  'app',
  'com.brave.Browser',
  'current',
  'active',
  'export',
  'bin',
  'com.brave.Browser',
);
const SYSTEM_FLATPAK_CHROME = join(
  '/var/lib/flatpak/app',
  'com.google.Chrome',
  'current',
  'active',
  'export',
  'bin',
  'com.google.Chrome',
);
/** The app directory alone, with no flatpak launcher inside it. */
const USER_FLATPAK_APP_DIR = join(
  HOME,
  '.local',
  'share',
  'flatpak',
  'app',
  'com.google.Chrome',
);

interface FakeHost {
  host: HostProbe;
  existsCalls: string[];
}

/**
 * A host probe with no filesystem behind it: `existing` decides what "exists"
 * means.
 */
function fakeHost(opts: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existing?: string[];
} = {}): FakeHost {
  const existing = new Set(opts.existing ?? []);
  const existsCalls: string[] = [];
  return {
    host: {
      platform: opts.platform ?? 'linux',
      env: opts.env ?? {},
      home: HOME,
      exists: (path) => {
        existsCalls.push(path);
        return existing.has(path);
      },
    },
    existsCalls,
  };
}

interface Attempt {
  calls: Array<{ executablePath?: string }>;
  attempt: (options: { executablePath?: string }) => Promise<Browser>;
}

/** A recording launch attempt. `failures` counts how many calls reject. */
function makeAttempt(failures = 0): Attempt {
  const calls: Array<{ executablePath?: string }> = [];
  let remaining = failures;
  return {
    calls,
    attempt: async (options) => {
      calls.push(options);
      if (remaining > 0) {
        remaining -= 1;
        throw new Error('launch failed');
      }
      return { version: () => '156.0.8078.47' } as unknown as Browser;
    },
  };
}

describe('browser-engine: candidate selection', () => {
  beforeEach(() => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'chromium';
    resetConfig();
  });
  afterEach(() => {
    delete process.env.WIGOLO_BROWSER_CHANNEL;
    resetConfig();
  });

  it('under the chromium pin the plan is the bundled engine alone and the host is never probed', async () => {
    const { host, existsCalls } = fakeHost({ existing: [USER_FLATPAK_CHROME] });
    const { calls, attempt } = makeAttempt();

    await createBrowserEngine(host).launchBestChromium(attempt);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({});
    expect(Object.keys(calls[0])).toEqual([]);
    expect(existsCalls).toEqual([]);
  });

  it('under the chromium pin an explicit chrome path is ignored (no host access at all)', async () => {
    const { host, existsCalls } = fakeHost({
      env: { WIGOLO_CHROME_PATH: '/opt/chrome/chrome' },
      existing: ['/opt/chrome/chrome'],
    });
    const { calls, attempt } = makeAttempt();

    await createBrowserEngine(host).launchBestChromium(attempt);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({});
    expect(existsCalls).toEqual([]);
  });

  it('prefers a flatpak Chrome launcher when the channel is auto', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    const { host } = fakeHost({ existing: [USER_FLATPAK_CHROME] });
    const { calls, attempt } = makeAttempt();

    await createBrowserEngine(host).launchBestChromium(attempt);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ executablePath: USER_FLATPAK_CHROME });
  });

  it('skips a flatpak app whose launcher is missing', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    // The app directory exists, but flatpak never exported a launcher in it.
    const { host } = fakeHost({ existing: [USER_FLATPAK_APP_DIR] });
    const { calls, attempt } = makeAttempt();

    await createBrowserEngine(host).launchBestChromium(attempt);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({});
  });

  it('falls back to the bundled engine when nothing is installed', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    const { host } = fakeHost();
    const { calls, attempt } = makeAttempt();

    await createBrowserEngine(host).launchBestChromium(attempt);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({});
  });

  it('falls back to the bundled engine when the installed build fails to launch', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    const { host } = fakeHost({ existing: [USER_FLATPAK_CHROME] });
    const { calls, attempt } = makeAttempt(1);

    const browser = await createBrowserEngine(host).launchBestChromium(attempt);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ executablePath: USER_FLATPAK_CHROME });
    expect(calls[1]).toEqual({});
    expect(browser).toBeDefined();
  });

  it('never retries a failed candidate, but still tries the next flatpak app', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    const { host } = fakeHost({
      existing: [USER_FLATPAK_CHROME, USER_FLATPAK_BRAVE],
    });
    const engine = createBrowserEngine(host);

    const first = makeAttempt(2);
    await engine.launchBestChromium(first.attempt);
    expect(first.calls).toHaveLength(3);
    expect(first.calls[0]).toEqual({ executablePath: USER_FLATPAK_CHROME });
    expect(first.calls[1]).toEqual({ executablePath: USER_FLATPAK_BRAVE });
    expect(first.calls[2]).toEqual({});

    const second = makeAttempt();
    await engine.launchBestChromium(second.attempt);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]).toEqual({});
  });

  it('uses the system flatpak root when the per-user root lacks the app', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    const { host } = fakeHost({ existing: [SYSTEM_FLATPAK_CHROME] });
    const { calls, attempt } = makeAttempt();

    await createBrowserEngine(host).launchBestChromium(attempt);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ executablePath: SYSTEM_FLATPAK_CHROME });
  });

  it('honors XDG_DATA_HOME for the per-user flatpak root', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    const xdgChrome = join(
      '/xdg/share/flatpak/app/com.google.Chrome/current/active/export/bin/com.google.Chrome',
    );
    const { host } = fakeHost({
      env: { XDG_DATA_HOME: '/xdg/share' },
      existing: [xdgChrome],
    });
    const { calls, attempt } = makeAttempt();

    await createBrowserEngine(host).launchBestChromium(attempt);

    expect(calls[0]).toEqual({ executablePath: xdgChrome });
  });

  it.each([
    {
      platform: 'darwin' as NodeJS.Platform,
      expected: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      env: {},
    },
    {
      platform: 'linux' as NodeJS.Platform,
      expected: '/usr/bin/google-chrome',
      env: {},
    },
    {
      platform: 'win32' as NodeJS.Platform,
      expected: join('C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      env: { PROGRAMFILES: 'C:\\Program Files' },
    },
  ])('uses the native install table on $platform', async ({ platform, expected, env }) => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    const { host } = fakeHost({
      platform,
      env,
      existing: [expected],
    });
    const { calls, attempt } = makeAttempt();

    await createBrowserEngine(host).launchBestChromium(attempt);

    expect(calls).toHaveLength(1);
    expect(calls[0].executablePath).toBe(expected);
  });

  it('prefers an explicit chrome path over an installed build', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    const { host } = fakeHost({
      env: { WIGOLO_CHROME_PATH: '/opt/chrome/chrome' },
      existing: ['/opt/chrome/chrome', USER_FLATPAK_CHROME],
    });
    const { calls, attempt } = makeAttempt();

    await createBrowserEngine(host).launchBestChromium(attempt);

    expect(calls[0]).toEqual({ executablePath: '/opt/chrome/chrome' });
  });
});

describe('browser-engine: authentic path for the raw-CDP rung', () => {
  beforeEach(() => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'chromium';
    resetConfig();
  });
  afterEach(() => {
    delete process.env.WIGOLO_BROWSER_CHANNEL;
    resetConfig();
  });

  it('is null under the chromium pin', () => {
    const { host } = fakeHost({ existing: [USER_FLATPAK_CHROME] });
    expect(createBrowserEngine(host).resolveAuthenticChromiumPath()).toBeNull();
  });

  it('is the flatpak launcher under the auto channel', () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    const { host } = fakeHost({ existing: [USER_FLATPAK_CHROME] });
    expect(createBrowserEngine(host).resolveAuthenticChromiumPath()).toBe(USER_FLATPAK_CHROME);
  });

  it('is null when only the bundled engine is available', () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    const { host } = fakeHost();
    expect(createBrowserEngine(host).resolveAuthenticChromiumPath()).toBeNull();
  });
});
