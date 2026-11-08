import { createIrailApi } from "./irail-api.mjs";
import { IrailApiError } from "./irail-errors.mjs";

const IRAIL_CALLS = new Set(["stations", "liveboard", "connections", "vehicle"]);
const FILL_HORIZON = 2 * 86400; // how far past the request to look for more options
const FILL_ROUNDS = 8;

export function createPlannerService(planner) {
  let sources = [];
  const irail = createIrailApi(planner);

  // Journeys with route and stop identifiers resolved. With `minOptions`, a
  // search that found fewer alternatives continues after the last departure
  // until enough are found or nothing more departs within two days.
  async function planLabeled(payload, selected, onProgress) {
    const { minOptions = 0, ...query } = payload;
    const search = (departureAfter) =>
      planner.planJourneys({
        ...query,
        departureAfter,
        sources: selected,
        onProgress,
      });
    let result = await search(query.departureAfter);
    let extended = false;
    for (
      let round = 0;
      round < FILL_ROUNDS &&
      result.found &&
      result.options.length < minOptions;
      round += 1
    ) {
      const cursor = result.options.at(-1).departure + 1;
      if (cursor >= query.departureAfter + FILL_HORIZON) break;
      const next = await search(cursor);
      if (!next.options.length) break;
      extended = true;
      result = {
        ...result,
        options: [...result.options, ...next.options],
        totalOptions: result.totalOptions + next.totalOptions,
        scanned: result.scanned + next.scanned,
        window: {
          ...result.window,
          to: Math.max(result.window.to, next.window.to),
        },
      };
    }
    // A search that had to continue returns the number asked for, not a few more.
    if (result.options.length > minOptions && minOptions > 0 && extended)
      result = { ...result, options: result.options.slice(0, minOptions) };
    onProgress?.({ phase: "labels" });
    for (const option of result.options)
      for (const leg of option.legs) {
        if (leg.kind !== "ride") continue;
        const source = selected.find((source) => source.id === leg.sourceId);
        const trip = source.tables.trips.get(leg.trip);
        const route = source.tables.routes.get(trip.routeIdx);
        // Times are already real-time adjusted; these say by how much, and
        // where the feed names a platform.
        const board = planner.realtimeStop?.(
          source,
          leg.trip,
          leg.serviceDate,
          leg.boardStop,
          "dep",
        );
        const alight = planner.realtimeStop?.(
          source,
          leg.trip,
          leg.serviceDate,
          leg.alightStop,
          "arr",
        );
        Object.assign(leg, {
          boardDelay: board?.delay ?? 0,
          alightDelay: alight?.delay ?? 0,
          boardPlatform: board?.platform ?? null,
          alightPlatform: alight?.platform ?? null,
          routeName: route.shortName || route.longName || "",
          routeType: route.routeType,
          headsign: trip.headsign || "",
          tripIri: trip.iri,
          routeIri: route.iri,
          boardStopIri: source.stops.iri[leg.boardStop],
          alightStopIri: source.stops.iri[leg.alightStop],
        });
      }
    return result;
  }

  return async function handle(type, payload, onProgress) {
    if (type === "init") {
      const descriptors = await planner.discoverSources(payload?.dataUrl);
      const results = await Promise.allSettled(
        descriptors.map(planner.loadSource),
      );
      for (const r of results) if (r.status === "rejected") throw r.reason;
      const loaded = results.map((r) => r.value);
      if (!loaded.length) throw new Error("No source could be loaded");
      if (new Set(loaded.map((source) => source.id)).size !== loaded.length)
        throw new Error("Source IDs must be unique");
      sources = loaded;
      // Real-time data is on unless asked otherwise, and never blocks a start.
      planner.resetRealtime?.();
      if (payload?.realtime !== false)
        await planner.refreshRealtime?.(sources).catch(() => {});
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        color: source.color,
        manifest: {
          counts: source.manifest.counts,
          schemaVersion: source.manifest.schemaVersion,
          releaseId: source.manifest.releaseId,
          coverageStart: source.manifest.coverageStart,
          coverageEnd: source.manifest.coverageEnd,
          timeZone: source.manifest.timeZone,
        },
        stops: {
          id: source.stops.id,
          name: source.stops.name,
          lat: source.stops.lat,
          lon: source.stops.lon,
        },
        stopFamily: { searchable: source.stopFamily.searchable },
      }));
    }
    if (type === "realtime") {
      if (!sources.length)
        throw new Error("Initialize the planner before querying");
      return planner.refreshRealtime(sources);
    }
    if (IRAIL_CALLS.has(type)) {
      if (!sources.length)
        throw new IrailApiError(400, "Initialize the planner before querying");
      return irail[type](
        sources,
        payload ?? {},
        payload?.now ?? Date.now() / 1000,
        planLabeled,
      );
    }
    if (type !== "plan" && type !== "isochrone")
      throw new Error(`Unknown planner request: ${type}`);
    if (!sources.length)
      throw new Error("Initialize the planner before querying");
    const active = new Set(payload.sourceIds || sources.map((s) => s.id));
    const selected = sources.filter((s) => active.has(s.id));
    if (!selected.length || selected.length !== active.size)
      throw new Error("Select at least one known source");
    if (type === "isochrone") {
      const result = await planner.planIsochrone({
        ...payload,
        sources: selected,
        onProgress,
      });
      const bySource = new Map(selected.map((s) => [s.id, s]));
      const points = result.reachable
        .map((r) => {
          const source = bySource.get(r.sourceId);
          return {
            sourceId: r.sourceId,
            networkName: source.name,
            networkColor: source.color,
            name: source.stops.name[r.stopIdx] || source.stops.id[r.stopIdx],
            lat: source.stops.lat[r.stopIdx],
            lon: source.stops.lon[r.stopIdx],
            durationSeconds: r.durationSeconds,
          };
        })
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      return {
        found: result.found,
        noAccess: result.noAccess,
        origin: result.origin,
        maxWalkMeters: result.maxWalkMeters,
        points,
        scanned: result.scanned,
        pages: result.pages,
        diagnostics: result.diagnostics,
      };
    }
    return planLabeled(payload, selected, onProgress);
  };
}
