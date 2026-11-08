import uriTemplates from "uri-templates";
import schemas from "./lc-schemas.json" with { type: "json" };

export const LC_VERSION = "2-alpha";

export function validateSchema(schema, dataset, releaseId) {
  for (const [key, value] of Object.entries({
    schemaVersion: LC_VERSION,
    dataset,
    releaseId,
  })) {
    if (schema.metadata.get(key) !== value)
      throw new Error(`Invalid ${dataset} metadata: expected ${key}=${value}`);
  }
  for (const expected of schemas[dataset]) {
    const field = schema.fields.find((field) => field.name === expected.name);
    if (
      !field ||
      String(field.type) !== expected.type ||
      field.nullable !== expected.nullable
    )
      throw new Error(
        `Invalid ${dataset} column ${expected.name}: expected ${expected.type}, nullable=${expected.nullable}`,
      );
  }
}

export function resourceUrl(value, base) {
  const reference = typeof value === "string" ? value : value?.["@id"];
  if (!reference) throw new Error("Missing timetable resource IRI");
  const url = new URL(reference, base);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Timetable resources must use HTTP or HTTPS");
  return url.href;
}

export async function loadLCTimetable(manifest, url, loadTable) {
  if (
    manifest.schemaVersion !== LC_VERSION ||
    manifest["@type"] !== "Timetable"
  )
    throw new Error(
      `Unsupported Linked Connections schema: ${manifest.schemaVersion}`,
    );
  if (!manifest.releaseId || !manifest.timeZone || !manifest.connections)
    throw new Error("Timetable requires releaseId, timeZone and connections");
  // Check the timezone without silently changing service-date semantics.
  new Intl.DateTimeFormat("en", { timeZone: manifest.timeZone });
  const files = Object.fromEntries(
    ["stops", "trips", "routes", "transfers"]
      .filter((key) => manifest[key])
      .map((key) => [key, resourceUrl(manifest[key], url)]),
  );
  for (const key of ["stops", "trips", "routes"])
    if (!files[key]) throw new Error(`Timetable is missing ${key}`);
  const tables = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([key, file]) => [
        key,
        await loadTable(file, { dataset: key, releaseId: manifest.releaseId }),
      ]),
    ),
  );
  const values = (table, column) => Array.from(table.getChild(column));
  const stops = {
    id: values(tables.stops, "iri"),
    iri: values(tables.stops, "iri"),
    name: values(tables.stops, "name"),
    // toArray() would turn Arrow nulls into zero coordinates.
    lat: Float64Array.from(values(tables.stops, "lat"), (v) => v ?? NaN),
    lon: Float64Array.from(values(tables.stops, "lon"), (v) => v ?? NaN),
    parentIdx: tables.stops.getChild("parentIdx").toArray(),
    minTransferTime: tables.stops.getChild("minTransferTime").toArray(),
    regionIdx: values(tables.stops, "regionIri").map(
      (v) => v ?? "unpartitioned",
    ),
    transferRules: Array.from({ length: tables.stops.numRows }, () => []),
  };
  for (let i = 0; i < stops.id.length; i += 1) {
    const seen = new Set([i]);
    let parent = stops.parentIdx[i];
    while (parent !== -1) {
      if (parent < 0 || parent >= stops.id.length || seen.has(parent))
        throw new Error("Invalid or cyclic stop hierarchy");
      seen.add(parent);
      parent = stops.parentIdx[parent];
    }
  }
  const stationRoot = (stop) => {
    while (stops.parentIdx[stop] !== -1) stop = stops.parentIdx[stop];
    return stop;
  };
  // In-seat (linked-trip) transfers: a train that splits or joins keeps its
  // passengers seated while the trip changes. `linkedTrips` maps a trip to the
  // trips it continues as, each at one stop.
  const linkedTrips = new Map();
  if (tables.transfers)
    for (const row of tables.transfers) {
      if (row.transferType > 5)
        throw new Error(`Unsupported transfer type: ${row.transferType}`);
      // Type 5 says riders must get off, which is what a transfer between two
      // trips already means: nothing to record.
      if (row.transferType === 5) continue;
      if (row.transferType === 4) {
        const { fromTripIdx: from, toTripIdx: to, fromStopIdx: stop } = row;
        if (
          from == null ||
          to == null ||
          stop == null ||
          row.toStopIdx !== stop ||
          !stops.transferRules[stop] ||
          from < 0 ||
          to < 0 ||
          from >= tables.trips.numRows ||
          to >= tables.trips.numRows
        )
          throw new Error(
            "Linked-trip transfer needs two trips and one stop of this timetable",
          );
        if (!linkedTrips.has(from)) linkedTrips.set(from, []);
        linkedTrips.get(from).push({ to, stop });
        continue;
      }
      if (
        row.fromStopIdx == null ||
        row.toStopIdx == null ||
        !stops.transferRules[row.fromStopIdx] ||
        !stops.transferRules[row.toStopIdx]
      )
        throw new Error("Transfer references an invalid stop");
      if (row.transferType === 2 && row.minTransferTime == null)
        throw new Error("Minimum-time transfer is missing minTransferTime");
      // Overrides between different stations are ignored: walking between
      // stations uses physical distance, so only same-station rules apply.
      if (stationRoot(row.fromStopIdx) !== stationRoot(row.toStopIdx)) continue;
      stops.transferRules[row.fromStopIdx].push({
        to: row.toStopIdx,
        type: row.transferType,
        seconds: row.minTransferTime ?? 0,
        fromTrip: row.fromTripIdx ?? -1,
        toTrip: row.toTripIdx ?? -1,
        fromRoute: row.fromRouteIdx ?? -1,
        toRoute: row.toRouteIdx ?? -1,
      });
    }
  const childrenOf = new Map();
  const searchable = [];
  for (let i = 0; i < stops.id.length; i += 1) {
    const parent = stops.parentIdx[i];
    if (parent === -1) searchable.push(i);
    else {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(i);
    }
  }
  return {
    manifestUrl: url,
    stops,
    linkedTrips,
    tables,
    tripRoutes: tables.trips.getChild("routeIdx").toArray(),
    stopFamily: { childrenOf, searchable },
    manifest: {
      ...manifest,
      counts: Object.fromEntries(
        Object.entries(tables).map(([key, table]) => [key, table.numRows]),
      ),
    },
  };
}

