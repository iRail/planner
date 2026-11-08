// Adapted from LinkedConnections/gtfs2lc test/planner-cases.mjs (MIT).
// Exporter-specific tests are replaced by LC 2-alpha integration tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as arrow from "apache-arrow";
import { createPlanner } from "../src/planner-core.mjs";
import { buildNetwork, WALK_SPEED } from "../src/planner-network.mjs";
import { computeProfile } from "../src/planner-profile.mjs";
import { computeIsochrone } from "../src/planner-isochrone.mjs";
import { createEarliestSearch } from "../src/planner-earliest.mjs";
import { PageCache, scanBackward, scanForward } from "../src/planner-data.mjs";
import { LoaderPool } from "../src/planner-loader-pool.mjs";
import { resolveDataUrl } from "../src/planner-config.mjs";
import { PlannerClient } from "../src/planner-client.mjs";
const planner = createPlanner(arrow);
const start = Date.parse("2026-11-08T08:00:00Z") / 1000;
test("worker failure rejects pending and subsequent requests", async () => {
  const listeners = {};
  let terminated = false;
  const client = new PlannerClient({
    addEventListener: (type, fn) => (listeners[type] = fn),
    postMessage() {},
    terminate() {
      terminated = true;
    },
  });
  const pending = client.request("init");
  listeners.error({ message: "Cannot load module" });
  await assert.rejects(pending, /Cannot load module/);
  await assert.rejects(client.request("plan"), /Cannot load module/);
  assert.equal(terminated, true);
});

function inMemoryNetwork(rows, count = 4, spacing = 1, maxWalkMeters = 0) {
  const source = {
    id: "s",
    manifest: { counts: { trips: 100 } },
    stops: {
      id: Array.from({ length: count }, (_, i) => String(i)),
      parentIdx: new Int32Array(count).fill(-1),
      lat: Float64Array.from({ length: count }, (_, i) => 40 + i * spacing),
      lon: new Float64Array(count),
    },
  };
  const network = buildNetwork([source], maxWalkMeters);
  const batch = { epoch: 0, length: rows.length, source: network.sources[0] };
  for (const key of ["dep", "arr", "dS", "aS", "trip", "pickup", "dropOff"])
    batch[key] = Float64Array.from(rows.map((r) => r[key] || 0));
  return { network, batch };
}

function withTransfers(fixture, rules, minimum = [0, 60, 0, 0], maxWalk = 0) {
  const source = fixture.network.sources[0];
  source.stops.minTransferTime = Uint32Array.from(minimum);
  source.stops.transferRules = rules;
  const network = buildNetwork([source], maxWalk);
  fixture.batch.source = network.sources[0];
  return { network, batch: fixture.batch };
}

function earliestArrival(batch, network, destination = 3) {
  const search = createEarliestSearch(network, 0, destination, 0, 1000);
  scanForward([batch], 0, 1000, search.visit);
  return search.arrival;
}

test("station transfer buffers reject tight vehicle changes, preserve physical arrivals and exempt through-rides", () => {
  const rows = [
    { dep: 10, arr: 100, dS: 0, aS: 1, trip: 0 },
    { dep: 110, arr: 200, dS: 1, aS: 3, trip: 1 },
    { dep: 170, arr: 250, dS: 1, aS: 3, trip: 2 },
  ];
  const { network, batch } = withTransfers(inMemoryNetwork(rows));
  assert.equal(earliestArrival(batch, network), 250);
  const profile = computeProfile([batch], network, 0, 3, 0, 1000);
  assert.equal(profile.options[0].arrival, 250);
  assert.deepEqual(
    profile.options[0].legs.map((leg) => leg.trip),
    [0, 2],
  );
  const iso = computeIsochrone(
    [batch],
    network,
    { lat: 40, lon: 0 },
    0,
    200,
    0,
  );
  assert.equal(iso.reachable.find((stop) => stop.stopIdx === 1).arrival, 100);
  batch.trip[1] = 0;
  batch.pickup[1] = 1;
  assert.equal(earliestArrival(batch, network), 200);
  assert.equal(
    computeProfile([batch], network, 0, 3, 0, 1000).options[0].arrival,
    200,
  );
});

test("walking into a station permits immediate boarding without its ride-transfer buffer", () => {
  const fixture = inMemoryNetwork([
    { dep: 10, arr: 100, dS: 0, aS: 1, trip: 0 },
    { dep: 115, arr: 210, dS: 2, aS: 3, trip: 1 },
  ]);
  fixture.network.sources[0].stops.lat[2] = 41.0001;
  const { network, batch } = withTransfers(
    fixture,
    undefined,
    [0, 300, 300, 0],
    30,
  );
  assert.equal(earliestArrival(batch, network), 210);
  const profile = computeProfile([batch], network, 0, 3, 0, 1000);
  assert.equal(profile.options[0].arrival, 210);
  assert.deepEqual(
    profile.options[0].legs.map((leg) => leg.kind),
    ["ride", "walk", "ride"],
  );
  const access = createEarliestSearch(network, 2, 3, 110, 1000);
  scanForward([batch], 110, 1000, access.visit);
  assert.equal(access.arrival, 210);
});

