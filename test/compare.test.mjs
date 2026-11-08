import assert from "node:assert/strict";
import test from "node:test";
import {
  apiConnectionsUrl,
  apiStationId,
  buildStations,
  compareJourneys,
  median,
  normalizeApiConnection,
  normalizePlannerJourney,
  searchStations,
  stationKey,
  zonedParts,
  zonedToEpoch,
} from "../playground/compare.mjs";

test("station keys join planner IRIs and iRail API identifiers", () => {
  for (const id of [
    "https://irail.be/id/be.sncb/stops/S8892007",
    "https://irail.be/id/be.sncb/stops/8892007",
    "https://irail.be/id/be.sncb/stops/8892007_12",
    "https://irail.be/id/be.sncb/stops/8892007_TE%20BEPAL",
    "BE.NMBS.008892007",
    "http://irail.be/stations/NMBS/008892007",
  ])
    assert.equal(stationKey(id), "8892007", id);
  assert.equal(stationKey("https://irail.be/id/be.sncb/stops/7015400"), "7015400");
  assert.equal(stationKey("https://example.org/other"), null);
  assert.equal(stationKey(undefined), null);
  assert.equal(apiStationId("8892007"), "BE.NMBS.008892007");
  assert.equal(apiStationId("7015400"), "BE.NMBS.007015400");
});

test("Brussels wall-clock time converts to and from epoch seconds across DST", () => {
  // 2026-11-08 09:00 in Brussels is UTC+1 (winter); 2026-07-01 09:00 is UTC+2.
  assert.equal(
    zonedToEpoch({ year: 2026, month: 11, day: 8, hour: 9, minute: 0 }),
    Date.parse("2026-11-08T08:00:00Z") / 1000,
  );
  assert.equal(
    zonedToEpoch({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }),
    Date.parse("2026-07-01T07:00:00Z") / 1000,
  );
  // The clock change on 2026-10-25 02:00 → 03:00 happens at 01:00 UTC.
  assert.equal(
    zonedToEpoch({ year: 2026, month: 10, day: 25, hour: 4, minute: 0 }),
    Date.parse("2026-10-25T03:00:00Z") / 1000,
  );
  assert.deepEqual(zonedParts(Date.parse("2026-11-08T23:30:00Z") / 1000), {
    year: 2026,
    month: 11,
    day: 9,
    hour: 0,
    minute: 30,
  });
});

test("API URL uses Belgian local date and time", () => {
  const url = new URL(
    apiConnectionsUrl({
      fromKey: "8892007",
      toKey: "8841004",
      departureAfter: Date.parse("2026-11-08T08:05:00Z") / 1000,
    }),
  );
  assert.equal(url.origin + url.pathname, "https://api.irail.be/v1/connections");
  assert.equal(url.searchParams.get("from"), "BE.NMBS.008892007");
  assert.equal(url.searchParams.get("to"), "BE.NMBS.008841004");
  assert.equal(url.searchParams.get("date"), "081126");
  assert.equal(url.searchParams.get("time"), "0905");
  assert.equal(url.searchParams.get("timesel"), "departure");
});

const apiStop = (id, name, time, extra = {}) => ({
  station: name,
  stationinfo: { id: `BE.NMBS.${id}`, name },
  time: String(time),
  platform: "3",
  ...extra,
});

function apiConnection({ departure, arrival, via, canceled, delay = 0 }) {
  return {
    departure: apiStop("008892007", "Ghent-Sint-Pieters", departure, {
      vehicle: "BE.NMBS.IC508",
      vehicleinfo: { shortname: "IC 508" },
      direction: { name: "Eupen" },
      delay: String(delay),
      canceled: canceled ? "1" : "0",
    }),
    arrival: apiStop("008841004", "Liège-Guillemins", arrival, {
      delay: String(delay),
      canceled: "0",
    }),
    vias: via
      ? {
          number: "1",
          via: [
            {
              station: "Brussels-South",
              stationinfo: { id: "BE.NMBS.008814001", name: "Brussels-South" },
              arrival: apiStop("008814001", "Brussels-South", via.arrive),
              departure: apiStop("008814001", "Brussels-South", via.leave, {
                vehicle: "BE.NMBS.IC1832",
                vehicleinfo: { shortname: "IC 1832" },
              }),
            },
          ],
        }
      : undefined,
  };
}

