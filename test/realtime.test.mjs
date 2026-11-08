import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { RealtimeWatcher, createPlanner } from "../src/index.mjs";
import { decodeTripUpdates } from "../src/gtfs-rt.mjs";
import { applyRealtime, realtimeFeeds } from "../src/realtime.mjs";
import { timetable, start } from "./helpers/timetable.mjs";
import { encodeFeed } from "./helpers/gtfs-rt.mjs";
import { startWorker } from "./helpers/worker.mjs";

// Station numbers (the digits) tie stop IRIs to the feed's stop ids.
const stopIris = [1000001, 1000002, 1000003, 1000004].map(
  (n) => `https://irail.be/id/be.sncb/stops/S${n}`,
);
const ORIGIN = "1000001";
const INTERCHANGE = "1000002";
const DESTINATION = "1000003";
const nine = new Date(start * 1000);
const at = (seconds) => new Date((start + seconds) * 1000);

// Trip 0 rides Origin → Interchange → Destination (08:00, 08:11 → 08:21);
// trip 1 is a direct train at 08:05; trip 2 leaves at 08:30.
const row = (from, to, dep, arr, tripIdx, seq) => ({
  departureStopIdx: from,
  arrivalStopIdx: to,
  departureTimeOffset: dep,
  arrivalTimeOffset: arr,
  tripIdx,
  stopSequence: seq,
  arrivalStopSequence: seq + 1,
});
const rows = [
  row(0, 1, 0, 600, 0, 1),
  row(1, 2, 700, 1300, 0, 2),
  row(0, 2, 300, 1500, 1, 1),
  row(0, 2, 1800, 2400, 2, 1),
];
const trip = (tripId, extra = {}) => ({
  tripId: String(tripId),
  startDate: 20261108,
  ...extra,
});
const stop = (stopId, scheduled, arrivalDelay, departureDelay = arrivalDelay) => ({
  stopId,
  arrival:
    arrivalDelay === undefined
      ? undefined
      : { delay: arrivalDelay, time: start + scheduled[0] + arrivalDelay },
  departure:
    departureDelay === undefined
      ? undefined
      : { delay: departureDelay, time: start + scheduled[1] + departureDelay },
});
// Trip 0, `delay` seconds late from the first stop on, leaving Origin on platform 2.
const lateTrip = (delay) =>
  trip(0, {
    stops: [
      { ...stop(`${ORIGIN}_2`, [0, 0], undefined, delay), arrival: undefined },
      stop(INTERCHANGE, [600, 700], delay),
      { ...stop(DESTINATION, [1300, 1300], delay), departure: undefined },
    ],
  });

async function setup(t, { feed, realtime = true } = {}) {
  const fixture = await timetable({
    stopIris,
    tripShortNames: ["100", "200", "300", "400"],
    connections: rows,
    manifest: realtime
      ? {
          realtime: [
            {
              "@id": "trip-updates.pb",
              "@type": "GtfsRealtimeFeed",
              tripTemplate: "https://example.org/trips/{trip_id}",
            },
          ],
        }
      : {},
  });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const feedFile = path.join(fixture.directory, "trip-updates.pb");
  const setFeed = (value) =>
    writeFile(
      feedFile,
      encodeFeed({ timestamp: start + 60, ...(value ?? { trips: [] }) }),
    );
  if (feed !== undefined) await setFeed(feed);
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
  return { ...fixture, planner, setFeed, feedFile, fetcher };
}

const journeys = (planner, from, to, after = start) =>
  planner.plan({
    origin: { sourceId: "default", stopIdx: from },
    destination: { sourceId: "default", stopIdx: to },
    departureAfter: after,
    windowMode: "full",
  });

// ------------------------------------------------------------ the decoder

