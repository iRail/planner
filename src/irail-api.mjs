// The calls of the iRail API (https://docs.irail.be) over the planner, in plain
// JavaScript types: times are `Date`s, numbers are numbers, lists are arrays and
// what is unknown is `null`. Like the real API, a `time` is the scheduled time
// and `delay` (seconds) is how late the real-time feed says it will be, so the
// expected time is `time + delay`. Without a real-time feed, delays are 0 and
// nothing is canceled. Platforms come from the feed and are `null` otherwise.
import {
  apiStationId,
  normalizeLanguage,
  resolveStation,
  stationLabel,
  stationUri,
} from "./irail-stations.mjs";
import { serviceDateOf, zonedToEpoch, zonedParts } from "./irail-time.mjs";
import { IrailApiError, NotSupportedError } from "./irail-errors.mjs";
import { timeAt } from "./planner-data.mjs";
import {
  ARRIVAL_SKIPPED,
  DEPARTURE_SKIPPED,
  TRIP_CANCELED,
} from "./realtime.mjs";

const LIVEBOARD_SECONDS = 3600; // like the iRail API: the hour from `time`
const TRIP_REACH_SECONDS = 8 * 3600; // longest trip we look across to find its ends
const VEHICLE_PREFIX = "BE.NMBS.";
const MAX_RESULTS = 12;

const finite = (value) => (Number.isFinite(value) ? value : null);

// ------------------------------------------------------------ trip lookups

const tripTablesBySource = new WeakMap();
function tripTables(source) {
  let tables = tripTablesBySource.get(source);
  if (!tables) {
    const trips = source.tables.trips;
    const routes = source.tables.routes;
    tables = {
      routeIdx: trips.getChild("routeIdx").toArray(),
      shortName: Array.from(trips.getChild("shortName")),
      headsign: Array.from(trips.getChild("headsign")),
      routeShort: Array.from(routes.getChild("shortName")),
      routeLong: Array.from(routes.getChild("longName")),
      byVehicle: undefined,
    };
    tripTablesBySource.set(source, tables);
  }
  return tables;
}

/** `{ id: "IC508", type: "IC", number: "508", headsign }` for a trip. */
function vehicleOf(source, tripIdx) {
  const tables = tripTables(source);
  const route = tables.routeIdx[tripIdx];
  const type = tables.routeShort[route] || tables.routeLong[route] || "";
  const number = tables.shortName[tripIdx] || "";
  return {
    id: `${type}${number}`,
    type,
    number,
    headsign: tables.headsign[tripIdx] || "",
  };
}

function tripsOfVehicle(source, vehicleId) {
  const tables = tripTables(source);
  if (!tables.byVehicle) {
    tables.byVehicle = new Map();
    for (let trip = 0; trip < tables.shortName.length; trip += 1) {
      const id = vehicleOf(source, trip).id;
      if (!tables.byVehicle.has(id)) tables.byVehicle.set(id, []);
      tables.byVehicle.get(id).push(trip);
    }
  }
  return tables.byVehicle.get(vehicleId) ?? [];
}

/** The public shape of a vehicle (a train, or a bus replacing one). */
const vehicleView = (vehicle) => ({
  id: VEHICLE_PREFIX + vehicle.id,
  uri: `http://irail.be/vehicle/${vehicle.id}`,
  type: vehicle.type,
  number: vehicle.number,
  name: vehicle.type
    ? `${vehicle.type} ${vehicle.number}`.trim()
    : vehicle.id,
});

// -------------------------------------------------------------- input / views

/** An instant from a Date or epoch milliseconds, defaulting to `now` (seconds). */
function instantOf(value, now, name = "time") {
  if (value === undefined || value === null) return now;
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds))
    throw new IrailApiError(
      400,
      `${name} must be a Date or epoch milliseconds`,
    );
  return milliseconds / 1000;
}

const byStopBySource = new WeakMap();
function stationOfStop(context, stopIdx) {
  let byStop = byStopBySource.get(context.stations);
  if (!byStop) {
    byStop = new Map();
    for (const station of context.stations)
      for (const idx of station.stopIdxs) byStop.set(idx, station);
    byStopBySource.set(context.stations, byStop);
  }
  return byStop.get(stopIdx);
}

