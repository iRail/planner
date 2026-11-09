# iRail planner

[![npm version](https://img.shields.io/npm/v/@irail/planner?color=c72929&logo=npm)](https://www.npmjs.com/package/@irail/planner)
[![npm downloads](https://img.shields.io/npm/dm/@irail/planner?color=c72929)](https://www.npmjs.com/package/@irail/planner)
[![CI](https://github.com/iRail/planner/actions/workflows/pages.yml/badge.svg?branch=main)](https://github.com/iRail/planner/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/npm/l/@irail/planner)](LICENSE)
[![Node.js version](https://img.shields.io/node/v/@irail/planner?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript types included](https://img.shields.io/npm/types/@irail/planner)](https://www.npmjs.com/package/@irail/planner)
[![Playground](https://img.shields.io/badge/playground-irail.github.io%2Fplanner-c72929)](https://irail.github.io/planner/)

```sh
npm install @irail/planner
```

**You can start working with `@irail/planner` today.** It is an ESM library for Node.js
22.12+ and modern browsers, with TypeScript types included. Try it in the
[playground](https://irail.github.io/planner/) first, or jump to
[Install and use in Node.js](#install-and-use-in-nodejs). It is a `0.x` release on a
draft specification, so the API can still change between minor versions; pin the
version you use.

An ESM npm library for journey planning over **Linked Connections 2.0-alpha**
(`schemaVersion: "2-alpha"`) in Node.js and modern browsers. It scans Apache Arrow
connection pages locally, supports multiple networks and walking, and returns
journey alternatives with publisher-provided IRIs. It also answers the familiar
[iRail API](https://docs.irail.be) calls (stations, liveboard, connections,
vehicle) from the same data; see [iRail API calls](#irail-api-calls).

[Playground and documentation](https://irail.github.io/planner/) ·
[iRail API comparison](https://irail.github.io/planner/irail.html) ·
[LC 2.0-alpha draft](https://linkedconnections.org/specification/2-0-alpha) ·
[Draft proposal](https://github.com/linkedconnections/website/pull/14)

The library targets the Linked Connections draft dated 7 November 2026. The original
GTFS-to-Arrow manifest formats are not supported. The playground is built and
published by the included GitHub Actions workflow.

## Install and use in Node.js

Requires Node.js **22.12 or newer**. The library is native JavaScript ESM; its npm
package ships `src/` and TypeScript declarations without a compilation step.

```sh
npm install @irail/planner
```

To work on the library itself, clone the repository and run `npm ci` instead; see
[Development](#development-playground-and-github-pages).

```js
import { createPlanner } from "@irail/planner";

const planner = createPlanner({
  dataUrl: "https://irail.github.io/iRail-cdn/manifest.jsonld",
  cacheBytes: 64 * 1024 * 1024, // optional; default 64 MiB
});
const [source] = await planner.init();

// Stops are named by the publisher's absolute IRIs, for iRail the station IRIs.
// Indices belong to this release.
const stop = (iri) => source.stops.id.indexOf(iri);
const result = await planner.plan(
  {
    origin: {
      sourceId: source.id,
      stopIdx: stop("http://irail.be/stations/NMBS/008892007"), // Gent-Sint-Pieters
    },
    destination: {
      sourceId: source.id,
      stopIdx: stop("http://irail.be/stations/NMBS/008841004"), // Liège-Guillemins
    },
    departureAfter: Date.parse("2026-11-09T08:00:00Z") / 1000,
    maxWalkMeters: 1000,
    windowMode: "adaptive",
  },
  (progress) => console.log(progress.phase),
);

for (const journey of result.options) {
  console.log(
    journey.departure,
    journey.arrival,
    journey.transfers,
    journey.legs,
  );
}
```

Use IRIs that exist in your publisher's timetable and a departure inside its
coverage. All API times are **UTC epoch seconds**, not JavaScript milliseconds.
Either endpoint can instead be `{ lon, lat }`; walking access and egress are
included without snapping the point to a single stop. To work with station names
instead of IRIs, use [the iRail calls](#irail-api-calls): `stations()`,
`liveboard()` and `connections()` take names in any language.

## API

`createPlanner(options)` returns a `Planner`; `new Planner(options)` is equivalent.
Options are `dataUrl`, `cacheBytes`, and an optional Fetch-compatible `fetch`
function for custom HTTP transport. The Node entry point creates no workers and
imports no browser globals. Calls on one instance run sequentially; create
separate instances for independent concurrent workloads.

| Method                                              | Returns                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `await planner.init(dataUrl?, { realtime? })`       | Source metadata, stop IRIs/names/coordinates, searchable station indices, release ID, timezone and coverage. Call again to load a new release. Also loads the real-time feed unless `realtime` is `false`. |
| `await planner.refreshRealtime()`                   | Re-reads the manifest's GTFS Realtime feed; one `{ sourceId, supported, changed, timestamp, … }` per source. See [Real-time updates](#real-time-updates). |
| `planner.watchRealtime({ intervalMs? })`            | Polls the feed (every 30 s) and emits `update` events when it changes. Returns a watcher with `stop()`.                                              |
| `await planner.plan(query, onProgress?)`            | `{ found, options, totalOptions, scanned, window, diagnostics }`. Each option has `departure`, `arrival`, `transfers` and `legs`.                     |
| `await planner.isochrone(query, onProgress?)`       | `{ found, noAccess, origin, points, maxWalkMeters, scanned, pages, diagnostics }`. Points include coordinates, names, networks and `durationSeconds`. |
| `await planner.request(type, payload, onProgress?)` | The underlying message protocol (`init`, `plan`, `isochrone` and the iRail calls), also used by `PlannerClient`.                                      |

Journey queries require `origin`, `destination` and either `departureAfter` (leave
at or after) or `arrivalBefore` (arrive at or before; see below), as UTC epoch seconds. Optional
`sourceIds` selects active networks; omitting it uses all loaded networks.
`maxWalkMeters` defaults to 1000 in `plan`/`isochrone` and must be between 0 and 5000. Low-level `request` calls must supply it explicitly.

Isochrone queries use a coordinate `origin`, `departureAfter`, `maxWalkMeters`
and `maxDurationSeconds` between 60 and 10800:

```js
const surface = await planner.isochrone({
  origin: { lon: 3.7103, lat: 51.0357 },
  departureAfter: Date.parse("2026-11-08T08:00:00Z") / 1000,
  maxWalkMeters: 1000,
  maxDurationSeconds: 3600,
});
```

Ride legs include `sourceId`, `trip`, `boardStop`, `alightStop`, `boardTime`,
`alightTime`, `serviceDate`, `routeName`, `routeType`, `headsign`, `vehicle` (the
train as the iRail API names it: `{ id: "BE.NMBS.IC502", name: "IC 502", type, number }`;
pass its `id`, and an instant on the leg's `serviceDate`, to `vehicle()` for the stops of
that run), `tripIri`,
`routeIri`, `boardStopIri`, `alightStopIri` and the boarding `connectionIri`, and,
from real-time data, `boardDelay` and `alightDelay` (seconds late) and
`boardPlatform` and `alightPlatform` (`null` when unknown). `boardTime`, `alightTime`
and a journey's `departure` and `arrival` already include those delays.
Walk legs include endpoint references, times and distance in meters.

## Real-time updates

When the manifest names a GTFS Realtime feed (`"realtime": [{ "@type":
"GtfsRealtimeFeed", "@id": "…trip-updates.pb", "tripTemplate": "…{trip_id}" }]`, as
the iRail CDN does), `init` loads it and every search uses it. The feed is applied
to the connections *while they are read*, so journeys, liveboards and vehicles
all see the same network:

- **Delays** move a connection's departure and arrival. The delay of the last
  stop the feed mentions carries on to the stops after it, a train never leaves
  early, and the pages are re-sorted because delays reorder departures.
- **Canceled trips** cannot be traveled, but they are not hidden: journeys that need
  one are returned flagged `canceled: true` (see below). Liveboards and `vehicle`
  list canceled trains with `canceled: true`.
- **Skipped stops** cannot be boarded or left, but the train still rides through.
- **Platforms** come from the feed's stop ids (`8892601_1` is platform 1).

The scheduled pages stay untouched in the cache; the overlay is applied to a copy,
so a feed update costs one small download and no page reloads.

**Canceled journeys.** By default a search also returns the journeys that would
exist if the canceled trains ran, so a traveller sees "the 08:12 is canceled" rather
than a gap in the list. Each is flagged and never mixed up with a journey that can be
traveled:

```js
const { found, options } = await planner.plan(query);
for (const journey of options) {
  if (journey.canceled) {
    // times are the schedule; the legs say which train
    const dead = journey.legs.filter((leg) => leg.canceled);
  }
}
```

- `journey.canceled` is true when a train of the journey is canceled or skips a stop it
  needs (`leg.canceled`, `leg.boardCanceled`, `leg.alightCanceled` say where).
- `found` means at least one journey **can be traveled**: it is false when all that
  exist are canceled, even though `options` is not empty. `result.canceledOptions`
  counts them.
- Canceled journeys are listed among the others by departure time, never push a
  possible journey out and never count toward `minOptions`. They are shown as far as
  the possible journeys reach.
- `connections()` flags them with `canceled: true` (and `canceled` on the affected
  leg ends); `limit` counts only connections that can be traveled, the canceled ones
  come on top.
- Pass `includeCanceled: false` to `plan()` or `connections()` for only journeys that
  can be traveled. Searches cost an extra pass while the feed cancels something; this
  skips it too.

In the iRail calls, a `time` is the scheduled time and `delay` is how late the feed says
it is, like in the iRail API: the expected time is `time + delay`. In `plan`, the
times already include the delay, and each ride leg says how much it was.

To keep results up to date, poll the feed and search again when it changes:

```js
const watcher = planner.watchRealtime(); // or { intervalMs: 30_000 } (the default)
watcher.addEventListener("update", async (event) => {
  const [status] = event.detail; // { timestamp, delayed, canceled, … }
  showJourneys(await planner.connections({ from, to }));
});
watcher.addEventListener("error", (event) => console.warn(event.detail));
// later
watcher.stop();
```

`update` fires only when the publisher regenerated the feed, `poll` after every poll,
and `error` when a poll fails (the previous data stays in use and polling goes on).
Polls never overlap. `await planner.refreshRealtime()` does a single poll;
`watcher.pollNow()` polls immediately, for example when a hidden tab becomes visible
again. `PlannerClient` has the same methods in the browser, and the polling runs in
the page, not the worker. Both playground pages do exactly this: the main page plans the journey on screen again
when the feed changes, keeping the selected journey and the map view, and the
[comparison page](#development-playground-and-github-pages) redraws both sides.

Limits: updates for trips the timetable does not contain (added trips) are ignored;
only trip updates are read, not alerts or vehicle positions; and a train's delay is
not predicted beyond what the feed says.

The lower-level `@irail/planner/core` entry exports `createPlanner(arrow, options)`
for callers managing loaded source objects and page loaders themselves. Most
applications should use the main entry or the browser worker client.

## iRail API calls

The planner also offers the features of the [iRail API](https://docs.irail.be),
answered from the timetable and its real-time feed, as ordinary JavaScript: times are `Date`s
(or epoch milliseconds when you pass them in), numbers are numbers, lists are
arrays and what is unknown is `null`. They are methods of `Planner` and, in the
browser, of `PlannerClient`.

```js
const planner = createPlanner({
  dataUrl: "https://irail.github.io/iRail-cdn/manifest.jsonld",
});
await planner.init();

// The hour of departures at a station.
const board = await planner.liveboard({
  station: "Gent-Sint-Pieters", // a name in any language, an id, or a Station
  time: new Date("2026-11-09T09:00:00+01:00"), // default: now
  language: "nl",
});
for (const { time, vehicle, destination } of board.entries)
  console.log(time, vehicle.name, destination.name);

// A train overview for one day.
const { vehicle, stops } = await planner.vehicle({
  id: "BE.NMBS.IC508",
  date: new Date("2026-11-09T12:00:00Z"),
});
console.log(vehicle.name, stops.map((stop) => stop.station.name));

// Journeys, six by default: one leg per vehicle.
const connections = await planner.connections({
  from: "Gent-Sint-Pieters",
  to: "Liège-Guillemins",
  time: new Date("2026-11-09T08:30:00+01:00"),
});
for (const { departure, arrival, transfers, legs } of connections)
  console.log(departure, arrival, transfers, legs.map((leg) => leg.vehicle?.name));
```

| Call                                        | iRail API                  | Returns and notes                                                                                                                                                            |
| ------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stations({ language, query, limit, fuzzy })` | `GET /stations/`         | `Station[]`: `id`, `uri`, `name` (in `language`: `nl`, `fr`, `en`, `de`; default `en`), `standardName`, `latitude`, `longitude`. With `query`, a search instead of the full list (see below). |
| `liveboard({ station, time, type })`        | `GET /liveboard/`          | `{ station, type, entries }` for the hour from `time`. `type` is `departure` (default) or `arrival`. Entries have `time`, `vehicle`, `platform` and `destination` or `origin`. |
| `connections({ from, to, time, limit })`    | `GET /connections/`        | `Connection[]` (default 6, at most 12), continuing past the search window until it has them: `departure`, `arrival`, `duration` (s), `transfers` and `legs`.                  |
| `vehicle({ id, date })`                     | `GET /vehicle/`            | `{ vehicle, stops }` for a train such as `BE.NMBS.IC508` or `IC508`, on the Belgian day of `date`. Stops have `arrival` and `departure`.                                       |
| `composition({ vehicle })`                  | `GET /composition/`        | **Not supported yet:** rejects with a `NotSupportedError`. The data comes from a source the planner does not read.                                                            |
| `disturbances()`                            | `GET /disturbances/`       | **Not supported yet**, same reason (service alerts).                                                                                                                          |
| `occupancyFeedback({ ... })`                | `POST /feedback/occupancy` | **Not supported yet:** the planner does not send reports anywhere.                                                                                                            |

A `station` or `from`/`to` is a station id (`BE.NMBS.008892007`), URI or number, a
name in any language, or a `Station` returned by an earlier call. A connection leg is
`{ type: "ride" | "walk", from, to, vehicle, direction, stops, distanceMeters }`;
`from` and `to` hold the `station`, `time` (scheduled), `platform`, `delay` (seconds) and
`canceled`, and a ride's `stops` are the stops in between, each with its own delay.
A connection has scheduled `departure` and `arrival` with `departureDelay` and
`arrivalDelay` beside them. `connections` also takes
`maxWalkMeters` (default 0: no walking between stations).

Delays, cancellations and platforms come from the real-time feed (see
[Real-time updates](#real-time-updates)); without one, `delay` is 0, `canceled` is
`false` and `platform` is `null`. Station labels, translations and the traffic figures that rank
station search results come from the iRail CDN's `stations.arrow` extension, loaded on
first use; without it the timetable's own stop names are used. A leg's `direction` is the
timetable's published headsign.

`stations({ query })` searches like the station box of irail.be: stations whose name, in any
language and ignoring accents and case, equals, starts with or contains the text come first
(`limit` of them, 10 by default), the busiest (`avgStopTimes`) first within each kind. Free
places are then filled with stations a typo away, again busiest first: `"Gnet"` finds
Gent-Sint-Pieters, `"Brusels"` Brussels-Midi. Text of one to three letters allows no typos,
four to six allow one, longer text two; a missing, extra, wrong or swapped letter is one.
Pass `fuzzy: false` for exact matching only. Names given to the other calls (`liveboard`,
`connections`, …) stay strict: a typo there is a 404, not another station.

`connections({ arriveBy: true })` treats `time` as the moment to arrive by (see "Arriving by
a time"). Not yet supported inside supported calls: `vehicles` other than `all`, which
rejects with a `NotSupportedError`.

Errors are `IrailApiError`s with the HTTP `status` the iRail API would use: 400 for a
missing or malformed parameter, 404 for an unknown station or train. A
`NotSupportedError` is a subclass with status 501 and the `call` that was made. Both are
exported:

```js
import { IrailApiError, NotSupportedError } from "@irail/planner";

try {
  await planner.composition({ vehicle: "IC508" });
} catch (error) {
  if (error instanceof NotSupportedError) console.log(error.call, error.status); // composition 501
}
```

The same holds for the journey search: `plan` takes `minOptions` to keep searching later
departures (for up to two days) until that many alternatives are found, where a single
search can return fewer when its window is short. Its own times stay UTC epoch seconds.

## Browser workers

Use a worker-aware ESM bundler such as Vite. The browser entry bundles the planner,
Apache Arrow, and nested decoding workers from the installed package:

```js
import { PlannerClient, createPlannerWorker } from "@irail/planner/browser";

const client = new PlannerClient(createPlannerWorker());
const [source] = await client.request("init", {
  dataUrl: "https://publisher.example/manifest.jsonld",
});
const result = await client.request(
  "plan",
  {
    origin: { sourceId: source.id, stopIdx: 0 },
    destination: { sourceId: source.id, stopIdx: 3 },
    departureAfter: Date.parse("2026-11-08T08:00:00Z") / 1000,
    maxWalkMeters: 1000,
  },
  (progress) => console.log(progress),
);

// When the owning view is disposed; rejects any pending requests.
client.close();
```

The browser client serializes requests in the worker and streams progress and
useful profile edges to the UI. Decoded connections stay off the main thread.
Modern browsers need module workers and Fetch;
no cross-origin isolation headers are needed. A bundler is required for bare npm
imports; opening the HTML directly through `file://` is not supported.

## Data and routing behavior

Pass an absolute HTTP(S) manifest URL, with any filename or extension, or a directory
URL ending in `/` containing `manifest.jsonld`.
For multiple feeds, a directory may expose an application-level `sources.json`:

```json
{
  "sources": [
    {
      "id": "nmbs",
      "name": "NMBS / SNCB",
      "manifest": "nmbs/manifest.jsonld",
      "color": "#2563eb"
    },
    { "id": "other", "manifest": "https://other.example/manifest.jsonld" }
  ]
}
```

Manifest and table links resolve against HTTP response URLs, including redirects.
The loader reads the published compact LC context's terms, validates Arrow schema
version, required column types/nullability and release IDs, and follows publisher
IRIs. It does not perform arbitrary JSON-LD context expansion.

Supported discovery includes irregular `connections.pages` lists, regional pages
and arrival-region summaries, `ScheduledPagination` with positive whole-second
ISO durations, and `RedirectPagination` with immutable `next` links. Missing page
bounds or region summaries cause conservative scanning. Missing listed or
scheduled files are errors; a redirect lookup's 404 means no further service.
Region IRIs in RFC 6570 templates are encoded by the URI-template implementation.
HTTP content encoding is handled by Fetch; resources must be Arrow IPC **files**,
not streams or separately named gzip archives. Browser publishers must enable CORS.

A profile connection scan optimizes later departure, earlier arrival and fewer
vehicle changes. Up to six nondominated alternatives are returned; `totalOptions`
reports the full count. The default `adaptive` window first finds the earliest
arrival within 24 elapsed hours, then scans twice that elapsed time, capped at
24 hours. It is a heuristic and may exclude later or slower journeys. Set
`windowMode: 'full'` for the complete 24-hour window. UTC timestamps avoid DST
arithmetic errors; `serviceDate` keeps each vehicle run separate.

**Arriving by a time.** Pass `arrivalBefore` instead of `departureAfter` to get the journeys
that arrive at or before it, the ones closest to the deadline: the profile scan runs
backward from the deadline, so no earliest-arrival pass is needed to size a window (and
`windowMode` is ignored). A search looks three hours back first and, if nothing fits, up to
two days; the result holds up to six journeys, in departure order, ending with the one that
leaves latest. With `minOptions` it keeps going earlier until it has that many (it then holds
exactly that many, the closest to the deadline). `result.window.mode` is `"arrive-by"`.
`connections({ time, arriveBy: true })` does the same through the iRail call: the `limit`
journeys closest to `time`. The deadline is a time the journey must arrive by including
real-time delays. Giving both `departureAfter` and `arrivalBefore` is an error.

The planner groups station platforms, considers selected networks together
(including A → B → A journeys), and supports straight-line walking at 5 km/h at
both ends and between rides. The distance limit applies to each continuous walk;
walks cannot be chained to bypass it. Minimum station transfer times and
trip/route-specific transfer overrides apply to changes of vehicles. Staying on
the same run requires consecutive stop sequences and incurs no transfer time.
Pickup/drop-off types 1, 2 and 3 cannot be used for ordinary boarding/alighting;
remaining aboard is permitted.

**Trains that split or join.** Transfer type 4 ("in-seat transfer") links a trip to the
trip it continues as at one stop, for example a train that changes number or loses
or gains coaches. Riders stay seated: the planner follows the link without a transfer
and without transfer time, on the same service date. A journey over a link has two ride legs
(one per trip, the second boarding at the stop where the first alights) but is one ride:
it does not count as a transfer, so `transfers` is smaller than `legs.length - 1`.
Type 5 ("riders must get off") is what a transfer already means and changes nothing.
Links work in both window modes and in isochrones.

Current limits:

- Real-time data is limited to GTFS Realtime trip updates; alerts and vehicle positions
  are not read.
- Transfer types above 5 fail explicitly.
- Transfer overrides between different stations are ignored. Walking between
  stations uses physical distance. Street paths, accessibility, barriers and fares are not modeled.
- Shapes are not part of this implementation; maps connect stop coordinates.
- Redirect-only collections are discovered across all source regions for the query
  window before scanning; page-list collections load relevant regions lazily.

## Development, playground and GitHub Pages

```sh
npm ci
npm test
npm run dev                 # http://localhost:5173
npm run build:playground    # static site: dist/playground/
npm run preview             # preview the production build
npm pack --dry-run          # inspect the library package
npm run build:proto         # regenerate src/gtfs-realtime.mjs from proto/gtfs-realtime.proto
```

The library lives in `src/`, tests in `test/`, and the interactive demo plus hosted
API documentation in [`playground/`](playground/README.md). `npm run build` is an
alias for `build:playground`; the library itself ships native ESM source. Only
`src/`, README and LICENSE enter the npm tarball.

The GTFS Realtime feed is decoded with [protobufjs](https://github.com/protobufjs/protobuf.js)
(a runtime dependency). `src/gtfs-realtime.mjs` is code generated from the subset of the
official `.proto` kept in `proto/`; generated code needs only protobufjs's small runtime
and builds nothing at run time, so it also works under strict content security policies
and on runtimes that forbid `eval`. Edit the `.proto` and run `npm run build:proto` to
read more fields.

The playground loads the iRail CDN's live LC 2.0-alpha timetable
(`https://irail.github.io/iRail-cdn/manifest.jsonld`, NMBS/SNCB open data, scheduled
service plus its GTFS Realtime feed) by default. It starts at the current time, clamped to the feed's
coverage, with Gent-Sint-Pieters → Liège-Guillemins preselected. Override it with
the timetable URL form, `?data=https://publisher.example/manifest.jsonld`, or a
build-time `VITE_DATA_URL`. A small **illustrative timetable for 8 November 2026**,
with invented services between Belgian stations, is generated during the build and
available at `?data=./data/`; it is not a real timetable. Maps and contours load MapLibre, d3-contour and OpenStreetMap
resources on demand; Arrow and routing dependencies are bundled locally.

The playground has a second page, `irail.html`, styled like irail.be. It plans each
search twice, with `https://api.irail.be/v1/connections` and with the planner
library on the iRail CDN data, then shows the journeys side by side with a diff
(identical, other arrival, only in one side, slower journeys the planner omits by
design, arrivals beyond the planner's adaptive window) and timings: first request
and repeat for both, plus the planner's one-off start-up. API results include
realtime delays and cancellations from iRail's own sources, planner results from
the NMBS/SNCB GTFS Realtime feed, so small differences are possible and each
carries a reason. The page checks the feed every 30 seconds and, when it changes,
asks both sides again and redraws the results in place (open journeys stay open);
**Check now** does so on demand and the checkbox switches it off. Stations are matched through
their NMBS station number. The station search works like irail.be's: it finds
stations by their name in any language (nl, fr, de, en), shows the label in the
language chosen in the header, and ranks exact, word-prefix, prefix and partial
matches, busiest (`avgStopTimes`) first. The translations come from the CDN's
`stations.arrow` (an iRail extension linked from `irail:extensions` in the
manifest, not part of LC 2-alpha); without it the timetable's own names are used. The page needs the iRail CDN data and CORS access to
`api.irail.be`; the bundled sample timetable has no matching stations.

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) tests on Node 22 and 24,
checks npm packaging, builds the playground on pushes and pull requests, and
uploads `dist/playground/` as a Pages artifact. Pushes to the default branch and
manual runs deploy it. In repository **Settings → Pages → Build and deployment**,
choose **GitHub Actions**. The build also publishes the iRail API comparison page, `irail.html`. Optionally
set the repository variable
`PLANNER_DATA_URL` to use a different LC alpha manifest URL than the iRail CDN. Relative asset paths support
both repository subpaths and domain roots. No site or package is published by
running local build commands.

## Tests and provenance

The routing, walking, transfer, cache, region-activation and worker-pool regression
cases were adapted from `test/planner-cases.mjs` in the nearby
`routable-connections-gtfs2lc` checkout (LinkedConnections/gtfs2lc, MIT). Producer
and legacy-format tests were replaced with standalone LC alpha fixtures and
Node/worker integration tests. Tests generate small IPC files in temporary
directories; no sibling checkout, live feed, network access or GTFS converter is
required. The checked-in schema snapshot follows the LC 2-alpha draft above.

```sh
npm run test:coverage
```

MIT licensed; see [LICENSE](LICENSE).
