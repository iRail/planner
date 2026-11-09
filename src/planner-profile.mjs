import { scanBackward, timeAt } from "./planner-data.mjs";
import { WALK_SPEED } from "./planner-network.mjs";

// Query-local structure of arrays. Only retained labels allocate a slot.
export class ProfileStore {
  constructor(stopCount) {
    this.profiles = new Array(stopCount);
    this.contexts = [];
    this.connectionIris = [];
    this.length = 0;
    this.lookups = 0;
    this.lookupHits = 0;
    this.capacity = 0;
    this.grow();
  }
  grow() {
    this.capacity = this.capacity ? this.capacity * 2 : 4096;
    for (const name of [
      "dep",
      "arrival",
      "alightTime",
      "meters",
      "boardStop",
      "alightStop",
      "trip",
      "next",
      "rides",
      "kind",
      "serviceDate",
      "stopSequence",
      "lastStopSequence",
    ]) {
      const Type = ["dep", "arrival", "alightTime", "meters"].includes(name)
        ? Float64Array
        : ["serviceDate", "stopSequence", "lastStopSequence"].includes(name)
          ? Uint32Array
          : Int32Array;
      const next = new Type(this.capacity);
      if (this[name]) next.set(this[name]);
      this[name] = next;
    }
  }
  add(
    dep,
    arrival,
    boardStop,
    alightStop,
    alightTime,
    trip,
    next,
    rides,
    kind = 0,
    meters = 0,
  ) {
    if (this.length === this.capacity) this.grow();
    const id = this.length++;
    this.dep[id] = dep;
    this.arrival[id] = arrival;
    this.boardStop[id] = boardStop;
    this.alightStop[id] = alightStop;
    this.alightTime[id] = alightTime;
    this.trip[id] = trip;
    this.next[id] = next;
    this.rides[id] = rides;
    this.kind[id] = kind;
    this.meters[id] = meters;
    if (kind === 1) this.onConnection?.(boardStop, alightStop, kind);
    return id;
  }
  bound(list, field, value, upper = false) {
    let lo = 0;
    let hi = list.length;
    const values = this[field];
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (values[list[mid]] < value || (upper && values[list[mid]] === value))
        lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  lookup(list, time) {
    this.lookups += 1;
    if (!list.length) return -1;
    if (list.cached && time > list.lower && time <= list.upper) {
      this.lookupHits += 1;
      return list.cachedId;
    }
    const index = this.bound(list, "dep", time);
    list.lower = index ? this.dep[list[index - 1]] : -Infinity;
    list.upper = index < list.length ? this.dep[list[index]] : Infinity;
    list.cachedId = index < list.length ? list[index] : -1;
    list.cached = true;
    return list.cachedId;
  }
  dominated(stop, dep, arrival, rides, context = 0) {
    const groups = this.profiles[stop];
    if (!groups) return false;
    for (const list of groups.values()) {
      if (list.rides > rides || list.context !== context) continue;
      const i = this.bound(list, "dep", dep);
      if (i < list.length && this.arrival[list[i]] <= arrival) return true;
    }
    return false;
  }
  insert(stop, id, check = true) {
    const dep = this.dep[id];
    const arrival = this.arrival[id];
    const rides = this.rides[id];
    const context =
      stop === this.profiles.length - 1 ? 0 : this.contexts[id] || 0;
    if (check && this.dominated(stop, dep, arrival, rides, context))
      return false;
    const groups = (this.profiles[stop] ??= new Map());
    groups.minArrival = Math.min(groups.minArrival ?? Infinity, arrival);
    groups.minRides = Math.min(groups.minRides ?? Infinity, rides);
    for (const list of groups.values()) {
      if (list.rides < rides || list.context !== context) continue;
      const lo = this.bound(list, "arrival", arrival);
      const hi = this.bound(list, "dep", dep, true);
      if (hi > lo) {
        list.splice(lo, hi - lo);
        list.cached = false;
      }
    }
    const key = context ? `${rides}:${context}` : rides;
    if (!groups.has(key)) {
      const entries = [];
      entries.rides = rides;
      entries.context = context;
      groups.set(key, entries);
    }
    const list = groups.get(key);
    list.splice(this.bound(list, "dep", dep), 0, id);
    list.cached = false;
    return true;
  }
}

export function computeProfile(
  batches,
  network,
  origin,
  destination,
  from,
  to,
) {
  const search = createProfileSearch(network, origin, destination, from, to);
  return search.finish(scanBackward(batches, from, to, search.visit));
}

export function createProfileSearch(
  network,
  origin,
  destination,
  from,
  to,
  onReach,
  endpoints,
) {
  const store = new ProfileStore(network.stopCount + 1);
  store.onConnection = endpoints?.onConnection;
  const tripBest = new Map();
  const egress = endpoints?.egress ?? new Map();
  if (!endpoints) {
    const endNeighbors = network.neighbors(destination);
    for (let i = 0; i < endNeighbors.stops.length; i += 1)
      egress.set(endNeighbors.stops[i], endNeighbors.meters[i]);
  }
  // Reused scratch frontier: no candidate object allocated per scanned label.
  const arrivals = [],
    rides = [],
    kinds = [],
    refs = [],
    walking = [],
    targets = [];
  function candidateDominates(arrival, count) {
    for (let i = 0; i < arrivals.length; i += 1)
      if (arrivals[i] <= arrival && rides[i] <= count) return true;
    return false;
  }
  function offer(arrival, count, kind, ref, meters = 0, target = -1) {
    for (let i = 0; i < arrivals.length; i += 1)
      if (arrivals[i] <= arrival && rides[i] <= count) return;
    for (let i = arrivals.length - 1; i >= 0; i -= 1)
      if (arrival <= arrivals[i] && count <= rides[i]) {
        arrivals.splice(i, 1);
        rides.splice(i, 1);
        kinds.splice(i, 1);
        refs.splice(i, 1);
        walking.splice(i, 1);
        targets.splice(i, 1);
      }
    arrivals.push(arrival);
    rides.push(count);
    kinds.push(kind);
    refs.push(ref);
    walking.push(meters);
    targets.push(target);
  }
  // Where each trip that another trip continues as (a split or joined train)
  // can be ridden on from: run -> station root -> { time, options }.
  const linkedDepartures = new Map();
  let currentTime = NaN;
  let equalTimeTrips = new Map();
  let acceptedRows = 0;
  let relaxations = 0;
  const visit = (batch, row, dep) => {
    relaxations += 1;
    const arr = timeAt(batch, "arr", row);
    if (arr > to || arr < dep) return false;
    acceptedRows += 1;
    if (dep !== currentTime) {
      currentTime = dep;
      equalTimeTrips = new Map();
    }
    const { source } = batch;
    const dS = source.stopOffset + batch.dS[row];
    const aS = source.stopOffset + batch.aS[row];
    const dRoot = network.root[dS];
    const aRoot = network.root[aS];
    const trip = source.tripOffset + batch.trip[row];
    const serviceDate = batch.serviceDate?.[row] || 0;
    const run = serviceDate * network.tripCount + trip;
    const context = network.transferClass(dS, trip);
    arrivals.length =
      rides.length =
      kinds.length =
      refs.length =
      walking.length =
      targets.length =
        0;
    const key = (stop, sequence) =>
      batch.arrivalStopSequence ? `${stop}/${sequence}` : stop;
    const previous =
      arr === dep
        ? equalTimeTrips
            .get(run)
            ?.get(key(aS, batch.arrivalStopSequence?.[row])) ||
          tripBest.get(run)
        : tripBest.get(run);
    if (
      previous &&
      previous.stop === aS &&
      previous.time >= arr &&
      (!batch.arrivalStopSequence ||
        previous.sequence === batch.arrivalStopSequence[row])
    )
      for (const id of previous.options)
        offer(store.arrival[id], store.rides[id], 1, id);
    // In-seat transfer: this trip continues as another one at this stop, so
    // the rest of that trip is ridden without getting off. It is one ride for
    // the traveller, shown as two legs, and needs no transfer time.
    const links = network.linked.get(trip);
    if (links)
      for (const link of links) {
        if (network.root[link.stop] !== aRoot) continue;
        const boarding = linkedDepartures
          .get(serviceDate * network.tripCount + link.trip)
          ?.get(aRoot);
        if (boarding && boarding.time >= arr)
          for (const id of boarding.options)
            offer(store.arrival[id], store.rides[id], 3, id);
      }
    if ((batch.dropOff?.[row] ?? 0) === 0) {
      const meters = egress.get(aRoot);
      if (meters !== undefined && arr + meters / WALK_SPEED <= to)
        offer(arr + meters / WALK_SPEED, 1, 0, meters);
      const neighbors = network.neighbors(aRoot);
      for (let n = 0; n < neighbors.stops.length; n += 1) {
        const stop = neighbors.stops[n];
        const groups = store.profiles[stop];
        if (
          !groups ||
          candidateDominates(groups.minArrival, groups.minRides + 1)
        )
          continue;
        for (const list of groups.values()) {
          const count = list.rides;
          if (
            !list.length ||
            candidateDominates(store.arrival[list[0]], count + 1)
          )
            continue;
          const ready =
            arr +
            (stop === aRoot
              ? network.transferTime(
                  aS,
                  store.boardStop[list[0]],
                  trip,
                  store.trip[list[0]],
                )
              : neighbors.meters[n] / WALK_SPEED);
          const id = store.lookup(list, ready);
          if (id !== -1)
            offer(
              store.arrival[id],
              count + 1,
              2,
              id,
              neighbors.meters[n],
              stop,
            );
        }
      }
    }

    if (!arrivals.length) return false;
    // Profiles compress through-rides into one boarding/alighting leg. The
    // live map shows the underlying useful timetable segments instead.
    store.onConnection?.(dS, aS, 0);
    let changed = false;
    const options = [];
    let canBoard = false;
    for (let i = 0; i < arrivals.length; i += 1) {
      const boardable =
        (batch.pickup?.[row] ?? 0) === 0 &&
        !store.dominated(dRoot, dep, arrivals[i], rides[i], context);
      // A trip that another trip continues as keeps its own label even when an
      // identical twin dominates it for boarders: riders staying seated get it
      // without the extra ride the twin would cost them.
      if (kinds[i] === 1 && !boardable && !network.linkTargets.has(trip)) {
        options.push(refs[i]);
        continue;
      }
      let alight = aS;
      let alightTime = arr;
      let next = -1;
      if (kinds[i] === 1) {
        alight = store.alightStop[refs[i]];
        alightTime = store.alightTime[refs[i]];
        next = store.next[refs[i]];
      } else if (kinds[i] === 3) {
        next = refs[i];
      } else if (kinds[i] === 2) {
        next = refs[i];
        if (targets[i] !== aRoot)
          next = store.add(
            arr,
            arrivals[i],
            aRoot,
            targets[i],
            arr + walking[i] / WALK_SPEED,
            -1,
            next,
            rides[i] - 1,
            1,
            walking[i],
          );
      } else if (refs[i] > 0 || aRoot !== destination)
        next = store.add(
          arr,
          arrivals[i],
          aRoot,
          destination,
          arrivals[i],
          -1,
          -1,
          0,
          1,
          refs[i],
        );
      const id = store.add(
        dep,
        arrivals[i],
        dS,
        alight,
        alightTime,
        trip,
        next,
        rides[i],
      );
      store.contexts[id] = context;
      store.serviceDate[id] = serviceDate;
      store.connectionIris[id] = batch.iri?.[row];
      store.stopSequence[id] = batch.stopSequence?.[row] || 0;
      store.lastStopSequence[id] =
        kinds[i] === 1
          ? store.lastStopSequence[refs[i]]
          : batch.stopSequence?.[row] || 0;
      options.push(id);
      if (boardable) {
        changed = store.insert(dRoot, id, false) || changed;
        canBoard = true;
      }
    }
    if (network.linkTargets.has(trip)) {
      const continuing = options.filter(
        (id) => store.boardStop[id] === dS && store.trip[id] === trip,
      );
      if (continuing.length) {
        if (!linkedDepartures.has(run)) linkedDepartures.set(run, new Map());
        linkedDepartures.get(run).set(dRoot, { time: dep, options: continuing });
      }
    }
    const state = {
      stop: dS,
      time: dep,
      options,
      sequence: batch.stopSequence?.[row],
    };
    if (!equalTimeTrips.has(run)) equalTimeTrips.set(run, new Map());
    const sameTime = equalTimeTrips.get(run);
    const old = sameTime.get(key(dS, batch.stopSequence?.[row]));
    if (
      !old ||
      options.some(
        (id) =>
          !old.options.some(
            (other) =>
              store.arrival[other] <= store.arrival[id] &&
              store.rides[other] <= store.rides[id],
          ),
      )
    ) {
      sameTime.set(key(dS, batch.stopSequence?.[row]), state);
      changed = true;
    }
    tripBest.set(run, state);
    onReach?.(dRoot, dep, canBoard);
    return changed;
  };
  // At most six journeys: the earliest departing, or with `latest` (arriving by
  // a deadline) the ones closest to the deadline.
  function finish(scanned, { latest = false } = {}) {
    // Resolve walking access once, after the scan. Intermediate walking was
    // resolved at arrival lookup, avoiding a label copy at every nearby stop.
    const originProfile = network.stopCount;
    const access = endpoints?.access ?? network.neighbors(origin);
    for (let n = 0; n < access.stops.length; n += 1) {
      const stop = access.stops[n];
      for (const list of store.profiles[stop]?.values() || [])
        for (const id of list) {
          const dep = store.dep[id] - access.meters[n] / WALK_SPEED;
          if (
            dep < from ||
            store.dominated(
              originProfile,
              dep,
              store.arrival[id],
              store.rides[id],
            )
          )
            continue;
          const entry =
            stop === origin
              ? id
              : store.add(
                  dep,
                  store.arrival[id],
                  origin,
                  stop,
                  store.dep[id],
                  -1,
                  id,
                  store.rides[id],
                  1,
                  access.meters[n],
                );
          store.insert(originProfile, entry);
        }
    }
    const meters = endpoints ? endpoints.directMeters : egress.get(origin);
    if (meters !== undefined && from + meters / WALK_SPEED <= to) {
      // Walking-only journeys do not have a meaningful latest departure. Show
      // the option starting at the requested time alongside scheduled profiles.
      store.insert(
        originProfile,
        store.add(
          from,
          from + meters / WALK_SPEED,
          origin,
          destination,
          from + meters / WALK_SPEED,
          -1,
          -1,
          0,
          1,
          meters,
        ),
      );
    }
    const candidates = [];
    for (const list of store.profiles[originProfile]?.values() || [])
      for (const id of list) candidates.push(id);
    candidates.sort(
      (a, b) =>
        store.dep[a] - store.dep[b] || store.arrival[a] - store.arrival[b],
    );
    const options = (latest ? candidates.slice(-6) : candidates.slice(0, 6)).map((id) => {
      const legs = [];
      for (let entry = id; entry !== -1; entry = store.next[entry]) {
        const resolve = endpoints?.localStop ?? network.localStop;
        const board = resolve(store.boardStop[entry]);
        const alight = resolve(store.alightStop[entry]);
        if (store.kind[entry] === 1) {
          if (
            store.meters[entry] ||
            board.sourceId !== alight.sourceId ||
            board.stopIdx !== alight.stopIdx
          )
            legs.push({
              kind: "walk",
              from: board,
              to: alight,
              boardTime: store.dep[entry],
              alightTime: store.alightTime[entry],
              distanceMeters: store.meters[entry],
            });
        } else {
          const source = network.sources[network.owner[store.boardStop[entry]]];
          legs.push({
            kind: "ride",
            sourceId: source.id,
            trip: store.trip[entry] - source.tripOffset,
            connectionIri: store.connectionIris[entry],
            serviceDate: store.serviceDate[entry],
            stopSequence: store.stopSequence[entry],
            lastStopSequence: store.lastStopSequence[entry],
            boardStop: board.stopIdx,
            alightStop: alight.stopIdx,
            boardTime: store.dep[entry],
            alightTime: store.alightTime[entry],
          });
        }
      }
      return {
        departure: store.dep[id],
        arrival: store.arrival[id],
        transfers: Math.max(0, store.rides[id] - 1),
        legs,
      };
    });
    return {
      found: options.length > 0,
      options,
      totalOptions: candidates.length,
      scanned,
      diagnostics: {
        labels: store.length,
        relaxations,
        acceptedRows,
        lookups: store.lookups,
        lookupHits: store.lookupHits,
      },
    };
  }
  return { visit, finish };
}