/** The public shape of a station, labelled in the query's language. */
function stationView(station, lang) {
  return {
    id: apiStationId(station.key),
    uri: stationUri(station.key),
    name: stationLabel(station, lang),
    standardName: station.name,
    latitude: finite(station.lat),
    longitude: finite(station.lon),
  };
}

/** The station of a stop (platforms resolve to their station) as a view. */
function placeOf(context, stopIdx) {
  const station = stationOfStop(context, stopIdx);
  if (station) return stationView(station, context.lang);
  // A stop the station table does not know: describe it by its own IRI.
  const { source } = context;
  const iri = source.stops.iri[stopIdx];
  const name = source.stops.name[stopIdx] || iri;
  return {
    id: iri,
    uri: iri,
    name,
    standardName: name,
    latitude: finite(source.stops.lat[stopIdx]),
    longitude: finite(source.stops.lon[stopIdx]),
  };
}

const at = (seconds) => new Date(seconds * 1000);

function lookupStation(context, input, what) {
  if (input === undefined || input === null || input === "")
    throw new IrailApiError(400, `Missing parameter: ${what}`);
  // A station object returned by an earlier call is as good as its id.
  const wanted = typeof input === "object" ? input.id : input;
  const station = resolveStation(context.stations, wanted);
  if (!station) throw new IrailApiError(404, `Could not find station ${wanted}`);
  return station;
}

async function makeContext(core, sources, payload = {}) {
  const source = payload.sourceId
    ? sources.find((s) => s.id === payload.sourceId)
    : sources[0];
  if (!source)
    throw new IrailApiError(
      payload.sourceId ? 404 : 400,
      payload.sourceId
        ? `Unknown source ${payload.sourceId}`
        : "Initialize the planner before querying",
    );
  let lang = "en";
  if (payload.language !== undefined && payload.language !== "") {
    lang = normalizeLanguage(payload.language);
    if (!lang)
      throw new IrailApiError(400, "language must be one of nl, fr, en, de");
  }
  const stations = await core.stationDirectory(source);
  return { core, source, stations, lang };
}

// ---------------------------------------------------------------- stations

async function stations(core, sources, payload) {
  const context = await makeContext(core, sources, payload);
  const all = [...context.stations, ...(context.stations.unrouted ?? [])];
  all.sort((a, b) => a.name.localeCompare(b.name));
  return all.map((station) => stationView(station, context.lang));
}

// --------------------------------------------------------------- liveboard

const tripKey = (trip, serviceDate) => trip * 1e9 + serviceDate;

/**
 * For the trips behind a set of connections, the stop where each starts and
 * where each ends, from the connections around the requested window.
 */
async function tripEnds(context, hits, from, to) {
  const wanted = new Set(hits.map((hit) => hit.key));
  const ends = new Map();
  await context.core.scanConnections(
    context.source,
    from - TRIP_REACH_SECONDS,
    to + TRIP_REACH_SECONDS,
    (batch, row) => {
      const key = tripKey(batch.trip[row], batch.serviceDate?.[row] ?? 0);
      if (!wanted.has(key)) return;
      let end = ends.get(key);
      if (!end) {
        end = {
          firstSeq: Infinity,
          origin: undefined,
          lastSeq: -Infinity,
          destination: undefined,
        };
        ends.set(key, end);
      }
      if (batch.stopSequence[row] < end.firstSeq) {
        end.firstSeq = batch.stopSequence[row];
        end.origin = batch.dS[row];
      }
      if (batch.arrivalStopSequence[row] > end.lastSeq) {
        end.lastSeq = batch.arrivalStopSequence[row];
        end.destination = batch.aS[row];
      }
    },
  );
  return ends;
}

