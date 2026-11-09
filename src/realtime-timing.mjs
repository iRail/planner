// When to look at a GTFS Realtime feed again. A feed is regenerated on a
// schedule (the iRail one every 30 s) and its HTTP response says when:
// `Last-Modified` is when this copy was published, `ETag` identifies it, and
// `Date` is the server's clock. Polling at a fixed interval sees a new copy up
// to one interval late; polling right after the next one is due sees it within
// a second or two, and a cheap HEAD request can tell whether it is there.

const MIN_PERIOD_MS = 5_000;
const MAX_PERIOD_MS = 600_000;
const HISTORY = 6; // publications to estimate the period from
const MARGIN_MS = 1_000; // after the expected publication, before looking
export const RETRY_MS = 2_000; // when it was due but is not there yet

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** What a response says about its copy of the feed, `undefined` for what it omits. */
export function feedValidators(headers, now = Date.now()) {
  const stamp = (name) => {
    const parsed = Date.parse(headers?.get?.(name) ?? "");
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const date = stamp("date");
  return {
    etag: headers?.get?.("etag") ?? undefined,
    lastModified: stamp("last-modified"),
    // The server's clock minus ours. `Date` has whole seconds, so this runs up
    // to a second low, which only makes us wait a little longer. Browsers hide
    // `Date` from other origins: then our own clock has to do.
    clockOffset: date === undefined ? undefined : date - now,
  };
}

/** Whether two responses carry the same copy; false when neither can say. */
export function sameCopy(a, b) {
  if (a?.etag && b?.etag) return a.etag === b.etag;
  if (a?.lastModified !== undefined && b?.lastModified !== undefined)
    return a.lastModified === b.lastModified;
  return false;
}

/**
 * Follows when one source's feed is published. `see(validators, now)` takes
 * what a response said, `nextCheckIn(now)` says how long to wait before
 * looking again (milliseconds), or `undefined` when it cannot tell.
 */
export function createFeedClock() {
  let published = []; // distinct publication times, oldest first
  let offset = 0;

  const period = () => {
    if (published.length < 2) return undefined;
    const gaps = published.slice(1).map((time, i) => time - published[i]);
    return Math.min(MAX_PERIOD_MS, Math.max(MIN_PERIOD_MS, median(gaps)));
  };

  return {
    /** Note a response. `publishedAt` stands in when it has no `Last-Modified`. */
    see(validators, now = Date.now(), publishedAt) {
      if (validators.clockOffset !== undefined) offset = validators.clockOffset;
      const time = validators.lastModified ?? publishedAt;
      if (time === undefined) return;
      if (!published.length || time > published.at(-1))
        published = [...published, time].slice(-HISTORY);
    },
    /** When the newest copy was published, epoch milliseconds. */
    published: () => published.at(-1),
    /** How old the newest copy is by the server's clock, in milliseconds. */
    age(now = Date.now()) {
      return published.length
        ? Math.max(0, now + offset - published.at(-1))
        : undefined;
    },
    period,
    nextCheckIn(now = Date.now()) {
      const every = period();
      if (every === undefined) return undefined;
      const wait = published.at(-1) + every + MARGIN_MS - (now + offset);
      // Not yet due: wait for it. A wait of more than two periods can only be
      // a wrong clock, so do not trust it.
      if (wait > 0) return wait <= 2 * every ? Math.ceil(wait) : undefined;
      // Due but not published: look again soon, for one more period; after
      // that the feed is late or paused and the plain interval is gentler.
      return -wait <= every ? RETRY_MS : undefined;
    },
  };
}
