import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { resetConfig } from '../../../src/config.js';
import {
  cdpDirectConnect,
  cdpDirectFetch,
  loadCRI,
  _setCriForTests,
  _setCdpDirectFetchDepsForTests,
  _setProcessKillForTests,
  type CdpDirectFetchDeps,
  type CdpSend,
  type CdpTransport,
} from '../../../src/fetch/cdp-direct.js';

/**
 * The engine's host is a FAKE: the rung resolves its binary through the engine,
 * so the fake host decides which "installed" build exists.
 */
const engineState = vi.hoisted(() => ({
  existing: [] as string[],
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
          exists: (path) => engineState.existing.includes(path),
        });
      }
      return engineState.engine;
    },
  };
});

import { getBrowserEngine } from '../../../src/fetch/browser-engine.js';

// A recording CDP transport: captures every send(method, params) so a test can
// assert the leak-free invariant — that the connect/eval sequence issues ZERO
// `Runtime.enable` and ZERO `Target.setAutoAttach`.
function makeRecordingTransport(overrides?: {
  onSend?: (method: string, params?: Record<string, unknown>) => unknown;
}): {
  transport: CdpTransport;
  calls: Array<{ method: string; params?: Record<string, unknown> }>;
  closed: () => boolean;
} {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let closedFlag = false;
  const send: CdpSend = async (method, params) => {
    calls.push({ method, params });
    if (overrides?.onSend) {
      const r = overrides.onSend(method, params);
      if (r !== undefined) return r;
    }
    // Default happy-path responses for the commands the handle issues.
    switch (method) {
      case 'Page.createIsolatedWorld':
        return { executionContextId: 42 };
      case 'Runtime.evaluate':
        return { result: { type: 'string', value: '<html><body>hello</body></html>' } };
      case 'Page.navigate':
        return { frameId: 'frame-1' };
      default:
        return {};
    }
  };
  const transport: CdpTransport = {
    send,
    close: async () => {
      closedFlag = true;
    },
  };
  return { transport, calls, closed: () => closedFlag };
}

