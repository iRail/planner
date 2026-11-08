// A small, dependency-free decoder for the trip updates of a GTFS Realtime feed
// (https://gtfs.org/documentation/realtime/reference/). It reads the protobuf
// wire format directly and keeps only what journey planning needs: which trips
// are canceled, which stops are skipped, and the delay or predicted time of each
// stop. Vehicle positions and service alerts are ignored.
//
// Field numbers follow gtfs-realtime.proto:
//   FeedMessage       header=1 entity=2
//   FeedHeader        version=1 incrementality=2 timestamp=3
//   FeedEntity        id=1 is_deleted=2 trip_update=3
//   TripUpdate        trip=1 stop_time_update=2 vehicle=3 timestamp=4 delay=5
//   TripDescriptor    trip_id=1 start_time=2 start_date=3 schedule_relationship=4
//   StopTimeUpdate    stop_sequence=1 arrival=2 departure=3 stop_id=4
//                     schedule_relationship=5
//   StopTimeEvent     delay=1 time=2 uncertainty=3

const TRIP_RELATIONSHIP = {
  0: "scheduled",
  1: "added",
  2: "unscheduled",
  3: "canceled",
  5: "replacement",
  6: "duplicated",
  7: "deleted",
};
const STOP_RELATIONSHIP = {
  0: "scheduled",
  1: "skipped",
  2: "no-data",
  3: "unscheduled",
};

const utf8 = new TextDecoder();

class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.position = start;
    this.end = end;
  }

  get done() {
    return this.position >= this.end;
  }

  // Varints carry up to 64 bits, and negative numbers are sign-extended to ten
  // bytes, so read them as BigInt and narrow afterwards.
  varint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.position >= this.end) throw new Error("Truncated protobuf");
      const byte = this.bytes[this.position++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
      if (shift > 70n) throw new Error("Invalid protobuf varint");
    }
  }

  /** The next field as `[number, wireType, value]`; length-delimited values are `[start, end]`. */
  field() {
    const tag = Number(this.varint());
    const number = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) return [number, wire, this.varint()];
    if (wire === 2) {
      const length = Number(this.varint());
      const start = this.position;
      this.position += length;
      if (this.position > this.end) throw new Error("Truncated protobuf");
      return [number, wire, [start, start + length]];
    }
    if (wire === 5 || wire === 1) {
      this.position += wire === 5 ? 4 : 8;
      return [number, wire, null];
    }
    throw new Error(`Unsupported protobuf wire type ${wire}`);
  }

  sub([start, end]) {
    return new Reader(this.bytes, start, end);
  }

  text([start, end]) {
    return utf8.decode(this.bytes.subarray(start, end));
  }
}

const int32 = (value) => Number(BigInt.asIntN(32, value));
const int64 = (value) => Number(BigInt.asIntN(64, value));

function stopTimeEvent(reader) {
  const event = {};
  while (!reader.done) {
    const [number, wire, value] = reader.field();
    if (wire !== 0) continue;
    if (number === 1) event.delay = int32(value);
    else if (number === 2) event.time = int64(value);
  }
  return event;
}

function stopTimeUpdate(reader) {
  const update = { relationship: "scheduled" };
  while (!reader.done) {
    const [number, wire, value] = reader.field();
    if (number === 1 && wire === 0) update.stopSequence = Number(value);
    else if (number === 2 && wire === 2)
      update.arrival = stopTimeEvent(reader.sub(value));
    else if (number === 3 && wire === 2)
      update.departure = stopTimeEvent(reader.sub(value));
    else if (number === 4 && wire === 2) update.stopId = reader.text(value);
    else if (number === 5 && wire === 0)
      update.relationship = STOP_RELATIONSHIP[Number(value)] ?? "scheduled";
  }
  return update;
}

function tripDescriptor(reader, update) {
  while (!reader.done) {
    const [number, wire, value] = reader.field();
    if (number === 1 && wire === 2) update.tripId = reader.text(value);
    else if (number === 2 && wire === 2) update.startTime = reader.text(value);
    else if (number === 3 && wire === 2) {
      // GTFS dates are YYYYMMDD, the same integer the connections carry.
      const date = Number(reader.text(value));
      if (Number.isInteger(date)) update.startDate = date;
    } else if (number === 4 && wire === 0)
      update.relationship = TRIP_RELATIONSHIP[Number(value)] ?? "scheduled";
  }
}

function tripUpdate(reader) {
  const update = { relationship: "scheduled", stops: [] };
  while (!reader.done) {
    const [number, wire, value] = reader.field();
    if (number === 1 && wire === 2) tripDescriptor(reader.sub(value), update);
    else if (number === 2 && wire === 2)
      update.stops.push(stopTimeUpdate(reader.sub(value)));
    else if (number === 4 && wire === 0) update.timestamp = int64(value);
    else if (number === 5 && wire === 0) update.delay = int32(value);
  }
  return update;
}

/**
 * Decode a GTFS Realtime `FeedMessage`. Resolves to
 * `{ timestamp, updates }`: the feed's own timestamp (UTC epoch seconds, when it
 * was produced) and one entry per trip update with `tripId`, `startDate`
 * (`YYYYMMDD` as a number), `startTime`, `relationship` (`scheduled`, `added`,
 * `canceled`, …), an optional trip-wide `delay` and `stops`: each `{ stopId,
 * stopSequence?, arrival?, departure?, relationship }` where an event is
 * `{ delay?, time? }` (seconds; `time` is UTC epoch seconds).
 */
export function decodeTripUpdates(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const root = new Reader(bytes);
  const feed = { timestamp: undefined, updates: [] };
  while (!root.done) {
    const [number, wire, value] = root.field();
    if (number === 1 && wire === 2) {
      const header = root.sub(value);
      while (!header.done) {
        const [headerNumber, headerWire, headerValue] = header.field();
        if (headerNumber === 3 && headerWire === 0)
          feed.timestamp = Number(headerValue);
      }
    } else if (number === 2 && wire === 2) {
      const entity = root.sub(value);
      let deleted = false;
      let update;
      while (!entity.done) {
        const [entityNumber, entityWire, entityValue] = entity.field();
        if (entityNumber === 2 && entityWire === 0)
          deleted = entityValue !== 0n;
        else if (entityNumber === 3 && entityWire === 2)
          update = tripUpdate(entity.sub(entityValue));
      }
      if (update && !deleted && update.tripId) feed.updates.push(update);
    }
  }
  return feed;
}
