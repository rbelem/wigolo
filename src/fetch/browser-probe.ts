import { existsSync } from 'node:fs';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import { getBrowserEngine } from './browser-engine.js';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

const BROWSER_API: Record<BrowserName, BrowserType> = {
  chromium,
  firefox,
  webkit,
};

export interface BrowserProbeResult {
  /** Browser binary resolves to a path that exists on disk. */
  onDisk: boolean;
  /** Browser actually launched (and closed) headless — the real health check. */
  launchable: boolean;
  /** Resolved executable path (empty when executablePath() throws). */
  execPath: string;
  /** Which build was probed: an installed one the tier selected, or Playwright's. */
  origin: 'installed' | 'bundled';
  /** Failure detail when onDisk is false or launch threw. */
  error?: string;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`launch timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Single source of truth for browser health, shared by `wigolo warmup` and
 * `wigolo doctor` so they can never disagree (GH #116). Resolves a Playwright
 * `executablePath()`, checks it exists on disk, then performs a real
 * `launch({ headless: true })` + `close()` smoke-test under a timeout.
 *
 * A browser is only healthy when it actually launches: on bare Linux the
 * binary can be on disk yet fail at launch because OS shared libs (libnss3,
 * libgbm, ...) are missing. existsSync alone would lie; the launch smoke-test
 * is the honest "does it work" result.
 *
 * `preferInstalled` answers a different question, and only `doctor` wants it.
 * With it set, chromium probes the build the browser tier would really launch,
 * which may be an installed one (Flatpak Chrome or Brave). Probing the bundled
 * build instead reports a missing browser on a host whose fetches work.
 * `warmup` leaves it off: its question is whether the bundled engine is
 * installed, so it must keep measuring that.
 */
export async function probeBrowser(
  name: BrowserName,
  opts: { launchTimeoutMs?: number; preferInstalled?: boolean } = {},
): Promise<BrowserProbeResult> {
  const api = BROWSER_API[name];

  const installed =
    name === 'chromium' && opts.preferInstalled
      ? getBrowserEngine().resolveAuthenticChromiumPath()
      : null;

  let execPath = '';
  let onDisk = false;
  if (installed) {
    execPath = installed;
    onDisk = existsSync(installed);
  } else {
    try {
      execPath = api.executablePath();
      onDisk = !!execPath && existsSync(execPath);
    } catch (err) {
      return {
        onDisk: false,
        launchable: false,
        execPath: '',
        origin: 'bundled',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const origin: BrowserProbeResult['origin'] = installed ? 'installed' : 'bundled';

  if (!onDisk) {
    return {
      onDisk: false,
      launchable: false,
      execPath,
      origin,
      error: installed
        ? `selected browser missing on disk: ${installed}`
        : 'browser binary missing on disk',
    };
  }

  const timeout = opts.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  try {
    const launchOpts = installed ? { headless: true, executablePath: installed } : { headless: true };
    const browser = await withTimeout(api.launch(launchOpts), timeout);
    try {
      await browser.close();
    } catch {
      // Close failures don't change the result — it launched.
    }
    return { onDisk: true, launchable: true, execPath, origin };
  } catch (err) {
    return {
      onDisk: true,
      launchable: false,
      execPath,
      origin,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
