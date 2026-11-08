// Station knowledge for the iRail-style API and the comparison page.
//
// The LC `stops.arrow` has one label per stop. iRail's CDN publishes the rest in
// a `stations.arrow` extension (one row per station: `name`, `alternativeFr`,
// `alternativeNl`, `alternativeDe`, `alternativeEn`, `lat`, `lon`,
// `avgStopTimes`, `iri`), linked from the manifest's `irail:extensions`.
// Station numbers (`8892007`) tie the two together: they appear in the stop
// IRIs (`.../stops/S8892007`, `.../stops/8892007_3`) and in the API's station
// ids (`BE.NMBS.008892007`).

export const LANGUAGES = ["en", "nl", "fr", "de"];
const ALTERNATIVE_COLUMNS = {
  fr: "alternativeFr",
  nl: "alternativeNl",
  de: "alternativeDe",
  en: "alternativeEn",
};

/**
 * The numeric NMBS/SNCB station number shared by stop IRIs and API station
 * identifiers: a string without leading zeros, or null when there is none.
 */
export function stationKey(identifier) {
  if (typeof identifier !== "string") return null;
  const match =
    /\/stops\/S?(\d+)(?:_[^/]*)?$/u.exec(identifier) ||
    /(?:BE\.NMBS\.|\/stations\/NMBS\/)0*(\d+)$/u.exec(identifier) ||
    /^0*(\d{6,9})$/u.exec(identifier);
  return match ? String(Number(match[1])) : null;
}

/** The iRail API's station identifier (`BE.NMBS.008892007`) for a station key. */
export const apiStationId = (key) => `BE.NMBS.${String(key).padStart(9, "0")}`;

/** The iRail station URI (`http://irail.be/stations/NMBS/008892007`). */
export const stationUri = (key) =>
  `http://irail.be/stations/NMBS/${String(key).padStart(9, "0")}`;

export function normalizeLanguage(value) {
  const language = String(value || "")
    .toLowerCase()
    .split("-")[0];
  return LANGUAGES.includes(language) ? language : "";
}

/**
 * Fetch the iRail `stations.arrow` extension table that the manifest points at
 * (`irail:extensions` → irail.json → `files.stations.path`). Resolves to the
 * rows, or null when the publisher offers no such extension. Throws for an
 * unreadable or mismatching table, so callers can fall back to the stop labels.
 * `tableFromIPC` is Apache Arrow's, passed in so this module stays dependency-free;
 * pass `manifest` when it is already parsed, to skip fetching it again.
 */
export async function loadStationRows(
  manifestUrl,
  { fetch: fetchFn = globalThis.fetch, tableFromIPC, manifest: loaded } = {},
) {
  const json = async (url) => {
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return { data: await response.json(), url: response.url || url };
  };
  const { data: manifest, url: manifestBase } = loaded
    ? { data: loaded, url: manifestUrl }
    : await json(manifestUrl);
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
  const table = tableFromIPC(new Uint8Array(await response.arrayBuffer()));
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
 * One record per station that the timetable can route from, most frequently
 * served first: `{ key, iri, name, names: { fr, nl, de, en }, lat, lon,
 * avgStopTimes, stopIdx, stopIdxs, searchNames }`. `name` is the standard name,
 * `names` the translations that exist, `stopIdx` the station-level stop and
 * `stopIdxs` every stop (platforms included) of the station. Stations the table
 * does not list (or all of them, when `rows` is empty) fall back to the stop's
 * own label. Table rows without any stop in the timetable are kept in
 * `unrouted`, so a station list can still show them.
 */
export function buildStations({ rows = [], ids, names, searchable, lat, lon }) {
  const stopIndex = new Map();
  for (const idx of searchable) {
    const key = stationKey(ids[idx]);
    if (key !== null && !stopIndex.has(key)) stopIndex.set(key, idx);
  }
  const stopIdxs = new Map();
  for (let idx = 0; idx < ids.length; idx += 1) {
    const key = stationKey(ids[idx]);
    if (key === null) continue;
    if (!stopIdxs.has(key)) stopIdxs.set(key, []);
    stopIdxs.get(key).push(idx);
  }
  const stations = [];
  const unrouted = [];
  const listed = new Set();
  const coordinate = (value, fallback) =>
    Number.isFinite(value) ? value : (fallback ?? NaN);
  for (const row of rows) {
    const key = stationKey(row.iri);
    if (key === null || listed.has(key)) continue;
    listed.add(key);
    const stopIdx = stopIndex.get(key);
    const station = {
      key,
      iri: row.iri,
      name: row.name || (stopIdx === undefined ? "" : names[stopIdx]),
      names: Object.fromEntries(
        Object.entries(ALTERNATIVE_COLUMNS)
          .filter(([, column]) => row[column])
          .map(([language, column]) => [language, row[column]]),
      ),
      lat: coordinate(row.lat, lat?.[stopIdx]),
      lon: coordinate(row.lon, lon?.[stopIdx]),
      avgStopTimes: Number(row.avgStopTimes) || 0,
      stopIdx,
      stopIdxs: stopIdxs.get(key) ?? [],
    };
    station.searchNames = searchNames(station);
    (stopIdx === undefined ? unrouted : stations).push(station);
  }
  for (const [key, stopIdx] of stopIndex) {
    if (listed.has(key)) continue;
    const station = {
      key,
      iri: ids[stopIdx],
      name: names[stopIdx] || ids[stopIdx],
      names: {},
      lat: coordinate(lat?.[stopIdx]),
      lon: coordinate(lon?.[stopIdx]),
      avgStopTimes: rows.length ? 0 : stopIdxs.get(key).length,
      stopIdx,
      stopIdxs: stopIdxs.get(key),
    };
    station.searchNames = searchNames(station);
    stations.push(station);
  }
  const busiest = (a, b) =>
    b.avgStopTimes - a.avgStopTimes || a.name.localeCompare(b.name);
  stations.sort(busiest);
  stations.unrouted = unrouted.sort(busiest);
  return stations;
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

/**
 * Resolve what an API caller passed as a station: an id (`BE.NMBS.008892007`),
 * a station URI, a bare station number, or a name in any language. A name must
 * match exactly (ignoring case and accents) or, failing that, is searched like
 * irail.be's station search. Returns null when nothing matches.
 */
export function resolveStation(stations, input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const key = /^(BE\.NMBS\.|http:\/\/irail\.be\/stations\/NMBS\/)?0*\d{6,9}$/u.test(
    text,
  )
    ? stationKey(text)
    : null;
  if (key !== null)
    return (
      stations.find((s) => s.key === key) ??
      stations.unrouted?.find((s) => s.key === key) ??
      null
    );
  return (
    stationByName(stations, text) ??
    findStations(stations, text, 1)[0] ??
    stationByName(stations.unrouted ?? [], text) ??
    null
  );
}
