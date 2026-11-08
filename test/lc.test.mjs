import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm, cp } from "node:fs/promises";
import path from "node:path";
import { createPlanner, LC_VERSION } from "../src/index.mjs";
import { timetable, start, releaseId, iri } from "./helpers/timetable.mjs";
import { startWorker } from "./helpers/worker.mjs";
import { encodeTable } from "../scripts/arrow-table.mjs";

const query = {
  origin: { sourceId: "default", stopIdx: 0 },
  destination: { sourceId: "default", stopIdx: 2 },
  departureAfter: start,
  maxWalkMeters: 0,
  windowMode: "full",
};

async function setup(t, options) {
  const fixture = await timetable(options);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const fetched = [];
  const fetcher = async (url) => {
    fetched.push(String(url));
    try {
      const response = new Response(
        await readFile(
          path.join(
            fixture.directory,
            new URL(url).pathname.slice("/data/".length),
          ),
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
  return { ...fixture, fetched, fetcher, planner };
}

test("Node API routes over LC alpha IPC files and returns publisher IRIs", async (t) => {
  const { planner, fetched } = await setup(t);
  assert.equal(LC_VERSION, "2-alpha");
  const sources = await planner.init();
  assert.equal(sources[0].stops.id[0], iri("stops", 0));
  assert.equal(sources[0].manifest.schemaVersion, "2-alpha");
  const progress = [];
  const result = await planner.plan(query, (event) =>
    progress.push(event.phase),
  );
  assert.equal(result.options[0].arrival, start + 200);
  assert.equal(result.options[0].transfers, 0);
  const leg = result.options[0].legs[0];
  assert.equal(leg.routeName, "IC");
  assert.equal(leg.routeType, 2);
  assert.equal(leg.tripIri, iri("trips", 0));
  assert.equal(leg.connectionIri, iri("connections", 0));
  assert.equal(leg.boardStopIri, iri("stops", 0));
  assert.ok(progress.includes("labels"));
  const count = fetched.length;
  assert.deepEqual((await planner.plan(query)).options, result.options);
  assert.equal(fetched.length, count);
  assert.equal(
    (await planner.plan({ ...query, windowMode: "adaptive" })).window
      .earliestArrival,
    start + 200,
  );
});

test("the actual planner worker and nested loader workers decode LC alpha", async (t) => {
  const { directory } = await setup(t);
  const { client, worker, fetched } = await startWorker(directory);
  t.after(() => worker.terminate());
  await client.request("init", { dataUrl: "https://example.org/data/" });
  const result = await client.request("plan", query);
  assert.equal(result.options[0].arrival, start + 200);
  const downloads = fetched.length;
  assert.deepEqual(
    (await client.request("plan", query)).options,
    result.options,
  );
  assert.equal(fetched.length, downloads);
  assert.ok(fetched.some((url) => url.includes("pages/arbitrary-")));
});

test("isochrones share the LC data loader and accept arbitrary coordinates", async (t) => {
  const { planner } = await setup(t);
  await planner.init();
  const result = await planner.isochrone({
    origin: { lat: 51, lon: 4 },
    departureAfter: start,
    maxWalkMeters: 0,
    maxDurationSeconds: 300,
  });
  assert.equal(result.found, true);
  assert.ok(
    result.points.some(
      (point) => point.name === "Destination" && point.durationSeconds === 200,
    ),
  );
});

test("pages without bounds, regions or arrival summaries are scanned conservatively", async (t) => {
  const f = await setup(t);
  f.manifest.connections.pages = f.manifest.connections.pages.map((page) => ({
    "@id": page["@id"],
  }));
  await writeFile(
    path.join(f.directory, "manifest.jsonld"),
    JSON.stringify(f.manifest),
  );
  await f.planner.init();
  assert.equal((await f.planner.plan(query)).options[0].arrival, start + 200);
});

test("direct manifest URLs and redirected manifest response URLs resolve resources", async (t) => {
  const f = await setup(t);
  const planner = createPlanner({
    dataUrl: "https://example.org/entry.jsonld",
    fetch: async (url) =>
      f.fetcher(
        url === "https://example.org/entry.jsonld"
          ? "https://example.org/data/manifest.jsonld"
          : url,
      ),
  });
  await planner.init();
  assert.equal((await planner.plan(query)).found, true);
  assert.ok(!f.fetched.some((url) => url.includes("sources.json")));
  await planner.init("https://example.org/data/manifest.jsonld");
  const extensionless = createPlanner({
    dataUrl: "https://example.org/timetable",
    fetch: async (url) =>
      f.fetcher(
        url === "https://example.org/timetable"
          ? "https://example.org/data/manifest.jsonld"
          : url,
      ),
  });
  await extensionless.init();
  assert.equal((await extensionless.plan(query)).found, true);
});

test("multi-source indexes resolve relative and absolute manifest IRIs", async (t) => {
  const f = await setup(t);
  await writeFile(
    path.join(f.directory, "sources.json"),
    JSON.stringify({
      sources: [
        { id: "nmbs", name: "NMBS", manifest: "manifest.jsonld" },
        { id: "other", manifest: "https://example.org/data/manifest.jsonld" },
      ],
    }),
  );
  assert.equal((await f.planner.init()).length, 2);
  const result = await f.planner.plan({
    ...query,
    sourceIds: ["nmbs"],
    origin: { sourceId: "nmbs", stopIdx: 0 },
    destination: { sourceId: "nmbs", stopIdx: 2 },
  });
  assert.ok(
    result.options.every((option) =>
      option.legs.every((leg) => leg.sourceId === "nmbs"),
    ),
  );
  await assert.rejects(
    f.planner.plan({ ...query, sourceIds: ["unknown"] }),
    /known source/,
  );
});

test("LC sources can route A–B–A and source selection constrains the journey", async (t) => {
  const row = (from, to, dep, arr, tripIdx) => ({
    departureStopIdx: from,
    arrivalStopIdx: to,
    departureTimeOffset: dep,
    arrivalTimeOffset: arr,
    tripIdx,
    stopSequence: 1,
    arrivalStopSequence: 2,
  });
  const a = await setup(t, {
    connections: [
      row(0, 1, 0, 100, 0),
      row(0, 3, 0, 1000, 1),
      row(2, 3, 160, 200, 2),
    ],
  });
  const b = await setup(t, { connections: [row(1, 2, 110, 150, 0)] });
  await cp(b.directory, path.join(a.directory, "b"), { recursive: true });
  await writeFile(
    path.join(a.directory, "sources.json"),
    JSON.stringify({
      sources: [
        { id: "a", manifest: "manifest.jsonld" },
        { id: "b", manifest: "b/manifest.jsonld" },
      ],
    }),
  );
  await a.planner.init();
  const request = {
    ...query,
    origin: { sourceId: "a", stopIdx: 0 },
    destination: { sourceId: "a", stopIdx: 3 },
  };
  const result = await a.planner.plan(request);
  assert.equal(result.options[0].arrival, start + 200);
  assert.deepEqual(
    result.options[0].legs
      .filter((leg) => leg.kind === "ride")
      .map((leg) => leg.sourceId),
    ["a", "b", "a"],
  );
  assert.equal(
    (await a.planner.plan({ ...request, sourceIds: ["a"] })).options[0].arrival,
    start + 1000,
  );
});

test("scheduled pagination supports arbitrary whole-second intervals and RFC 6570 regions", async (t) => {
  const f = await setup(t, { regions: false });
  const bytes = encodeTable(
    "connections",
    [
      {
        departureStopIdx: 0,
        arrivalStopIdx: 2,
        departureTimeOffset: 0,
        arrivalTimeOffset: 100,
        tripIdx: 0,
        pickupType: 0,
        dropOffType: 0,
        serviceDate: 20261108,
        stopSequence: 1,
        arrivalStopSequence: 2,
        iri: iri("connections", 0),
      },
    ],
    releaseId,
    { epochSeconds: String(start) },
  );
  f.manifest.connections = {
    paginationStrategy: "ScheduledPagination",
    pageInterval: "PT1H",
    searchTemplate:
      "https://example.org/data/slot/{yyyy}-{MM}-{dd}/{HH}{?region}",
  };
  await writeFile(
    path.join(f.directory, "manifest.jsonld"),
    JSON.stringify(f.manifest),
  );
  const requests = [];
  const planner = createPlanner({
    dataUrl: "https://example.org/data/",
    fetch: async (url) => {
      if (url.includes("/slot/")) {
        requests.push(url);
        return new Response(bytes);
      }
      return f.fetcher(url);
    },
  });
  await planner.init();
  assert.equal((await planner.plan(query)).options[0].arrival, start + 100);
  assert.deepEqual(requests, ["https://example.org/data/slot/2026-11-08/08"]);
});

test("redirect pagination follows next links relative to the immutable response URL", async (t) => {
  const f = await setup(t, { regions: false });
  f.manifest.connections = {
    paginationStrategy: "RedirectPagination",
    searchTemplate: "https://example.org/data/lookup{?departureTime,region}",
  };
  await writeFile(
    path.join(f.directory, "manifest.jsonld"),
    JSON.stringify(f.manifest),
  );
  const planner = createPlanner({
    dataUrl: "https://example.org/data/",
    fetch: (url) =>
      f.fetcher(
        url.includes("/lookup?")
          ? "https://example.org/data/pages/arbitrary-0.arrow"
          : url,
      ),
  });
  await planner.init();
  assert.equal((await planner.plan(query)).options[0].arrival, start + 200);
  assert.ok(
    f.fetched.includes("https://example.org/data/pages/arbitrary-2.arrow"),
  );
});

test("an empty redirect lookup returns no journey, while missing listed pages fail", async (t) => {
  const f = await setup(t, {
    manifest: {
      connections: {
        paginationStrategy: "RedirectPagination",
        searchTemplate: "https://example.org/data/missing{?departureTime}",
      },
    },
  });
  await f.planner.init();
  assert.equal((await f.planner.plan(query)).found, false);
  f.manifest.connections = { pages: [{ "@id": "missing.arrow" }] };
  await writeFile(
    path.join(f.directory, "manifest.jsonld"),
    JSON.stringify(f.manifest),
  );
  await f.planner.init();
  await assert.rejects(f.planner.plan(query), /HTTP 404/);
});

for (const pickupType of [1, 2, 3])
  test(`pickup type ${pickupType} cannot be boarded as an ordinary service`, async (t) => {
    const f = await setup(t, {
      connections: [
        {
          departureStopIdx: 0,
          arrivalStopIdx: 2,
          departureTimeOffset: 10,
          arrivalTimeOffset: 100,
          tripIdx: 0,
          stopSequence: 1,
          arrivalStopSequence: 2,
          pickupType,
        },
      ],
    });
    await f.planner.init();
    assert.equal((await f.planner.plan(query)).found, false);
    assert.equal(
      (await f.planner.plan({ ...query, windowMode: "adaptive" })).found,
      false,
    );
  });

test("connection metadata from another release is rejected", async (t) => {
  const f = await setup(t);
  await writeFile(
    path.join(f.directory, "pages/arbitrary-0.arrow"),
    encodeTable(
      "connections",
      [
        {
          ...f.rows[0],
          serviceDate: 20261108,
          iri: iri("connections", 0),
        },
      ],
      "other-release",
      { epochSeconds: String(start) },
    ),
  );
  await f.planner.init();
  await assert.rejects(f.planner.plan(query), /releaseId/);
});

test("separate Arrow transfer tables enforce minimum times between vehicles", async (t) => {
  const f = await setup(t, {
    connections: [
      {
        departureStopIdx: 0,
        arrivalStopIdx: 1,
        departureTimeOffset: 0,
        arrivalTimeOffset: 100,
        tripIdx: 0,
        stopSequence: 1,
        arrivalStopSequence: 2,
      },
      {
        departureStopIdx: 1,
        arrivalStopIdx: 2,
        departureTimeOffset: 110,
        arrivalTimeOffset: 200,
        tripIdx: 1,
        stopSequence: 1,
        arrivalStopSequence: 2,
      },
      {
        departureStopIdx: 1,
        arrivalStopIdx: 2,
        departureTimeOffset: 170,
        arrivalTimeOffset: 250,
        tripIdx: 2,
        stopSequence: 1,
        arrivalStopSequence: 2,
      },
    ],
    transfers: [
      { fromStopIdx: 1, toStopIdx: 1, transferType: 2, minTransferTime: 60 },
    ],
  });
  await f.planner.init();
  for (const windowMode of ["full", "adaptive"])
    assert.equal(
      (await f.planner.plan({ ...query, windowMode })).options[0].arrival,
      start + 250,
    );
});

test("nonconsecutive segments of the same run cannot bypass boarding restrictions", async (t) => {
  const f = await setup(t, {
    connections: [
      {
        departureStopIdx: 0,
        arrivalStopIdx: 1,
        departureTimeOffset: 0,
        arrivalTimeOffset: 100,
        tripIdx: 0,
        stopSequence: 1,
        arrivalStopSequence: 2,
      },
      {
        departureStopIdx: 1,
        arrivalStopIdx: 2,
        departureTimeOffset: 110,
        arrivalTimeOffset: 200,
        tripIdx: 0,
        stopSequence: 4,
        arrivalStopSequence: 5,
        pickupType: 1,
      },
    ],
  });
  await f.planner.init();
  for (const windowMode of ["full", "adaptive"])
    assert.equal((await f.planner.plan({ ...query, windowMode })).found, false);
});

test("reference-table types and Arrow IPC framing are checked before planning", async (t) => {
  const f = await setup(t);
  await writeFile(
    path.join(f.directory, "stops.arrow"),
    new TextEncoder().encode("not an Arrow file"),
  );
  await assert.rejects(f.planner.init(), /Arrow IPC file/);
  const other = await setup(t);
  await writeFile(
    path.join(other.directory, "stops.arrow"),
    encodeTable("routes", other.routes, releaseId),
  );
  await assert.rejects(other.planner.init(), /metadata/);
});

test("old manifests, unsupported schemas and linked-trip transfers fail explicitly", async (t) => {
  for (const schemaVersion of [undefined, "1", "3"]) {
    const f = await setup(t, { manifest: { schemaVersion } });
    await assert.rejects(
      f.planner.init(),
      /Unsupported Linked Connections schema/,
    );
  }
  for (const transfers of [
    [{ transferType: 6 }],
    [{ transferType: 4, fromTripIdx: 0, toTripIdx: 1 }],
    [{ transferType: 4, fromStopIdx: 1, toStopIdx: 1, fromTripIdx: 0, toTripIdx: 99 }],
    [{ transferType: 4, fromStopIdx: 1, toStopIdx: 2, fromTripIdx: 0, toTripIdx: 1 }],
  ]) {
    const f = await setup(t, { transfers });
    await assert.rejects(f.planner.init(), /Unsupported transfer type|Linked-trip transfer needs/);
  }
});

// Trip 0 rides Origin → Interchange and trip 1 Interchange → Destination, which
// leaves a minute after trip 0 arrives: too little for the five-minute transfer
// rule, but fine for riders who stay seated because the train splits or joins.
// Trip 2 is the next ordinary train to Destination.
const seatRows = (extra = {}) => [
  {
    departureStopIdx: 0,
    arrivalStopIdx: 1,
    departureTimeOffset: 0,
    arrivalTimeOffset: 600,
    tripIdx: 0,
    stopSequence: 1,
    arrivalStopSequence: 2,
  },
  {
    departureStopIdx: 1,
    arrivalStopIdx: 2,
    departureTimeOffset: 660,
    arrivalTimeOffset: 1200,
    tripIdx: 1,
    stopSequence: 1,
    arrivalStopSequence: 2,
    ...extra,
  },
  {
    departureStopIdx: 1,
    arrivalStopIdx: 2,
    departureTimeOffset: 1500,
    arrivalTimeOffset: 2100,
    tripIdx: 2,
    stopSequence: 1,
    arrivalStopSequence: 2,
  },
];
const transferRule = { fromStopIdx: 1, toStopIdx: 1, transferType: 2, minTransferTime: 300 };
const seatLink = (overrides = {}) => ({
  fromStopIdx: 1,
  toStopIdx: 1,
  transferType: 4,
  fromTripIdx: 0,
  toTripIdx: 1,
  ...overrides,
});
async function seatPlan(t, { rows = seatRows(), links = [seatLink()], ...rest } = {}) {
  const f = await setup(t, {
    connections: rows,
    transfers: [transferRule, ...links],
  });
  await f.planner.init();
  return { ...f, result: await f.planner.plan({ ...query, ...rest }) };
}

test("without a link, the tight connection is missed and the next train is taken", async (t) => {
  const { result } = await seatPlan(t, { links: [] });
  assert.equal(result.options[0].arrival, start + 2100);
  assert.equal(result.options[0].transfers, 1);
});

test("a linked trip is ridden on without a transfer: two legs, one ride, no transfer time", async (t) => {
  const { result } = await seatPlan(t);
  const [journey] = result.options;
  assert.equal(journey.arrival, start + 1200);
  assert.equal(journey.transfers, 0, "staying seated is not a transfer");
  assert.equal(result.options.length, 1, "the later train is no better");
  assert.equal(journey.legs.length, 2);
  const [first, second] = journey.legs;
  assert.deepEqual(
    [first.trip, first.boardStop, first.alightStop, first.alightTime],
    [0, 0, 1, start + 600],
  );
  assert.deepEqual(
    [second.trip, second.boardStop, second.alightStop, second.boardTime],
    [1, 1, 2, start + 660],
  );
});

test("both window modes find it, and the adaptive window is sized from it", async (t) => {
  for (const windowMode of ["full", "adaptive"]) {
    const { result } = await seatPlan(t, { windowMode });
    assert.equal(result.options[0].arrival, start + 1200, windowMode);
    assert.equal(result.options[0].transfers, 0, windowMode);
  }
  const { result } = await seatPlan(t, { windowMode: "adaptive" });
  assert.equal(result.window.earliestArrival, start + 1200);
});

test("the continuing trip need not be boardable at the link's stop", async (t) => {
  const { result } = await seatPlan(t, { rows: seatRows({ pickupType: 1 }) });
  assert.equal(result.options[0].arrival, start + 1200);
  assert.equal(result.options[0].transfers, 0);
  // Nobody can get on there, though: from Interchange the next train is trip 2.
  const board = await seatPlan(t, {
    rows: seatRows({ pickupType: 1 }),
    origin: { sourceId: "default", stopIdx: 1 },
  });
  assert.equal(board.result.options[0].arrival, start + 2100);
});

test("a link only joins trips of the same service date", async (t) => {
  const { result } = await seatPlan(t, { rows: seatRows({ serviceDate: 20261109 }) });
  assert.equal(result.options[0].arrival, start + 2100);
});

test("a link applies at its own stop, from its own trip, in its own direction", async (t) => {
  // None of these links helps the traveller reach trip 1: the tight connection is still missed.
  for (const link of [
    seatLink({ fromStopIdx: 0, toStopIdx: 0 }), // another stop
    seatLink({ fromTripIdx: 1, toTripIdx: 0 }), // the other direction
  ]) {
    const { result } = await seatPlan(t, { links: [link] });
    assert.equal(result.options[0].arrival, start + 2100, JSON.stringify(link));
    assert.equal(result.options[0].transfers, 1, JSON.stringify(link));
  }
  // A link to the later train is a real link: staying seated until it leaves.
  const { result } = await seatPlan(t, { links: [seatLink({ toTripIdx: 2 })] });
  assert.equal(result.options[0].arrival, start + 2100);
  assert.equal(result.options[0].transfers, 0);
  assert.deepEqual(result.options[0].legs.map((leg) => leg.trip), [0, 2]);
});

test("a train that splits in two can be followed into either half", async (t) => {
  const rows = [
    ...seatRows(),
    {
      departureStopIdx: 1,
      arrivalStopIdx: 3,
      departureTimeOffset: 660,
      arrivalTimeOffset: 1000,
      tripIdx: 3,
      stopSequence: 1,
      arrivalStopSequence: 2,
    },
  ];
  const links = [seatLink(), seatLink({ toTripIdx: 3 })];
  const toDestination = await seatPlan(t, { rows, links });
  assert.equal(toDestination.result.options[0].arrival, start + 1200);
  const toOther = await seatPlan(t, {
    rows,
    links,
    destination: { sourceId: "default", stopIdx: 3 },
  });
  assert.equal(toOther.result.options[0].arrival, start + 1000);
  assert.equal(toOther.result.options[0].transfers, 0);
});

test("a linked trip is still followed when an identical twin trip would shadow it", async (t) => {
  // Real feeds publish the same train as several trips with identical times,
  // and trips have several stops, so the continuing trip's first connection is
  // itself a through-ride. Only one twin is linked from trip 0; the planner
  // must not drop it because the other one runs at the same instants.
  const continuing = (tripIdx) => [
    {
      departureStopIdx: 1,
      arrivalStopIdx: 3,
      departureTimeOffset: 660,
      arrivalTimeOffset: 900,
      tripIdx,
      stopSequence: 1,
      arrivalStopSequence: 2,
    },
    {
      departureStopIdx: 3,
      arrivalStopIdx: 2,
      departureTimeOffset: 900,
      arrivalTimeOffset: 1200,
      tripIdx,
      stopSequence: 2,
      arrivalStopSequence: 3,
    },
  ];
  for (const [linked, twinFirst] of [
    [1, true],
    [1, false],
    [3, true],
    [3, false],
  ]) {
    const rows = [
      seatRows()[0],
      ...(twinFirst
        ? [...continuing(linked === 1 ? 3 : 1), ...continuing(linked)]
        : [...continuing(linked), ...continuing(linked === 1 ? 3 : 1)]),
      seatRows()[2],
    ];
    const { result } = await seatPlan(t, {
      rows,
      links: [seatLink({ toTripIdx: linked })],
    });
    const [journey] = result.options;
    const label = `link to trip ${linked}, twin ${twinFirst ? "first" : "last"}`;
    assert.equal(journey.arrival, start + 1200, label);
    assert.equal(journey.transfers, 0, label);
    assert.deepEqual(journey.legs.map((leg) => leg.trip), [0, linked], label);
  }
});

test("transfer type 5 (riders must get off) changes nothing", async (t) => {
  const { result } = await seatPlan(t, { links: [seatLink({ transferType: 5 })] });
  assert.equal(result.options[0].arrival, start + 2100);
});

test("isochrones follow linked trips too", async (t) => {
  const reach = async (links) => {
    const f = await setup(t, { connections: seatRows(), transfers: [transferRule, ...links] });
    await f.planner.init();
    const surface = await f.planner.isochrone({
      origin: { lat: 51, lon: 4 },
      departureAfter: start,
      maxWalkMeters: 100,
      maxDurationSeconds: 3000,
    });
    return surface.points.find((point) => point.name === "Destination")?.durationSeconds;
  };
  assert.equal(await reach([seatLink()]), 1200);
  assert.equal(await reach([]), 2100);
});

test("transfer overrides between different stations are ignored", async (t) => {
  // Real feeds (e.g. the iRail CDN) publish them; walking uses physical distance.
  const f = await setup(t, {
    transfers: [
      { fromStopIdx: 0, toStopIdx: 1, transferType: 3 },
      { fromStopIdx: 1, toStopIdx: 0, transferType: 2, minTransferTime: 600 },
    ],
  });
  await f.planner.init();
  const result = await f.planner.plan(query);
  assert.equal(result.found, true);
  assert.equal(result.options[0].transfers, 0);
});

test("requests require initialization and a failed query does not poison the queue", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.planner.plan(query), /Initialize/);
  await f.planner.init();
  await assert.rejects(
    f.planner.plan({ ...query, maxWalkMeters: -1 }),
    /walking limit/,
  );
  assert.equal((await f.planner.plan(query)).found, true);
});
