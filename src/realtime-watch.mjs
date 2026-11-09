// Polling for real-time updates, for anything with a `request(type, payload)`
// function: the Node `Planner` and the browser `PlannerClient`.

export const DEFAULT_REALTIME_INTERVAL_MS = 30_000;
const MIN_ADAPTIVE_DELAY_MS = 1_000;

/**
 * Re-reads the real-time feed on a timer and tells listeners when it changed.
 *
 * Events (all `CustomEvent`s):
 * - `update`: the feed was regenerated; `detail` is the status list of
 *   `refreshRealtime()`. Listeners re-run their searches here.
 * - `poll`: every successful poll, changed or not.
 * - `error`: a poll failed; the previous data stays in use and polling goes on.
 *
 * The next poll is scheduled when the previous one has finished, so slow
 * networks never pile requests up.
 *
 * By default polls are timed to the feed: the status of a poll says when the
 * next copy is expected (`nextCheckIn`, learned from the feed's HTTP
 * `Last-Modified` times), so a new copy is seen a second or two after it is
 * published instead of up to `intervalMs` later. `intervalMs` is then the wait
 * when the feed gives no timing, and a poll that finds nothing new yet is
 * a small HEAD request. With `adaptive: false` every poll is `intervalMs` apart.
 */
export class RealtimeWatcher extends EventTarget {
  constructor(
    refresh,
    { intervalMs = DEFAULT_REALTIME_INTERVAL_MS, adaptive = true } = {},
  ) {
    super();
    if (!Number.isFinite(intervalMs) || intervalMs < 1000)
      throw new RangeError("intervalMs must be at least 1000");
    this.refresh = refresh;
    this.intervalMs = intervalMs;
    this.adaptive = adaptive;
    this.timer = undefined;
    this.running = false;
    this.polling = false;
    this.failed = false;
    /** The status of the last successful poll. */
    this.status = undefined;
  }

  /** Start polling; the first poll happens now unless `immediate` is false. */
  start({ immediate = true } = {}) {
    if (this.running) return this;
    this.running = true;
    if (immediate) this.pollNow();
    else this.schedule();
    return this;
  }

  /** Stop polling. A poll already in flight finishes but is not reported. */
  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    return this;
  }

  /** Milliseconds until the next poll: the feed's own timing, else `intervalMs`. */
  delay() {
    // After a failed poll the old timing means nothing: wait the plain interval.
    if (!this.adaptive || !this.status || this.failed) return this.intervalMs;
    const hints = this.status
      .map((source) => source.nextCheckIn)
      .filter((wait) => Number.isFinite(wait));
    return hints.length
      ? Math.max(MIN_ADAPTIVE_DELAY_MS, Math.min(...hints))
      : this.intervalMs;
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.running)
      this.timer = setTimeout(() => this.pollNow(), this.delay());
  }

  /** Poll right away, for example when a hidden page becomes visible again. */
  async pollNow() {
    if (this.polling) return this.status;
    clearTimeout(this.timer);
    this.polling = true;
    try {
      const status = await this.refresh();
      if (!this.running) return status;
      this.status = status;
      this.failed = false;
      this.dispatchEvent(new CustomEvent("poll", { detail: status }));
      if (status.some((source) => source.changed))
        this.dispatchEvent(new CustomEvent("update", { detail: status }));
      return status;
    } catch (error) {
      this.failed = true;
      if (this.running)
        this.dispatchEvent(new CustomEvent("error", { detail: error }));
      return undefined;
    } finally {
      this.polling = false;
      this.schedule();
    }
  }
}

export const realtimeMethods = {
  /**
   * Fetch the real-time feed(s) of the timetable now and apply them to every
   * later search. Resolves to one status per source, with `changed` telling
   * whether the feed differs from the last fetch.
   */
  refreshRealtime() {
    return this.request("realtime", {});
  },
  /**
   * Poll the real-time feed, timed to when it is published (every 30 seconds
   * when it gives no timing), and emit `update` when it changes. Call `.stop()` on the result to end polling.
   */
  watchRealtime(options) {
    return new RealtimeWatcher(() => this.refreshRealtime(), options).start(
      options,
    );
  },
};

export function addRealtimeMethods(target) {
  for (const [name, method] of Object.entries(realtimeMethods))
    Object.defineProperty(target, name, {
      value: method,
      writable: true,
      configurable: true,
    });
  return target;
}