test("trip-specific transfer overrides preserve otherwise dominated valid boarding alternatives", () => {
  const fixture = inMemoryNetwork([
    { dep: 10, arr: 100, dS: 0, aS: 1, trip: 0 },
    { dep: 170, arr: 230, dS: 1, aS: 3, trip: 1 },
    { dep: 190, arr: 200, dS: 1, aS: 3, trip: 2 },
  ]);
  const base = {
    to: 1,
    fromTrip: -1,
    toTrip: -1,
    fromRoute: -1,
    toRoute: -1,
    type: 2,
    seconds: 60,
  };
  const { network, batch } = withTransfers(fixture, [
    [],
    [base, { ...base, type: 3, fromTrip: 0, toTrip: 2 }],
    [],
    [],
  ]);
  assert.equal(earliestArrival(batch, network), 230);
  const profile = computeProfile([batch], network, 0, 3, 0, 1000);
  assert.equal(profile.options[0].arrival, 230);
  assert.deepEqual(
    profile.options[0].legs.map((leg) => leg.trip),
    [0, 1],
  );
});

test("station-level transfer rules apply across sibling platforms", () => {
  const fixture = inMemoryNetwork(
    [
      { dep: 10, arr: 100, dS: 0, aS: 2, trip: 0 },
      { dep: 110, arr: 200, dS: 3, aS: 4, trip: 1 },
      { dep: 170, arr: 250, dS: 3, aS: 4, trip: 2 },
    ],
    5,
  );
  const source = fixture.network.sources[0];
  source.stops.parentIdx = Int32Array.from([-1, -1, 1, 1, -1]);
  const rule = {
    to: 1,
    type: 2,
    seconds: 60,
    fromTrip: -1,
    toTrip: -1,
    fromRoute: -1,
    toRoute: -1,
  };
  const { network, batch } = withTransfers(
    fixture,
    [[], [rule], [], [], []],
    [0, 60, 60, 60, 0],
  );
  assert.equal(earliestArrival(batch, network, 4), 250);
  assert.equal(
    computeProfile([batch], network, 0, 4, 0, 1000).options[0].arrival,
    250,
  );
});

test("the same GTFS trip on two service dates cannot bypass station transfer time as a through-ride", () => {
  const { network, batch } = withTransfers(
    inMemoryNetwork([
      { dep: 10, arr: 100, dS: 0, aS: 1, trip: 0 },
      { dep: 110, arr: 200, dS: 1, aS: 3, trip: 0 },
    ]),
  );
  batch.serviceDate = Uint32Array.from([20260914, 20260915]);
  assert.equal(earliestArrival(batch, network), Infinity);
  assert.equal(computeProfile([batch], network, 0, 3, 0, 1000).found, false);
});

// Independent pages in distinct departure regions, including actual arrival
// summaries. A single row per page exercises activation across page ties.
function regionalFixture(rows, spacing = 1, maxWalkMeters = 0) {
  const { network, batch } = inMemoryNetwork(rows, 4, spacing, maxWalkMeters);
  const source = network.sources[0];
  source.manifestUrl = "https://test.example/manifest.jsonld";
  source.stops.regionIdx = Int32Array.from([0, 1, 2, 3]);
  const pages = [];
  const data = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const region = row.dS;
    const name = `${region}/${i}.arrow`;
    pages.push({
      "@id": name,
      region,
      epochSeconds: 0,
      minDepartureTime: row.dep,
      maxDepartureTime: row.dep,
      arrivalRegions: [row.aS],
    });
    data.set(name, [
      Object.fromEntries(
        Object.entries(batch).map(([k, v]) => [
          k,
          ArrayBuffer.isView(v) ? v.subarray(i, i + 1) : k === "length" ? 1 : v,
        ]),
      ),
    ]);
  }
  source.manifest.schemaVersion = "2-alpha";
  source.manifest.releaseId = "test";
  source.manifest.connections = { pages };
  const fetched = [];
  const planner = createPlanner(arrow, {
    loadPage: async ({ url }) => {
      url = new URL(url).pathname.slice(1);
      fetched.push(url);
      assert.ok(data.has(url));
      return data.get(url);
    },
  });
  const query = {
    sources: [source],
    origin: { sourceId: "s", stopIdx: 0 },
    destination: { sourceId: "s", stopIdx: 3 },
    departureAfter: 0,
    maxWalkMeters,
  };
  return { planner, query, network, batch, fetched };
}

