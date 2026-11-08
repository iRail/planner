import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { encodeTable } from "./arrow-table.mjs";

// An intentionally fixed, reproducible example. These are invented services,
// never a substitute for a publisher's operational timetable.
const root = new URL("../playground/public/data/", import.meta.url);
const releaseId = "illustrative-20261108";
const release = `releases/${releaseId}/`;
await mkdir(new URL(release, root), { recursive: true });
const iri = (kind, id) => `https://example.org/irail-demo/${kind}/${id}`;
const stations = [
  ["Gent-Sint-Pieters", 51.0357, 3.7103],
  ["Brussel-Zuid / Bruxelles-Midi", 50.8357, 4.3365],
  ["Leuven", 50.8823, 4.7157],
  ["Liège-Guillemins", 50.6245, 5.5667],
  ["Antwerpen-Centraal", 51.2172, 4.4211],
];
const stops = stations.map(([name, lat, lon], i) => ({
  name,
  lat,
  lon,
  parentIdx: -1,
  minTransferTime: 180,
  iri: iri("stops", i),
  regionIri: null,
}));
const routes = [
  {
    shortName: "IC demo",
    longName: "Gent – Brussel – Leuven – Liège",
    routeType: 2,
    iri: iri("routes", 0),
  },
  {
    shortName: "IC direct demo",
    longName: "Gent – Liège",
    routeType: 2,
    iri: iri("routes", 1),
  },
  {
    shortName: "IC via Antwerpen demo",
    longName: "Gent – Antwerpen – Leuven",
    routeType: 2,
    iri: iri("routes", 2),
  },
];
const trips = [];
const connections = [];
const epochSeconds = Date.parse("2026-11-08T07:00:00Z") / 1000;
function trip(route, segments, offset) {
  const tripIdx = trips.length;
  trips.push({
    routeIdx: route,
    headsign: stations[segments.at(-1)[1]][0],
    shortName: null,
    iri: iri("trips", tripIdx),
  });
  for (const [i, [from, to, departure, arrival]] of segments.entries())
    connections.push({
      departureStopIdx: from,
      arrivalStopIdx: to,
      departureTimeOffset: offset + departure,
      arrivalTimeOffset: offset + arrival,
      tripIdx,
      pickupType: 0,
      dropOffType: 0,
      serviceDate: 20261108,
      stopSequence: i + 1,
      arrivalStopSequence: i + 2,
      iri: iri("connections", `${tripIdx}-20261108-${i + 1}`),
    });
}
for (let hour = 0; hour < 12; hour += 1) {
  const offset = hour * 3600;
  trip(
    0,
    [
      [0, 1, 600, 2400],
      [1, 2, 2700, 3900],
      [2, 3, 4200, 6000],
    ],
    offset,
  );
  trip(1, [[0, 3, 1500, 7200]], offset);
  trip(
    2,
    [
      [0, 4, 900, 3300],
      [4, 2, 3600, 5700],
    ],
    offset,
  );
}
connections.sort((a, b) => a.departureTimeOffset - b.departureTimeOffset);
for (const [dataset, rows] of Object.entries({
  stops,
  routes,
  trips,
  connections,
}))
  await writeFile(
    new URL(`${release}${dataset}.arrow`, root),
    encodeTable(
      dataset,
      rows,
      releaseId,
      dataset === "connections" ? { epochSeconds: String(epochSeconds) } : {},
    ),
  );
await writeFile(
  new URL("manifest.jsonld", root),
  JSON.stringify(
    {
      "@context":
        "https://linkedconnections.org/specification/2-0-alpha/context.jsonld",
      "@id": "./manifest.jsonld",
      "@type": "Timetable",
      schemaVersion: "2-alpha",
      releaseId,
      name: "Belgian rail · illustrative timetable",
      timeZone: "Europe/Brussels",
      license: "https://creativecommons.org/publicdomain/zero/1.0/",
      rights:
        "Invented services for demonstrating the iRail planner; not travel advice.",
      coverageStart: new Date(epochSeconds * 1000).toISOString(),
      coverageEnd: new Date((epochSeconds + 13 * 3600) * 1000).toISOString(),
      stops: `${release}stops.arrow`,
      trips: `${release}trips.arrow`,
      routes: `${release}routes.arrow`,
      connections: {
        "@type": "ConnectionCollection",
        pages: [
          {
            "@id": `${release}connections.arrow`,
            epochSeconds,
            minDepartureTime: new Date(
              (epochSeconds + connections[0].departureTimeOffset) * 1000,
            ).toISOString(),
            maxDepartureTime: new Date(
              (epochSeconds + connections.at(-1).departureTimeOffset) * 1000,
            ).toISOString(),
          },
        ],
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Built illustrative LC 2-alpha timetable in ${fileURLToPath(root)}`,
);