async function liveboard(core, sources, payload, now) {
  const context = await makeContext(core, sources, payload);
  const type = payload.type ?? "departure";
  if (type !== "departure" && type !== "arrival")
    throw new IrailApiError(400, "type must be departure or arrival");
  const station = lookupStation(context, payload.station, "station");
  const from = instantOf(payload.time, now);
  const to = from + LIVEBOARD_SECONDS;
  const stops = new Set(station.stopIdxs);
  const arrivals = type === "arrival";
  const hits = [];
  await core.scanConnections(
    context.source,
    arrivals ? from - TRIP_REACH_SECONDS : from,
    to + 1,
    (batch, row) => {
      const stop = arrivals ? batch.aS[row] : batch.dS[row];
      if (!stops.has(stop)) return;
      const time = timeAt(batch, arrivals ? "arr" : "dep", row);
      if (time < from || time > to) return;
      // A stop the feed says is skipped is shown, as canceled. Otherwise
      // pickup/drop-off type 1 means passengers cannot use this stop.
      const flags = batch.flags?.[row] ?? 0;
      const skipped = (flags & (arrivals ? ARRIVAL_SKIPPED : DEPARTURE_SKIPPED)) !== 0;
      if ((arrivals ? batch.dropOff : batch.pickup)?.[row] === 1 && !skipped)
        return;
      const serviceDate = batch.serviceDate?.[row] ?? 0;
      hits.push({
        time,
        delay: (arrivals ? batch.arrDelay : batch.depDelay)?.[row] ?? 0,
        canceled: skipped || (flags & TRIP_CANCELED) !== 0,
        platform:
          (arrivals ? batch.arrPlatform : batch.depPlatform)?.[row] ?? null,
        trip: batch.trip[row],
        key: tripKey(batch.trip[row], serviceDate),
        stop,
      });
    },
  );
  const ends = await tripEnds(context, hits, from, to);
  hits.sort(
    (a, b) => a.time - a.delay - (b.time - b.delay) || a.trip - b.trip,
  );
  const entries = hits.map((hit) => {
    const end = ends.get(hit.key);
    const other = placeOf(
      context,
      (arrivals ? end?.origin : end?.destination) ?? hit.stop,
    );
    return {
      time: at(hit.time - hit.delay),
      delay: hit.delay,
      canceled: hit.canceled,
      vehicle: vehicleView(vehicleOf(context.source, hit.trip)),
      [arrivals ? "origin" : "destination"]: other,
      platform: hit.platform,
    };
  });
  return { station: stationView(station, context.lang), type, entries };
}

// ----------------------------------------------------------------- vehicle

/** What the real-time overlay says about one connection (all zeros without it). */
const rowRealtime = (batch, row) => ({
  depDelay: batch.depDelay?.[row] ?? 0,
  arrDelay: batch.arrDelay?.[row] ?? 0,
  flags: batch.flags?.[row] ?? 0,
  depPlatform: batch.depPlatform?.[row] ?? null,
  arrPlatform: batch.arrPlatform?.[row] ?? null,
});

/** Stops of one trip, from its connections in stop-sequence order. */
function stopsOfTrip(context, rows) {
  rows.sort((a, b) => a.stopSequence - b.stopSequence);
  const stops = [];
  for (let i = 0; i <= rows.length; i += 1) {
    const arrivalRow = rows[i - 1];
    const departureRow = rows[i];
    stops.push({
      station: placeOf(context, departureRow ? departureRow.dS : arrivalRow.aS),
      arrival: arrivalRow ? at(arrivalRow.arr - arrivalRow.arrDelay) : null,
      departure: departureRow ? at(departureRow.dep - departureRow.depDelay) : null,
      platform: departureRow?.depPlatform ?? arrivalRow?.arrPlatform ?? null,
      arrivalDelay: arrivalRow?.arrDelay ?? 0,
      departureDelay: departureRow?.depDelay ?? 0,
      canceled:
        ((arrivalRow?.flags ?? 0) & (TRIP_CANCELED | ARRIVAL_SKIPPED)) !== 0 ||
        ((departureRow?.flags ?? 0) & (TRIP_CANCELED | DEPARTURE_SKIPPED)) !== 0,
    });
  }
  return stops;
}

