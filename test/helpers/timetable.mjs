import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as arrow from "apache-arrow";
import { encodeTable } from "../../scripts/arrow-table.mjs";

export const start = Date.parse("2026-11-08T08:00:00Z") / 1000;
export const releaseId = "test-release";
export const iri = (kind, id) => `https://example.org/${kind}/${id}`;

// Rows of the iRail `stations.arrow` extension, written next to the tables and
// linked from the manifest's `irail:extensions`.
async function writeStationExtension(directory, rows) {
  const columns = {
    name: [],
    alternativeFr: [],
    alternativeNl: [],
    alternativeDe: [],
    alternativeEn: [],
    lat: [],
    lon: [],
    avgStopTimes: [],
    iri: [],
  };
  for (const row of rows)
    for (const column of Object.keys(columns))
      columns[column].push(row[column] ?? null);
  const table = arrow.tableFromArrays(columns);
  const batch = new arrow.RecordBatch(
    new arrow.Schema(table.schema.fields, new Map([["releaseId", releaseId]])),
    table.batches[0].data,
  );
  await writeFile(
    path.join(directory, "stations.arrow"),
    arrow.tableToIPC(new arrow.Table(batch), "file"),
  );
  await writeFile(
    path.join(directory, "irail.json"),
    JSON.stringify({ files: { stations: { path: "stations.arrow" } } }),
  );
}

export async function timetable({
  connections,
  transfers = [],
  manifest: extra = {},
  regions = true,
  stopIris,
  tripShortNames = [],
  stationRows,
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "lc-planner-"));
  const stops = ["Origin", "Interchange", "Destination", "Disconnected"].map(
    (name, i) => ({
      name,
      lat: 51 + i * 0.1,
      lon: 4,
      parentIdx: -1,
      minTransferTime: 0,
      iri: stopIris?.[i] ?? iri("stops", i),
      regionIri: regions ? iri("regions", i) : null,
    }),
  );
  const tripCount = Math.max(
    4,
    ...(connections ?? []).map((row) => row.tripIdx + 1),
  );
  const trips = Array.from({ length: tripCount }, (_, i) => ({
    routeIdx: 0,
    headsign: "Destination",
    shortName: tripShortNames[i] ?? null,
    iri: iri("trips", i),
  }));
  const routes = [
    {
      shortName: "IC",
      longName: "Intercity",
      routeType: 2,
      iri: iri("routes", 0),
    },
  ];
  for (const [dataset, rows] of Object.entries({
    stops,
    trips,
    routes,
    transfers,
  }))
    await writeFile(
      path.join(directory, `${dataset}.arrow`),
      encodeTable(dataset, rows, releaseId),
    );
  const rows = connections ?? [
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
      departureTimeOffset: 100,
      arrivalTimeOffset: 200,
      tripIdx: 0,
      pickupType: 1,
      stopSequence: 2,
      arrivalStopSequence: 3,
    },
    {
      departureStopIdx: 0,
      arrivalStopIdx: 2,
      departureTimeOffset: 150,
      arrivalTimeOffset: 220,
      tripIdx: 1,
      stopSequence: 1,
      arrivalStopSequence: 2,
    },
  ];
  if (stationRows) await writeStationExtension(directory, stationRows);
  const pages = [];
  await mkdir(path.join(directory, "pages"));
  for (const [i, row] of rows.entries()) {
    const region = regions ? stops[row.departureStopIdx].regionIri : undefined;
    const full = {
      pickupType: 0,
      dropOffType: 0,
      serviceDate: 20261108,
      ...row,
      iri: iri("connections", i),
    };
    const id = `pages/arbitrary-${i}.arrow`;
    const next = i + 1 < rows.length ? `arbitrary-${i + 1}.arrow` : undefined;
    await writeFile(
      path.join(directory, id),
      encodeTable("connections", [full], releaseId, {
        epochSeconds: String(start),
        ...(region ? { region } : {}),
        ...(next ? { next } : {}),
      }),
    );
    pages.push({
      "@id": id,
      region,
      epochSeconds: start,
      minDepartureTime: new Date(
        (start + row.departureTimeOffset) * 1000,
      ).toISOString(),
      maxDepartureTime: new Date(
        (start + row.departureTimeOffset) * 1000,
      ).toISOString(),
      ...(regions
        ? { arrivalRegions: [stops[row.arrivalStopIdx].regionIri] }
        : {}),
    });
  }
  const manifest = {
    "@context":
      "https://linkedconnections.org/specification/2-0-alpha/context.jsonld",
    "@id": "https://example.org/manifest.jsonld",
    "@type": "Timetable",
    schemaVersion: "2-alpha",
    releaseId,
    timeZone: "Europe/Brussels",
    coverageStart: new Date(start * 1000).toISOString(),
    coverageEnd: new Date((start + 3600) * 1000).toISOString(),
    stops: "stops.arrow",
    trips: "trips.arrow",
    routes: "routes.arrow",
    transfers: "transfers.arrow",
    connections: { "@type": "ConnectionCollection", pages },
    ...(stationRows ? { "irail:extensions": { "@id": "irail.json" } } : {}),
    ...extra,
  };
  await writeFile(
    path.join(directory, "manifest.jsonld"),
    JSON.stringify(manifest),
  );
  return { directory, manifest, stops, trips, routes, rows };
}
