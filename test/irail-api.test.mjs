import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  IrailApiError,
  NotSupportedError,
  createPlanner,
} from "../src/index.mjs";
import { timetable, start } from "./helpers/timetable.mjs";
import { stationKey } from "../src/irail-stations.mjs";
import { startWorker } from "./helpers/worker.mjs";

// Station numbers (the digits) tie stop IRIs to the iRail station table.
const stopIris = [1000001, 1000002, 1000003, 1000004].map(
  (n) => `https://irail.be/id/be.sncb/stops/S${n}`,
);
const stationRows = [
  ["Origin", "Origine", null, "Ursprung", "Origin Town", 51, 400],
  ["Interchange", null, "Overstap", null, null, 51.1, 300],
  ["Destination", "Destination FR", null, null, null, 51.2, 200],
  ["Disconnected", null, null, null, null, 51.3, 0],
].map(([name, fr, nl, de, en, lat, avgStopTimes], i) => ({
  iri: `http://irail.be/stations/NMBS/00100000${i + 1}`,
  name,
  alternativeFr: fr,
  alternativeNl: nl,
  alternativeDe: de,
  alternativeEn: en,
  lat,
  lon: 4,
  avgStopTimes,
}));
const tripShortNames = ["100", "200", "300", "400"];
const nine = new Date(start * 1000); // 08:00 UTC, 09:00 in Brussels
const at = (seconds) => new Date((start + seconds) * 1000);

async function setup(t, options = {}) {
  const fixture = await timetable({
    stopIris,
    tripShortNames,
    stationRows,
    ...options,
  });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const fetcher = async (url) => {
    try {
      const response = new Response(
        await readFile(
          path.join(fixture.directory, new URL(url).pathname.slice("/data/".length)),
        ),
      );
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    } catch {
      return new Response("missing", { status: 404 });
    }
  };
  const planner = createPlanner({
    dataUrl: "https://example.org/data/",
    fetch: fetcher,
  });
  await planner.init();
  return { ...fixture, planner };
}

const plain = (value) =>
  value === null ||
  ["string", "number", "boolean"].includes(typeof value) ||
  value instanceof Date ||
  (Array.isArray(value)
    ? value.every(plain)
    : typeof value === "object" && Object.values(value).every(plain));

test("stations lists every station labelled in the requested language", async (t) => {
  const { planner } = await setup(t);
  const stations = await planner.stations({ language: "fr" });
  assert.ok(Array.isArray(stations));
  assert.equal(stations.length, 4);
  assert.deepEqual(stations.find((s) => s.id === "BE.NMBS.001000001"), {
    id: "BE.NMBS.001000001",
    uri: "http://irail.be/stations/NMBS/001000001",
    name: "Origine",
    standardName: "Origin",
    latitude: 51,
    longitude: 4,
  });
  // No translation: the standard name.
  assert.equal(
    (await planner.stations({ language: "de" })).find((s) => s.id === "BE.NMBS.001000002").name,
    "Interchange",
  );
  assert.equal((await planner.stations())[0].name, "Destination");
  assert.equal(
    (await planner.stations()).find((s) => s.id === "BE.NMBS.001000001").name,
    "Origin Town",
  );
  await assert.rejects(planner.stations({ language: "es" }), (e) => e.status === 400);
});

test("stations searches by name, tolerating typos unless told not to", async (t) => {
  const { planner } = await setup(t);
  assert.deepEqual(
    (await planner.stations({ query: "Origin" })).map((s) => s.id),
    ["BE.NMBS.001000001"],
  );
  // A typo finds the station; the language only changes the label.
  const typo = await planner.stations({ query: "Orgin Town", language: "fr" });
  assert.equal(typo[0].id, "BE.NMBS.001000001");
  assert.equal(typo[0].name, "Origine");
  assert.deepEqual(await planner.stations({ query: "Orgin Town", fuzzy: false }), []);
  assert.deepEqual(await planner.stations({ query: "Nowhere" }), []);
  assert.equal((await planner.stations({ query: "Origin", limit: 1 })).length, 1);
  await assert.rejects(planner.stations({ query: 5 }), (e) => e.status === 400);
  await assert.rejects(planner.stations({ query: "a", limit: 0 }), (e) => e.status === 400);
  // Names given to other calls stay strict: a typo is not another station.
  await assert.rejects(
    planner.liveboard({ station: "Orgin Town", time: nine }),
    (e) => e.status === 404,
  );
});

