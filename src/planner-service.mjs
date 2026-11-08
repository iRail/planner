export function createPlannerService(planner) {
  let sources = [];
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
    const result = await planner.planJourneys({
      ...payload,
      sources: selected,
      onProgress,
    });
    onProgress?.({ phase: "labels" });
    for (const option of result.options)
      for (const leg of option.legs) {
        if (leg.kind !== "ride") continue;
        const source = selected.find((source) => source.id === leg.sourceId);
        const trip = source.tables.trips.get(leg.trip);
        const route = source.tables.routes.get(trip.routeIdx);
        Object.assign(leg, {
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
  };
}