test("the decoder reads delays, times, relationships and negative numbers", () => {
  const feed = decodeTripUpdates(
    encodeFeed({
      timestamp: 1_794_172_583,
      trips: [
        {
          tripId: "a:b",
          startDate: 20261108,
          delay: -30,
          stops: [
            {
              stopId: "8812005_5",
              stopSequence: 3,
              arrival: { delay: -60, time: 1_794_214_140 },
              departure: { delay: 120, time: 1_794_214_260 },
            },
            { stopId: "8814001", relationship: "skipped" },
          ],
        },
        { tripId: "gone", startDate: 20261108, relationship: "canceled" },
        { tripId: "extra", relationship: "added" },
      ],
    }),
  );
  assert.equal(feed.timestamp, 1_794_172_583);
  assert.equal(feed.updates.length, 3);
  assert.deepEqual(feed.updates[0], {
    relationship: "scheduled",
    tripId: "a:b",
    startDate: 20261108,
    delay: -30,
    stops: [
      {
        relationship: "scheduled",
        stopId: "8812005_5",
        stopSequence: 3,
        arrival: { delay: -60, time: 1_794_214_140 },
        departure: { delay: 120, time: 1_794_214_260 },
      },
      { relationship: "skipped", stopId: "8814001" },
    ],
  });
  assert.equal(feed.updates[1].relationship, "canceled");
  assert.equal(feed.updates[2].relationship, "added");
  assert.equal(feed.updates[2].startDate, undefined);
});

test("the decoder rejects empty, foreign and truncated input", () => {
  for (const body of [
    new Uint8Array(),
    new TextEncoder().encode("<html>Service Unavailable</html>"),
    new TextEncoder().encode('{"error":"rate limited"}'),
  ])
    assert.throws(() => decodeTripUpdates(body), /GTFS Realtime/u);
  assert.deepEqual(decodeTripUpdates(encodeFeed({ timestamp: 7 })), {
    timestamp: 7,
    updates: [],
  });
  const bytes = encodeFeed({
    timestamp: 5,
    trips: [{ tripId: "x", startDate: 20261108 }],
  });
  assert.throws(() => decodeTripUpdates(bytes.subarray(0, bytes.length - 3)), /GTFS Realtime/u);
});

test("the manifest's GtfsRealtimeFeed entries are found, other kinds ignored", () => {
  const feeds = realtimeFeeds(
    {
      realtime: [
        { "@id": "/rt/trips.pb", "@type": "GtfsRealtimeFeed", tripTemplate: "t/{trip_id}" },
        { "@id": "/rt/alerts.pb", "@type": "SomethingElse" },
      ],
    },
    "https://example.org/data/manifest.jsonld",
  );
  assert.deepEqual(feeds, [
    { url: "https://example.org/rt/trips.pb", tripTemplate: "t/{trip_id}" },
  ]);
  assert.deepEqual(realtimeFeeds({}, "https://example.org/"), []);
});

// ------------------------------------------------------------ the overlay

const fakeBatch = () => ({
  epoch: start,
  length: 3,
  dep: Uint32Array.from([0, 100, 200]),
  arr: Uint32Array.from([50, 150, 250]),
  dS: Int32Array.from([0, 0, 0]),
  aS: Int32Array.from([1, 1, 1]),
  trip: Int32Array.from([0, 1, 2]),
  serviceDate: Uint32Array.from([20261108, 20261108, 20261108]),
  stopSequence: Uint32Array.from([1, 1, 1]),
  arrivalStopSequence: Uint32Array.from([2, 2, 2]),
  iri: ["a", "b", "c"],
});
const overlayTrip = (extra) => ({
  canceled: false,
  stops: new Map(),
  timeline: [],
  resolved: new Map(),
  ...extra,
});
const overlayOf = (...entries) => ({
  trips: new Map(entries.map(([id, value]) => [id * 1e9 + 20261108, value])),
});

test("a delayed connection moves later, the page is sorted again and every column follows", () => {
  const batch = fakeBatch();
  const result = applyRealtime(
    batch,
    overlayOf([
      0,
      overlayTrip({
        stops: new Map([
          [0, { departure: { delay: 150 }, arrival: undefined }],
          [1, { arrival: { delay: 150 }, departure: undefined }],
        ]),
      }),
    ]),
  );
  assert.deepEqual([...result.trip], [1, 0, 2]);
  assert.deepEqual([...result.dep], [100, 150, 200]);
  assert.deepEqual([...result.arr], [150, 200, 250]);
  assert.deepEqual([...result.depDelay], [0, 150, 0]);
  assert.deepEqual([...result.arrDelay], [0, 150, 0]);
  assert.deepEqual(result.iri, ["b", "a", "c"]);
  assert.equal(result.length, 3);
  assert.deepEqual([...batch.dep], [0, 100, 200], "the scheduled page is untouched");
});

