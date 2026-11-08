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

The quick start, API reference and format notes in `index.html` are the hosted
library documentation. Keep these and the repository README consistent.
