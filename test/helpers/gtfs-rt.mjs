// A GTFS Realtime encoder for tests: the inverse of src/gtfs-rt.mjs, written
// from the same .proto field numbers so the two check each other.

const TRIP = { scheduled: 0, added: 1, unscheduled: 2, canceled: 3, deleted: 7 };
const STOP = { scheduled: 0, skipped: 1, "no-data": 2 };

function varint(value) {
  // Negative numbers are sign-extended to 64 bits, like protobuf int32/int64.
  let rest = BigInt.asUintN(64, BigInt(value));
  const out = [];
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest) byte |= 0x80;
    out.push(byte);
  } while (rest);
  return out;
}
const tag = (field, wire) => varint((field << 3) | wire);
const number = (field, value) => [...tag(field, 0), ...varint(value)];
const bytes = (field, content) => [
  ...tag(field, 2),
  ...varint(content.length),
  ...content,
];
const text = (field, value) => bytes(field, [...new TextEncoder().encode(value)]);

const event = ({ delay, time } = {}) => [
  ...(delay === undefined ? [] : number(1, delay)),
  ...(time === undefined ? [] : number(2, time)),
];

const stopUpdate = (stop) => [
  ...(stop.stopSequence === undefined ? [] : number(1, stop.stopSequence)),
  ...(stop.arrival ? bytes(2, event(stop.arrival)) : []),
  ...(stop.departure ? bytes(3, event(stop.departure)) : []),
  ...text(4, stop.stopId),
  ...(stop.relationship ? number(5, STOP[stop.relationship]) : []),
];

const tripUpdate = (trip) => [
  ...bytes(1, [
    ...text(1, trip.tripId),
    ...(trip.startDate === undefined ? [] : text(3, String(trip.startDate))),
    ...(trip.relationship ? number(4, TRIP[trip.relationship]) : []),
  ]),
  ...(trip.stops ?? []).flatMap((stop) => bytes(2, stopUpdate(stop))),
  ...(trip.delay === undefined ? [] : number(5, trip.delay)),
];

/**
 * `encodeFeed({ timestamp, trips })` → Uint8Array. A trip is
 * `{ tripId, startDate, relationship?, delay?, stops: [{ stopId, arrival?,
 * departure?, relationship?, stopSequence? }] }` with events `{ delay?, time? }`.
 */
export function encodeFeed({ timestamp, trips = [] }) {
  return Uint8Array.from([
    ...bytes(1, [...text(1, "2.0"), ...number(2, 0), ...number(3, timestamp)]),
    ...trips.flatMap((trip, i) =>
      bytes(2, [...text(1, `entity-${i}`), ...bytes(3, tripUpdate(trip))]),
    ),
  ]);
}