test("a batch the feed does not mention is returned as it is", () => {
  const batch = fakeBatch();
  assert.equal(applyRealtime(batch, overlayOf([9, overlayTrip()])), batch);
});

test("a connection never leaves early or arrives before it leaves", () => {
  const result = applyRealtime(
    fakeBatch(),
    overlayOf([
      0,
      overlayTrip({
        stops: new Map([
          [0, { departure: { delay: -60 } }],
          [1, { arrival: { delay: -500 } }],
        ]),
      }),
    ]),
  );
  const row = [...result.trip].indexOf(0);
  assert.equal(result.dep[row], 0);
  assert.equal(result.arr[row], 0);
  assert.equal(result.depDelay[row], 0);
});

test("an absolute time wins over a delay, and a lone event covers both", () => {
  const result = applyRealtime(
    fakeBatch(),
    overlayOf(
      [0, overlayTrip({ stops: new Map([[0, { departure: { delay: 5, time: start + 40 } }]]) })],
      [1, overlayTrip({ stops: new Map([[0, { arrival: { delay: 30 } }]]) })],
    ),
  );
  assert.equal(result.dep[[...result.trip].indexOf(0)], 40);
  assert.equal(result.depDelay[[...result.trip].indexOf(1)], 30);
});

test("canceled connections are removed, or kept and flagged on request", () => {
  const overlay = overlayOf([1, overlayTrip({ canceled: true })]);
  const dropped = applyRealtime(fakeBatch(), overlay);
  assert.deepEqual([...dropped.trip], [0, 2]);
  const kept = applyRealtime(fakeBatch(), overlay, { keepCanceled: true });
  assert.deepEqual([...kept.trip], [0, 1, 2]);
  assert.deepEqual([...kept.flags], [0, 1, 0]);
});

// ------------------------------------------------------- planning with it

test("planning rides the delayed train: later times, with the delay and platform on the leg", async (t) => {
  const { planner } = await setup(t, { feed: { trips: [lateTrip(300)] } });
  const { options } = await journeys(planner, 0, 1);
  assert.equal(options.length, 1);
  const [leg] = options[0].legs;
  assert.equal(leg.boardTime, start + 300);
  assert.equal(leg.alightTime, start + 900);
  assert.equal(options[0].arrival, start + 900);
  assert.equal(leg.boardDelay, 300);
  assert.equal(leg.alightDelay, 300);
  assert.equal(leg.boardPlatform, "2");
  assert.equal(leg.alightPlatform, null);
});

test("without the feed, the same search gives the schedule and no delays", async (t) => {
  const { planner } = await setup(t, { realtime: false });
  const { options } = await journeys(planner, 0, 1);
  assert.equal(options[0].arrival, start + 600);
  assert.equal(options[0].legs[0].boardDelay, 0);
  assert.equal(options[0].legs[0].boardPlatform, null);
});

test("a delay can make another train the better one", async (t) => {
  // Trip 0 is the faster way to Destination (arrives 1300) until it is 15 min late.
  const scheduled = await setup(t, { realtime: false });
  const best = (result) => Math.min(...result.options.map((o) => o.arrival));
  assert.equal(best(await journeys(scheduled.planner, 0, 2)), start + 1300);
  const { planner } = await setup(t, { feed: { trips: [lateTrip(900)] } });
  assert.equal(best(await journeys(planner, 0, 2)), start + 1500);
});

test("a train that slipped past the end of its page is still found", async (t) => {
  // Each fixture page ends at its connection's scheduled departure (08:00).
  const { planner } = await setup(t, { feed: { trips: [lateTrip(300)] } });
  const result = await journeys(planner, 0, 1, start + 120);
  assert.equal(result.found, true);
  assert.equal(result.options[0].legs[0].boardTime, start + 300);
  const scheduled = await setup(t, { realtime: false });
  assert.equal((await journeys(scheduled.planner, 0, 1, start + 120)).found, false);
});

