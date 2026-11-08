# Playground and documentation

The existing route planner and analysis UI live here. They use the same library
and worker entry points as npm consumers. Vite bundles Apache Arrow and both
worker levels; the routing code has no CDN imports. Maps and contours still load
MapLibre, d3-contour and OpenStreetMap tiles on demand.

From the repository root:

```sh
npm ci
npm run dev
npm run build:playground
npm run preview
```

`build:playground` writes a complete static site to `dist/playground/`. Its relative
asset URLs work at a GitHub Pages repository subpath or at a domain root. Serve or
upload that directory as a whole.

By default the playground loads the iRail CDN's live LC 2.0-alpha timetable
(`https://irail.github.io/iRail-cdn/manifest.jsonld`). It starts at the current
time, clamped to the feed's coverage, and preselects Gent-Sint-Pieters and
Liège-Guillemins when the source names them.

The build also generates a small, reproducible LC 2-alpha timetable with invented
services between Belgian stations on **8 November 2026**, served at `?data=./data/`.
It is illustrative and must not be used to plan real travel.

Enter a publisher's absolute manifest URL in the page, use
`?data=https://publisher.example/manifest.jsonld`, or set `VITE_DATA_URL` before
building. For GitHub Actions, the optional `PLANNER_DATA_URL` repository variable
sets the build default. An empty value uses the iRail CDN default. Publishers must
enable CORS for browser access.

## iRail API comparison

`irail.html` is a second page, built from the same sources, that looks like
[irail.be](https://github.com/iRail/irail.be). Each search runs against
`https://api.irail.be/v1/connections` and against the planner library (in a
worker, on the iRail CDN data), then shows:

- a verdict (same earliest arrival?) and a per-journey diff with a reason for every
  difference;
- timings for both sides: first request, a repeat of the same request, and the
  planner's one-off start-up. Requests run one after the other so they do not
  distort each other;
- both result lists side by side in irail.be's card style.

Both sides apply realtime delays and cancellations, from different feeds (iRail's
own sources and the NMBS/SNCB GTFS Realtime feed), so they can disagree and the
diff says so. (The main page, `index.html`, refreshes its journeys the same way.) While the page is open, `planner.watchRealtime()` checks the planner's
feed every 30 seconds; when it changes, both sides are asked again and the results
are redrawn in place, keeping the cards you opened. The API lists the next departures including slower ones, the planner
lists Pareto-optimal alternatives within its search window. Journeys match when
their scheduled departure and arrival instants are equal. The logic is in
`compare.mjs` and covered by `test/compare.test.mjs`.

Station names come from the iRail CDN's `stations.arrow` extension (columns
`name`, `alternativeFr/Nl/De/En`, `avgStopTimes`, `iri`; found through the
manifest's `irail:extensions` link and `irail.json`), because the LC `stops.arrow`
has a single label per stop. `irail/stations.mjs` ports irail.be's station search:
text in any language matches, the language picker chooses the displayed label,
and results rank exact > word prefix > prefix > partial, then by `avgStopTimes`
descending. Covered by `test/stations.test.mjs`.

The quick start, API reference and format notes in `index.html` are the hosted
library documentation. Keep these and the repository README consistent.