test("liveboard lists the hour of departures with destinations", async (t) => {
  const { planner } = await setup(t);
  const board = await planner.liveboard({ station: "BE.NMBS.001000001", time: nine });
  assert.equal(board.type, "departure");
  assert.equal(board.station.name, "Origin Town");
  assert.equal(board.station.id, "BE.NMBS.001000001");
  assert.equal(board.entries.length, 2);
  const [first, second] = board.entries;
  assert.deepEqual(first.time, at(0));
  assert.ok(first.time instanceof Date);
  assert.deepEqual(first.vehicle, {
    id: "BE.NMBS.IC100",
    uri: "http://irail.be/vehicle/IC100",
    type: "IC",
    number: "100",
    name: "IC 100",
  });
  assert.equal(first.destination.id, "BE.NMBS.001000003"); // IC 100 ends at Destination
  assert.equal(first.platform, null);
  assert.equal(first.delay, 0);
  assert.equal(first.canceled, false);
  assert.deepEqual(second.time, at(150));
  assert.equal(second.vehicle.id, "BE.NMBS.IC200");
  assert.ok(plain(board));
  // Names work as well as ids, in any language; the language labels the stations.
  const byName = await planner.liveboard({ station: "origine", time: nine, language: "fr" });
  assert.equal(byName.station.name, "Origine");
  assert.equal(byName.entries.length, 2);
  // A station object from an earlier call works too.
  assert.equal((await planner.liveboard({ station: board.station, time: nine })).entries.length, 2);
  // The window is the hour from `time`; milliseconds work like Dates.
  assert.equal(
    (await planner.liveboard({ station: "Origin", time: (start + 60) * 1000 })).entries.length,
    1,
  );
  assert.equal((await planner.liveboard({ station: "Origin", time: at(7200) })).entries.length, 0);
});

test("liveboard arrivals name where trains come from, and skip stops closed to passengers", async (t) => {
  const { planner } = await setup(t);
  const board = await planner.liveboard({
    station: "BE.NMBS.001000002",
    time: nine,
    type: "arrival",
  });
  assert.equal(board.type, "arrival");
  assert.equal(board.entries.length, 1);
  const [arrival] = board.entries;
  assert.deepEqual(arrival.time, at(100));
  assert.equal(arrival.origin.id, "BE.NMBS.001000001"); // IC 100 started at Origin
  assert.equal(arrival.destination, undefined);
  // The test timetable does not allow boarding at Interchange.
  assert.equal((await planner.liveboard({ station: "BE.NMBS.001000002", time: nine })).entries.length, 0);
});

test("liveboard rejects bad requests", async (t) => {
  const { planner } = await setup(t);
  const status = (status) => (e) => e instanceof IrailApiError && e.status === status;
  await assert.rejects(planner.liveboard({}), status(400));
  await assert.rejects(planner.liveboard({ station: "Nowhere" }), status(404));
  await assert.rejects(planner.liveboard({ station: "Origin", time: "09:00" }), status(400));
  await assert.rejects(planner.liveboard({ station: "Origin", time: new Date("nope") }), status(400));
  await assert.rejects(planner.liveboard({ station: "Origin", type: "both" }), status(400));
});

test("vehicle lists a train's stops with arrival and departure times", async (t) => {
  const { planner } = await setup(t);
  const { vehicle, stops } = await planner.vehicle({ id: "BE.NMBS.IC100", date: nine });
  assert.equal(vehicle.id, "BE.NMBS.IC100");
  assert.equal(vehicle.name, "IC 100");
  assert.deepEqual(
    stops.map((s) => s.station.id),
    ["BE.NMBS.001000001", "BE.NMBS.001000002", "BE.NMBS.001000003"],
  );
  assert.deepEqual(
    stops.map((s) => [s.arrival, s.departure]),
    [
      [null, at(0)],
      [at(100), at(100)],
      [at(200), null],
    ],
  );
  assert.equal(stops[0].platform, null);
  assert.equal(stops[0].canceled, false);
  assert.ok(plain(stops));
  // The id also works without the prefix, and any instant of the Belgian day.
  const later = await planner.vehicle({ id: "IC200", date: at(3 * 3600) });
  assert.equal(later.stops.length, 2);
});

