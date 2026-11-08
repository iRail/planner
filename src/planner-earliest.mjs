import { timeAt } from "./planner-data.mjs";
import { WALK_SPEED } from "./planner-network.mjs";

export function createEarliestSearch(
  network,
  origin,
  destination,
  from,
  to,
  activate,
  endpoints,
) {
  const ready = new Float64Array(network.stopCount).fill(Infinity);
  const walkReady = new Float64Array(network.stopCount).fill(Infinity);
  const arrivals = new Float64Array(network.stopCount).fill(Infinity);
  const rideArrivals = new Array(network.stopCount);
  const tripBest = new Map();
  let currentTime = NaN;
  let equalTimeTrips = new Map();
  let arrival =
    endpoints?.directMeters === undefined
      ? Infinity
      : from + endpoints.directMeters / WALK_SPEED;
  if (arrival > to) arrival = Infinity;
  function offer(stop, time, walking = true) {
    arrivals[stop] = Math.min(arrivals[stop], time);
    if (walking) walkReady[stop] = Math.min(walkReady[stop], time);
    if (time > to || time >= ready[stop]) return false;
    ready[stop] = time;
    activate?.(stop, time);
    if (stop === destination) arrival = Math.min(arrival, time);
    return true;
  }
  const access = endpoints?.access ?? network.neighbors(origin);
  for (let i = 0; i < access.stops.length; i += 1)
    offer(access.stops[i], from + access.meters[i] / WALK_SPEED);

  function visit(batch, row, dep) {
    const arr = timeAt(batch, "arr", row);
    if (arr < dep || arr > to) return false;
    if (dep !== currentTime) {
      currentTime = dep;
      equalTimeTrips = new Map();
    }
    const { source } = batch;
    const dS = source.stopOffset + batch.dS[row];
    const aS = source.stopOffset + batch.aS[row];
    const trip = source.tripOffset + batch.trip[row];
    const run = (batch.serviceDate?.[row] || 0) * network.tripCount + trip;
    const key = (stop, sequence) =>
      batch.arrivalStopSequence ? `${stop}/${sequence}` : stop;
    const sameTime = equalTimeTrips.get(run);
    const previous = tripBest.get(run);
    const aboard =
      (sameTime?.get(key(dS, batch.stopSequence?.[row])) ?? Infinity) <= dep ||
      (previous?.stop === dS &&
        previous.time <= dep &&
        (!batch.arrivalStopSequence ||
          previous.sequence === batch.stopSequence[row]));
    const boardingRoot = network.root[dS];
    const canTransfer = () => {
      if (walkReady[boardingRoot] <= dep) return true;
      for (const state of rideArrivals[boardingRoot]?.values() || [])
        if (
          state.time + network.transferTime(state.stop, dS, state.trip, trip) <=
          dep
        )
          return true;
      return false;
    };
    if (
      !aboard &&
      ((batch.pickup?.[row] ?? 0) !== 0 ||
        ready[boardingRoot] > dep ||
        !canTransfer())
    )
      return false;
    if (!equalTimeTrips.has(run)) equalTimeTrips.set(run, new Map());
    const states = equalTimeTrips.get(run);
    let changed = false;
    if (
      arr < (states.get(key(aS, batch.arrivalStopSequence?.[row])) ?? Infinity)
    ) {
      states.set(key(aS, batch.arrivalStopSequence?.[row]), arr);
      changed = true;
    }
    tripBest.set(run, {
      stop: aS,
      time: arr,
      sequence: batch.arrivalStopSequence?.[row],
    });
    // Continue the vehicle in its next departure region even if alighting
    // here is forbidden. Stop reachability still requires usable drop-off.
    activate?.(network.root[aS], arr);
    if ((batch.dropOff?.[row] ?? 0) === 0) {
      const meters = endpoints?.egress?.get(network.root[aS]);
      if (meters !== undefined && arr + meters / WALK_SPEED <= to)
        arrival = Math.min(arrival, arr + meters / WALK_SPEED);
      const root = network.root[aS];
      const candidates = (rideArrivals[root] ??= new Map());
      const context = network.transferClass(aS, trip);
      if (arr < (candidates.get(context)?.time ?? Infinity)) {
        candidates.set(context, { stop: aS, trip, time: arr });
        changed = true;
      }
      changed = offer(root, arr, false) || changed;
      const neighbors = network.neighbors(aS);
      // Expand exactly one walking leg from a ride arrival. Expanding from
      // an already walked-to stop would bypass the per-leg distance limit.
      for (let i = 1; i < neighbors.stops.length; i += 1)
        changed =
          offer(neighbors.stops[i], arr + neighbors.meters[i] / WALK_SPEED) ||
          changed;
    }
    return changed;
  }
  return {
    visit,
    ready,
    arrivals,
    access,
    get arrival() {
      return arrival;
    },
  };
}
