// The trip updates of a GTFS Realtime feed
// (https://gtfs.org/documentation/realtime/reference/), decoded with protobufjs.
//
// The decoder in `gtfs-realtime.mjs` is generated from `proto/gtfs-realtime.proto`
// (`npm run build:proto`). Generated code needs only protobufjs's small runtime
// and builds nothing at run time, so it works under strict content security
// policies and on runtimes that forbid `eval`. This module keeps what journey
// planning needs: which trips are canceled, which stops are skipped, and the
// delay or predicted time of each stop. Vehicle positions and service alerts
// are not read.

import { transit_realtime as gtfsRealtime } from "./gtfs-realtime.mjs";

const names = (enumeration) =>
  Object.fromEntries(
    Object.entries(enumeration).map(([name, value]) => [
      value,
      name.toLowerCase().replaceAll("_", "-"),
    ]),
  );
const TRIP_RELATIONSHIP = names(gtfsRealtime.TripDescriptor.ScheduleRelationship);
const STOP_RELATIONSHIP = names(
  gtfsRealtime.TripUpdate.StopTimeUpdate.ScheduleRelationship,
);

// 64-bit fields arrive as Long objects, which hold any UTC epoch second.
const number = (value) => (typeof value === "number" ? value : value.toNumber());
const has = (message, field) => Object.hasOwn(message, field);

// Whether a field was in the feed matters: a delay of 0 says "on time", no
// delay says "unknown". Absent fields are simply left out.
function stopTimeEvent(event) {
  const result = {};
  if (has(event, "delay")) result.delay = event.delay;
  if (has(event, "time")) result.time = number(event.time);
  return result;
}

function stopTimeUpdate(update) {
  const result = {
    relationship: STOP_RELATIONSHIP[update.scheduleRelationship] ?? "scheduled",
  };
  if (has(update, "stopSequence")) result.stopSequence = update.stopSequence;
  if (update.arrival) result.arrival = stopTimeEvent(update.arrival);
  if (update.departure) result.departure = stopTimeEvent(update.departure);
  if (has(update, "stopId")) result.stopId = update.stopId;
  return result;
}

function tripUpdate(update) {
  const { trip } = update;
  const result = {
    relationship: TRIP_RELATIONSHIP[trip.scheduleRelationship] ?? "scheduled",
    stops: update.stopTimeUpdate.map(stopTimeUpdate),
  };
  if (has(trip, "tripId")) result.tripId = trip.tripId;
  if (has(trip, "startTime")) result.startTime = trip.startTime;
  // GTFS dates are YYYYMMDD, the same integer the connections carry.
  const date = Number(trip.startDate);
  if (has(trip, "startDate") && Number.isInteger(date)) result.startDate = date;
  if (has(update, "timestamp")) result.timestamp = number(update.timestamp);
  if (has(update, "delay")) result.delay = update.delay;
  return result;
}

/**
 * Decode a GTFS Realtime `FeedMessage`; throws when the input is not one,
 * including an empty or truncated one, so a bad response never stands in for
 * "nothing is late". Returns `{ timestamp, updates }`: the feed's own timestamp
 * (UTC epoch seconds, when it was produced) and one entry per trip update with
 * `tripId`, `startDate` (`YYYYMMDD` as a number), `startTime`, `relationship`
 * (`scheduled`, `added`, `canceled`, …), an optional trip-wide `delay` and
 * `stops`: each `{ stopId, stopSequence?, arrival?, departure?, relationship }`
 * where an event is `{ delay?, time? }` (seconds; `time` is UTC epoch seconds).
 */
export function decodeTripUpdates(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let message;
  try {
    message = gtfsRealtime.FeedMessage.decode(bytes);
  } catch (error) {
    throw new Error(`Not a GTFS Realtime feed: ${error.message}`, {
      cause: error,
    });
  }
  const feed = {
    timestamp: has(message.header, "timestamp")
      ? number(message.header.timestamp)
      : undefined,
    updates: [],
  };
  for (const entity of message.entity) {
    if (entity.isDeleted || !entity.tripUpdate) continue;
    const update = tripUpdate(entity.tripUpdate);
    if (update.tripId) feed.updates.push(update);
  }
  return feed;
}