describe('cdp-direct — leak-free raw-CDP connect', () => {
  beforeEach(() => {
    _setCriForTests(undefined);
  });
  afterEach(() => {
    _setCriForTests(undefined);
    vi.restoreAllMocks();
  });

  it('connect + navigate + getContentHtml issues NO Runtime.enable and NO Target.setAutoAttach', async () => {
    const { transport, calls } = makeRecordingTransport();
    const handle = await cdpDirectConnect({ transport });
    expect(handle).not.toBeNull();

    await handle!.navigate('https://example.com');
    const html = await handle!.getContentHtml();
    expect(html).toContain('hello');

    const methods = calls.map((c) => c.method);
    // The whole point: these fingerprinted handshake commands must never appear.
    expect(methods).not.toContain('Runtime.enable');
    expect(methods).not.toContain('Target.setAutoAttach');
  });

  it('evaluates through an isolated world, never the default auto-enabled Runtime path', async () => {
    const { transport, calls } = makeRecordingTransport();
    const handle = await cdpDirectConnect({ transport });
    await handle!.navigate('https://example.com');
    await handle!.getContentHtml();

    const methods = calls.map((c) => c.method);
    // Isolated world must be created before evaluation.
    expect(methods).toContain('Page.createIsolatedWorld');

    const isoIdx = methods.indexOf('Page.createIsolatedWorld');
    const evalIdx = methods.indexOf('Runtime.evaluate');
    expect(evalIdx).toBeGreaterThan(isoIdx);

    // Runtime.evaluate must be scoped to the isolated world's contextId.
    const evalCall = calls.find((c) => c.method === 'Runtime.evaluate');
    expect(evalCall?.params?.contextId).toBe(42);
  });

  it('getContentHtml returns the isolated-world eval string', async () => {
    const { transport } = makeRecordingTransport({
      onSend: (method) =>
        method === 'Runtime.evaluate'
          ? { result: { type: 'string', value: '<html>ISO</html>' } }
          : undefined,
    });
    const handle = await cdpDirectConnect({ transport });
    await handle!.navigate('https://x.test');
    expect(await handle!.getContentHtml()).toBe('<html>ISO</html>');
  });

  it('close() detaches the transport and is idempotent', async () => {
    const { transport, closed } = makeRecordingTransport();
    const handle = await cdpDirectConnect({ transport });
    expect(closed()).toBe(false);
    await handle!.close();
    expect(closed()).toBe(true);
    // Idempotent — second close does not throw.
    await expect(handle!.close()).resolves.toBeUndefined();
  });

  it('honors an already-aborted signal by returning null (no connect)', async () => {
    const { transport, calls } = makeRecordingTransport();
    const controller = new AbortController();
    controller.abort();
    const handle = await cdpDirectConnect({ transport, signal: controller.signal });
    expect(handle).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('operations after close reject safely (abort-safe teardown)', async () => {
    const { transport } = makeRecordingTransport();
    const handle = await cdpDirectConnect({ transport });
    await handle!.close();
    await expect(handle!.getContentHtml()).rejects.toThrow();
  });
});

describe('cdp-direct — graceful optional-dependency fallback', () => {
  beforeEach(() => {
    _setCriForTests(undefined);
  });
  afterEach(() => {
    _setCriForTests(undefined);
  });

  it('loadCRI returns null when the optional dep is absent', async () => {
    // Simulate an unavailable dep by installing an explicit null override.
    _setCriForTests(null);
    const cri = await loadCRI();
    expect(cri).toBeNull();
  });

  it('cdpDirectConnect returns null (no throw) when neither transport nor CRI is available', async () => {
    _setCriForTests(null);
    const handle = await cdpDirectConnect({
      cdpUrl: 'http://127.0.0.1:9222',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
    });
    expect(handle).toBeNull();
  });

  it('cdpDirectConnect uses CRI to build a transport when the dep is present', async () => {
    const calls: string[] = [];
    // Minimal CRI factory stub: returns a client with send + close.
    const criFactory = vi.fn(async () => ({
      send: async (method: string, params?: Record<string, unknown>) => {
        calls.push(method);
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'Runtime.evaluate') return { result: { type: 'string', value: '<html/>' } };
        return {};
      },
      close: async () => {},
    }));
    _setCriForTests(criFactory);

    const handle = await cdpDirectConnect({
      cdpUrl: 'http://127.0.0.1:9222',
      // Provide the page target directly so we don't need a live /json endpoint.
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
    });
    expect(handle).not.toBeNull();
    expect(criFactory).toHaveBeenCalledTimes(1);

    await handle!.navigate('https://example.com');
    await handle!.getContentHtml();
    expect(calls).not.toContain('Runtime.enable');
    expect(calls).not.toContain('Target.setAutoAttach');
    await handle!.close();
  });
});

// A flatpak-installed Chrome, as the engine resolves it.
const INSTALLED_CHROME =
  '/home/tester/.local/share/flatpak/app/com.google.Chrome/current/active/export/bin/com.google.Chrome';

/** A fake spawned child: the rung only needs the EventEmitter surface. */
class FakeChild extends EventEmitter {
  pid = 4242;
  kill(): boolean {
    setImmediate(() => this.emit('exit', 0, null));
    return true;
  }
}

function makeRungDeps(spawn: ReturnType<typeof vi.fn>): CdpDirectFetchDeps {
  return {
    resolveChrome: () => getBrowserEngine().resolveAuthenticChromiumPath(),
    spawn: spawn as unknown as CdpDirectFetchDeps['spawn'],
    isReachable: async () => true,
    mkdtemp: async (prefix: string) => `${prefix}fake`,
    rm: async () => {},
    // No transport: the rung yields nothing and the caller falls back.
    connectTransport: async () => null,
  };
}

describe('cdp-direct — the rung only ever drives an AUTHENTIC installed build', () => {
  beforeEach(() => {
    resetConfig();
    engineState.existing = [];
    engineState.engine = null;
    _setCdpDirectFetchDepsForTests(undefined);
    // Never signal a real process group: the fake child's pid is not real.
    _setProcessKillForTests(() => {});
  });
  afterEach(() => {
    delete process.env.WIGOLO_BROWSER_CHANNEL;
    resetConfig();
    _setCdpDirectFetchDepsForTests(undefined);
    _setProcessKillForTests(undefined);
  });

  it('under the chromium pin the rung yields nothing and never spawns', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'chromium';
    resetConfig();
    engineState.existing = [INSTALLED_CHROME];
    const spawn = vi.fn(() => new FakeChild());
    _setCdpDirectFetchDepsForTests(makeRungDeps(spawn));

    const result = await cdpDirectFetch('https://example.com', {});

    expect(result).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('under the auto channel the rung spawns the installed build', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
    engineState.existing = [INSTALLED_CHROME];
    const spawn = vi.fn(() => new FakeChild());
    _setCdpDirectFetchDepsForTests(makeRungDeps(spawn));

    const result = await cdpDirectFetch('https://example.com', {});

    // The spawned binary IS the resolved installed build.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe(INSTALLED_CHROME);
    // No transport → the rung yields nothing and the caller falls back.
    expect(result).toBeNull();
  });
});
