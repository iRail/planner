// Polling for real-time updates, for anything with a `request(type, payload)`
// function: the Node `Planner` and the browser `PlannerClient`.

export const DEFAULT_REALTIME_INTERVAL_MS = 30_000;

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
 */
export class RealtimeWatcher extends EventTarget {
  constructor(refresh, { intervalMs = DEFAULT_REALTIME_INTERVAL_MS } = {}) {
    super();
    if (!Number.isFinite(intervalMs) || intervalMs < 1000)
      throw new RangeError("intervalMs must be at least 1000");
    this.refresh = refresh;
    this.intervalMs = intervalMs;
    this.timer = undefined;
    this.running = false;
    this.polling = false;
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

  schedule() {
    clearTimeout(this.timer);
    if (this.running)
      this.timer = setTimeout(() => this.pollNow(), this.intervalMs);
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
      this.dispatchEvent(new CustomEvent("poll", { detail: status }));
      if (status.some((source) => source.changed))
        this.dispatchEvent(new CustomEvent("update", { detail: status }));
      return status;
    } catch (error) {
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
   * Poll the real-time feed (every 30 seconds by default) and emit `update`
   * when it changes. Call `.stop()` on the result to end polling.
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
