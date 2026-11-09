import assert from "node:assert/strict";
import test from "node:test";
import { editDistance } from "../src/irail-stations.mjs";
import * as arrow from "apache-arrow";
import {
  buildStations,
  findStations,
  fuzzyStations,
  loadStationRows,
  normalizeLanguage,
  stationByName,
  stationKey,
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

test("a name in one language finds the station labelled in another", () => {
  const set = buildStations({
    rows: [
      row("008892908", "Ronse", { fr: "Renaix", en: "Ronse/Renaix" }, 60),
      row("008886587", "Rebaix", {}, 10),
      row("008728600", "Lille-Flandres", { nl: "Rijsel Vlaanderen" }, 400),
    ],
    ids: [8892908, 8886587, 8728600].map((n) => `https://irail.be/id/be.sncb/stops/S${n}`),
    names: ["", "", ""],
    searchable: [0, 1, 2],
  });
  // The French name finds Ronse first (exact), and the label stays per language.
  const [ronse] = findStations(set, "Renaix");
  assert.equal(ronse.key, "8892908");
  assert.equal(stationLabel(ronse, "nl"), "Ronse");
  assert.equal(stationLabel(ronse, "fr"), "Renaix");
  assert.equal(findStations(set, "Renaiks")[0].key, "8892908"); // typo in a foreign name
  assert.equal(findStations(set, "rijsel")[0].key, "8728600");
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

test("edit distance counts inserts, deletes, replaces and swapped neighbours", () => {
  assert.equal(editDistance("gent", "gent"), 0);
  assert.equal(editDistance("gnet", "gent"), 1); // swap
  assert.equal(editDistance("brusels", "brussels"), 1); // missing letter
  assert.equal(editDistance("lueven", "leuven"), 1);
  assert.equal(editDistance("antwerpn", "antwerpen"), 1);
  assert.equal(editDistance("kitten", "sitting", 5), 3);
  // Gives up beyond the limit.
  assert.equal(editDistance("abcdef", "uvwxyz", 2), 3);
  assert.equal(editDistance("a", "abcdef", 2), 3);
});

const fuzzySet = () =>
  buildStations({
    rows: [
      row("1", "Leuven", {}, 300),
      row("2", "Leuven-Noord", {}, 20), // a quieter name close to the same text
      row("3", "Louven", {}, 5), // one letter off "Leuven"
      row("4", "Gent-Sint-Pieters", { fr: "Gand-Saint-Pierre" }, 500),
      row("5", "Genk", {}, 150),
      row("6", "Gentbrugge", {}, 40),
      row("7", "Brussel-Zuid/Bruxelles-Midi", { en: "Brussels-South" }, 900),
      row("8", "Brussel-Centraal", { en: "Brussels-Central" }, 800),
    ],
    ids: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `https://irail.be/id/be.sncb/stops/S${n}`),
    names: Array(8).fill(""),
    searchable: [0, 1, 2, 3, 4, 5, 6, 7],
  });

test("fuzzy matching finds stations despite typos, in any language", () => {
  const set = fuzzySet();
  const first = (text) => findStations(set, text)[0]?.key;
  assert.equal(first("Lueven"), "1"); // swapped letters
  assert.equal(first("Leuvn"), "1"); // missing letter
  assert.equal(first("Leuvenn"), "1"); // extra letter
  assert.equal(first("Gand Saint Piere"), "4"); // typo in a French name
  assert.equal(first("brusels south"), "7"); // typo in an English name
  assert.equal(first("Gand-Sant-Pierre"), "4");
  assert.equal(first("LEUVRN"), "1"); // replaced letter, other case
  // The text is still being typed: the start of the name is a typo away.
  assert.equal(first("Brusell"), "7");
});

test("fuzzy matches follow exact ones and rank the busiest station first", () => {
  const set = fuzzySet();
  // The typo "Gnet" matches nothing exactly, so every result is fuzzy, busiest
  // first: Gent-Sint-Pieters (500) before Gentbrugge (40). Genk is two edits away.
  assert.deepEqual(
    findStations(set, "Gnet").map((s) => s.key),
    ["4", "6"],
  );
  assert.deepEqual(
    fuzzyStations(set, "Gnet").map((m) => m.station.avgStopTimes),
    [500, 40],
  );
  // Exact matches stay in front: "leuven" matches two by name, and the typo
  // match of the quietest station never overtakes them.
  assert.deepEqual(
    findStations(set, "leuven").map((s) => s.key).slice(0, 2),
    ["1", "2"],
  );
  // Fuzzy only fills the places the exact matches leave free.
  assert.deepEqual(findStations(set, "leuven", 2).map((s) => s.key), ["1", "2"]);
  assert.equal(findStations(set, "leuven", 6).at(-1).key, "3"); // Louven, after the exact ones
});

test("fuzzy matching can be switched off and stays quiet for short or distant text", () => {
  const set = fuzzySet();
  assert.deepEqual(findStations(set, "Gnet", 6, { fuzzy: false }), []);
  assert.deepEqual(findStations(set, "xyz"), []); // too short to be typo-matched
  assert.deepEqual(findStations(set, "Gnt"), []); // three letters: no typos allowed
  assert.deepEqual(findStations(set, "Mechelen"), []); // nothing close
  assert.deepEqual(findStations(set, "zzzz"), []);
  assert.deepEqual(fuzzyStations(set, ""), []);
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

test("stops named by iRail station IRIs work like the S-prefixed stop IRIs", () => {
  // The iRail CDN is moving to iRail's station IRIs for station-level stops.
  const stationIris = buildStations({
    rows,
    ids: [
      "http://irail.be/stations/NMBS/008892106",
      "http://irail.be/stations/NMBS/008814001",
      "http://irail.be/stations/NMBS/008892007",
      "https://irail.be/id/be.sncb/stops/8892007_1",
      "http://irail.be/stations/NMBS/008841004",
    ],
    names: ["Gentbrugge", "Bruxelles-Midi", "Gand-Saint-Pierre", "Gand-Saint-Pierre", "Liège-Guillemins"],
    searchable: [0, 1, 2, 4],
  });
  assert.deepEqual(label(stationIris), ["8814001", "8892007", "8841004", "8892106"]);
  const ghent = stationIris.find((s) => s.key === "8892007");
  assert.equal(ghent.stopIdx, 2);
  assert.deepEqual(ghent.stopIdxs, [2, 3]); // the station and its platform
  assert.equal(findStations(stationIris, "ghent")[0].key, "8892007");
  assert.equal(stationKey("http://irail.be/stations/NMBS/008892007"), "8892007");
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