test("planned ride legs name the train like the iRail API, and its id opens the run", async (t) => {
  const { planner } = await setup(t);
  const result = await planner.plan({
    origin: { sourceId: "default", stopIdx: 0 },
    destination: { sourceId: "default", stopIdx: 1 },
    departureAfter: start,
    maxWalkMeters: 0,
  });
  const leg = result.options[0].legs[0];
  assert.equal(leg.vehicle.name, "IC 100");
  assert.equal(leg.vehicle.id, "BE.NMBS.IC100");
  assert.equal(leg.vehicle.type, "IC");
  assert.equal(leg.vehicle.number, "100");
  // The same vehicle opens the trip of that service day, with the leg's stops on it.
  const day = String(leg.serviceDate);
  const noon = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6), 12));
  const run = await planner.vehicle({ id: leg.vehicle.id, date: noon });
  assert.equal(run.vehicle.name, "IC 100");
  assert.ok(
    run.stops.some(
      (stop) => stationKey(stop.station.id) === stationKey(leg.boardStopIri),
    ),
  );
});

test("vehicle rejects unknown trains, other days and missing ids", async (t) => {
  const { planner } = await setup(t);
  await assert.rejects(planner.vehicle({}), (e) => e.status === 400);
  await assert.rejects(planner.vehicle({ id: "IC999", date: nine }), (e) => e.status === 404);
  await assert.rejects(planner.vehicle({ id: "IC100", date: at(86400) }), (e) => e.status === 404);
});

test("connections returns journeys as legs", async (t) => {
  const { planner } = await setup(t);
  const connections = await planner.connections({
    from: "BE.NMBS.001000001",
    to: "Destination",
    time: nine,
  });
  assert.equal(connections.length, 2);
  const [direct, later] = connections;
  assert.deepEqual(direct.departure, at(0));
  assert.deepEqual(direct.arrival, at(200));
  assert.equal(direct.duration, 200);
  assert.equal(direct.transfers, 0);
  assert.equal(direct.legs.length, 1);
  const [leg] = direct.legs;
  assert.equal(leg.type, "ride");
  assert.equal(leg.from.station.id, "BE.NMBS.001000001");
  assert.equal(leg.to.station.id, "BE.NMBS.001000003");
  assert.deepEqual(leg.from.time, at(0));
  assert.equal(leg.from.platform, null);
  assert.equal(leg.vehicle.id, "BE.NMBS.IC100");
  assert.equal(leg.direction, "Destination");
  // The stops between the ends of the ride.
  assert.equal(leg.stops.length, 1);
  assert.equal(leg.stops[0].station.id, "BE.NMBS.001000002");
  assert.deepEqual(leg.stops[0].arrival, at(100));
  assert.equal(later.legs[0].vehicle.id, "BE.NMBS.IC200");
  assert.deepEqual(later.legs[0].stops, []);
  assert.ok(plain(connections));
});

test("connections with a change have one leg per vehicle", async (t) => {
  const row = (extra) => ({ stopSequence: 1, arrivalStopSequence: 2, ...extra });
  const { planner } = await setup(t, {
    connections: [
      row({ departureStopIdx: 0, arrivalStopIdx: 1, departureTimeOffset: 0, arrivalTimeOffset: 100, tripIdx: 0 }),
      row({ departureStopIdx: 1, arrivalStopIdx: 2, departureTimeOffset: 400, arrivalTimeOffset: 500, tripIdx: 1 }),
    ],
  });
  const connections = await planner.connections({
    from: "Origin",
    to: "Destination",
    time: nine,
    language: "nl",
  });
  assert.equal(connections.length, 1);
  const [journey] = connections;
  assert.equal(journey.duration, 500);
  assert.equal(journey.transfers, 1);
  assert.equal(journey.legs.length, 2);
  const [first, second] = journey.legs;
  assert.equal(first.to.station.name, "Overstap"); // Dutch label
  assert.equal(first.to.station.standardName, "Interchange");
  assert.equal(first.vehicle.id, "BE.NMBS.IC100");
  assert.deepEqual(first.to.time, at(100));
  assert.equal(second.from.station.id, first.to.station.id);
  assert.deepEqual(second.from.time, at(400));
  assert.equal(second.vehicle.id, "BE.NMBS.IC200");
});

