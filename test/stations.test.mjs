import assert from "node:assert/strict";
import test from "node:test";
import * as arrow from "apache-arrow";
import {
  buildStations,
  findStations,
  loadStationRows,
  normalizeLanguage,
  stationByName,
  stationLabel,
  stationQueryRegex,
} from "../playground/irail/stations.mjs";

// Rows shaped like the iRail CDN's stations.arrow (nullable translations).
const row = (id, name, alt, avgStopTimes) => ({
  iri: `http://irail.be/stations/NMBS/${id}`,
  name,
  alternativeFr: alt.fr ?? null,
  alternativeNl: alt.nl ?? null,
  alternativeDe: alt.de ?? null,
  alternativeEn: alt.en ?? null,
  avgStopTimes,
});
const rows = [
  row("008892106", "Gentbrugge", {}, 40),
  row("008814001", "Brussel-Zuid/Bruxelles-Midi", {
    fr: "Bruxelles-Midi",
    nl: "Brussel-Zuid",
    de: "Brüssel-Süd (Midi)",
    en: "Brussels-South/Brussels-Midi",
  }, 970),
  row("008892007", "Gent-Sint-Pieters", { fr: "Gand-Saint-Pierre", en: "Ghent-Sint-Pieters" }, 546),
  row("008841004", "Liège-Guillemins", { nl: "Luik-Guillemins", de: "Lüttich-Guillemins" }, 427),
  row("008800000", "Not In Timetable", {}, 9999), // curated, but no GTFS stop
];
// Planner stops: platforms (`_n`) and station roots (`S…`); GTFS-only station S8899999.
const ids = [
  "https://irail.be/id/be.sncb/stops/S8892106",
  "https://irail.be/id/be.sncb/stops/S8814001",
  "https://irail.be/id/be.sncb/stops/S8892007",
  "https://irail.be/id/be.sncb/stops/8892007_1",
  "https://irail.be/id/be.sncb/stops/S8841004",
  "https://irail.be/id/be.sncb/stops/S8899999",
];
const names = [
  "Gentbrugge",
  "Bruxelles-Midi",
  "Gand-Saint-Pierre",
  "Gand-Saint-Pierre",
  "Liège-Guillemins",
  "Only In GTFS",
];
const input = { rows, ids, names, searchable: [0, 1, 2, 4, 5] };
const stations = buildStations(input);
const label = (list) => list.map((s) => s.key);

test("stations are built per station number, most frequently served first", () => {
  assert.deepEqual(label(stations), [
    "8814001",
    "8892007",
    "8841004",
    "8892106",
    "8899999",
  ]);
  const ghent = stations.find((s) => s.key === "8892007");
  assert.equal(ghent.stopIdx, 2);
  assert.equal(ghent.avgStopTimes, 546);
  // Curated stations without a stop in the timetable cannot be routed from.
  assert.equal(stations.some((s) => s.key === "8800000"), false);
  // Stations missing from the table keep the stop's own label.
  assert.equal(stations.at(-1).name, "Only In GTFS");
});

test("labels follow the language and fall back to the standard name", () => {
  const midi = stations.find((s) => s.key === "8814001");
  assert.equal(stationLabel(midi, "nl"), "Brussel-Zuid");
  assert.equal(stationLabel(midi, "fr"), "Bruxelles-Midi");
  assert.equal(stationLabel(midi, "de"), "Brüssel-Süd (Midi)");
  assert.equal(stationLabel(midi, "en"), "Brussels-South/Brussels-Midi");
  const ghent = stations.find((s) => s.key === "8892007");
  assert.equal(stationLabel(ghent, "nl"), "Gent-Sint-Pieters"); // no Dutch alternative
  assert.equal(stationLabel(ghent, "en"), "Ghent-Sint-Pieters");
  assert.equal(normalizeLanguage("nl-BE"), "nl");
  assert.equal(normalizeLanguage("es"), "");
});

test("autocomplete matches the label of any language", () => {
  for (const text of ["brussel zuid", "bruxelles midi", "Brüssel", "brussels south", "midi"])
    assert.equal(findStations(stations, text)[0]?.key, "8814001", text);
  for (const text of ["luik", "lüttich", "liege guill"])
    assert.equal(findStations(stations, text)[0]?.key, "8841004", text);
  for (const text of ["ghent", "gand saint", "gent sint", "gent st pieters", "gent-st-pieters"])
    assert.equal(findStations(stations, text)[0]?.key, "8892007", text);
  assert.deepEqual(findStations(stations, ""), []);
  assert.deepEqual(findStations(stations, "zzzz"), []);
});

