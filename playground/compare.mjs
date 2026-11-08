// Pure helpers for the iRail API vs. planner comparison page: station identity
// mapping, Brussels-time conversion, normalising both result formats into one
// journey shape, and diffing the two result sets. No DOM and no network.

import { TIME_ZONE, zonedParts, zonedToEpoch } from "../src/irail-time.mjs";

export { TIME_ZONE };
export const API_BASE = "https://api.irail.be/v1";

const asArray = (value) => (value ? (Array.isArray(value) ? value : [value]) : []);

import { apiStationId, stationKey } from "../src/irail-stations.mjs";

export { apiStationId, stationKey };
export { zonedParts, zonedToEpoch };

const pad = (n, width = 2) => String(n).padStart(width, "0");

/** Query string for the API's connections endpoint (Belgian local date and time). */
export function apiConnectionsUrl({
  fromKey,
  toKey,
  departureAfter,
  results = 6,
  language = "en",
}) {
  const p = zonedParts(departureAfter);
  const params = new URLSearchParams({
    from: apiStationId(fromKey),
    to: apiStationId(toKey),
    date: `${pad(p.day)}${pad(p.month)}${pad(p.year % 100)}`,
    time: `${pad(p.hour)}${pad(p.minute)}`,
    timesel: "departure",
    results: String(results),
    format: "json",
    lang: language,
    typeOfTransport: "automatic",
  });
  return `${API_BASE}/connections?${params}`;
}

const seconds = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Both result formats are reduced to
 * `{ departure, arrival, transfers, legs, delay, canceled }` with times in UTC
 * epoch seconds. A leg is `{ kind: 'ride'|'walk', from, to, label }` where
 * from/to are `{ key, name, time, platform? }`.
 */
export function normalizeApiConnection(connection) {
  const departure = connection.departure || {};
  const arrival = connection.arrival || {};
  const vias = asArray(connection.vias?.via);
  const point = (stop, name, info) => ({
    key: stationKey(info?.id) ?? stationKey(info?.["@id"]),
    name: name || info?.name || "",
    time: seconds(stop.time),
    platform: stop.platform && stop.platform !== "?" ? stop.platform : undefined,
  });
  const legs = [];
  let start = { stop: departure, name: departure.station, info: departure.stationinfo };
  const finish = (end) => {
    const walking = Number(start.stop.walking) === 1;
    legs.push({
      kind: walking ? "walk" : "ride",
      from: point(start.stop, start.name, start.info),
      to: point(end.stop, end.name, end.info),
      label: walking
        ? "Walk"
        : start.stop.vehicleinfo?.shortname ||
          String(start.stop.vehicle || "").replace(/^BE\.NMBS\./u, ""),
      headsign: start.stop.direction?.name,
    });
  };
  for (const via of vias) {
    finish({ stop: via.arrival || {}, name: via.station, info: via.stationinfo });
    start = { stop: via.departure || {}, name: via.station, info: via.stationinfo };
  }
  finish({ stop: arrival, name: arrival.station, info: arrival.stationinfo });
  const stops = [departure, arrival, ...vias.flatMap((v) => [v.arrival, v.departure])];
  return {
    departure: seconds(departure.time),
    arrival: seconds(arrival.time),
    transfers: vias.length,
    legs,
    delay: seconds(departure.delay),
    arrivalDelay: seconds(arrival.delay),
    canceled: stops.some((stop) => Number(stop?.canceled) > 0),
  };
}

/** `names[stopIdx]` and `ids[stopIdx]` come from the planner's init response. */
export function normalizePlannerJourney(journey, { names, ids }) {
  const endpoint = (ref, time) => {
    const known = ref && ref.stopIdx !== undefined;
    return {
      key: known ? stationKey(ids[ref.stopIdx]) : null,
      name: known ? names[ref.stopIdx] || ids[ref.stopIdx] : "Your location",
      time,
    };
  };
  return {
    departure: journey.departure,
    arrival: journey.arrival,
    transfers: journey.transfers,
    delay: 0,
    arrivalDelay: 0,
    canceled: false,
    legs: journey.legs.map((leg) =>
      leg.kind === "walk"
        ? {
            kind: "walk",
            from: endpoint(leg.from, leg.boardTime),
            to: endpoint(leg.to, leg.alightTime),
            label: "Walk",
            meters: leg.distanceMeters,
          }
        : {
            kind: "ride",
            from: {
              key: stationKey(leg.boardStopIri),
              name: names[leg.boardStop] || leg.boardStopIri,
              time: leg.boardTime,
            },
            to: {
              key: stationKey(leg.alightStopIri),
              name: names[leg.alightStop] || leg.alightStopIri,
              time: leg.alightTime,
            },
            label: leg.routeName || "Train",
            headsign: leg.headsign,
          },
    ),
  };
}

// a is at least as good as b on departure, arrival and transfers, and better on one.
const dominates = (a, b) =>
  a.departure >= b.departure &&
  a.arrival <= b.arrival &&
  a.transfers <= b.transfers &&
  (a.departure > b.departure || a.arrival < b.arrival || a.transfers < b.transfers);