test("API connections become legs with station keys, including via stops", () => {
  const direct = normalizeApiConnection(
    apiConnection({ departure: 1000, arrival: 5000 }),
  );
  assert.equal(direct.transfers, 0);
  assert.equal(direct.legs.length, 1);
  assert.deepEqual(
    [direct.legs[0].from.key, direct.legs[0].to.key, direct.legs[0].label],
    ["8892007", "8841004", "IC 508"],
  );
  const viaJourney = normalizeApiConnection(
    apiConnection({ departure: 1000, arrival: 5000, via: { arrive: 2000, leave: 2300 } }),
  );
  assert.equal(viaJourney.transfers, 1);
  assert.deepEqual(
    viaJourney.legs.map((leg) => [leg.from.key, leg.to.key, leg.from.time, leg.to.time]),
    [
      ["8892007", "8814001", 1000, 2000],
      ["8814001", "8841004", 2300, 5000],
    ],
  );
  assert.equal(
    normalizeApiConnection(apiConnection({ departure: 1, arrival: 2, canceled: true })).canceled,
    true,
  );
});

const stopsFixture = {
  ids: [
    "https://irail.be/id/be.sncb/stops/8892007_1",
    "https://irail.be/id/be.sncb/stops/8841004_1",
    "https://irail.be/id/be.sncb/stops/S8892007",
    "https://irail.be/id/be.sncb/stops/S8841004",
  ],
  names: ["Gent-Sint-Pieters", "Liège-Guillemins", "Gent-Sint-Pieters", "Liège-Guillemins"],
};

test("planner journeys are normalized to the same shape", () => {
  const journey = normalizePlannerJourney(
    {
      departure: 1000,
      arrival: 5000,
      transfers: 0,
      legs: [
        {
          kind: "ride",
          boardStop: 2,
          alightStop: 3,
          boardTime: 1000,
          alightTime: 5000,
          routeName: "IC",
          headsign: "Eupen",
          boardStopIri: stopsFixture.ids[2],
          alightStopIri: stopsFixture.ids[3],
        },
      ],
    },
    stopsFixture,
  );
  assert.deepEqual(
    [journey.legs[0].from.key, journey.legs[0].to.key, journey.legs[0].label],
    ["8892007", "8841004", "IC"],
  );
  const walking = normalizePlannerJourney(
    {
      departure: 0,
      arrival: 600,
      transfers: 0,
      legs: [
        {
          kind: "walk",
          from: { lat: 50, lon: 4 },
          to: { sourceId: "x", stopIdx: 3 },
          boardTime: 0,
          alightTime: 600,
          distanceMeters: 500,
        },
      ],
    },
    stopsFixture,
  );
  assert.equal(walking.legs[0].from.name, "Your location");
  assert.equal(walking.legs[0].to.key, "8841004");
});

const j = (departure, arrival, transfers = 0, extra = {}) => ({
  departure,
  arrival,
  transfers,
  delay: 0,
  arrivalDelay: 0,
  canceled: false,
  legs: [],
  ...extra,
});

test("comparison classifies every difference with a reason", () => {
  const api = [
    j(100, 500), // identical
    j(200, 700), // planner arrives earlier
    j(300, 900), // dominated by (400, 800): leaves later, arrives earlier
    j(400, 800),
    j(500, 950, 0, { canceled: true }), // only iRail, canceled
  ];
  const planner = [
    j(100, 500),
    j(200, 650),
    j(400, 800),
    j(480, 820), // within iRail's window, not returned by iRail
    j(900, 1200), // after iRail's last departure
  ];
  const { rows, summary } = compareJourneys(api, planner);
  const byDeparture = (d) => rows.find((r) => (r.api ?? r.planner).departure === d);
  assert.equal(byDeparture(100).status, "same");
  assert.equal(byDeparture(200).status, "differs");
  assert.match(byDeparture(200).notes[0], /planner arrives 1 min earlier/);
  assert.equal(byDeparture(300).status, "dominated");
  assert.equal(byDeparture(400).status, "same");
  assert.equal(byDeparture(500).status, "only-api");
  assert.deepEqual(byDeparture(500).notes, ["canceled in realtime"]);
  assert.equal(byDeparture(480).status, "only-planner");
  assert.equal(byDeparture(900).status, "outside");
  assert.deepEqual(
    rows.map((r) => (r.api ?? r.planner).departure),
    [100, 200, 300, 400, 480, 500, 900],
  );
  assert.equal(summary.same, 2);
  assert.equal(summary.sameEarliestArrival, true);
});

