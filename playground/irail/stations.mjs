// Station names for the comparison page. The planner's stops.arrow has a single
// label per stop, so the translations and the traffic figures come from the iRail
// CDN's `stations.arrow` extension (one row per station: `name`, `alternativeFr`,
// `alternativeNl`, `alternativeDe`, `alternativeEn`, `avgStopTimes`, `iri`), the
// same data irail.be builds its station search from.
import * as arrow from "apache-arrow";
import { stationKey } from "../compare.mjs";

export const LANGUAGES = ["en", "nl", "fr", "de"];
const ALTERNATIVE_COLUMNS = {
  fr: "alternativeFr",
  nl: "alternativeNl",
  de: "alternativeDe",
  en: "alternativeEn",
};

/**
 * Fetch the iRail `stations.arrow` extension table that the manifest points at
 * (`irail:extensions` → irail.json → `files.stations.path`). Resolves to the
 * rows, or null when the publisher offers no such extension. Throws for an
 * unreadable or mismatching table, so callers can fall back to the stop labels.
 */
export async function loadStationRows(manifestUrl, fetchFn = globalThis.fetch) {
  const json = async (url) => {
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return { data: await response.json(), url: response.url || url };
  };
  const { data: manifest, url: manifestBase } = await json(manifestUrl);
  const extension = manifest["irail:extensions"]?.["@id"];
  if (!extension) return null;
  const { data: info, url: infoUrl } = await json(
    new URL(extension, manifestBase).href,
  );
  const path = info.files?.stations?.path;
  if (!path) return null;
  const tableUrl = new URL(path, infoUrl).href;
  const response = await fetchFn(tableUrl);
  if (!response.ok) throw new Error(`${tableUrl}: HTTP ${response.status}`);
  const table = arrow.tableFromIPC(new Uint8Array(await response.arrayBuffer()));
  const releaseId = table.schema.metadata.get("releaseId");
  if (releaseId && manifest.releaseId && releaseId !== manifest.releaseId)
    throw new Error("stations.arrow belongs to another release");
  for (const column of ["name", "iri", ...Object.values(ALTERNATIVE_COLUMNS)])
    if (!table.getChild(column))
      throw new Error(`stations.arrow has no ${column} column`);
  return Array.from({ length: table.numRows }, (_, i) => {
    const row = {};
    for (const field of table.schema.fields)
      row[field.name] = table.getChild(field.name).get(i);
    return row;
  });
}

/**
 * One record per station that the planner can route from, most frequently
 * served first: `{ key, iri, name, names: { fr, nl, de, en }, avgStopTimes,
 * stopIdx, searchNames }`. `name` is the station's standard name; `names` holds
 * the translations that exist. Stations the table does not list (or all of
 * them, when `rows` is empty) fall back to the stop's own label.
 */
export function buildStations({ rows = [], ids, names, searchable }) {
  const stopIndex = new Map();
  for (const idx of searchable) {
    const key = stationKey(ids[idx]);
    if (key !== null && !stopIndex.has(key)) stopIndex.set(key, idx);
  }
  const platforms = new Map();
  for (const id of ids) {
    const key = stationKey(id);
    if (key !== null) platforms.set(key, (platforms.get(key) || 0) + 1);
  }
  const stations = [];
  const listed = new Set();
  for (const row of rows) {
    const key = stationKey(row.iri);
    const stopIdx = stopIndex.get(key);
    if (key === null || stopIdx === undefined || listed.has(key)) continue;
    listed.add(key);
    stations.push({
      key,
      iri: row.iri,
      name: row.name || names[stopIdx],
      names: Object.fromEntries(
        Object.entries(ALTERNATIVE_COLUMNS)
          .filter(([, column]) => row[column])
          .map(([language, column]) => [language, row[column]]),
      ),
      avgStopTimes: Number(row.avgStopTimes) || 0,
      stopIdx,
    });
  }
  for (const [key, stopIdx] of stopIndex) {
    if (listed.has(key)) continue;
    stations.push({
      key,
      iri: ids[stopIdx],
      name: names[stopIdx] || ids[stopIdx],
      names: {},
      avgStopTimes: rows.length ? 0 : platforms.get(key) || 0,
      stopIdx,
    });
  }
  for (const station of stations) station.searchNames = searchNames(station);
  return stations.sort(
    (a, b) => b.avgStopTimes - a.avgStopTimes || a.name.localeCompare(b.name),
  );
}