test("a canceled trip cannot be boarded", async (t) => {
  const { planner } = await setup(t, {
    feed: { trips: [trip(0, { relationship: "canceled" })] },
  });
  assert.equal((await journeys(planner, 0, 1)).found, false);
  assert.ok((await journeys(planner, 0, 2)).found, "other trains still run");
});

test("a skipped stop cannot be used to get on or off, but the train rides through", async (t) => {
  const { planner } = await setup(t, {
    feed: {
      trips: [trip(0, { stops: [{ stopId: INTERCHANGE, relationship: "skipped" }] })],
    },
  });
  assert.equal((await journeys(planner, 0, 1)).found, false, "no getting off at the skipped stop");
  const { options } = await journeys(planner, 0, 2);
  const through = options.find((option) => option.arrival === start + 1300);
  assert.ok(through, "the train still reaches Destination");
  assert.equal(through.transfers, 0);
});

test("updates for trips the timetable does not know are counted and ignored", async (t) => {
  const { planner } = await setup(t, {
    feed: {
      trips: [
        lateTrip(60),
        trip("unknown-trip", { stops: [] }),
        trip(1, { relationship: "added" }),
        { tripId: "0" },
      ],
    },
  });
  const [status] = await planner.refreshRealtime();
  assert.equal(status.updates, 4);
  assert.equal(status.matched, 1);
  assert.equal(status.unmatched, 3);
  assert.equal(status.delayed, 1);
});

// ----------------------------------------------------------- the API calls

test("the liveboard shows scheduled time, delay, platform and cancellations", async (t) => {
  const { planner } = await setup(t, {
    feed: { trips: [lateTrip(300), trip(1, { relationship: "canceled" })] },
  });
  const { entries } = await planner.liveboard({ station: "Origin", time: nine });
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => [e.vehicle.name, e.time, e.delay, e.canceled, e.platform]),
    [
      ["IC 100", at(0), 300, false, "2"],
      ["IC 200", at(300), 0, true, null],
      ["IC 300", at(1800), 0, false, null],
    ],
  );
});

test("a late train is on the liveboard while it is still to come, however early it was due", async (t) => {
  const { planner } = await setup(t, { feed: { trips: [lateTrip(300)] } });
  // Due at 08:00, expected 08:05: still at the station at 08:02.
  const board = await planner.liveboard({ station: "Origin", time: at(120) });
  assert.deepEqual(
    board.entries.map((e) => e.vehicle.name),
    ["IC 100", "IC 200", "IC 300"],
  );
});

test("a skipped stop shows as canceled on the liveboard", async (t) => {
  const { planner } = await setup(t, {
    feed: {
      trips: [trip(0, { stops: [{ stopId: INTERCHANGE, relationship: "skipped" }] })],
    },
  });
  const { entries } = await planner.liveboard({ station: "Interchange", time: nine });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].canceled, true);
});

test("the vehicle call carries the last known delay on to the stops the feed leaves out", async (t) => {
  const { planner } = await setup(t, {
    feed: {
      trips: [
        trip(0, {
          stops: [
            { stopId: `${ORIGIN}_2`, departure: { delay: 120, time: start + 120 } },
          ],
        }),
      ],
    },
  });
  const { stops } = await planner.vehicle({ id: "IC100", date: nine });
  assert.deepEqual(
    stops.map((s) => [s.arrivalDelay, s.departureDelay, s.canceled]),
    [
      [0, 120, false],
      [120, 120, false],
      [120, 0, false],
    ],
  );
  assert.deepEqual(stops[1].arrival, at(600), "times stay the scheduled ones");
  assert.equal(stops[0].platform, "2");
});

test("the vehicle call flags a canceled trip's stops", async (t) => {
  const { planner } = await setup(t, {
    feed: { trips: [trip(0, { relationship: "canceled" })] },
  });
  const { stops } = await planner.vehicle({ id: "IC100", date: nine });
  assert.equal(stops.length, 3);
  assert.ok(stops.every((s) => s.canceled));
});

