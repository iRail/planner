import { scanForward } from "./planner-data.mjs";
import { createEarliestSearch } from "./planner-earliest.mjs";
import { validatePoint } from "./planner-endpoints.mjs";

export function createIsochroneSearch(
  network,
  origin,
  from,
  to,
  maxWalkMeters,
  activate,
) {
  origin = validatePoint(origin);
  const access = network.pointNeighbors(origin.lat, origin.lon, maxWalkMeters);
  const search = createEarliestSearch(network, -1, -2, from, to, activate, {
    access,
  });
  function finish(scanned) {
    const reachable = [];
    for (let stop = 0; stop < network.stopCount; stop += 1) {
      const arrival = search.arrivals[stop];
      if (
        network.root[stop] !== stop ||
        !Number.isFinite(arrival) ||
        arrival > to
      )
        continue;
      reachable.push({
        ...network.localStop(stop),
        arrival,
        durationSeconds: arrival - from,
      });
    }
    reachable.sort((a, b) => a.durationSeconds - b.durationSeconds);
    return {
      found: reachable.length > 0,
      noAccess: access.stops.length === 0,
      origin,
      from,
      to,
      reachable,
      maxWalkMeters,
      scanned,
    };
  }
  return { visit: search.visit, finish };
}

export function computeIsochrone(
  batches,
  network,
  origin,
  from,
  to,
  maxWalkMeters,
) {
  const search = createIsochroneSearch(
    network,
    origin,
    from,
    to,
    maxWalkMeters,
  );
  return search.finish(scanForward(batches, from, to, search.visit));
}