test("connections keeps searching until it has the requested number of options", async (t) => {
  // Eight departures; a single adaptive search finds only the first few.
  const rows = Array.from({ length: 8 }, (_, i) => ({
    departureStopIdx: 0,
    arrivalStopIdx: 2,
    departureTimeOffset: i * 300,
    arrivalTimeOffset: i * 300 + 100,
    tripIdx: i,
    stopSequence: 1,
    arrivalStopSequence: 2,
  }));
  const { planner } = await setup(t, { connections: rows, tripShortNames: [] });
  const query = {
    origin: { sourceId: "default", stopIdx: 0 },
    destination: { sourceId: "default", stopIdx: 2 },
    departureAfter: start,
    maxWalkMeters: 0,
  };
  const single = await planner.plan(query);
  assert.ok(single.options.length < 6, `adaptive found ${single.options.length}`);
  const filled = await planner.plan({ ...query, minOptions: 6 });
  assert.equal(filled.options.length, 6);
  assert.deepEqual(
    filled.options.map((o) => o.departure),
    [0, 1, 2, 3, 4, 5].map((i) => start + i * 300),
  );
  const connections = await planner.connections({
    from: "Origin",
    to: "Destination",
    time: nine,
    limit: 8,
  });
  assert.equal(connections.length, 8);
  // Fewer exist than asked for: all of them, and no error.
  const rest = await planner.plan({ ...query, departureAfter: start + 6 * 300, minOptions: 6 });
  assert.equal(rest.options.length, 2);
});

const departures = (offsets, { duration = 100 } = {}) =>
  offsets.map((offset, i) => ({
    departureStopIdx: 0,
    arrivalStopIdx: 2,
    departureTimeOffset: offset,
    arrivalTimeOffset: offset + duration,
    tripIdx: i,
    stopSequence: 1,
    arrivalStopSequence: 2,
  }));
const between = {
  origin: { sourceId: "default", stopIdx: 0 },
  destination: { sourceId: "default", stopIdx: 2 },
  maxWalkMeters: 0,
};

test("plan arriving by a time returns the journeys closest to the deadline", async (t) => {
  // Eight trains, every five minutes, each ride 100 s.
  const { planner } = await setup(t, {
    connections: departures(Array.from({ length: 8 }, (_, i) => i * 300)),
    tripShortNames: [],
  });
  const arrivalBefore = start + 7 * 300 + 150;
  const result = await planner.plan({ ...between, arrivalBefore, minOptions: 3 });
  assert.equal(result.found, true);
  // The last three trains, in departure order, none arriving after the deadline.
  assert.deepEqual(
    result.options.map((o) => o.departure),
    [5, 6, 7].map((i) => start + i * 300),
  );
  assert.ok(result.options.every((o) => o.arrival <= arrivalBefore));
  assert.equal(result.window.mode, "arrive-by");
  assert.equal(result.window.to, arrivalBefore);
  // The deadline is inclusive and a train arriving after it is left out.
  const exact = await planner.plan({ ...between, arrivalBefore: start + 4 * 300 + 100 });
  assert.equal(exact.options.at(-1).departure, start + 4 * 300);
  const tight = await planner.plan({ ...between, arrivalBefore: start + 4 * 300 + 99 });
  assert.equal(tight.options.at(-1).departure, start + 3 * 300);
  // Without enough alternatives, every one that exists comes back.
  const few = await planner.plan({ ...between, arrivalBefore: start + 2 * 300 + 150, minOptions: 6 });
  assert.deepEqual(
    few.options.map((o) => o.departure),
    [0, 1, 2].map((i) => start + i * 300),
  );
});

test("plan arriving by a time looks further back when nothing fits the first window", async (t) => {
  const { planner } = await setup(t, {
    connections: departures([10]),
    tripShortNames: [],
  });
  // Six hours later: past the first three-hour look-back.
  const result = await planner.plan({ ...between, arrivalBefore: start + 6 * 3600 });
  assert.equal(result.found, true);
  assert.equal(result.options[0].departure, start + 10);
  // Nothing arrives that early.
  const none = await planner.plan({ ...between, arrivalBefore: start + 50 });
  assert.equal(none.found, false);
  assert.deepEqual(none.options, []);
});

test("plan takes a departure time or an arrival time, not both", async (t) => {
  const { planner } = await setup(t, { connections: departures([0]), tripShortNames: [] });
  await assert.rejects(
    planner.plan({ ...between, departureAfter: start, arrivalBefore: start + 3600 }),
    /not both/u,
  );
});