const journeyCriteria = (result) =>
  result.options.map(({ departure, arrival, transfers }) => ({
    departure,
    arrival,
    transfers,
  }));

test("regional scans match exhaustive walking journeys and the full-network bounded profile", async () => {
  let seed = 93;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let trial = 0; trial < 60; trial += 1) {
    const rows = Array.from({ length: 12 }, (_, trip) => ({
      dep: random(1100),
      arr: 0,
      dS: random(4),
      aS: random(4),
      trip,
      pickup: random(7) === 0 ? 1 : 0,
      dropOff: random(7) === 0 ? 1 : 0,
    }))
      .map((row) => ({ ...row, arr: row.dep + 1 + random(50) }))
      .sort((a, b) => a.dep - b.dep);
    const f = regionalFixture(rows, 0.002, trial % 2 ? 250 : 0);
    const distances = Array.from({ length: 4 }, (_, stop) => {
      const neighbors = f.network.neighbors(stop);
      return new Map(
        Array.from(neighbors.stops, (s, i) => [
          s,
          neighbors.meters[i] / WALK_SPEED,
        ]),
      );
    });
    let earliest = Infinity;
    function explore(stop, time) {
      const egress = distances[stop].get(3);
      if (egress !== undefined) earliest = Math.min(earliest, time + egress);
      for (const row of rows) {
        const walk = distances[stop].get(row.dS);
        if (
          walk !== undefined &&
          !row.pickup &&
          !row.dropOff &&
          row.dep >= time + walk
        )
          explore(row.aS, row.arr);
      }
    }
    explore(0, 0);
    const full = await f.planner.planJourneys({
      ...f.query,
      windowMode: "full",
    });
    const reference = computeProfile([f.batch], f.network, 0, 3, 0, 86400);
    assert.deepEqual(
      journeyCriteria(full),
      journeyCriteria(reference),
      `full trial ${trial}`,
    );
    assert.equal(
      full.totalOptions,
      reference.totalOptions,
      `full count ${trial}`,
    );
    const adaptive = await f.planner.planJourneys(f.query);
    if (!Number.isFinite(earliest)) {
      assert.equal(adaptive.found, false, `no journey ${trial}`);
    } else {
      assert.equal(
        adaptive.window.earliestArrival,
        earliest,
        `earliest trial ${trial}`,
      );
      const bounded = computeProfile(
        [f.batch],
        f.network,
        0,
        3,
        0,
        adaptive.window.to,
      );
      assert.deepEqual(
        journeyCriteria(adaptive),
        journeyCriteria(bounded),
        `adaptive trial ${trial}`,
      );
      assert.equal(
        adaptive.totalOptions,
        bounded.totalOptions,
        `adaptive count ${trial}`,
      );
    }
  }
});

test("regions activate at reachable times, skip disconnected pages, and reuse pages across passes", async () => {
  const f = regionalFixture([
    { dep: 5, arr: 6, dS: 1, aS: 3, trip: 0 }, // too early to catch
    { dep: 10, arr: 20, dS: 0, aS: 1, trip: 1 },
    { dep: 12, arr: 15, dS: 2, aS: 2, trip: 2 }, // disconnected region
    { dep: 30, arr: 40, dS: 1, aS: 3, trip: 3 },
    { dep: 60, arr: 80, dS: 0, aS: 3, trip: 4 }, // arrival exactly at doubled deadline
    { dep: 70, arr: 81, dS: 0, aS: 3, trip: 5 },
  ]);
  const result = await f.planner.planJourneys(f.query);
  assert.equal(result.window.earliestArrival, 40);
  assert.equal(result.window.to, 80);
  assert.ok(result.options.some((o) => o.arrival === 80));
  assert.ok(result.options.every((o) => o.arrival <= 80));
  assert.ok(!f.fetched.includes("1/0.arrow"));
  assert.ok(!f.fetched.includes("2/2.arrow"));
  assert.equal(new Set(f.fetched).size, f.fetched.length);
  const count = f.fetched.length;
  assert.deepEqual(
    (await f.planner.planJourneys(f.query)).options,
    result.options,
  );
  assert.equal(f.fetched.length, count);
});