test("matches rank exact, word prefix, prefix, partial, then by avgStopTimes", () => {
  const set = buildStations({
    rows: [
      row("1", "Zandhoven", {}, 100), // partial: "hoven" inside the name
      row("2", "Hovenstad", {}, 5), // prefix
      row("3", "Hoven Noord", {}, 10), // word prefix
      row("4", "Hoven", {}, 1), // exact
      row("5", "Hoven Zuid", {}, 50), // word prefix, busier
    ],
    ids: [1, 2, 3, 4, 5].map((n) => `https://irail.be/id/be.sncb/stops/S${n}`),
    names: ["", "", "", "", ""],
    searchable: [0, 1, 2, 3, 4],
  });
  assert.deepEqual(label(findStations(set, "hoven")), ["4", "5", "3", "2", "1"]);
  assert.deepEqual(label(findStations(set, "hoven", 2)), ["4", "5"]);
});

test("query normalization follows irail.be", () => {
  assert.ok(stationQueryRegex("St-Niklaas").test("saint niklaas"));
  assert.ok(stationQueryRegex("St-Niklaas").test("sint niklaas"));
  assert.ok(stationQueryRegex("Bruxelles-Midi (Brussel)").test("bruxelles midi"));
  assert.ok(stationQueryRegex("Brussels Airport-Zaventem").test("brussels airport"));
  assert.equal(stationQueryRegex("   "), null);
  // Regex metacharacters are escaped, never thrown or interpreted.
  assert.ok(stationQueryRegex("(").test("a(b"));
  assert.equal(stationQueryRegex("a.c").test("abc"), false);
});

test("stationByName finds an exact label in any language", () => {
  assert.equal(stationByName(stations, "Luik-Guillemins")?.key, "8841004");
  assert.equal(stationByName(stations, "brüssel-süd (midi)")?.key, "8814001");
  assert.equal(stationByName(stations, "Liege-Guillemins")?.key, "8841004");
  assert.equal(stationByName(stations, "Nowhere"), null);
});

test("without the extension table, stops are labelled by their own names", () => {
  const fallback = buildStations({ rows: [], ids, names, searchable: input.searchable });
  assert.equal(fallback.length, 5);
  assert.equal(findStations(fallback, "gand")[0].key, "8892007");
  // More platforms means busier when there is no avgStopTimes to go by.
  assert.equal(fallback[0].key, "8892007");
});

function stationsTable(releaseId) {
  const table = arrow.tableFromArrays({
    name: ["Gent-Sint-Pieters"],
    alternativeFr: ["Gand-Saint-Pierre"],
    alternativeNl: [null],
    alternativeDe: [null],
    alternativeEn: ["Ghent-Sint-Pieters"],
    avgStopTimes: [546.2],
    iri: ["http://irail.be/stations/NMBS/008892007"],
  });
  const batch = new arrow.RecordBatch(
    new arrow.Schema(table.schema.fields, new Map([["releaseId", releaseId]])),
    table.batches[0].data,
  );
  return arrow.tableToIPC(new arrow.Table(batch), "file");
}

function fakeFetch({ extension = true, release = "r1", tableRelease = "r1" } = {}) {
  const base = "https://cdn.example/irail/";
  const files = new Map([
    [
      base + "manifest.jsonld",
      JSON.stringify({
        releaseId: release,
        ...(extension ? { "irail:extensions": { "@id": "/irail/releases/r1/irail.json" } } : {}),
      }),
    ],
    [
      "https://cdn.example/irail/releases/r1/irail.json",
      JSON.stringify({ files: { stations: { path: "/irail/releases/r1/stations.arrow" } } }),
    ],
    ["https://cdn.example/irail/releases/r1/stations.arrow", stationsTable(tableRelease)],
  ]);
  return async (url) => {
    const body = files.get(url);
    if (!body) return { ok: false, status: 404, url };
    return {
      ok: true,
      status: 200,
      url,
      json: async () => JSON.parse(body),
      arrayBuffer: async () => new Uint8Array(body).buffer,
    };
  };
}

test("the station table is found through the manifest's iRail extension", async () => {
  const loaded = await loadStationRows("https://cdn.example/irail/manifest.jsonld", fakeFetch());
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].alternativeFr, "Gand-Saint-Pierre");
  assert.equal(loaded[0].alternativeNl, null);
  assert.equal(loaded[0].iri, "http://irail.be/stations/NMBS/008892007");
});

test("publishers without the extension, or with a mismatching table, are handled", async () => {
  assert.equal(
    await loadStationRows("https://cdn.example/irail/manifest.jsonld", fakeFetch({ extension: false })),
    null,
  );
  await assert.rejects(
    loadStationRows(
      "https://cdn.example/irail/manifest.jsonld",
      fakeFetch({ tableRelease: "other" }),
    ),
    /another release/,
  );
  await assert.rejects(
    loadStationRows("https://cdn.example/irail/missing.jsonld", fakeFetch()),
    /HTTP 404/,
  );
});