test("connections report scheduled times with the delays of the trains", async (t) => {
  const { planner } = await setup(t, { feed: { trips: [lateTrip(300)] } });
  const [journey] = await planner.connections({
    from: "Origin",
    to: "Interchange",
    time: nine,
    limit: 1,
  });
  assert.deepEqual(journey.departure, at(0));
  assert.deepEqual(journey.arrival, at(600));
  assert.equal(journey.departureDelay, 300);
  assert.equal(journey.arrivalDelay, 300);
  assert.equal(journey.duration, 600);
  const [leg] = journey.legs;
  assert.equal(leg.from.delay, 300);
  assert.equal(leg.from.platform, "2");
  assert.deepEqual(leg.from.time, at(0));
  assert.equal(leg.to.delay, 300);
});

// ---------------------------------------------------------------- refreshing

test("refreshing reports whether the feed changed and applies new data to later searches", async (t) => {
  const { planner, setFeed } = await setup(t, { feed: { trips: [lateTrip(300)] } });
  const [again] = await planner.refreshRealtime();
  assert.equal(again.supported, true);
  assert.equal(again.changed, false, "same feed timestamp as at init");
  assert.equal(again.timestamp, start + 60);

  await setFeed({ timestamp: start + 120, trips: [lateTrip(600)] });
  const [changed] = await planner.refreshRealtime();
  assert.equal(changed.changed, true);
  assert.equal(changed.timestamp, start + 120);
  const { options } = await journeys(planner, 0, 1);
  assert.equal(options[0].legs[0].boardDelay, 600);
});

test("a feed that cannot be read rejects and leaves the last data in use", async (t) => {
  const { planner, feedFile } = await setup(t, { feed: { trips: [lateTrip(300)] } });
  await unlink(feedFile);
  await assert.rejects(planner.refreshRealtime(), /HTTP 404/u);
  const { options } = await journeys(planner, 0, 1);
  assert.equal(options[0].legs[0].boardDelay, 300);
});

test("an empty response does not wipe the real-time data already loaded", async (t) => {
  const { planner, feedFile } = await setup(t, { feed: { trips: [lateTrip(300)] } });
  await writeFile(feedFile, new Uint8Array());
  await assert.rejects(planner.refreshRealtime(), /GTFS Realtime/u);
  assert.equal((await journeys(planner, 0, 1)).options[0].legs[0].boardDelay, 300);
});

test("a feed that fails at start-up does not stop the planner starting", async (t) => {
  const { planner } = await setup(t); // advertised, but no file
  assert.equal((await journeys(planner, 0, 1)).options[0].arrival, start + 600);
  await assert.rejects(planner.refreshRealtime(), /HTTP 404/u);
});

test("realtime can be left off at init, and manifests without a feed say so", async (t) => {
  const { planner } = await setup(t, { feed: { trips: [lateTrip(300)] } });
  await planner.init("https://example.org/data/", { realtime: false });
  assert.equal((await journeys(planner, 0, 1)).options[0].arrival, start + 600);
  const [status] = await planner.refreshRealtime();
  assert.equal(status.changed, true, "an explicit refresh still works");

  const bare = await setup(t, { realtime: false });
  assert.deepEqual(await bare.planner.refreshRealtime(), [
    { sourceId: "default", supported: false, changed: false },
  ]);
});

test("loading the sources again forgets the old real-time data", async (t) => {
  const { planner, feedFile } = await setup(t, { feed: { trips: [lateTrip(300)] } });
  await unlink(feedFile);
  await planner.init();
  assert.equal((await journeys(planner, 0, 1)).options[0].arrival, start + 600);
});