test("lazy activation handles equal-time through-rides and forbidden boarding/alighting", async () => {
  const f = regionalFixture([
    { dep: 10, arr: 10, dS: 0, aS: 1, trip: 0 },
    { dep: 10, arr: 10, dS: 1, aS: 2, trip: 0, pickup: 1, dropOff: 1 },
    { dep: 10, arr: 20, dS: 2, aS: 3, trip: 0, pickup: 1 },
  ]);
  const result = await f.planner.planJourneys(f.query);
  assert.equal(result.window.earliestArrival, 20);
  assert.equal(result.options[0].arrival, 20);
  assert.equal(result.options[0].transfers, 0);
  assert.equal(result.options[0].legs.length, 1);
});

test("forward horizon discovery cannot chain walking legs across regions", async () => {
  const f = regionalFixture([], 0.002, 250);
  const result = await f.planner.planJourneys(f.query);
  assert.equal(result.found, false);
  assert.equal(result.scanned, 0);
});

test("station families activate their children's departure and arrival regions", async () => {
  const f = regionalFixture([{ dep: 10, arr: 20, dS: 1, aS: 2, trip: 0 }]);
  f.query.sources[0].stops.parentIdx = Int32Array.from([-1, 0, 3, -1]);
  const result = await f.planner.planJourneys(f.query);
  assert.equal(result.window.earliestArrival, 20);
  assert.equal(result.options[0].legs[0].boardStop, 1);
  assert.equal(result.options[0].legs[0].alightStop, 2);
});

test("missing page regions and arrival summaries use conservative indexes", async () => {
  for (const missingStops of [false, true]) {
    const f = regionalFixture([{ dep: 10, arr: 20, dS: 0, aS: 3, trip: 0 }]);
    const source = f.query.sources[0];
    if (missingStops) {
      delete source.manifest.connections.pages[0].region;
    } else {
      delete source.manifest.connections.pages[0].arrivalRegions;
    }
    const result = await f.planner.planJourneys(f.query);
    assert.equal(result.window.earliestArrival, 20);
    assert.equal(result.options[0].arrival, 20);
    assert.deepEqual(
      (await f.planner.planJourneys({ ...f.query, windowMode: "full" }))
        .options,
      result.options,
    );
  }
});

test("region bounds can improve after a slower incoming ride initially activates them", async () => {
  const f = regionalFixture([
    { dep: 10, arr: 100, dS: 0, aS: 1, trip: 0 },
    { dep: 20, arr: 30, dS: 0, aS: 1, trip: 1 },
    { dep: 40, arr: 50, dS: 1, aS: 3, trip: 2 },
    { dep: 110, arr: 120, dS: 1, aS: 3, trip: 3 },
  ]);
  const result = await f.planner.planJourneys(f.query);
  assert.equal(result.window.earliestArrival, 50);
  assert.equal(result.options[0].arrival, 50);
  assert.ok(f.fetched.includes("1/2.arrow"));
  assert.ok(!f.fetched.includes("1/3.arrow"));
});

test("unreached forward regions remain available for later alternatives", async () => {
  const f = regionalFixture([
    { dep: 10, arr: 20, dS: 0, aS: 3, trip: 0 },
    { dep: 25, arr: 30, dS: 0, aS: 1, trip: 1 },
    { dep: 30, arr: 35, dS: 1, aS: 2, trip: 2 },
    { dep: 35, arr: 40, dS: 2, aS: 3, trip: 3 },
  ]);
  const result = await f.planner.planJourneys(f.query);
  assert.equal(result.window.to, 40);
  assert.ok(result.options.some((o) => o.arrival === 40));
  assert.equal(result.totalOptions, 2);
});

test("zero-duration earliest arrivals retain an equal-time ride and terminate page activation", async () => {
  const f = regionalFixture([
    { dep: 0, arr: 0, dS: 0, aS: 1, trip: 0 },
    { dep: 0, arr: 0, dS: 1, aS: 2, trip: 0, pickup: 1, dropOff: 1 },
    { dep: 0, arr: 0, dS: 2, aS: 3, trip: 0, pickup: 1 },
  ]);
  const result = await f.planner.planJourneys(f.query);
  assert.equal(result.window.earliestArrival, 0);
  assert.equal(result.window.to, 1);
  assert.equal(result.options[0].arrival, 0);
  assert.equal(result.options[0].legs.length, 1);
});

test("fractional walking deadlines and the 24-hour cap match full-network profiles", async () => {
  for (const [rows, walk] of [
    [
      [
        { dep: 50, arr: 100, dS: 0, aS: 2, trip: 0 },
        { dep: 519, arr: 519, dS: 0, aS: 3, trip: 1 },
        { dep: 520, arr: 520, dS: 0, aS: 3, trip: 2 },
      ],
      250,
    ],
    [[{ dep: 50000, arr: 50001, dS: 0, aS: 3, trip: 0 }], 0],
  ]) {
    const f = regionalFixture(rows, 0.002, walk);
    const result = await f.planner.planJourneys(f.query);
    const reference = computeProfile(
      [f.batch],
      f.network,
      0,
      3,
      0,
      result.window.to,
    );
    assert.deepEqual(journeyCriteria(result), journeyCriteria(reference));
    assert.equal(result.totalOptions, reference.totalOptions);
    if (!walk) assert.equal(result.window.to, 86400);
    else assert.ok(!Number.isInteger(result.window.to));
  }
});

