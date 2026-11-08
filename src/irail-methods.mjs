// The calls of the iRail API (https://docs.irail.be) as methods for anything with
// a `request(type, payload)` function: the Node `Planner` and the browser
// `PlannerClient`. The four calls the timetable can answer go through
// `request`; the others exist so callers can program against the whole API and
// reject with a NotSupportedError until their data source is supported.
import { unsupportedCalls } from "./irail-api.mjs";

export const irailMethods = {
  /** Like `GET /stations/`: every station, labelled in `language`. */
  stations(query = {}) {
    return this.request("stations", query);
  },
  /** Like `GET /liveboard/`: the hour of departures (or arrivals) at a station. */
  liveboard(query) {
    return this.request("liveboard", query);
  },
  /** Like `GET /connections/`: journeys from one station to another. */
  connections(query) {
    return this.request("connections", query);
  },
  /** Like `GET /vehicle/`: the stops of one train on one day. */
  vehicle(query) {
    return this.request("vehicle", query);
  },
  /** Like `GET /composition/`: not supported yet. */
  composition: unsupportedCalls.composition,
  /** Like `GET /disturbances/`: not supported yet. */
  disturbances: unsupportedCalls.disturbances,
  /** Like `POST /feedback/occupancy`: not supported yet. */
  occupancyFeedback: unsupportedCalls.occupancyFeedback,
};

export function addIrailMethods(target) {
  for (const [name, method] of Object.entries(irailMethods))
    Object.defineProperty(target, name, {
      value: method,
      writable: true,
      configurable: true,
    });
  return target;
}
