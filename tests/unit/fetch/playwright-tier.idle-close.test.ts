import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

const closeBrowser = vi.fn().mockResolvedValue(undefined);
const closeContext = vi.fn().mockResolvedValue(undefined);
const launch = vi.fn().mockResolvedValue({
  newContext: vi.fn().mockResolvedValue({
    newPage: vi.fn().mockResolvedValue({
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ textLen: 1000, nodes: 20 }),
      content: vi.fn().mockResolvedValue('<html><body>page</body></html>'),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    close: closeContext,
  }),
  close: closeBrowser,
});

vi.mock('playwright', () => {
  const stub = { launch, executablePath: () => '/fake/chrome' };
  return { chromium: stub, firefox: stub, webkit: stub };
});

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: () => true };
});

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('playwright-tier daemon browser idle close', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    closeBrowser.mockClear();
    closeContext.mockClear();
    launch.mockClear();
  });

  afterEach(async () => {
    process.env = originalEnv;
    resetConfig();
    const { closeDaemonBrowser } = await import('../../../src/fetch/playwright-tier.js');
    await closeDaemonBrowser().catch(() => undefined);
    vi.resetModules();
  });

  it('closes the daemon browser after the idle window', async () => {
    process.env.BROWSER_PROCESS_IDLE_TIMEOUT = '80';
    resetConfig();
    const { fetchWithPlaywright } = await import('../../../src/fetch/playwright-tier.js');

    await fetchWithPlaywright('https://example.com');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(closeBrowser).not.toHaveBeenCalled();

    await wait(250);

    expect(closeContext).toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalled();
  }, 10000);

  it('keeps the daemon browser resident when the idle timeout is disabled', async () => {
    process.env.BROWSER_PROCESS_IDLE_TIMEOUT = '0';
    resetConfig();
    const { fetchWithPlaywright } = await import('../../../src/fetch/playwright-tier.js');

    await fetchWithPlaywright('https://example.com');
    await wait(200);

    expect(closeBrowser).not.toHaveBeenCalled();
  }, 10000);

  it('relaunches the browser on the next fetch after an idle close', async () => {
    process.env.BROWSER_PROCESS_IDLE_TIMEOUT = '80';
    resetConfig();
    const { fetchWithPlaywright } = await import('../../../src/fetch/playwright-tier.js');

    await fetchWithPlaywright('https://example.com');
    await wait(250);
    expect(launch).toHaveBeenCalledTimes(1);

    await fetchWithPlaywright('https://example.com');
    expect(launch).toHaveBeenCalledTimes(2);
  }, 10000);
});
