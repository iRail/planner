import { validateSchema } from "./lc-timetable.mjs";

export function timeAt(batch, field, row) {
  return batch.epoch + Number(batch[field][row]);
}

export function lowerBound(batch, time) {
  let lo = 0;
  let hi = batch.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeAt(batch, "dep", mid) < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Numeric toArray() on each single-batch vector gives a buffer view.
export async function readConnectionBatches(
  RecordBatchReader,
  { url, epochSeconds, from, to, releaseId, allowNotFound, region },
  fetcher = globalThis.fetch,
) {
  const response = await fetcher(url);
  if (response.status === 404 && allowNotFound)
    return Object.assign([], { page: { notFound: true } });
  if (!response.ok)
    throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  const input = new Uint8Array(await response.arrayBuffer());
  if (String.fromCharCode(...input.subarray(0, 6)) !== "ARROW1")
    throw new Error(`Expected an Arrow IPC file: ${url}`);
  const reader = await RecordBatchReader.from(input);
  await reader.open();
  validateSchema(reader.schema, "connections", releaseId);
  const metadata = reader.schema.metadata;
  if (
    region != null &&
    region !== "unpartitioned" &&
    metadata.get("region") !== region
  )
    throw new Error(`Missing or inconsistent page region: ${url}`);
  const metadataEpoch = Number(metadata.get("epochSeconds"));
  const epoch = epochSeconds ?? metadataEpoch;
  if (
    !Number.isSafeInteger(epoch) ||
    !metadata.has("epochSeconds") ||
    epoch !== metadataEpoch
  )
    throw new Error(`Missing or inconsistent page epoch: ${url}`);
  const batches = [];
  batches.page = {
    url: response.url || url,
    next: metadata.get("next"),
    previous: metadata.get("previous"),
    region: metadata.get("region"),
    minDepartureTime: Infinity,
    maxDepartureTime: -Infinity,
  };
  let previousDeparture = -Infinity;
  for await (const batch of reader) {
    if (!batch.numRows) continue;
    const view = {
      epoch,
      dep: batch.getChild("departureTimeOffset").toArray(),
      arr: batch.getChild("arrivalTimeOffset").toArray(),
      dS: batch.getChild("departureStopIdx").toArray(),
      aS: batch.getChild("arrivalStopIdx").toArray(),
      trip: batch.getChild("tripIdx").toArray(),
      serviceDate: batch.getChild("serviceDate")?.toArray(),
      stopSequence: batch.getChild("stopSequence")?.toArray(),
      arrivalStopSequence: batch.getChild("arrivalStopSequence").toArray(),
      iri: Array.from(batch.getChild("iri")),
      pickup: batch.getChild("pickupType")?.toArray(),
      dropOff: batch.getChild("dropOffType")?.toArray(),
      length: batch.numRows,
    };
    for (let row = 0; row < view.length; row += 1) {
      if (
        view.dep[row] < previousDeparture ||
        view.arr[row] < view.dep[row] ||
        view.arrivalStopSequence[row] <= view.stopSequence[row]
      )
        throw new Error(`Invalid or unsorted connection: ${url}`);
      previousDeparture = view.dep[row];
    }
    batches.page.minDepartureTime = Math.min(
      batches.page.minDepartureTime,
      timeAt(view, "dep", 0),
    );
    batches.page.maxDepartureTime = timeAt(view, "dep", view.length - 1);
    if (
      timeAt(view, "dep", 0) < to &&
      timeAt(view, "dep", view.length - 1) >= from
    )
      batches.push(view);
  }
  return batches;
}

export function buffersOf(batches) {
  const buffers = new Set();
  for (const batch of batches)
    for (const value of Object.values(batch)) {
      if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
    }
  return [...buffers];
}

// Forward counterpart of scanBackward: connections in non-decreasing
// departure order, for a one-to-many earliest-arrival scan (isochrones)
// rather than a one-to-one backward profile. Same equal-departure fixpoint
// discipline, since a zero-duration connection can enable another
// connection departing at that same instant.
export function scanForward(batches, from, to, visit) {
  const heap = [];
  const less = (a, b) =>
    a.time < b.time || (a.time === b.time && a.ordinal < b.ordinal);
  const push = (cursor) => {
    let i = heap.length;
    heap.push(cursor);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (!less(cursor, heap[parent])) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = cursor;
  };
  const pop = () => {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && less(heap[child + 1], heap[child]))
          child += 1;
        if (!less(heap[child], last)) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  for (let ordinal = 0; ordinal < batches.length; ordinal += 1) {
    const batch = batches[ordinal];
    const lo = lowerBound(batch, from);
    const hi = lowerBound(batch, to);
    if (lo < hi)
      push({ batch, row: lo, hi, ordinal, time: timeAt(batch, "dep", lo) });
  }
  let scanned = 0;
  while (heap.length) {
    const time = heap[0].time;
    const group = [];
    while (heap.length && heap[0].time === time) {
      const cursor = pop();
      scanned += 1;
      group.push(cursor.ordinal, cursor.row);
      cursor.row += 1;
      if (cursor.row < cursor.hi) {
        cursor.time = timeAt(cursor.batch, "dep", cursor.row);
        push(cursor);
      }
    }
    let changed;
    do {
      changed = false;
      for (let i = 0; i < group.length; i += 2) {
        changed = visit(batches[group[i]], group[i + 1], time) || changed;
      }
    } while (changed);
  }
  return scanned;
}

export class PageCache {
  constructor(budget = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(budget) || budget < 0)
      throw new Error("cacheBytes must be a nonnegative safe integer");
    this.budget = budget;
    this.bytes = 0;
    this.entries = new Map();
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.batches;
  }
  set(key, batches) {
    const bytes =
      buffersOf(batches).reduce((sum, b) => sum + b.byteLength, 0) +
      batches.reduce(
        (sum, batch) =>
          sum +
          (batch.iri?.reduce((size, iri) => size + 8 + iri.length * 2, 0) ?? 0),
        0,
      );
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    if (bytes > this.budget) return;
    while (this.bytes + bytes > this.budget) {
      const oldest = this.entries.keys().next().value;
      this.bytes -= this.entries.get(oldest).bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { batches, bytes });
    this.bytes += bytes;
  }
}

