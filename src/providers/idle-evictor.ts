/**
 * Idle eviction for an owner-managed resource whose quiescence the owner can
 * observe — today the pooled browser PROCESS and the daemon browser. The
 * resource's owner calls `touch()` after each use and `dispose()` to stop the
 * countdown; the evictor releases the resource once it has gone unused for the
 * configured window.
 *
 * Model sessions (fastembed, the ONNX cross-encoder) use `idle-unload.ts`
 * instead: the factory there owns the instance, so an in-flight count and a
 * Proxy wrapper are a better fit than a busy predicate.
 *
 * Why this exists: the Chromium process tree parks ~1.2 GB of memory the JS
 * heap does not own, so it survives until something explicitly closes it.
 * Without an idle window, a daemon that served one request holds it for its
 * whole lifetime.
 *
 * Three races are handled explicitly:
 *  - a use that starts after the timer was armed: the elapsed-time re-check
 *    re-arms instead of evicting under an active caller;
 *  - an operation still in flight when the timer fires: eviction is deferred
 *    (bounded — a hung operation must not pin the resource forever);
 *  - a use that starts while the release is running: `onEvict` must be
 *    idempotent, and the owner's own load path re-creates the resource.
 */
export interface IdleEvictorOptions {
  /** Current idle window in ms. Read at arm time; 0 (or less) disables eviction. */
  idleMs: () => number;
  /** Release the resource. Must be idempotent and must not throw. */
  onEvict: () => void;
  /** True while the resource is in use. */
  isBusy: () => boolean;
  /** Injected clock (tests). */
  now?: () => number;
  /** Max consecutive deferrals before eviction is forced anyway. */
  maxDeferrals?: number;
}

export class IdleEvictor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastUseAt = 0;
  private deferrals = 0;
  private readonly now: () => number;

  constructor(private readonly opts: IdleEvictorOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Mark the resource as used and (re)arm the idle window. */
  touch(): void {
    this.lastUseAt = this.now();
    this.deferrals = 0;
    this.arm();
  }

  /** Stop tracking the resource. Safe to call more than once. */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(delayMs?: number): void {
    this.dispose();
    const idleMs = this.opts.idleMs();
    if (idleMs <= 0) return;
    const delay = delayMs ?? idleMs;
    const timer = setTimeout(() => {
      this.timer = null;
      this.check();
    }, delay);
    // Never hold the process open just to wait out an idle window.
    timer.unref?.();
    this.timer = timer;
  }

  private check(): void {
    const idleMs = this.opts.idleMs();
    if (idleMs <= 0) return;

    // A use that started after the timer was armed: wait out the remainder
    // rather than releasing the resource under an active caller.
    const elapsed = this.now() - this.lastUseAt;
    if (elapsed < idleMs) {
      this.arm(idleMs - elapsed);
      return;
    }

    if (this.opts.isBusy()) {
      // In use. Defer, but not forever: an operation that never completes
      // would otherwise pin the resource for the life of the process.
      const maxDeferrals = this.opts.maxDeferrals ?? 3;
      if (this.deferrals < maxDeferrals) {
        this.deferrals++;
        this.arm();
        return;
      }
    }

    this.opts.onEvict();
  }
}