test("ordered profiles match exhaustive small-network journeys", () => {
  let seed = 42;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let trial = 0; trial < 60; trial += 1) {
    const rows = Array.from({ length: 16 }, (_, trip) => {
      const dep = random(90);
      return {
        dep,
        arr: dep + 1 + random(10),
        dS: random(4),
        aS: random(4),
        trip,
      };
    }).sort((a, b) => a.dep - b.dep);
    const candidates = [];
    function explore(stop, time, departure, rides) {
      if (stop === 3) {
        candidates.push({ departure, arrival: time, transfers: rides - 1 });
        return;
      }
      for (const row of rows)
        if (row.dS === stop && row.dep >= time && row.arr <= 100)
          explore(row.aS, row.arr, rides ? departure : row.dep, rides + 1);
    }
    explore(0, 0, 0, 0);
    const front = candidates.filter(
      (a, i) =>
        !candidates.some(
          (b, j) =>
            j !== i &&
            b.departure >= a.departure &&
            b.arrival <= a.arrival &&
            b.transfers <= a.transfers &&
            (j < i ||
              b.departure > a.departure ||
              b.arrival < a.arrival ||
              b.transfers < a.transfers),
        ),
    );
    front.sort((a, b) => a.departure - b.departure || a.arrival - b.arrival);
    const { network, batch } = inMemoryNetwork(rows);
    const result = computeProfile([batch], network, 0, 3, 0, 100);
    assert.equal(result.totalOptions, front.length, `trial ${trial}`);
    assert.deepEqual(
      result.options.map(({ departure, arrival, transfers }) => ({
        departure,
        arrival,
        transfers,
      })),
      front.slice(0, 6),
      `trial ${trial}`,
    );
  }
});

test("reverse merge handles page ties and zero-duration through-rides without boarding restrictions breaking continuity", () => {
  const rows = [
    { dep: 10, arr: 10, dS: 0, aS: 1, trip: 0 },
    { dep: 10, arr: 10, dS: 1, aS: 2, trip: 0, pickup: 1, dropOff: 1 },
    { dep: 10, arr: 20, dS: 2, aS: 3, trip: 0, pickup: 1 },
  ];
  const { network, batch } = inMemoryNetwork(rows);
  const batches = rows
    .map((_, i) =>
      Object.fromEntries(
        Object.entries(batch).map(([key, value]) => [
          key,
          ArrayBuffer.isView(value)
            ? value.subarray(i, i + 1)
            : key === "length"
              ? 1
              : value,
        ]),
      ),
    )
    .reverse();
  const result = computeProfile(batches, network, 0, 3, 0, 100);
  assert.equal(result.options[0].arrival, 20);
  assert.equal(result.options[0].transfers, 0);
  assert.equal(result.options[0].legs.length, 1);
  assert.equal(result.scanned, 3);
});

test("column cursors share buffers and cache eviction does not detach active data", () => {
  const { batch } = inMemoryNetwork([
    { dep: 10, arr: 20, dS: 0, aS: 1, trip: 0 },
    { dep: 30, arr: 40, dS: 1, aS: 2, trip: 1 },
  ]);
  const cache = new PageCache(112);
  cache.set("one", [batch]);
  const retained = cache.get("one");
  assert.equal(retained[0].dep.buffer, batch.dep.buffer);
  const other = { ...batch, dep: batch.dep.slice() };
  cache.set("two", [other]);
  assert.equal(cache.get("one"), undefined);
  const times = [];
  scanBackward(retained, 0, 25, (_, __, dep) => {
    times.push(dep);
    return false;
  });
  assert.deepEqual(times, [10]);
  assert.ok(cache.bytes <= cache.budget);
});

