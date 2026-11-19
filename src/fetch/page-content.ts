import type { Page } from 'playwright';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

/** Errors that mean the page is mid-navigation — callers retry these, never fall back. */
export const NAV_RACE_PATTERN =
  /execution context (?:was )?destroyed|page is navigating|frame.*detached|target closed/i;

/**
 * Read the page's serialized HTML.
 *
 * Playwright's `page.content()` runs an injected serializer inside the page.
 * Non-Chromium CDP engines can reject that script with a JS error even though
 * the DOM is fully readable — e.g. Kitesurf's Boa runtime throws
 * "not a callable function (callee=undefined)" on every call. In that case,
 * evaluate `documentElement.outerHTML` directly: it returns the same HTML
 * without the injected-script dependency.
 *
 * Navigation races are deliberately NOT swallowed — the browser pool's retry
 * loop owns those, and falling back mid-nav would capture a partial document.
 */
export async function readPageHtml(page: Page, url?: string): Promise<string> {
  try {
    return await page.content();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (NAV_RACE_PATTERN.test(msg)) throw err;
    log.debug('page.content failed, using documentElement.outerHTML', {
      url,
      error: msg.slice(0, 200),
    });
    return await page.evaluate(() => document.documentElement.outerHTML);
  }
}