const transferKeys = (journey) =>
  journey.legs
    .slice(1)
    .map((leg) => leg.from.key)
    .join(",");
// Names of the transfer stations the other journey does not use.
const transfersOnlyIn = (journey, other) => {
  const used = new Set(other.legs.slice(1).map((leg) => leg.from.key));
  const names = journey.legs
    .slice(1)
    .filter((leg) => !used.has(leg.from.key))
    .map((leg) => leg.from.name || leg.from.key);
  return names.join(" + ") || "none";
};

/**
 * Diff two result sets of the same query. Journeys are the same when they
 * leave and arrive at the same scheduled instants. Every difference gets a
 * reason, because the two sides answer slightly different questions: the API
 * lists the next few departures (including slower ones), the planner lists
 * Pareto-optimal alternatives, and only the API knows realtime delays.
 *
 * `plannerWindow` ({ from, to } in epoch seconds, from the planner result)
 * explains iRail journeys the planner's heuristic search window never reached.
 *
 * statuses: same | differs | only-api | only-planner | dominated | outside | window
 */
export function compareJourneys(
  apiJourneys,
  plannerJourneys,
  { plannerWindow } = {},
) {
  const rows = [];
  const plannerLeft = new Set(plannerJourneys);
  const apiLeft = [];
  for (const api of apiJourneys) {
    const planner = plannerJourneys.find(
      (p) => plannerLeft.has(p) && p.departure === api.departure && p.arrival === api.arrival,
    );
    if (planner) {
      plannerLeft.delete(planner);
      const notes = [];
      if (planner.transfers !== api.transfers)
        notes.push(`${api.transfers} vs ${planner.transfers} transfers`);
      else if (transferKeys(api) !== transferKeys(planner))
        notes.push(
          `same times, other transfer stations (iRail: ${transfersOnlyIn(api, planner)}; planner: ${transfersOnlyIn(planner, api)})`,
        );
      if (api.canceled) notes.push("canceled in realtime");
      else if (api.arrivalDelay > 0)
        notes.push(`${Math.round(api.arrivalDelay / 60)} min late in realtime`);
      rows.push({ status: "same", api, planner, notes });
    } else apiLeft.push(api);
  }
  // Same departure but another arrival: two answers for the same train choice.
  for (const api of [...apiLeft]) {
    const planner = [...plannerLeft].find((p) => p.departure === api.departure);
    if (!planner) continue;
    apiLeft.splice(apiLeft.indexOf(api), 1);
    plannerLeft.delete(planner);
    const diff = Math.round((planner.arrival - api.arrival) / 60);
    rows.push({
      status: "differs",
      api,
      planner,
      notes: [
        `planner arrives ${Math.abs(diff)} min ${diff < 0 ? "earlier" : "later"}`,
      ],
    });
  }
  for (const api of apiLeft) {
    const better = apiJourneys.find((other) => other !== api && dominates(other, api));
    if (better)
      rows.push({
        status: "dominated",
        api,
        notes: ["slower than another iRail result, so the planner omits it"],
      });
    else if (plannerWindow && api.arrival > plannerWindow.to)
      rows.push({
        status: "window",
        api,
        notes: [
          "arrives after the end of the planner's search window",
        ],
      });
    else
      rows.push({
        status: "only-api",
        api,
        notes: api.canceled ? ["canceled in realtime"] : [],
      });
  }
  const first = Math.min(...apiJourneys.map((j) => j.departure));
  const last = Math.max(...apiJourneys.map((j) => j.departure));
  for (const planner of plannerLeft) {
    const outside =
      apiJourneys.length > 0 && (planner.departure < first || planner.departure > last);
    rows.push({
      status: outside ? "outside" : "only-planner",
      planner,
      notes: outside ? ["outside the departures iRail returned"] : [],
    });
  }
  rows.sort(
    (a, b) =>
      (a.api ?? a.planner).departure - (b.api ?? b.planner).departure ||
      (a.api ?? a.planner).arrival - (b.api ?? b.planner).arrival,
  );
  const count = (status) => rows.filter((row) => row.status === status).length;
  const earliest = (list) =>
    list.length ? Math.min(...list.map((j) => j.arrival)) : undefined;
  const apiBest = earliest(apiJourneys.filter((j) => !j.canceled));
  const plannerBest = earliest(plannerJourneys);
  return {
    rows,
    summary: {
      same: count("same"),
      differs: count("differs"),
      onlyApi: count("only-api"),
      onlyPlanner: count("only-planner"),
      dominated: count("dominated"),
      outside: count("outside"),
      beyondWindow: count("window"),
      apiCount: apiJourneys.length,
      plannerCount: plannerJourneys.length,
      apiEarliestArrival: apiBest,
      plannerEarliestArrival: plannerBest,
      sameEarliestArrival:
        apiBest !== undefined && plannerBest !== undefined && apiBest === plannerBest,
    },
  };
}

export function median(values) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