test("walking continuation profiles match exhaustive routes with access, transfers and egress", () => {
  let seed = 91;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let trial = 0; trial < 25; trial += 1) {
    const rows = Array.from({ length: 12 }, (_, trip) => {
      const dep = random(1100);
      return {
        dep,
        arr: dep + 1 + random(50),
        dS: random(4),
        aS: random(4),
        trip,
      };
    }).sort((a, b) => a.dep - b.dep);
    const { network, batch } = inMemoryNetwork(rows, 4, 0.002, 250);
    const distances = Array.from({ length: 4 }, (_, stop) => {
      const neighbors = network.neighbors(stop);
      return new Map(
        Array.from(neighbors.stops, (other, i) => [
          other,
          neighbors.meters[i] / WALK_SPEED,
        ]),
      );
    });
    const candidates = [];
    function explore(stop, time, departure, rides) {
      const finalWalk = distances[stop].get(3);
      if (rides && finalWalk !== undefined && time + finalWalk <= 1200)
        candidates.push({
          departure,
          arrival: time + finalWalk,
          transfers: rides - 1,
        });
      if (stop === 3) return;
      for (const row of rows) {
        const walk = distances[stop].get(row.dS);
        if (walk !== undefined && row.dep >= time + walk && row.arr <= 1200)
          explore(
            row.aS,
            row.arr,
            rides ? departure : row.dep - walk,
            rides + 1,
          );
      }
    }
    explore(0, 0, 0, 0);
    const front = candidates.filter(
      (a, i) =>
        !candidates.some(
          (b, j) =>
            j !== i &&
            b.departure >= a.departure &&
            b.arrival <= a.arrival &&
            b.transfers <= a.transfers &&
            (j < i ||
              b.departure > a.departure ||
              b.arrival < a.arrival ||
              b.transfers < a.transfers),
        ),
    );
    front.sort((a, b) => a.departure - b.departure || a.arrival - b.arrival);
    const result = computeProfile([batch], network, 0, 3, 0, 1200);
    assert.equal(result.totalOptions, front.length, `walking trial ${trial}`);
    assert.deepEqual(
      result.options.map(({ departure, arrival, transfers }) => ({
        departure,
        arrival,
        transfers,
      })),
      front.slice(0, 6),
      `walking trial ${trial}`,
    );
  }
});

test("loader pool bounds parallel work and rejects all pending work on worker failure", async () => {
  const workers = [];
  const create = () => {
    const worker = {
      listeners: {},
      requests: [],
      addEventListener(type, handler) {
        this.listeners[type] = handler;
      },
      postMessage(request) {
        this.requests.push(request);
      },
      terminate() {
        this.terminated = true;
      },
    };
    workers.push(worker);
    return worker;
  };
  const pool = new LoaderPool(create, 2);
  const first = pool.load("first");
  const second = pool.load("second");
  const third = pool.load("third");
  assert.deepEqual(
    workers.map((w) => w.requests),
    [["first"], ["second"]],
  );
  workers[0].listeners.message({ data: { batches: ["loaded"] } });
  assert.deepEqual(await first, ["loaded"]);
  assert.deepEqual(workers[0].requests, ["first", "third"]);
  const failures = Promise.all([
    assert.rejects(second, /loader crash/),
    assert.rejects(third, /loader crash/),
  ]);
  workers[1].listeners.error({ message: "loader crash" });
  await failures;
  await assert.rejects(pool.load("fourth"), /loader crash/);
  assert.ok(workers.every((w) => w.terminated));
  let calls = 0;
  assert.throws(
    () =>
      new LoaderPool(() => {
        if (calls++) throw new Error("construction failed");
        return create();
      }, 2),
    /construction failed/,
  );
  assert.ok(workers.at(-1).terminated);
});

test("walking-only alternatives prune inferior rides, and arrival at the deadline is included", () => {
  const walk = inMemoryNetwork(
    [{ dep: 0, arr: 500, dS: 0, aS: 1, trip: 0 }],
    2,
    0.002,
    250,
  );
  const result = computeProfile([walk.batch], walk.network, 0, 1, 0, 1000);
  assert.equal(result.totalOptions, 1);
  assert.equal(result.options[0].legs[0].kind, "walk");
  const deadline = inMemoryNetwork(
    [
      { dep: 10, arr: 100, dS: 0, aS: 1, trip: 0 },
      { dep: 50, arr: 101, dS: 0, aS: 1, trip: 1 },
      { dep: 100, arr: 100, dS: 0, aS: 1, trip: 2 },
    ],
    2,
  );
  const bounded = computeProfile(
    [deadline.batch],
    deadline.network,
    0,
    1,
    0,
    100,
  );
  assert.equal(bounded.totalOptions, 1);
  assert.equal(bounded.options[0].arrival, 100);
  assert.equal(bounded.scanned, 2);
});