async function vehicle(core, sources, payload, now) {
  const context = await makeContext(core, sources, payload);
  const raw = String(payload.id ?? "").trim();
  if (!raw) throw new IrailApiError(400, "Missing parameter: id");
  const id = raw.startsWith(VEHICLE_PREFIX)
    ? raw.slice(VEHICLE_PREFIX.length)
    : raw.replace(/^http:\/\/irail\.be\/vehicle\//u, "");
  // The service day is the Belgian calendar day of `date`.
  const day = zonedParts(instantOf(payload.date, now, "date"));
  const dayStart = zonedToEpoch({ ...day, hour: 0, minute: 0 });
  const serviceDate = serviceDateOf(dayStart);
  const candidates = new Set(tripsOfVehicle(context.source, id));
  const trips = new Map();
  if (candidates.size)
    await core.scanConnections(
      context.source,
      dayStart - 3 * 3600,
      dayStart + 36 * 3600,
      (batch, row) => {
        const trip = batch.trip[row];
        if (!candidates.has(trip) || batch.serviceDate?.[row] !== serviceDate)
          return;
        if (!trips.has(trip)) trips.set(trip, []);
        trips.get(trip).push({
          stopSequence: batch.stopSequence[row],
          dS: batch.dS[row],
          aS: batch.aS[row],
          dep: timeAt(batch, "dep", row),
          arr: timeAt(batch, "arr", row),
          ...rowRealtime(batch, row),
        });
      },
    );
  if (!trips.size)
    throw new IrailApiError(404, `Vehicle ${raw} not found on that date`);
  // Several trips can share a vehicle number on one day; report the first.
  const [tripIdx, rows] = [...trips].sort(
    (a, b) =>
      Math.min(...a[1].map((r) => r.dep)) - Math.min(...b[1].map((r) => r.dep)),
  )[0];
  return {
    vehicle: vehicleView(vehicleOf(context.source, tripIdx)),
    stops: stopsOfTrip(context, rows),
  };
}

// -------------------------------------------------------------- connections

function walkEnd(context, ref, time) {
  const station =
    ref && ref.stopIdx !== undefined
      ? placeOf(context, ref.stopIdx)
      : {
          id: "",
          uri: "",
          name: "Your location",
          standardName: "Your location",
          latitude: finite(ref?.lat),
          longitude: finite(ref?.lon),
        };
  return { station, time: at(time), platform: null, delay: 0, canceled: false };
}

// `time` is the expected time; the scheduled time is `delay` earlier.
const rideEnd = (context, stopIdx, time, delay, platform) => ({
  station: placeOf(context, stopIdx),
  time: at(time - delay),
  platform,
  delay,
  canceled: false,
});

/** Stops between the ends of each ride leg, read from the trip's connections. */
async function intermediateStops(context, journeys) {
  const legs = journeys.flatMap((j) => j.legs.filter((l) => l.kind === "ride"));
  const stops = new Map();
  if (!legs.length) return stops;
  const wanted = new Map();
  for (const leg of legs) wanted.set(tripKey(leg.trip, leg.serviceDate), []);
  await context.core.scanConnections(
    context.source,
    Math.min(...legs.map((l) => l.boardTime)),
    Math.max(...legs.map((l) => l.alightTime)),
    (batch, row) => {
      const rows = wanted.get(
        tripKey(batch.trip[row], batch.serviceDate?.[row] ?? 0),
      );
      if (rows)
        rows.push({
          stopSequence: batch.stopSequence[row],
          aS: batch.aS[row],
          dep: timeAt(batch, "dep", row),
          arr: timeAt(batch, "arr", row),
          ...rowRealtime(batch, row),
        });
    },
  );
  for (const leg of legs) {
    const rows = wanted
      .get(tripKey(leg.trip, leg.serviceDate))
      // `lastStopSequence` is the stop sequence of the ride's last connection.
      .filter(
        (r) =>
          r.stopSequence >= leg.stopSequence &&
          r.stopSequence <= leg.lastStopSequence,
      )
      .sort((a, b) => a.stopSequence - b.stopSequence);
    const list = [];
    for (let i = 0; i + 1 < rows.length; i += 1)
      list.push({
        station: placeOf(context, rows[i].aS),
        arrival: at(rows[i].arr - rows[i].arrDelay),
        departure: at(rows[i + 1].dep - rows[i + 1].depDelay),
        arrivalDelay: rows[i].arrDelay,
        departureDelay: rows[i + 1].depDelay,
        platform: rows[i + 1].depPlatform ?? rows[i].arrPlatform,
        canceled:
          (rows[i].flags & ARRIVAL_SKIPPED) !== 0 ||
          (rows[i + 1].flags & DEPARTURE_SKIPPED) !== 0,
      });
    stops.set(leg, list);
  }
  return stops;
}

function legView(context, leg, intermediates) {
  if (leg.kind === "walk")
    return {
      type: "walk",
      from: walkEnd(context, leg.from, leg.boardTime),
      to: walkEnd(context, leg.to, leg.alightTime),
      vehicle: null,
      direction: null,
      stops: [],
      distanceMeters: leg.distanceMeters,
    };
  const info = vehicleOf(context.source, leg.trip);
  return {
    type: "ride",
    from: rideEnd(
      context,
      leg.boardStop,
      leg.boardTime,
      leg.boardDelay ?? 0,
      leg.boardPlatform ?? null,
    ),
    to: rideEnd(
      context,
      leg.alightStop,
      leg.alightTime,
      leg.alightDelay ?? 0,
      leg.alightPlatform ?? null,
    ),
    vehicle: vehicleView(info),
    direction: info.headsign || null,
    stops: intermediates.get(leg) ?? [],
    distanceMeters: null,
  };
}

async function connections(core, sources, payload, now, plan) {
  const context = await makeContext(core, sources, payload);
  const from = lookupStation(context, payload.from, "from");
  const to = lookupStation(context, payload.to, "to");
  if (payload.arriveBy !== undefined && payload.arriveBy !== false)
    throw new NotSupportedError(
      "connections with arriveBy",
      "the planner only searches forward from a departure time",
    );
  const vehicles = payload.vehicles ?? "all";
  if (vehicles !== "all") {
    if (["trains", "domestic-trains"].includes(vehicles))
      throw new NotSupportedError(
        `connections with vehicles=${vehicles}`,
        "the planner does not filter by kind of vehicle yet",
      );
    throw new IrailApiError(400, "vehicles must be all, trains or domestic-trains");
  }
  if (from.key === to.key)
    throw new IrailApiError(400, "Departure and arrival station are the same");
  if (from.stopIdx === undefined || to.stopIdx === undefined)
    throw new IrailApiError(404, "That station is not in the timetable");
  const wanted = Math.min(
    MAX_RESULTS,
    Math.max(1, Math.floor(Number(payload.limit) || 6)),
  );
  const result = await plan(
    {
      origin: { sourceId: context.source.id, stopIdx: from.stopIdx },
      destination: { sourceId: context.source.id, stopIdx: to.stopIdx },
      departureAfter: instantOf(payload.time, now),
      maxWalkMeters: payload.maxWalkMeters ?? 0,
      windowMode: "adaptive",
      minOptions: wanted,
      sourceIds: [context.source.id],
    },
    [context.source],
  );
  const journeys = result.options.slice(0, wanted);
  const intermediates = await intermediateStops(context, journeys);
  return journeys.map((journey) => {
    // Journey times are scheduled; the delays are those of the first and the
    // last train, which is what a traveller waits for.
    const rides = journey.legs.filter((leg) => leg.kind === "ride");
    const departureDelay = rides[0]?.boardDelay ?? 0;
    const arrivalDelay = rides.at(-1)?.alightDelay ?? 0;
    const departure = journey.departure - departureDelay;
    const arrival = journey.arrival - arrivalDelay;
    return {
      departure: at(departure),
      departureDelay,
      arrival: at(arrival),
      arrivalDelay,
      duration: arrival - departure,
      transfers: journey.transfers,
      legs: journey.legs.map((leg) => legView(context, leg, intermediates)),
    };
  });
}

// --------------------------------------------------- not available (yet)

function unsupported(call, reason) {
  return async () => {
    throw new NotSupportedError(call, reason);
  };
}

export const unsupportedCalls = {
  composition: unsupported(
    "composition",
    "train composition comes from a source the planner does not read yet",
  ),
  disturbances: unsupported(
    "disturbances",
    "service alerts come from a source the planner does not read yet",
  ),
  occupancyFeedback: unsupported(
    "occupancyFeedback",
    "occupancy reports go to a service the planner does not talk to yet",
  ),
};

/** Handlers for the planner service: `(sources, payload, now, plan) => result`. */
export function createIrailApi(core) {
  return {
    stations: (sources, payload) => stations(core, sources, payload),
    liveboard: (sources, payload, now) =>
      liveboard(core, sources, payload, now),
    vehicle: (sources, payload, now) => vehicle(core, sources, payload, now),
    connections: (sources, payload, now, plan) =>
      connections(core, sources, payload, now, plan),
  };
}