const timestamp = (value, fallback) => {
  if (value === undefined) return fallback;
  const time = typeof value === "number" ? value : Date.parse(value) / 1000;
  if (!Number.isFinite(time)) throw new Error(`Invalid page time: ${value}`);
  return time;
};

function intervalSeconds(duration) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u.exec(
    duration || "",
  );
  const seconds = match
    ? (+match[1] * 86400 || 0) +
      (+match[2] * 3600 || 0) +
      (+match[3] * 60 || 0) +
      (+match[4] || 0)
    : NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0)
    throw new Error(`Unsupported pageInterval: ${duration}`);
  return seconds;
}

// Normalize publisher-defined pages into the scan's region index. Unknown
// bounds/regions stay conservative; page names are never interpreted as data.
export async function connectionPages(source, from, to, readPage) {
  const collection = source.manifest.connections;
  // Real-time delays push connections past the end of their page; the margin
  // keeps those pages in range of the scans that should still see them.
  const margin = source.realtimeMargin ?? 0;
  const page = (entry) => ({
    ...entry,
    url: resourceUrl(entry, source.manifestUrl),
    source,
    minDepartureTime: timestamp(entry.minDepartureTime, -Infinity),
    maxDepartureTime: timestamp(entry.maxDepartureTime, Infinity) + margin,
  });
  if (Array.isArray(collection.pages)) return collection.pages.map(page);
  if (!collection.searchTemplate)
    throw new Error("Connections require pages or searchTemplate");
  const regions = [...new Set(source.stops.regionIdx)];
  const template = uriTemplates(collection.searchTemplate);
  const expand = (values) =>
    resourceUrl(template.fill(values), source.manifestUrl);
  const pages = [];
  const start = Math.max(
    from,
    timestamp(source.manifest.coverageStart, -Infinity),
  );
  const end = Math.min(to, timestamp(source.manifest.coverageEnd, Infinity));
  if (start >= end) return pages;
  if (collection.paginationStrategy === "ScheduledPagination") {
    const interval = intervalSeconds(collection.pageInterval);
    for (
      let time = Math.floor(start / interval) * interval;
      time < end;
      time += interval
    ) {
      const iso = new Date(time * 1000).toISOString();
      for (const region of regions)
        pages.push(
          page({
            "@id": expand({
              yyyy: iso.slice(0, 4),
              MM: iso.slice(5, 7),
              dd: iso.slice(8, 10),
              HH: iso.slice(11, 13),
              mm: iso.slice(14, 16),
              ss: iso.slice(17, 19),
              region: region === "unpartitioned" ? undefined : region,
            }),
            region,
            minDepartureTime: time,
            maxDepartureTime: time + interval - 1,
          }),
        );
    }
  } else if (collection.paginationStrategy === "RedirectPagination") {
    // Fetch each region's first page and follow immutable next links. The
    // decoded buffers enter the regular cache and are reused by both scans.
    for (const region of regions) {
      let url = expand({
        departureTime: new Date(start * 1000).toISOString(),
        region: region === "unpartitioned" ? undefined : region,
      });
      const visited = new Set();
      while (url) {
        if (visited.has(url)) throw new Error("Cyclic connections pagination");
        visited.add(url);
        const job = {
          ...page({ "@id": url, region }),
          allowNotFound: visited.size === 1,
        };
        const batches = await readPage(job, from, to);
        if (batches.page?.notFound) break;
        const metadata = batches.page;
        if (!metadata)
          throw new Error("Connections page has no pagination metadata");
        job.url = metadata.url;
        if (metadata.minDepartureTime >= end) break;
        pages.push({
          ...job,
          ...metadata,
          region: metadata.region ?? region,
          source,
        });
        url = metadata.next ? resourceUrl(metadata.next, metadata.url) : null;
      }
    }
  } else
    throw new Error(
      `Unsupported paginationStrategy: ${collection.paginationStrategy}`,
    );
  return pages;
}