test("station families share profiles while returned ride legs retain platform indices", () => {
  const source = {
    id: "station-feed",
    manifest: { counts: { trips: 1 } },
    stops: {
      id: ["origin", "platform-1", "platform-2", "destination", "platform-3"],
      parentIdx: new Int32Array([-1, 0, 0, -1, 3]),
      lat: new Float64Array([NaN, 50, 50, 51, 51]),
      lon: new Float64Array(5).fill(4),
    },
  };
  const network = buildNetwork([source], 0);
  const { batch } = inMemoryNetwork(
    [{ dep: 10, arr: 20, dS: 2, aS: 4, trip: 0 }],
    5,
  );
  batch.source = network.sources[0];
  const result = computeProfile(
    [batch],
    network,
    network.globalStop({ sourceId: source.id, stopIdx: 1 }),
    network.globalStop({ sourceId: source.id, stopIdx: 3 }),
    0,
    100,
  );
  assert.equal(result.found, true);
  assert.equal(result.options[0].legs[0].boardStop, 2);
  assert.equal(result.options[0].legs[0].alightStop, 4);
});

test("isochrone reaches a clicked point's walking neighbors, then rides beyond walking range", () => {
  // Three stops roughly 222 m apart along a meridian; stop 2 is out of a
  // 300 m walking radius from stop 0, so it can only be reached by riding.
  const { network, batch } = inMemoryNetwork(
    [{ dep: 200, arr: 300, dS: 1, aS: 2, trip: 0 }],
    3,
    0.002,
    300,
  );
  const clickNearStop0 = { lat: 40, lon: 0 };
  const result = computeIsochrone(
    [batch],
    network,
    clickNearStop0,
    0,
    1000,
    300,
  );
  assert.equal(result.found, true);
  assert.equal(result.noAccess, false);
  const byStop = new Map(result.reachable.map((r) => [r.stopIdx, r]));
  assert.equal(byStop.get(0).durationSeconds, 0);
  assert.ok(byStop.get(1).durationSeconds > 0);
  assert.ok(byStop.get(1).durationSeconds < 300);
  // Only reachable by riding from stop 1, arriving at the connection's
  // scheduled time — not by a direct walk, which would exceed 300 m.
  assert.equal(byStop.get(2).arrival, 300);

  const tooFarToWalkAtAll = computeIsochrone(
    [batch],
    network,
    { lat: 0, lon: 0 },
    0,
    1000,
    300,
  );
  assert.equal(tooFarToWalkAtAll.found, false);
  assert.equal(tooFarToWalkAtAll.noAccess, true);
  assert.deepEqual(tooFarToWalkAtAll.reachable, []);
});

test("planIsochrone rejects an out-of-range duration or walking limit before loading any data", async () => {
  const empty = createPlanner(arrow);
  const base = {
    sources: [],
    origin: { lat: 51, lon: 4 },
    departureAfter: start,
    maxWalkMeters: 1000,
    maxDurationSeconds: 1800,
  };
  await assert.rejects(
    empty.planIsochrone({ ...base, maxDurationSeconds: 30 }),
    /duration/,
  );
  await assert.rejects(
    empty.planIsochrone({ ...base, maxDurationSeconds: 4 * 3600 }),
    /duration/,
  );
  await assert.rejects(
    empty.planIsochrone({ ...base, maxWalkMeters: -1 }),
    /walking limit/,
  );
  const result = await empty.planIsochrone(base);
  assert.equal(result.found, false);
});

test("analysis activates only reached regions from their arrival timestamps and repeats cold results", async () => {
  const f = regionalFixture([
    { dep: 10, arr: 100, dS: 0, aS: 1, trip: 0 },
    { dep: 50, arr: 60, dS: 1, aS: 3, trip: 1 }, // before region entry
    { dep: 110, arr: 150, dS: 1, aS: 2, trip: 2 },
    { dep: 20, arr: 30, dS: 3, aS: 2, trip: 3 }, // unreachable region
  ]);
  const request = {
    ...f.query,
    origin: { lat: 40, lon: 0 },
    maxDurationSeconds: 200,
  };
  const first = await f.planner.planIsochrone(request);
  assert.deepEqual(
    first.reachable.map((r) => [r.stopIdx, r.arrival]),
    [
      [0, 0],
      [1, 100],
      [2, 150],
    ],
  );
  assert.deepEqual(f.fetched, ["0/0.arrow", "1/2.arrow"]);
  const repeated = await f.planner.planIsochrone(request);
  assert.deepEqual(repeated.reachable, first.reachable);
  assert.equal(f.fetched.length, 2);
  const offNetwork = await f.planner.planIsochrone({
    ...request,
    origin: { lat: 0, lon: 0 },
  });
  assert.equal(offNetwork.noAccess, true);
  assert.equal(offNetwork.pages, 0);
  assert.equal(f.fetched.length, 2);
});