test("identical times with different transfers or realtime delays carry notes", () => {
  const a = j(100, 500, 1, {
    legs: [
      { from: { key: "1" } },
      { from: { key: "2" } },
    ],
    arrivalDelay: 300,
  });
  const p = j(100, 500, 1, {
    legs: [
      { from: { key: "1" } },
      { from: { key: "3" } },
    ],
  });
  const { rows } = compareJourneys([a], [p]);
  assert.equal(rows[0].status, "same");
  assert.deepEqual(rows[0].notes, [
    "same times, other transfer stations (iRail: 2; planner: 3)",
    "5 min late in realtime",
  ]);
  assert.deepEqual(
    compareJourneys([j(1, 2, 0)], [j(1, 2, 2)]).rows[0].notes,
    ["0 vs 2 transfers"],
  );
});

test("iRail journeys arriving after the planner's window get their own status", () => {
  const { rows, summary } = compareJourneys(
    [j(100, 500), j(200, 900)],
    [j(100, 500)],
    { plannerWindow: { from: 0, to: 600 } },
  );
  assert.equal(rows[1].status, "window");
  assert.match(rows[1].notes[0], /search window/);
  assert.equal(summary.beyondWindow, 1);
  // Without a window, the same journey is simply only in iRail.
  assert.equal(compareJourneys([j(200, 900)], []).rows[0].status, "only-api");
});

test("empty sides compare without errors", () => {
  assert.equal(compareJourneys([], []).rows.length, 0);
  const onlyPlanner = compareJourneys([], [j(1, 2)]);
  assert.equal(onlyPlanner.rows[0].status, "only-planner");
  assert.equal(onlyPlanner.summary.sameEarliestArrival, false);
  assert.equal(compareJourneys([j(1, 2)], []).rows[0].status, "only-api");
});

test("median handles odd, even and empty lists", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), undefined);
});

test("station search merges platforms, ignores diacritics and matches any label", () => {
  const ids = [
    "https://irail.be/id/be.sncb/stops/S8841004",
    "https://irail.be/id/be.sncb/stops/8841004_1",
    "https://irail.be/id/be.sncb/stops/8841004_2",
    "https://irail.be/id/be.sncb/stops/S8892007",
    "https://irail.be/id/be.sncb/stops/8892007_1",
    "https://irail.be/id/be.sncb/stops/S8892106",
  ];
  const names = [
    "Liège-Guillemins",
    "Luik-Guillemins",
    "Liège-Guillemins",
    "Gent-Sint-Pieters",
    "Gent-Sint-Pieters",
    "Gentbrugge",
  ];
  const stations = buildStations({ ids, names, searchable: [0, 3, 5] });
  assert.equal(stations.length, 3);
  assert.equal(searchStations(stations, "liege")[0].key, "8841004");
  assert.equal(searchStations(stations, "LUIK guil")[0].key, "8841004");
  assert.equal(searchStations(stations, "gent")[0].key, "8892007");
  assert.deepEqual(
    searchStations(stations, "gent").map((s) => s.name),
    ["Gent-Sint-Pieters", "Gentbrugge"],
  );
  assert.deepEqual(searchStations(stations, "sint pieters").map((s) => s.name), [
    "Gent-Sint-Pieters",
  ]);
  assert.deepEqual(searchStations(stations, ""), []);
  assert.equal(stations[0].stopIdx, 0);
});
