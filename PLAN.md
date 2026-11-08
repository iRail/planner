# Library migration

Implemented:

- Published on npm as `@irail/planner` (0.1.0).
- Playground defaults to the iRail CDN LC 2-alpha manifest.
- iRail API features (`stations`, `liveboard`, `connections`, `vehicle`) over the timetable as plain JS types; `composition`, `disturbances` and `occupancyFeedback` exist and reject as not supported yet.
- `minOptions` for journey searches; npm package check (`npm run check:package`).
- GTFS Realtime overlay (delays, cancellations, skipped stops, platforms) with `watchRealtime()`; both playground pages update live.
- Linked-trip (in-seat) transfers for trains that split or join.
- `irail.html`: irail.be-style page comparing iRail API and planner results and speed.
- Native ESM npm package, public Node API and browser worker entry, source in `src/`.
- Standalone regression tests adapted from routable-connections-gtfs2lc.
- LC 2.0-alpha manifests, schemas, identifiers, transfers and page discovery.
- Separate playground/documentation, reproducible sample data and Pages workflow.

Possible follow-up work:

- Wire up composition, disturbances, occupancy feedback once their data is published (headsign translations from `headsigns.arrow`).
- `connections` with `arriveBy` and `vehicles` filtering.
- Real-time alerts and added trips.
- Cross-station transfer overrides and pedestrian routing.
