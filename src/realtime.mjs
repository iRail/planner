// Real-time overlay for scheduled connection pages.
//
// The manifest may advertise GTFS Realtime feeds (`realtime`, each a
// `GtfsRealtimeFeed` with a `tripTemplate` that turns a feed `trip_id` into the
// trip IRI used by the trips table). `buildRealtime` matches a decoded feed to
// the timetable's trips and stops; `applyRealtime` then rewrites a page of
// scheduled connections *as it is read*, so the planner, the liveboard and the
// vehicle calls all see the same adjusted network:
//
// - delays move a connection's departure and arrival; a connection never leaves
//   before its scheduled time, and never arrives before it leaves;
// - the delay of the last known stop carries on to the stops after it, as the
//   GTFS Realtime specification says;
// - canceled trips lose their connections (or keep them, flagged, for callers
//   that want to show them);
// - skipped stops can no longer be boarded or left, but the train still rides
//   through them;
// - delays can reorder connections, so the page is sorted again.
//
// The cached pages are never modified: the scheduled timetable stays the base
// and the overlay is applied to a copy, per feed update.

import uriTemplates from "uri-templates";
import { resourceUrl } from "./lc-timetable.mjs";

/** Bits of the `flags` column of an overlaid batch. */
export const TRIP_CANCELED = 1;
export const DEPARTURE_SKIPPED = 2;
export const ARRIVAL_SKIPPED = 4;

// Page bounds are widened by the largest delay, so a connection that slipped
// past the end of its page is still found, but never by more than a page.
const MAX_MARGIN_SECONDS = 6 * 3600;
const MARGIN_SLACK_SECONDS = 600;

const tripKey = (trip, serviceDate) => trip * 1e9 + serviceDate;

/** The `GtfsRealtimeFeed` entries of a manifest, as `{ url, tripTemplate }`. */
export function realtimeFeeds(manifest, manifestUrl) {
  const entries = manifest.realtime
    ? Array.isArray(manifest.realtime)
      ? manifest.realtime
      : [manifest.realtime]
    : [];
  return entries
    .filter((entry) =>
      [].concat(entry?.["@type"] ?? []).includes("GtfsRealtimeFeed"),
    )
    .map((entry) => ({
      url: resourceUrl(entry, manifestUrl),
      tripTemplate: entry.tripTemplate,
    }));
}

const tripIndexes = new WeakMap();
function tripIndexOf(source) {
  if (!tripIndexes.has(source)) {
    const index = new Map();
    const iris = source.tables.trips.getChild("iri");
    for (let i = 0; i < iris.length; i += 1) index.set(iris.get(i), i);
    tripIndexes.set(source, index);
  }
  return tripIndexes.get(source);
}

const stopIndexes = new WeakMap();
function stopIndexOf(source) {
  if (!stopIndexes.has(source)) {
    const index = new Map();
    // Stations first, so a platform-level stop never shadows its station.
    for (const wantRoot of [true, false])
      source.stops.iri.forEach((iri, stopIdx) => {
        if ((source.stops.parentIdx[stopIdx] === -1) !== wantRoot) return;
        const match = /(?:\/stations\/NMBS\/|\/stops\/S?)0*(\d+)(?:_[^/]*)?$/u.exec(
          iri,
        );
        if (match && !index.has(match[1])) index.set(match[1], stopIdx);
      });
    stopIndexes.set(source, index);
  }
  return stopIndexes.get(source);
}

/**
 * Match decoded feeds (`[{ feed, decoded }]`, see `decodeTripUpdates`) to a
 * source's trips and stops. Updates for trips the timetable does not contain
 * (added trips, other releases) are counted in `unmatched` and ignored.
 */