// ------------------------------------------------------------------ watching

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the watcher polls on a timer and emits update only when the feed changed", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const answers = [
      [{ changed: true }],
      [{ changed: false }],
      new Error("offline"),
      [{ changed: true }],
    ];
    let calls = 0;
    const watcher = new RealtimeWatcher(
      async () => {
        const answer = answers[calls++];
        if (answer instanceof Error) throw answer;
        return answer;
      },
      { intervalMs: 30_000 },
    );
    const seen = [];
    for (const type of ["poll", "update", "error"])
      watcher.addEventListener(type, (event) => seen.push(type));
    watcher.start();
    await flush();
    assert.deepEqual(seen, ["poll", "update"], "the first poll is immediate");

    mock.timers.tick(29_999);
    await flush();
    assert.equal(calls, 1, "nothing before the interval has passed");
    mock.timers.tick(1);
    await flush();
    assert.deepEqual(seen.slice(2), ["poll"], "unchanged feed: no update");

    mock.timers.tick(30_000);
    await flush();
    assert.deepEqual(seen.slice(3), ["error"], "an error does not stop the polling");
    mock.timers.tick(30_000);
    await flush();
    assert.deepEqual(seen.slice(4), ["poll", "update"]);

    watcher.stop();
    mock.timers.tick(120_000);
    await flush();
    assert.equal(calls, 4, "no polls after stop()");
  } finally {
    mock.timers.reset();
  }
});

test("the watcher never overlaps polls and can poll on demand", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let release;
    let calls = 0;
    const watcher = new RealtimeWatcher(
      () => {
        calls += 1;
        return new Promise((resolve) => {
          release = () => resolve([{ changed: false }]);
        });
      },
      { intervalMs: 5_000 },
    );
    watcher.start();
    watcher.pollNow();
    watcher.pollNow();
    assert.equal(calls, 1, "a poll in flight is not repeated");
    mock.timers.tick(60_000);
    assert.equal(calls, 1, "the timer starts after the poll finishes");
    release();
    await flush();
    mock.timers.tick(5_000);
    await flush();
    assert.equal(calls, 2);
    watcher.stop();
    release();
  } finally {
    mock.timers.reset();
  }
});

test("the watcher rejects a silly interval and does not report after stop()", async () => {
  assert.throws(() => new RealtimeWatcher(async () => [], { intervalMs: 10 }), RangeError);
  let release;
  const watcher = new RealtimeWatcher(
    () => new Promise((resolve) => (release = () => resolve([{ changed: true }]))),
  );
  const seen = [];
  watcher.addEventListener("update", () => seen.push("update"));
  watcher.start();
  watcher.stop();
  release();
  await flush();
  assert.deepEqual(seen, []);
});

test("planner.watchRealtime polls the planner's feed and stops on request", async (t) => {
  const { planner, setFeed } = await setup(t, { feed: { trips: [lateTrip(300)] } });
  const watcher = planner.watchRealtime({ intervalMs: 1000 });
  t.after(() => watcher.stop());
  const first = await new Promise((resolve) =>
    watcher.addEventListener("poll", (event) => resolve(event.detail), { once: true }),
  );
  assert.equal(first[0].changed, false);
  await setFeed({ timestamp: start + 300, trips: [lateTrip(120)] });
  const update = await new Promise((resolve) =>
    watcher.addEventListener("update", (event) => resolve(event.detail), { once: true }),
  );
  assert.equal(update[0].timestamp, start + 300);
  assert.equal((await journeys(planner, 0, 1)).options[0].legs[0].boardDelay, 120);
});

// ------------------------------------------------------------------- worker

test("the browser worker client refreshes real-time data and sees it in the API calls", async (t) => {
  const { directory, setFeed } = await setup(t, { feed: { trips: [lateTrip(300)] } });
  const { client, worker } = await startWorker(directory);
  t.after(() => worker.terminate());
  await client.request("init", { dataUrl: "https://example.org/data/" });
  let board = await client.liveboard({ station: "Origin", time: nine });
  assert.equal(board.entries[0].delay, 300, "applied at init");
  assert.equal(board.entries[0].platform, "2");

  await setFeed({ timestamp: start + 600, trips: [lateTrip(60)] });
  const [status] = await client.refreshRealtime();
  assert.equal(status.changed, true);
  board = await client.liveboard({ station: "Origin", time: nine });
  assert.equal(board.entries[0].delay, 60);
});