/** A station's label in a language, falling back to its standard name. */
export const stationLabel = (station, language) =>
  station.names[language] || station.name;

// ----- search: a port of the station search in irail.be's app.js -----

const normalizeStationText = (value) =>
  value.normalize("NFD").replace(/[̀-ͯ]/gu, "");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function stationNameForms(name) {
  return [name, name.replace(/'/gu, " ")];
}

function searchNames(station) {
  return [station.name, ...Object.values(station.names)]
    .filter(Boolean)
    .map((name) =>
      stationNameForms(
        normalizeStationText(name.replace(/ am /giu, " ")).replace(
          /(-| )+/gu,
          " ",
        ),
      ),
    );
}

/** The regular expression irail.be derives from what the user typed. */
export function stationQueryRegex(query) {
  let q = query || "";
  q = q.replace(/Brussel Nat.+/iu, "Brussels Airport");
  q = q.replace(
    /Brussels Airport ?-? ?Z?a?v?e?n?t?e?m?/iu,
    "Brussels Airport",
  );
  q = q.replace(/- /gu, "-");
  q = q.replace(/l alleud/giu, "l'alleud");
  q = q.replace(/ Cdg /giu, " Charles de Gaulle ");
  q = q.replace(/ am /giu, " ");
  q = q.replace(/frankfurt fl/giu, "frankfurt main fl");
  q = q.replace(/Bru\./giu, "Brussel");
  q = q.replace(/Brux\./giu, "Bruxelles");
  q = q.replace(/Maastricht Randwijck/giu, "Maastricht Randwyck");
  q = q.replace(/\s?\(.*?\)/giu, "");
  q = q.replace(/st\.-/giu, "st ");
  q = q.replace(/st-/giu, "st ");
  q = q.replace(/st(\s|$|\.)/giu, "__SAINT__ ");
  q = q.split("/")[0].trim();
  q = normalizeStationText(q).replace(/([- ])+/gu, " ").trim();
  if (!q) return null;
  try {
    return new RegExp(
      escapeRegExp(q).replace(/__SAINT__/gu, "(saint|st|sint)"),
      "iu",
    );
  } catch {
    return null;
  }
}

/**
 * Stations matching the text typed in any language, best first: exact match,
 * then word prefix, prefix, and partial matches; within a rank the most
 * frequently served station (`avgStopTimes`) comes first.
 */
export function findStations(stations, query, limit = 6) {
  const regex = stationQueryRegex(query);
  if (!regex) return [];
  const exact = new RegExp(`^${regex.source}$`, "iu");
  const wordPrefix = new RegExp(`^${regex.source}(?:\\b|\\s)`, "iu");
  const prefix = new RegExp(`^${regex.source}`, "iu");
  const rankOf = (station) => {
    const forms = station.searchNames;
    const some = (test) => forms.some((name) => name.some((v) => test.test(v)));
    return some(exact)
      ? 0
      : some(wordPrefix)
        ? 1
        : some(prefix)
          ? 2
          : some(regex)
            ? 3
            : null;
  };
  return stations
    .map((station) => ({ station, rank: rankOf(station) }))
    .filter((match) => match.rank !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank || b.station.avgStopTimes - a.station.avgStopTimes,
    )
    .slice(0, limit)
    .map((match) => match.station);
}

/** A station whose label (in any language) equals the text, ignoring accents and case. */
export function stationByName(stations, text) {
  const wanted = normalizeStationText(String(text || "").trim()).toLowerCase();
  if (!wanted) return null;
  return (
    stations.find((station) =>
      [station.name, ...Object.values(station.names)].some(
        (name) => normalizeStationText(name).toLowerCase() === wanted,
      ),
    ) ?? null
  );
}

export function normalizeLanguage(value) {
  const language = String(value || "")
    .toLowerCase()
    .split("-")[0];
  return LANGUAGES.includes(language) ? language : "";
}