export function buildRealtime(source, feeds) {
  const tripIndex = tripIndexOf(source);
  const stopIndex = stopIndexOf(source);
  const trips = new Map();
  const stats = { updates: 0, matched: 0, unmatched: 0, canceled: 0, delayed: 0 };
  let timestamp = 0;
  let maxDelay = 0;
  for (const { feed, decoded } of feeds) {
    timestamp = Math.max(timestamp, decoded.timestamp ?? 0);
    const template = feed.tripTemplate ? uriTemplates(feed.tripTemplate) : null;
    for (const update of decoded.updates) {
      stats.updates += 1;
      const canceled =
        update.relationship === "canceled" || update.relationship === "deleted";
      const tripIdx = tripIndex.get(
        template ? template.fill({ trip_id: update.tripId }) : update.tripId,
      );
      if (
        tripIdx === undefined ||
        update.startDate === undefined ||
        (!canceled && update.relationship !== "scheduled")
      ) {
        stats.unmatched += 1;
        continue;
      }
      const stops = new Map();
      const timeline = [];
      let late = false;
      for (const stop of update.stops) {
        const id = /^0*(\d+)(?:_(.+))?$/u.exec(stop.stopId ?? "");
        const stopIdx = id ? stopIndex.get(id[1]) : undefined;
        if (stopIdx === undefined || stops.has(stopIdx)) continue;
        const skipped = stop.relationship === "skipped";
        stops.set(stopIdx, {
          arrival: stop.arrival,
          departure: stop.departure,
          skipped,
          platform: id[2],
        });
        if (skipped) continue;
        for (const event of [stop.arrival, stop.departure]) {
          if (event?.delay === undefined) continue;
          maxDelay = Math.max(maxDelay, event.delay);
          late ||= event.delay > 0;
        }
        // A stop with both a time and a delay pins down its scheduled time,
        // which orders it among the stops the feed does not mention.
        for (const event of [stop.departure, stop.arrival])
          if (event?.time !== undefined && event.delay !== undefined) {
            timeline.push({ scheduled: event.time - event.delay, delay: event.delay });
            break;
          }
      }
      timeline.sort((a, b) => a.scheduled - b.scheduled);
      trips.set(tripKey(tripIdx, update.startDate), {
        canceled,
        stops,
        timeline,
        tripDelay: update.delay,
        // Delays as applied to the connections, by stop: filled while pages are
        // overlaid, read back to annotate planned legs.
        resolved: new Map(),
      });
      stats.matched += 1;
      if (canceled) stats.canceled += 1;
      else if (late || (update.delay ?? 0) > 0) stats.delayed += 1;
    }
  }
  return {
    timestamp,
    trips,
    stats,
    margin: Math.min(
      MAX_MARGIN_SECONDS,
      Math.ceil(Math.max(maxDelay, 0) / 60) * 60 + MARGIN_SLACK_SECONDS,
    ),
  };
}

// The delay an event announces for a connection scheduled at `scheduled`.
const eventDelay = (event, scheduled) =>
  event === undefined
    ? undefined
    : event.time !== undefined
      ? event.time - scheduled
      : event.delay;

function carriedDelay(trip, scheduled) {
  const { timeline } = trip;
  if (!timeline.length) return trip.tripDelay ?? 0;
  for (let i = timeline.length - 1; i >= 0; i -= 1)
    if (timeline[i].scheduled <= scheduled) return timeline[i].delay;
  return 0; // before the first update: that part of the trip is already over
}

function delayAt(trip, stopIdx, kind, scheduled) {
  const stop = trip.stops.get(stopIdx);
  let delay;
  if (stop && !stop.skipped) {
    const own = kind === "dep" ? stop.departure : stop.arrival;
    const other = kind === "dep" ? stop.arrival : stop.departure;
    // A stop with only one of the two events applies it to both.
    delay = eventDelay(own, scheduled) ?? other?.delay;
  }
  return delay ?? carriedDelay(trip, scheduled);
}

const SKIPPED_COLUMNS = new Set(["epoch", "length", "source"]);

function gather(columns, order) {
  const result = {};
  for (const [name, column] of Object.entries(columns)) {
    if (SKIPPED_COLUMNS.has(name) || column === undefined) continue;
    if (ArrayBuffer.isView(column)) {
      const copy = new column.constructor(order.length);
      for (let i = 0; i < order.length; i += 1) copy[i] = column[order[i]];
      result[name] = copy;
    } else result[name] = order.map((row) => column[row]);
  }
  return result;
}

/**
 * One page batch with the overlay applied. A batch the feed does not touch is
 * returned as it is. Otherwise a new batch is returned with `dep` and `arr`
 * moved by the delays, plus the columns `depDelay` and `arrDelay` (seconds
 * against the schedule), `flags` (`TRIP_CANCELED`, `DEPARTURE_SKIPPED`,
 * `ARRIVAL_SKIPPED`) and `depPlatform` and `arrPlatform` (strings or undefined).
 * Canceled connections are removed unless `keepCanceled`.
 */
