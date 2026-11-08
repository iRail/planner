// The comparison page's view of the library's station module. Only the table
// loader is wrapped, to hand it the page's copy of Apache Arrow.
import { tableFromIPC } from "apache-arrow";
import { loadStationRows as load } from "../../src/irail-stations.mjs";

export {
  LANGUAGES,
  buildStations,
  findStations,
  normalizeLanguage,
  stationByName,
  stationKey,
  stationLabel,
  stationQueryRegex,
} from "../../src/irail-stations.mjs";

export const loadStationRows = (manifestUrl, fetchFn = globalThis.fetch) =>
  load(manifestUrl, { fetch: fetchFn, tableFromIPC });
