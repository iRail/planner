import { lowerBound, timeAt } from "./planner-data.mjs";

// Both directions use departure-sorted files. The reverse index discovers
// incoming files using their conservative arrival-region summaries.
export function buildRegionIndex(network, sourcePages) {
  const forward = new Map();
  const backward = new Map();
  const stopRegions = new Array(network.stopCount);
  const add = (map, key, page) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(page);
  };
  for (const [source, pages] of sourcePages) {
    const regions = [...new Set(source.stops.regionIdx)];
    const key = (region) => `${source.id}/${region}`;
    for (let i = 0; i < source.stops.id.length; i += 1) {
      const root = network.root[source.stopOffset + i];
      const list = (stopRegions[root] ??= []);
      const region = key(source.stops.regionIdx[i]);
      if (!list.includes(region)) list.push(region);
    }
    for (const page of pages) {
      for (const region of page.region == null ? regions : [page.region]) {
        const job = { ...page, source, departureRegion: key(region) };
        add(forward, key(region), job);
        for (const arrival of page.arrivalRegions || regions)
          add(backward, key(arrival), job);
      }
    }
  }
  return { forward, backward, stopRegions };
}

class Heap {
  constructor(backward) {
    this.items = [];
    this.direction = backward ? -1 : 1;
    this.ordinal = 0;
  }
  before(a, b) {
    return (
      this.direction * (a.time - b.time) < 0 ||
      (a.time === b.time && a.ordinal < b.ordinal)
    );
  }
  push(item) {
    item.ordinal ??= this.ordinal++;
    let i = this.items.length;
    this.items.push(item);
    while (i) {
      const parent = (i - 1) >>> 1;
      if (!this.before(item, this.items[parent])) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (
          child + 1 < this.items.length &&
          this.before(this.items[child + 1], this.items[child])
        )
          child += 1;
        if (!this.before(this.items[child], last)) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
  get first() {
    return this.items[0];
  }
}

export function createRegionScan(
  index,
  from,
  to,
  backward,
  loadPage,
  onProgress,
  earliestRegions,
) {
  const heap = new Heap(backward);
  const regionBounds = new Map();
  const pages = new Map();
  const bounds = new Float64Array(index.stopRegions.length).fill(
    backward ? -Infinity : Infinity,
  );
  let scanned = 0;
  let matched = 0;
  let loadMs = 0;
  function activate(stop, time) {
    if (backward ? time <= bounds[stop] : time >= bounds[stop]) return;
    bounds[stop] = time;
    for (const region of index.stopRegions[stop] || []) {
      const previous =
        regionBounds.get(region) ?? (backward ? -Infinity : Infinity);
      if (backward ? time <= previous : time >= previous) continue;
      regionBounds.set(region, time);
      // Newly opened intervals are disjoint, even if another reachable stop
      // improves a region's bound after a cursor has already been created.
      const lo = backward
        ? Math.max(from, Math.floor(previous) + 1)
        : Math.max(from, time);
      const hi = backward
        ? Math.min(to, Math.floor(time) + 1)
        : Math.min(to, previous);
      if (lo >= hi) continue;
      for (const page of (backward ? index.backward : index.forward).get(
        region,
      ) || []) {
        const lower = Math.max(
          lo,
          earliestRegions?.get(page.departureRegion) ?? lo,
        );
        if (page.maxDepartureTime < lower || page.minDepartureTime >= hi)
          continue;
        heap.push({
          page,
          lo: lower,
          hi,
          time: backward
            ? Math.min(page.maxDepartureTime, Math.ceil(hi) - 1)
            : Math.max(page.minDepartureTime, lower),
        });
      }
    }
  }
  // An incoming page can appear under several arrival regions. Track its
  // covered intervals so overlapping activations never process a row twice.
  const covered = new Map();
  function uncovered(url, lo, hi) {
    const intervals = covered.get(url) || [];
    const gaps = [];
    let cursor = lo;
    for (const [a, b] of intervals) {
      if (b <= cursor) continue;
      if (a >= hi) break;
      if (a > cursor) gaps.push([cursor, Math.min(a, hi)]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < hi) gaps.push([cursor, hi]);
    intervals.push([lo, hi]);
    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of intervals) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push(range.slice());
    }
    covered.set(url, merged);
    return gaps;
  }
  async function expand(stopAt) {
    const jobs = [];
    const priority = heap.first.time;
    while (
      jobs.length < 4 &&
      heap.first?.page &&
      heap.first.time === priority &&
      (backward || heap.first.time < stopAt())
    )
      jobs.push(heap.pop());
    const started = performance.now();
    const outcomes = await Promise.allSettled(
      jobs.map(async (job) => {
        let batches = pages.get(job.page.url);
        if (!batches) {
          batches = loadPage(job.page);
          pages.set(job.page.url, batches);
        }
        return { ...job, batches: await batches };
      }),
    );
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure) throw failure.reason;
    const results = outcomes.map((outcome) => outcome.value);
    loadMs += performance.now() - started;
    for (const { page, batches, lo, hi } of results)
      for (const [start, end] of uncovered(page.url, lo, hi))
        for (const batch of batches) {
          const lower = lowerBound(batch, start);
          const upper = lowerBound(batch, end);
          if (lower >= upper) continue;
          const row = backward ? upper - 1 : lower;
          heap.push({
            batch,
            row,
            lo: lower,
            hi: upper,
            time: timeAt(batch, "dep", row),
          });
        }
    onProgress?.({ completed: pages.size, regions: regionBounds.size });
  }
  async function scan(
    visit,
    { stopAt = () => Infinity, accept = () => true } = {},
  ) {
    while (heap.first) {
      if (!backward && heap.first.time >= stopAt()) break;
      if (heap.first.page) {
        await expand(stopAt);
        continue;
      }
      const time = heap.first.time;
      const group = [];
      let changed;
      do {
        changed = false;
        // Activations during relaxation may add new pages at this timestamp.
        // Expand them before finalizing its fixed point.
        while (heap.first?.time === time) {
          if (heap.first.page) {
            await expand(() => time + 1);
            continue;
          }
          const cursor = heap.pop();
          scanned += 1;
          const accepted = accept(cursor.batch, cursor.row, time);
          const tied =
            !backward || timeAt(cursor.batch, "arr", cursor.row) === time;
          // Keep initially unreachable zero-duration rows: another row or
          // newly loaded page at this same timestamp may activate their stop.
          if (tied) group.push(cursor.batch, cursor.row, accepted);
          if (accepted) {
            matched += 1;
            if (!tied)
              changed = visit(cursor.batch, cursor.row, time) || changed;
          }
          cursor.row += backward ? -1 : 1;
          if (cursor.row >= cursor.lo && cursor.row < cursor.hi) {
            cursor.time = timeAt(cursor.batch, "dep", cursor.row);
            heap.push(cursor);
          }
        }
        for (let i = 0; i < group.length; i += 3) {
          const batch = group[i];
          const row = group[i + 1];
          if (!accept(batch, row, time)) continue;
          if (!group[i + 2]) {
            matched += 1;
            group[i + 2] = true;
          }
          changed = visit(batch, row, time) || changed;
        }
      } while ((group.length && changed) || heap.first?.time === time);
    }
    return {
      scanned,
      matched,
      pages: pages.size,
      regions: regionBounds.size,
      loadMs,
    };
  }
  return { activate, bounds, regionBounds, scan };
}
