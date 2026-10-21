import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// Mock Playwright to avoid actual browser launches. The browser object is
// exposed on the mock so a test can assert on close() without awaiting the
// launch() promise.
vi.mock('playwright', () => {
  function makeMockBrowser(type: string) {
    const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const browser = {
      newContext: vi.fn().mockImplementation(() => {
        const ctx = {
          close: vi.fn().mockResolvedValue(undefined),
          newPage: vi.fn().mockResolvedValue({}),
        };
        contexts.push(ctx);
        return ctx;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    return {
      launch: vi.fn().mockResolvedValue(browser),
      _browser: browser,
      _contexts: contexts,
    };
  }

  return {
    chromium: makeMockBrowser('chromium'),
    firefox: makeMockBrowser('firefox'),
    webkit: makeMockBrowser('webkit'),
  };
});

import { BrowserPool } from '../../../src/fetch/browser-pool.js';
import { chromium } from 'playwright';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type MockBrowser = { close: ReturnType<typeof vi.fn> };
const browserMock = () => (chromium as unknown as { _browser: MockBrowser })._browser;

describe('BrowserPool browser-process idle close', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    vi.mocked(chromium.launch).mockClear();
    browserMock().close.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('closes a prewarmed browser that never served a context', async () => {
    process.env.BROWSER_PROCESS_IDLE_TIMEOUT = '80';
    resetConfig();
    const pool = new BrowserPool();

    await pool.warm();
    expect(chromium.launch).toHaveBeenCalledTimes(1);

    await wait(250);

    expect(browserMock().close).toHaveBeenCalled();
  }, 10000);

  it('closes the browser after the last context is evicted', async () => {
    process.env.MAX_BROWSERS = '3';
    process.env.BROWSER_IDLE_TIMEOUT = '60';
    process.env.BROWSER_PROCESS_IDLE_TIMEOUT = '80';
    resetConfig();
    const pool = new BrowserPool();

    const ctx = await pool.acquire();
    pool.release(ctx);

    // Past the context TTL (context evicted) and the process TTL (browser closed).
    await wait(350);

    expect(browserMock().close).toHaveBeenCalled();
  }, 10000);

  it('does not close the browser while a context is still checked out', async () => {
    process.env.MAX_BROWSERS = '3';
    process.env.BROWSER_IDLE_TIMEOUT = '60';
    process.env.BROWSER_PROCESS_IDLE_TIMEOUT = '80';
    resetConfig();
    const pool = new BrowserPool();

    // Acquire and never release: the browser is in use.
    await pool.acquire();

    await wait(350);

    expect(browserMock().close).not.toHaveBeenCalled();
  }, 10000);

  it('relaunches a fresh browser on the next acquire after an idle close', async () => {
    process.env.MAX_BROWSERS = '3';
    process.env.BROWSER_IDLE_TIMEOUT = '60';
    process.env.BROWSER_PROCESS_IDLE_TIMEOUT = '80';
    resetConfig();
    const pool = new BrowserPool();

    const ctx = await pool.acquire();
    pool.release(ctx);
    await wait(350);

    expect(chromium.launch).toHaveBeenCalledTimes(1);

    const ctx2 = await pool.acquire();
    expect(ctx2).toBeDefined();
    expect(chromium.launch).toHaveBeenCalledTimes(2);
    pool.release(ctx2);
  }, 10000);

  it('keeps the browser resident when the process idle timeout is disabled', async () => {
    process.env.MAX_BROWSERS = '3';
    process.env.BROWSER_IDLE_TIMEOUT = '60';
    process.env.BROWSER_PROCESS_IDLE_TIMEOUT = '0';
    resetConfig();
    const pool = new BrowserPool();

    const ctx = await pool.acquire();
    pool.release(ctx);
    await wait(300);

    expect(browserMock().close).not.toHaveBeenCalled();
  }, 10000);
});
