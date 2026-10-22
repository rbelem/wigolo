import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

/**
 * Where a candidate browser binary came from. Ranked `override > native >
 * flatpak`; the bundled engine is the implicit last rank (it has no origin
 * because it is not an installed browser).
 */
export type BrowserOrigin = 'override' | 'native' | 'flatpak';

/** An installed Chromium binary the engine may launch. */
export interface InstalledBrowser {
  /** Absolute path to the binary. */
  readonly path: string;
  /** Stable identity of the candidate (`flatpak:<app-id>` or the path). */
  readonly id: string;
  readonly origin: BrowserOrigin;
}

/**
 * The host facts the engine needs. Injected so the discovery + ranking logic
 * is unit-testable with NO filesystem access and NO real browser.
 */
export interface HostProbe {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly exists: (path: string) => boolean;
}

/**
 * Chooses WHICH installed Chromium binary a launch should use, and degrades to
 * the bundled engine when the chosen build cannot start.
 */
export interface BrowserEngine {
  /**
   * Launch the best candidate, falling back through the plan. The plan always
   * ends with the bundled engine, so a broken installed build degrades instead
   * of throwing. `attempt` must launch exactly one candidate.
   */
  launchBestChromium(
    attempt: (options: { executablePath?: string }) => Promise<Browser>,
  ): Promise<Browser>;
  /**
   * Absolute path to an AUTHENTIC installed Chromium for the raw-CDP rung, or
   * null. That rung spawns its own child and must never drive the bundled build.
   */
  resolveAuthenticChromiumPath(): string | null;
}

/**
 * Flatpak apps whose sandboxed browser the engine may launch. Only the app id
 * is needed: flatpak ships its own launcher at
 * `<root>/<app-id>/current/active/export/bin/<app-id>`, and that launcher
 * re-execs the app inside its sandbox. The browser therefore keeps the app's
 * own runtime, no internal binary layout is hardcoded here, and no host shared
 * libraries are needed. The `current` and `active` path components are
 * symlinks flatpak maintains, so no commit-hash globbing is needed either.
 *
 * `org.chromium.Chromium` is deliberately EXCLUDED: it cannot start outside
 * its sandbox because its build needs libs its runtime does not expose.
 */
const FLATPAK_APPS: ReadonlyArray<{ id: string }> = [
  { id: 'com.google.Chrome' },
  { id: 'com.brave.Browser' },
];

/** System-wide flatpak install root, searched after the per-user one. */
const SYSTEM_FLATPAK_ROOT = join('/var', 'lib', 'flatpak', 'app');

/**
 * Per-platform locations of an installed Chromium, in preference order. A
 * distro launcher here may legitimately be a shell script, so these candidates
 * are not inspected beyond their existence.
 */
function nativeCandidates(host: HostProbe): string[] {
  if (host.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (host.platform === 'win32') {
    return [
      join(host.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      join(host.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      join(host.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

/** Flatpak app roots: the per-user data home first, then the system root. */
function flatpakRoots(host: HostProbe): string[] {
  const dataHome = host.env.XDG_DATA_HOME?.trim();
  const base = dataHome && dataHome.length > 0 ? dataHome : join(host.home, '.local', 'share');
  return [join(base, 'flatpak', 'app'), SYSTEM_FLATPAK_ROOT];
}

/** A launch candidate: an installed binary, or the bundled engine. */
type Candidate =
  | { kind: 'bundled' }
  | { kind: 'installed'; browser: InstalledBrowser };

/**
 * The launch plan: every candidate the engine may try, best first. The bundled
 * engine is always last, so a plan always has a working fallback.
 */
function buildPlan(host: HostProbe): Candidate[] {
  // The pinned bundled engine is the whole plan: the host filesystem is never
  // touched, so a default install behaves identically on every machine.
  if (getConfig().browserChannel === 'chromium') {
    return [{ kind: 'bundled' }];
  }

  const candidates: Candidate[] = [];

  const override = host.env.WIGOLO_CHROME_PATH || host.env.CHROME_PATH;
  if (override && host.exists(override)) {
    candidates.push({
      kind: 'installed',
      browser: { path: override, id: override, origin: 'override' },
    });
  }

  for (const path of nativeCandidates(host)) {
    if (!path || !host.exists(path)) continue;
    candidates.push({
      kind: 'installed',
      browser: { path, id: path, origin: 'native' },
    });
  }

  for (const app of FLATPAK_APPS) {
    let found: InstalledBrowser | null = null;
    for (const root of flatpakRoots(host)) {
      const path = join(root, app.id, 'current', 'active', 'export', 'bin', app.id);
      if (!host.exists(path)) continue;
      found = { path, id: `flatpak:${app.id}`, origin: 'flatpak' };
      break;
    }
    if (found) candidates.push({ kind: 'installed', browser: found });
  }

  candidates.push({ kind: 'bundled' });
  return candidates;
}

/** The real host: the running process's own platform, env and home. */
function defaultHost(): HostProbe {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: (path) => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Build an engine over a host probe. Each engine owns its own failure memo,
 * so one broken installed build is probed once per engine, not once per
 * process.
 */
export function createBrowserEngine(host: HostProbe = defaultHost()): BrowserEngine {
  // Candidates whose launch threw. Keyed by InstalledBrowser.id so a failed
  // build is never repaid on a later launch.
  const failed = new Set<string>();

  return {
    async launchBestChromium(attempt) {
      for (const candidate of buildPlan(host)) {
        if (candidate.kind === 'bundled') {
          return await attempt({});
        }
        const { browser } = candidate;
        if (failed.has(browser.id)) continue;
        try {
          return await attempt({ executablePath: browser.path });
        } catch (err) {
          failed.add(browser.id);
          log.info('installed browser launch failed, falling back', {
            id: browser.id,
            origin: browser.origin,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      throw new Error('no launchable browser candidate');
    },

    resolveAuthenticChromiumPath() {
      for (const candidate of buildPlan(host)) {
        if (candidate.kind === 'installed') return candidate.browser.path;
      }
      return null;
    },
  };
}

let engine: BrowserEngine | null = null;

/** Process-wide engine used by production callers. */
export function getBrowserEngine(): BrowserEngine {
  if (!engine) engine = createBrowserEngine();
  return engine;
}