test("analysis walking activates the adjacent region at the walk's arrival time without chaining walks", async () => {
  const f = regionalFixture(
    [
      { dep: 150, arr: 170, dS: 1, aS: 3, trip: 0 },
      { dep: 170, arr: 200, dS: 1, aS: 2, trip: 1 },
      { dep: 300, arr: 310, dS: 3, aS: 0, trip: 2 },
    ],
    0.002,
    250,
  );
  const request = {
    ...f.query,
    origin: { lat: 40, lon: 0 },
    maxDurationSeconds: 400,
  };
  const result = await f.planner.planIsochrone(request);
  assert.deepEqual(f.fetched, ["1/1.arrow"]);
  assert.equal(result.reachable.find((r) => r.stopIdx === 2).arrival, 200);
  assert.ok(result.reachable.find((r) => r.stopIdx === 3).arrival > 350);
  const walkOnly = regionalFixture([], 0.002, 250);
  const reachable = await walkOnly.planner.planIsochrone({
    ...request,
    sources: walkOnly.query.sources,
  });
  assert.deepEqual(
    reachable.reachable.map((r) => r.stopIdx),
    [0, 1],
  );
  const short = await f.planner.planIsochrone({
    ...request,
    maxDurationSeconds: 60,
  });
  assert.deepEqual(
    short.reachable.map((r) => r.stopIdx),
    [0],
  );
});

test("coordinate endpoints retain walking access and egress in both window modes and stream distinct profile edges", async () => {
  for (const windowMode of ["adaptive", "full"]) {
    const f = regionalFixture(
      [
        { dep: 200, arr: 300, dS: 1, aS: 2, trip: 0 },
        { dep: 250, arr: 350, dS: 1, aS: 2, trip: 1 },
      ],
      0.002,
      250,
    );
    const edges = [];
    const result = await f.planner.planJourneys({
      ...f.query,
      windowMode,
      origin: { lat: 40, lon: 0 },
      destination: { lat: 40.006, lon: 0 },
      onProgress: (progress) => edges.push(...(progress.edges || [])),
    });
    assert.equal(result.found, true);
    const option = result.options[0];
    assert.deepEqual(
      option.legs.map((leg) => leg.kind),
      ["walk", "ride", "walk"],
    );
    assert.deepEqual(option.legs[0].from, { lat: 40, lon: 0 });
    assert.deepEqual(option.legs[2].to, { lat: 40.006, lon: 0 });
    assert.ok(option.departure >= 0 && option.departure < 41);
    assert.ok(option.arrival > 460 && option.arrival < 461);
    assert.ok(edges.some((edge) => edge.kind === "ride"));
    assert.ok(
      edges.some((edge) => edge.kind === "walk" && edge.from[1] === 40),
    );
    assert.ok(
      edges.some((edge) => edge.kind === "walk" && edge.to[1] === 40.006),
    );
    assert.equal(
      new Set(edges.map((edge) => JSON.stringify(edge))).size,
      edges.length,
    );
    assert.ok(
      edges.every((edge) => [...edge.from, ...edge.to].every(Number.isFinite)),
    );
    const mixed = await f.planner.planJourneys({
      ...f.query,
      windowMode,
      origin: { lat: 40, lon: 0 },
      destination: { sourceId: "s", stopIdx: 2 },
    });
    assert.equal(mixed.options[0].arrival, 300);
  }
});

test("coordinate walking-only journeys respect the distance cap and reject invalid coordinates", async () => {
  const f = regionalFixture([], 1, 250);
  const request = {
    ...f.query,
    origin: { lat: 0, lon: 0 },
    destination: { lat: 0.001, lon: 0 },
  };
  const result = await f.planner.planJourneys(request);
  assert.equal(result.found, true);
  assert.equal(result.options[0].legs[0].kind, "walk");
  assert.ok(result.options[0].arrival > 80 && result.options[0].arrival < 81);
  assert.equal(result.diagnostics.pages, 0);
  const tooFar = await f.planner.planJourneys({
    ...request,
    destination: { lat: 0.003, lon: 0 },
  });
  assert.equal(tooFar.found, false);
  await assert.rejects(
    f.planner.planJourneys({ ...request, origin: { lat: 91, lon: 0 } }),
    /Coordinates/,
  );
  await assert.rejects(
    f.planner.planIsochrone({
      ...request,
      origin: { lat: 0, lon: 181 },
      maxDurationSeconds: 600,
    }),
    /Coordinates/,
  );
  assert.equal(f.fetched.length, 0);
});

test("data URL configuration resolves relative paths and visit overrides", () => {
  const page = "https://client.example/app/index.html";
  assert.equal(
    resolveDataUrl("../exports/", page),
    "https://client.example/exports/",
  );
  assert.equal(
    resolveDataUrl("./", page + "?data=https://data.example/data/"),
    "https://data.example/data/",
  );
  assert.equal(resolveDataUrl("./", page), "https://client.example/app/");
  assert.throws(() => resolveDataUrl("file:///data/", page), /HTTP or HTTPS/);
});
