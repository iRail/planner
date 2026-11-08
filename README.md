# iRail planner

> **Work in progress: not yet published on npm.** `npm install @irail/planner`
> does not work yet. Until the first release, install from a checkout of this
> repository (see [Install and use in Node.js](#install-and-use-in-nodejs)). The API
> may change without notice.

An ESM npm library for journey planning over **Linked Connections 2.0-alpha**
(`schemaVersion: "2-alpha"`) in Node.js and modern browsers. It scans Apache Arrow
connection pages locally, supports multiple networks and walking, and returns
journey alternatives with publisher-provided IRIs.

[Playground and documentation](https://irail.github.io/planner/) ·
[iRail API comparison](https://irail.github.io/planner/irail.html) ·
[LC 2.0-alpha draft](https://linkedconnections.org/specification/2-0-alpha) ·
[Draft proposal](https://github.com/linkedconnections/website/pull/14)

This is an alpha library targeting the draft dated 7 November 2026. The original
GTFS-to-Arrow manifest formats are not supported. The playground is built and
published by the included GitHub Actions workflow once Pages is enabled.

## Install and use in Node.js

Requires Node.js **22.12 or newer**. The library is native JavaScript ESM; its npm
package ships `src/` and TypeScript declarations without a compilation step.

**The package is not yet published on npm.** For now, install a checkout of this
repository:

```sh
git clone https://github.com/iRail/planner
cd planner && npm ci
npm install /path/to/planner   # from your own project
```

Once it is published, the install will be `npm install @irail/planner`. The
examples below already use that package name; inside this repository, run them
after `npm ci`.

```js
import { createPlanner } from "@irail/planner";

const planner = createPlanner({
  dataUrl: "https://publisher.example/manifest.jsonld",
  cacheBytes: 64 * 1024 * 1024, // optional; default 64 MiB
});
const [source] = await planner.init();

// Stop IDs are the publisher's absolute IRIs. Indices belong to this release.
const originIdx = source.stops.id.indexOf(
  "https://publisher.example/stops/gent",
);
const destinationIdx = source.stops.id.indexOf(
  "https://publisher.example/stops/liege",
);
const result = await planner.plan(
  {
    origin: { sourceId: source.id, stopIdx: originIdx },
    destination: { sourceId: source.id, stopIdx: destinationIdx },
    departureAfter: Date.parse("2026-11-08T08:00:00Z") / 1000,
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

Use stop IRIs that exist in your publisher's timetable and a departure inside its
coverage. All API times are **UTC epoch seconds**, not JavaScript milliseconds.
Either endpoint can instead be `{ lon, lat }`; walking access and egress are
included without snapping the point to a single stop.

For a runnable example, use the iRail CDN's live NMBS/SNCB timetable,
`https://irail.github.io/iRail-cdn/manifest.jsonld`, with the stop IRIs
`https://irail.be/id/be.sncb/stops/S8892007` (Gent-Sint-Pieters) and
`https://irail.be/id/be.sncb/stops/S8841004` (Liège-Guillemins).

## API

`createPlanner(options)` returns a `Planner`; `new Planner(options)` is equivalent.
Options are `dataUrl`, `cacheBytes`, and an optional Fetch-compatible `fetch`
function for custom HTTP transport. The Node entry point creates no workers and
imports no browser globals. Calls on one instance run sequentially; create
separate instances for independent concurrent workloads.

| Method                                              | Returns                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `await planner.init(dataUrl?)`                      | Source metadata, stop IRIs/names/coordinates, searchable station indices, release ID, timezone and coverage. Call again to load a new release.        |
| `await planner.plan(query, onProgress?)`            | `{ found, options, totalOptions, scanned, window, diagnostics }`. Each option has `departure`, `arrival`, `transfers` and `legs`.                     |
| `await planner.isochrone(query, onProgress?)`       | `{ found, noAccess, origin, points, maxWalkMeters, scanned, pages, diagnostics }`. Points include coordinates, names, networks and `durationSeconds`. |
| `await planner.request(type, payload, onProgress?)` | The underlying `init`, `plan` or `isochrone` message protocol, also used by `PlannerClient`.                                                          |

Journey queries require `origin`, `destination` and `departureAfter`. Optional
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
`alightTime`, `serviceDate`, `routeName`, `routeType`, `headsign`, `tripIri`,
`routeIri`, `boardStopIri`, `alightStopIri` and the boarding `connectionIri`.
Walk legs include endpoint references, times and distance in meters.

The lower-level `@irail/planner/core` entry exports `createPlanner(arrow, options)`
for callers managing loaded source objects and page loaders themselves. Most
applications should use the main entry or the browser worker client.

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

The planner groups station platforms, considers selected networks together
(including A → B → A journeys), and supports straight-line walking at 5 km/h at
both ends and between rides. The distance limit applies to each continuous walk;
walks cannot be chained to bypass it. Minimum station transfer times and
trip/route-specific transfer overrides apply to changes of vehicles. Staying on
the same run requires consecutive stop sequences and incurs no transfer time.
Pickup/drop-off types 1, 2 and 3 cannot be used for ordinary boarding/alighting;
remaining aboard is permitted.

Current limits:

- Scheduled routing only; GTFS Realtime feeds are not applied.
- Linked trips (transfer types 4/5) are not implemented; such tables fail explicitly.
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
```

The library lives in `src/`, tests in `test/`, and the interactive demo plus hosted
API documentation in [`playground/`](playground/README.md). `npm run build` is an
alias for `build:playground`; the library itself ships native ESM source. Only
`src/`, README and LICENSE enter the npm tarball.

The playground loads the iRail CDN's live LC 2.0-alpha timetable
(`https://irail.github.io/iRail-cdn/manifest.jsonld`, NMBS/SNCB open data, scheduled
service only) by default. It starts at the current time, clamped to the feed's
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
realtime delays and cancellations, planner results are scheduled only, so
differences are expected and each carries a reason. Stations are matched through
their NMBS station number. The page needs the iRail CDN data and CORS access to
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