test("connections can arrive by a time", async (t) => {
  const { planner } = await setup(t, {
    connections: departures(Array.from({ length: 8 }, (_, i) => i * 300)),
    tripShortNames: [],
  });
  const result = await planner.connections({
    from: "Origin",
    to: "Destination",
    time: at(4 * 300 + 100),
    arriveBy: true,
    limit: 3,
  });
  // The three that get there latest without arriving after the time, earliest first.
  assert.deepEqual(
    result.map((c) => c.departure.getTime()),
    [2, 3, 4].map((i) => at(i * 300).getTime()),
  );
  assert.ok(result.every((c) => c.arrival <= at(4 * 300 + 100)));
  // Leaving after the same time goes the other way.
  const forward = await planner.connections({
    from: "Origin",
    to: "Destination",
    time: at(4 * 300),
    limit: 3,
  });
  assert.equal(forward[0].departure.getTime(), at(4 * 300).getTime());
});

test("connections rejects bad requests and what it cannot answer yet", async (t) => {
  const { planner } = await setup(t);
  const base = { from: "Origin", to: "Destination", time: nine };
  await assert.rejects(planner.connections({ ...base, from: undefined }), (e) => e.status === 400);
  await assert.rejects(planner.connections({ ...base, to: "Nowhere" }), (e) => e.status === 404);
  await assert.rejects(planner.connections({ ...base, to: "Origin" }), (e) => e.status === 400);
  await assert.rejects(
    planner.connections({ ...base, arriveBy: "yes" }),
    (e) => e.status === 400 && /arriveBy/u.test(e.message),
  );
  await assert.rejects(
    planner.connections({ ...base, vehicles: "trains" }),
    (e) => e instanceof NotSupportedError,
  );
  await assert.rejects(planner.connections({ ...base, vehicles: "boats" }), (e) => e.status === 400);
  await assert.doesNotReject(planner.connections({ ...base, vehicles: "all", arriveBy: false }));
});

test("composition, disturbances and occupancy feedback reject as not supported yet", async (t) => {
  const { planner } = await setup(t);
  for (const [call, query] of [
    ["composition", { vehicle: "IC100" }],
    ["disturbances", {}],
    ["occupancyFeedback", { vehicle: "BE.NMBS.IC100", occupancy: "low" }],
  ]) {
    assert.equal(typeof planner[call], "function");
    const error = await planner[call](query).catch((e) => e);
    assert.ok(error instanceof NotSupportedError, call);
    assert.ok(error instanceof IrailApiError);
    assert.equal(error.status, 501);
    assert.equal(error.call, call);
    assert.match(error.message, new RegExp(`^${call} is not supported yet`, "u"));
  }
  // Even before init, since nothing is asked of the timetable.
  const bare = createPlanner({ dataUrl: "https://example.org/data/" });
  await assert.rejects(bare.composition({ vehicle: "IC100" }), NotSupportedError);
});

test("the API calls need an initialized planner", async () => {
  const planner = createPlanner({ dataUrl: "https://example.org/data/" });
  await assert.rejects(
    planner.liveboard({ station: "Origin" }),
    (e) => e instanceof IrailApiError && e.status === 400 && /Initialize/u.test(e.message),
  );
});

test("without the station extension, stops are labelled by their own names", async (t) => {
  const { planner } = await setup(t, { stationRows: undefined });
  const board = await planner.liveboard({ station: "Origin", time: nine, language: "fr" });
  assert.equal(board.station.name, "Origin");
  assert.equal(board.entries.length, 2);
  assert.equal(board.entries[0].destination.id, "BE.NMBS.001000003");
});

test("the API methods work through the browser worker client, Dates and errors included", async (t) => {
  const { directory } = await setup(t);
  const { client, worker } = await startWorker(directory);
  t.after(() => worker.terminate());
  await client.request("init", { dataUrl: "https://example.org/data/" });
  const board = await client.liveboard({ station: "Origin", time: nine });
  assert.equal(board.entries.length, 2);
  assert.ok(board.entries[0].time instanceof Date);
  assert.deepEqual(board.entries[0].time, at(0));
  const connections = await client.connections({ from: "Origin", to: "Destination", time: nine });
  assert.equal(connections.length, 2);
  assert.deepEqual(connections[0].legs[0].from.time, at(0));
  const error = await client.vehicle({ id: "IC999", date: nine }).catch((e) => e);
  assert.ok(error instanceof IrailApiError);
  assert.equal(error.status, 404);
  await assert.rejects(client.composition({ vehicle: "IC100" }), NotSupportedError);
});
