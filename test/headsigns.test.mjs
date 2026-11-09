import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import * as arrow from "apache-arrow";
import { createPlanner } from "../src/index.mjs";
import { buildHeadsigns, loadHeadsignRows } from "../src/irail-headsigns.mjs";
import { timetable, start } from "./helpers/timetable.mjs";

const headsignRows = [
  {
    headsign: "Destination",
    translationNl: "Bestemming",
    translationDe: "Ziel",
    translationEn: "Goal",
  },
  { headsign: "Alost", translationNl: "Aalst", translationDe: null, translationEn: "Alost / Aalst" },
];
const stopIris = [1000001, 1000002, 1000003, 1000004].map(
  (n) => `https://irail.be/id/be.sncb/stops/S${n}`,
);
const nine = new Date(start * 1000);

test("a headsign is answered in the language, or as published without a translation", () => {
  const headsigns = buildHeadsigns(headsignRows);
  assert.equal(headsigns.translate("Alost", "nl"), "Aalst");
  assert.equal(headsigns.translate("Alost", "en"), "Alost / Aalst");
  assert.equal(headsigns.translate("Alost", "de"), "Alost"); // no German text
  assert.equal(headsigns.translate("Alost", "fr"), "Alost"); // the published one
  assert.equal(headsigns.translate("Alost", undefined), "Alost");
  assert.equal(headsigns.translate("Unknown", "nl"), "Unknown");
  assert.deepEqual(headsigns.all("Alost"), { fr: "Alost", nl: "Aalst", en: "Alost / Aalst" });
  assert.deepEqual(headsigns.all("Unknown"), { fr: "Unknown" });
  assert.equal(buildHeadsigns().translate("Alost", "nl"), "Alost");
});

test("the headsign table is found through the manifest's iRail extension", async () => {
  const table = arrow.tableFromArrays({
    headsign: ["Alost"],
    translationNl: ["Aalst"],
    translationDe: [null],
    translationEn: [null],
  });
  const body = arrow.tableToIPC(table, "file");
  const files = new Map([
    ["https://cdn.example/m.jsonld", JSON.stringify({ "irail:extensions": { "@id": "/r/irail.json" } })],
    ["https://cdn.example/r/irail.json", JSON.stringify({ files: { headsigns: { path: "/r/headsigns.arrow" } } })],
  ]);
  const fetch = async (url) => {
    const found = files.get(url);
    if (!found && url !== "https://cdn.example/r/headsigns.arrow")
      return { ok: false, status: 404, url };
    return {
      ok: true,
      url,
      json: async () => JSON.parse(found),
      arrayBuffer: async () => new Uint8Array(body).buffer,
    };
  };
  const rows = await loadHeadsignRows("https://cdn.example/m.jsonld", {
    fetch,
    tableFromIPC: arrow.tableFromIPC,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].translationNl, "Aalst");
  // A publisher that lists only stations offers no headsigns.
  files.set("https://cdn.example/r/irail.json", JSON.stringify({ files: { stations: { path: "s.arrow" } } }));
  assert.equal(
    await loadHeadsignRows("https://cdn.example/m.jsonld", { fetch, tableFromIPC: arrow.tableFromIPC }),
    null,
  );
});

async function setup(t, options = {}) {
  const fixture = await timetable({ stopIris, headsignRows, ...options });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const fetcher = async (url) => {
    try {
      const response = new Response(
        await readFile(path.join(fixture.directory, new URL(url).pathname.slice("/data/".length))),
      );
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    } catch {
      return new Response("missing", { status: 404 });
    }
  };
  const planner = createPlanner({ dataUrl: "https://example.org/data/", fetch: fetcher });
  await planner.init();
  return planner;
}

const query = {
  origin: { sourceId: "default", stopIdx: 0 },
  destination: { sourceId: "default", stopIdx: 1 },
  departureAfter: start,
  maxWalkMeters: 0,
};

test("planned legs show the headsign in the language asked, and in every language", async (t) => {
  const planner = await setup(t);
  const leg = (result) => result.options[0].legs[0];
  const dutch = leg(await planner.plan({ ...query, language: "nl" }));
  assert.equal(dutch.headsign, "Bestemming");
  assert.deepEqual(dutch.headsigns, {
    fr: "Destination",
    nl: "Bestemming",
    de: "Ziel",
    en: "Goal",
  });
  assert.equal(leg(await planner.plan({ ...query, language: "fr" })).headsign, "Destination");
  assert.equal(leg(await planner.plan({ ...query, language: "NL-be" })).headsign, "Bestemming");
  // Without a language the timetable's text stays, and nothing is loaded for it.
  const plain = leg(await planner.plan(query));
  assert.equal(plain.headsign, "Destination");
  assert.equal(plain.headsigns, undefined);
  await assert.rejects(planner.plan({ ...query, language: "es" }), /language must be one of/);
});

test("without translations the planned headsign is as published", async (t) => {
  const planner = await setup(t, { headsignRows: undefined, stationRows: [] });
  const result = await planner.plan({ ...query, language: "nl" });
  assert.equal(result.options[0].legs[0].headsign, "Destination");
});

test("a connection's direction is in the language of the query", async (t) => {
  const planner = await setup(t, {
    stationRows: [
      ["Origin", 1],
      ["Interchange", 2],
      ["Destination", 3],
      ["Disconnected", 4],
    ].map(([name, n]) => ({ iri: `http://irail.be/stations/NMBS/00100000${n}`, name, avgStopTimes: 1 })),
  });
  const direction = async (language) =>
    (await planner.connections({ from: "Origin", to: "Destination", time: nine, language }))[0]
      .legs[0].direction;
  assert.equal(await direction("nl"), "Bestemming");
  assert.equal(await direction("de"), "Ziel");
  assert.equal(await direction("fr"), "Destination");
  assert.equal(await direction("en"), "Goal");
});