// One mutable cursor per batch. No combined row array or per-connection object.
export function scanBackward(batches, from, to, visit) {
  const heap = [];
  const greater = (a, b) =>
    a.time > b.time || (a.time === b.time && a.ordinal > b.ordinal);
  const push = (cursor) => {
    let i = heap.length;
    heap.push(cursor);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (!greater(cursor, heap[parent])) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = cursor;
  };
  const pop = () => {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && greater(heap[child + 1], heap[child]))
          child += 1;
        if (!greater(heap[child], last)) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  for (let ordinal = 0; ordinal < batches.length; ordinal += 1) {
    const batch = batches[ordinal];
    const lo = lowerBound(batch, from);
    const row = lowerBound(batch, to) - 1;
    if (row >= lo)
      push({ batch, row, lo, ordinal, time: timeAt(batch, "dep", row) });
  }
  let scanned = 0;
  while (heap.length) {
    // Equal-time connections can contain zero-duration chains. Retain only
    // numeric batch/row indices for this timestamp and relax to a fixed point.
    const time = heap[0].time;
    const group = [];
    while (heap.length && heap[0].time === time) {
      const cursor = pop();
      scanned += 1;
      if (timeAt(cursor.batch, "arr", cursor.row) === time)
        group.push(cursor.ordinal, cursor.row);
      else visit(cursor.batch, cursor.row, time);
      cursor.row -= 1;
      if (cursor.row >= cursor.lo) {
        cursor.time = timeAt(cursor.batch, "dep", cursor.row);
        push(cursor);
      }
    }
    let changed;
    do {
      changed = false;
      for (let i = 0; i < group.length; i += 2) {
        changed = visit(batches[group[i]], group[i + 1], time) || changed;
      }
    } while (changed);
  }
  return scanned;
}
