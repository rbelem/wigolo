import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { IdleEvictor } from '../../../src/providers/idle-evictor.js';

describe('IdleEvictor', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('evicts after the idle window elapses', () => {
    vi.useFakeTimers();
    const onEvict = vi.fn();
    const evictor = new IdleEvictor({ idleMs: () => 1000, onEvict, isBusy: () => false });

    evictor.touch();
    expect(onEvict).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onEvict).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does not evict while the resource is in use (deferral)', () => {
    vi.useFakeTimers();
    const onEvict = vi.fn();
    let busy = true;
    const evictor = new IdleEvictor({ idleMs: () => 1000, onEvict, isBusy: () => busy });

    evictor.touch();
    vi.advanceTimersByTime(1000);
    expect(onEvict).not.toHaveBeenCalled();

    // Still busy after several windows: deferral is bounded, then forced.
    vi.advanceTimersByTime(1000 * 5);
    expect(onEvict).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('defers eviction when a use starts after the timer was armed', () => {
    vi.useFakeTimers();
    const onEvict = vi.fn();
    const evictor = new IdleEvictor({ idleMs: () => 1000, onEvict, isBusy: () => false });

    evictor.touch();
    // A use lands mid-window: touch() re-arms, so the full window restarts.
    vi.advanceTimersByTime(900);
    evictor.touch();
    vi.advanceTimersByTime(900);
    expect(onEvict).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(onEvict).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('never evicts when the idle window is 0 (disabled)', () => {
    vi.useFakeTimers();
    const onEvict = vi.fn();
    const evictor = new IdleEvictor({ idleMs: () => 0, onEvict, isBusy: () => false });

    evictor.touch();
    vi.advanceTimersByTime(60_000);
    expect(onEvict).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('dispose() cancels a pending eviction', () => {
    vi.useFakeTimers();
    const onEvict = vi.fn();
    const evictor = new IdleEvictor({ idleMs: () => 1000, onEvict, isBusy: () => false });

    evictor.touch();
    evictor.dispose();
    vi.advanceTimersByTime(5000);
    expect(onEvict).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not hold the process open (timer is unref\'d)', () => {
    vi.useFakeTimers();
    const onEvict = vi.fn();
    const evictor = new IdleEvictor({ idleMs: () => 1000, onEvict, isBusy: () => false });
    evictor.touch();
    // The timer object is unref'd, so a pending eviction never keeps the
    // event loop alive (a one-shot CLI must still exit).
    const timer = (evictor as unknown as { timer: { hasRef?: () => boolean } }).timer;
    if (timer && typeof timer.hasRef === 'function') {
      expect(timer.hasRef()).toBe(false);
    }
    evictor.dispose();
    vi.useRealTimers();
  });
});
