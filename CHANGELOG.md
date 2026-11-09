# Changelog

All notable changes to `@irail/planner`. The library is 0.x: minor versions may
change the API, patch versions are fixes and additions. Pin the version if you
need stability.

## 0.1.1 — 2026-11-09

**Update if you use the iRail CDN timetable.** 0.1.0 can no longer load it: the
CDN now publishes trains that split and join, which 0.1.0 rejected, so `init()`
fails with "Linked-trip transfers (types 4 and 5) are not supported yet".
0.1.1 plans over them. It also adds real-time data: delays, cancellations,
skipped stops and platforms.

### Added

- **Headsigns in your language.** The iRail CDN's `headsigns.arrow` extension is
  loaded on first use. A connection's `direction` is now in the query's
  `language`, and `plan()` takes `language` too: each ride leg's `headsign` is in
  that language, and `headsigns` has all of them. Without a translation the
  published headsign stays.
- **Real-time data.** When the manifest names a GTFS Realtime feed
  (`realtime` → `GtfsRealtimeFeed`, as the iRail CDN does), `init()` loads it and
  every search uses it. It is applied while connections are read, so journeys,
  liveboards and vehicles all see the same network:
  - delays move departures and arrivals (a delay carries on to the stops the feed
    does not mention, and a train never leaves early);
  - canceled trips cannot be traveled but are not hidden: journeys that need one
    are returned flagged `canceled: true` (see "Canceled journeys" below), and
    liveboards and `vehicle` show `canceled: true`;
  - skipped stops cannot be boarded or left, but the train rides through;
  - platforms come from the feed, so `platform` is filled in where the feed names
    one.
- **Canceled journeys stay in the results, clearly marked.** By default `plan()`
  and `connections()` also return the journeys that would exist if the canceled
  trains ran, each with `canceled: true` (and `canceled`, `boardCanceled`,
  `alightCanceled` on the legs concerned), so travellers see "the 08:12 is
  canceled" instead of a gap. A journey that needs a skipped stop is flagged the
  same way. They are listed among the others by departure time and never push a
  possible journey out or count toward `minOptions` or `limit`. Pass
  `includeCanceled: false` for only journeys that can be traveled. Both
  playground pages show them with a red "Not possible: … is canceled" banner,
  struck-through times and a "Canceled" tag on the leg and stops, and never put
  one first on the map.
- **Trains are named like in the iRail API, and clickable.** Every ride leg of
  `plan()` has a `vehicle` (`{ id: "BE.NMBS.IC502", name: "IC 502", type, number }`),
  where it only had the route's `routeName` ("IC"). In the playground, click the
  train to unfold its run on that day (all stops with delays, platforms and
  cancellations, the ridden part marked) and click a station to open its real-time
  liveboard, departures and arrivals, which stay current with the feed. The
  iRail comparison page names the planner's trains the same way, and both of its
  result lists (iRail and planner) have the same clickable trains and stations.
- **Arrive by a time.** `plan({ arrivalBefore })` returns the journeys that arrive
  at or before a deadline, the ones closest to it. The profile scan runs backward
  from the deadline, so the earliest-arrival pass that sizes the adaptive window is
  not needed (three hours back first, up to two days if nothing fits; `minOptions`
  goes on earlier). `connections({ time, arriveBy: true })` supports the iRail
  call's `arriveBy`, which used to reject with `NotSupportedError`. Both playground
  pages have it: a "Depart after / Arrive by" choice, and on the comparison page the
  iRail API is asked with `timesel=arrival` too. `departureAfter` is now optional in
  the types (give it or `arrivalBefore`).
- **Fuzzy station search.** `stations({ query, limit, fuzzy })` searches stations by
  name in any language, best match first and busiest (`avgStopTimes`) first within a
  kind, and fills free places with stations a typo away ("Gnet" finds Gent-Sint-Pieters).
  `fuzzy: false` turns the typo matching off; names passed to the other iRail calls
  stay strict. Both playground pages' station boxes use it, so a name in any
  language finds the station ("Renaix" finds Ronse, "Rijsel" Lille, "Luik" Liège).
- **`planner.refreshRealtime()`** reads the feed once and resolves to one status
  per source (`{ sourceId, supported, changed, timestamp, delayed, canceled, … }`).
- **`planner.watchRealtime({ intervalMs })`** polls the feed (every 30 s by
  default) and returns a `RealtimeWatcher` that emits `update` when the feed
  changed, `poll` after every poll and `error` when a poll fails (the last data
  stays in use). Polls never overlap; stop it with `watcher.stop()`.
  `PlannerClient` has the same methods, and `RealtimeWatcher` is exported.