export function applyRealtime(batch, realtime, { keepCanceled = false } = {}) {
  if (!batch.serviceDate) return batch;
  const affected = [];
  for (let row = 0; row < batch.length; row += 1) {
    const trip = realtime.trips.get(
      tripKey(batch.trip[row], batch.serviceDate[row]),
    );
    if (trip) affected.push(row, trip);
  }
  if (!affected.length) return batch;

  const { length, epoch } = batch;
  const dep = Uint32Array.from(batch.dep);
  const arr = Uint32Array.from(batch.arr);
  const pickup = batch.pickup ? Uint8Array.from(batch.pickup) : new Uint8Array(length);
  const dropOff = batch.dropOff ? Uint8Array.from(batch.dropOff) : new Uint8Array(length);
  const depDelay = new Int32Array(length);
  const arrDelay = new Int32Array(length);
  const flags = new Uint8Array(length);
  const depPlatform = new Array(length);
  const arrPlatform = new Array(length);
  const removed = new Uint8Array(length);

  for (let i = 0; i < affected.length; i += 2) {
    const row = affected[i];
    const trip = affected[i + 1];
    if (trip.canceled) {
      flags[row] = TRIP_CANCELED;
      if (!keepCanceled) removed[row] = 1;
      continue;
    }
    const from = batch.dS[row];
    const to = batch.aS[row];
    const departure = Math.max(
      0,
      delayAt(trip, from, "dep", epoch + batch.dep[row]),
    );
    dep[row] = batch.dep[row] + departure;
    const arrival = delayAt(trip, to, "arr", epoch + batch.arr[row]);
    arr[row] = Math.max(dep[row], batch.arr[row] + arrival);
    depDelay[row] = dep[row] - batch.dep[row];
    arrDelay[row] = arr[row] - batch.arr[row];
    trip.resolved.set(from * 2, depDelay[row]);
    trip.resolved.set(to * 2 + 1, arrDelay[row]);
    const first = trip.stops.get(from);
    const last = trip.stops.get(to);
    if (first?.skipped) {
      flags[row] |= DEPARTURE_SKIPPED;
      pickup[row] = 1;
    }
    if (last?.skipped) {
      flags[row] |= ARRIVAL_SKIPPED;
      dropOff[row] = 1;
    }
    depPlatform[row] = first?.platform;
    arrPlatform[row] = last?.platform;
  }

  const rows = [];
  for (let row = 0; row < length; row += 1) if (!removed[row]) rows.push(row);
  if (!rows.length) return { ...batch, length: 0 };
  // Delays reorder departures; the scans binary-search and merge on `dep`.
  rows.sort((a, b) => dep[a] - dep[b] || a - b);
  const columns = gather(
    {
      ...batch,
      dep,
      arr,
      pickup,
      dropOff,
      depDelay,
      arrDelay,
      flags,
      depPlatform,
      arrPlatform,
    },
    rows,
  );
  return { ...columns, epoch, length: rows.length };
}

/** `applyRealtime` for every batch of a page; empty batches are dropped. */
export function applyRealtimeToBatches(batches, realtime, options) {
  const result = batches
    .map((batch) => applyRealtime(batch, realtime, options))
    .filter((batch) => batch.length > 0);
  result.page = batches.page;
  return result;
}

/**
 * What the overlay did to one stop of one trip, for annotating planned legs:
 * `{ delay, platform, canceled }`, or null when the feed does not mention the
 * trip. `kind` is `"dep"` or `"arr"`. Only meaningful for stops of connections
 * already read through `applyRealtime`.
 */
export function stopStatus(realtime, trip, serviceDate, stopIdx, kind) {
  const entry = realtime?.trips.get(tripKey(trip, serviceDate));
  if (!entry) return null;
  const stop = entry.stops.get(stopIdx);
  return {
    delay: entry.resolved.get(stopIdx * 2 + (kind === "arr" ? 1 : 0)) ?? 0,
    platform: stop?.platform ?? null,
    canceled: entry.canceled || Boolean(stop?.skipped),
  };
}