- **`init(dataUrl, { realtime: false })`** opts out of loading the feed.
- **Trains that split or join** (in-seat transfers, transfer type 4). Riders stay
  seated, so the planner follows the link without a transfer and without transfer
  time. This works in both window modes and for isochrones.
- **Playground.** Both pages (`index.html` and the iRail comparison page
  `irail.html`) check the feed every 30 s and, when it changes, plan again and
  redraw in place. They show a live status line with an "Update automatically"
  switch and a "Check now" button, and pause while the tab is hidden.

### Changed

- **iRail-style calls report the scheduled time and the delay beside it**, like
  the real API: the expected time is `time + delay`. `Connection` gains
  `departureDelay` and `arrivalDelay`, and its `departure`, `arrival` and
  `duration` are scheduled. `IntermediateStop` gains `arrivalDelay`,
  `departureDelay`, `platform` and `canceled`. Without a real-time feed all delays
  are 0, as before.
- **`plan()` times include real-time delays**, so the same search can return
  different times than 0.1.0 while the feed is in use. Ride legs gain
  `boardDelay`, `alightDelay`, `boardPlatform` and `alightPlatform`.
- **`init()` now also fetches the real-time feed** (about 75 KB), unless you pass
  `{ realtime: false }`. A feed that cannot be read never stops the planner from
  starting.
- **`found` means a journey can be traveled.** When every journey that exists is
  canceled, `found` is `false` even though `options` holds the canceled ones;
  `result.canceledOptions` counts them. `Journey` and `Connection` gain
  `canceled`.
- **A journey over a split or joined train has two ride legs but is one ride.**
  `transfers` does not count it, so it can be smaller than `legs.length - 1`.
- **Playground: journeys are by train only.** The walking-distance settings of both
  pages are gone: like the iRail API, they plan without walking between stations
  (`maxWalkMeters: 0`), and the From and To boxes take stations only, no coordinates.
  The isochrone tab keeps its walking setting.
- **Playground: the route map no longer sets From and To.** Pick places with the
  search boxes. The map only shows the selected journey, and
  only on screens at least 900 px wide; on a phone it is hidden and not loaded.
  The isochrone tab still takes its starting point from a map click.
- **The iRail comparison page** drops its "Journeys" overview table: the same
  information is in the two result lists below it. It now compares scheduled times with the delays
  beside them on both sides, and says when the two sides disagree about a delay.
- **New runtime dependency:** [`protobufjs`](https://github.com/protobufjs/protobuf.js)
  (BSD-3-Clause) decodes the feed. The decoder is generated from a subset of the
  official `.proto` (`npm run build:proto`) and needs only protobufjs's small
  runtime, so it also works under strict content security policies and on
  runtimes that forbid `eval`.

### Fixed

- Loading a timetable with linked-trip transfers (type 4) failed. Type 5 ("riders
  must get off") is what a transfer already means and is ignored. Transfer types
  above 5 still fail with a clear error.
- An empty, truncated or non-feed response from the real-time endpoint is
  rejected instead of being read as "nothing is late", so it can no longer wipe
  real-time data that was loaded earlier.
- The lockfile still said version `0.1.0-alpha.0`.

### Limits and things to know

- Only GTFS Realtime **trip updates** are read: service alerts, vehicle positions
  and trips the timetable does not contain (added trips) are ignored.
- A feed that is valid but stale is applied as it is. Check `timestamp` in the
  status if that matters to you.
- Real-time journeys are planned from the feed's delays as given. The iRail API
  can list a connection whose change is already missed because of a delay (it
  shows the delay but not that the next train has left); the planner leaves such
  journeys out, so the two can differ.
- A link joins trips of the same service date only.
- Canceled journeys are the ones that would have been in the list had nothing been
  canceled, so a canceled train that was already slower than an alternative is not
  listed. While the feed cancels or skips anything, a search costs one extra pass
  (`includeCanceled: false` skips it).
- Not yet supported, as before: `composition`, `disturbances` and
  `occupancyFeedback` (they reject with `NotSupportedError`), `connections` with
  `vehicles` other than `all`, and headsign translations.

### Upgrading

No code change is needed for plain use: all new fields are additions. Review it if
you:

- compare `plan()` results between versions, or cache them (times now move with
  the feed);
- show every entry of `options` as a journey to take: while the feed cancels
  something, some entries are `canceled` (check `journey.canceled`, or pass
  `includeCanceled: false`);
- rely on `legs.length - 1 === transfers` (not true over a split or joined train);
- run in an environment without access to the CDN's real-time endpoint (pass
  `{ realtime: false }`, or ignore the failed refresh: `init()` does not fail);
- bundle the library yourself: it now depends on `protobufjs`, a CommonJS
  package. Vite bundles it without configuration (that is what the playground
  uses); other bundlers have not been tried.
