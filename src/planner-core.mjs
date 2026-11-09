import { networkColor } from "./planner-identifiers.mjs";
import {
  readConnectionBatches,
  PageCache,
  timeAt,
  lowerBound,
} from "./planner-data.mjs";
import { buildNetwork, WALK_SPEED } from "./planner-network.mjs";
import { createProfileSearch } from "./planner-profile.mjs";
import { createIsochroneSearch } from "./planner-isochrone.mjs";
import { buildRegionIndex, createRegionScan } from "./planner-regional.mjs";
import { createEarliestSearch } from "./planner-earliest.mjs";
import { createJourneyEndpoints } from "./planner-endpoints.mjs";
import {
  loadLCTimetable,
  connectionPages,
  validateSchema,
} from "./lc-timetable.mjs";
import { buildStations, loadStationRows } from "./irail-stations.mjs";
import { buildHeadsigns, loadHeadsignRows } from "./irail-headsigns.mjs";
import { decodeTripUpdates } from "./gtfs-rt.mjs";
import {
  applyRealtimeToBatches,
  buildRealtime,
  realtimeFeeds,
  stopStatus,
} from "./realtime.mjs";

export function createPlanner(
  { tableFromIPC, RecordBatchReader },
  { loadPage, cacheBytes, fetch: fetcher = globalThis.fetch } = {},
) {
  const cache = new PageCache(cacheBytes);
  // GTFS Realtime overlays by source id. The cache keeps scheduled pages; the
  // overlay is applied on the way out and its results are kept until the next
  // feed update.
  const realtime = new Map();
  const overlaid = new Map();
  let previousNetwork;
  let previousSources;
  let previousWalk;
  async function fetchResponse(url) {
    const response = await fetcher(url);
    if (!response.ok)
      throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
    return response;
  }

  async function loadSmallTable(url, expected) {
    const response = await fetchResponse(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (String.fromCharCode(...bytes.subarray(0, 6)) !== "ARROW1")
      throw new Error(`Expected an Arrow IPC file: ${url}`);
    const table = tableFromIPC(bytes);
    if (expected)
      validateSchema(table.schema, expected.dataset, expected.releaseId);
    return table;
  }

  // A direct manifest URL or a directory containing manifest.jsonld. An
  // optional sources.json remains an application-level multi-feed index.
  async function discoverSources(dataUrl) {
    const url = new URL(dataUrl);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("The data URL must use HTTP or HTTPS");
    if (!url.pathname.endsWith("/"))
      return [{ id: "default", name: "Timetable", manifestUrl: url.href }];
    const response = await fetcher(new URL("sources.json", url).href);
    if (response.ok) {
      const data = await response.json();
      return data.sources.map((source) => ({
        id: source.id,
        name: source.name || source.id,
        color: source.color,
        manifestUrl: new URL(source.manifest, response.url || url).href,
      }));
    }
    if (response.status !== 404)
      throw new Error(`Could not discover sources: HTTP ${response.status}`);
    return [
      {
        id: "default",
        name: "Timetable",
        manifestUrl: new URL("manifest.jsonld", url).href,
      },
    ];
  }

  async function loadSource(descriptor) {
    const response = await fetchResponse(descriptor.manifestUrl);
    const manifest = await response.json();
    const source = await loadLCTimetable(
      manifest,
      response.url || descriptor.manifestUrl,
      loadSmallTable,
    );
    return {
      ...source,
      id: descriptor.id,
      name: manifest.name || descriptor.name,
      color: networkColor(descriptor.id, manifest.color || descriptor.color),
    };
  }

  async function readPage(job) {
    const request = {
      url: job.url,
      epochSeconds: job.epochSeconds,
      releaseId: job.source.manifest.releaseId,
      allowNotFound: job.allowNotFound,
      region: job.region,
      from: -Infinity,
      to: Infinity,
    };
    const cacheKey = (url) =>
      JSON.stringify([
        job.source.manifest.releaseId,
        url,
        request.epochSeconds,
        request.from,
        request.to,
      ]);
    const key = cacheKey(request.url);
    let batches = cache.get(key);
    if (!batches) {
      batches = await (loadPage
        ? loadPage(request)
        : readConnectionBatches(RecordBatchReader, request, fetcher));
      cache.set(key, batches);
      if (batches.page?.url && batches.page.url !== request.url)
        cache.set(cacheKey(batches.page.url), batches);
    }
    const overlay = realtime.get(job.source.id);
    if (overlay) {
      const overlayKey = `${key}\n${job.keepCanceled ? 1 : 0}`;
      if (!overlaid.has(overlayKey))
        overlaid.set(
          overlayKey,
          applyRealtimeToBatches(batches, overlay, {
            keepCanceled: job.keepCanceled,
          }),
        );
      batches = overlaid.get(overlayKey);
    }
    return Object.assign(
      batches.map((batch) => ({ ...batch, source: job.source })),
      { page: batches.page },
    );
  }

  /**
   * Fetch the GTFS Realtime feeds the sources' manifests advertise and apply
   * them to every later search. Resolves to one status per source:
   * `{ sourceId, supported, timestamp, changed, ... }`. `changed` is false
   * when the feed has not been regenerated since the last call. A failing feed
   * rejects and leaves the previous overlay in place.
   */
  async function refreshRealtime(sources) {
    const statuses = [];
    for (const source of sources) {
      const feeds = realtimeFeeds(source.manifest, source.manifestUrl);
      if (!feeds.length) {
        statuses.push({ sourceId: source.id, supported: false, changed: false });
        continue;
      }
      const decoded = await Promise.all(
        feeds.map(async (feed) => {
          const response = await fetchResponse(feed.url);
          return {
            feed,
            decoded: decodeTripUpdates(await response.arrayBuffer()),
          };
        }),
      );
      const next = buildRealtime(source, decoded);
      const previous = realtime.get(source.id);
      const changed = !previous || previous.timestamp !== next.timestamp;
      if (changed) {
        realtime.set(source.id, next);
        source.realtimeMargin = next.margin;
        overlaid.clear();
      }
      statuses.push({
        sourceId: source.id,
        supported: true,
        changed,
        timestamp: (changed ? next : previous).timestamp,
        ...(changed ? next : previous).stats,
      });
    }
    return statuses;
  }

  /** Forget all real-time data, for example when sources are loaded again. */
  function resetRealtime() {
    realtime.clear();
    overlaid.clear();
  }

  /** Whether any source's feed cancels a trip or skips a stop right now. */
  function hasDisruptions(sources) {
    return sources.some((source) => {
      const stats = realtime.get(source.id)?.stats;
      return Boolean(stats && stats.canceled + stats.skipping > 0);
    });
  }

  /** The overlay's view of one stop of a trip: `{ delay, platform, canceled }` or null. */
  function realtimeStop(source, trip, serviceDate, stopIdx, kind) {
    return stopStatus(realtime.get(source.id), trip, serviceDate, stopIdx, kind);
  }

  function ensureNetwork(sources, maxWalkMeters) {
    if (
      !previousNetwork ||
      previousWalk !== maxWalkMeters ||
      sources.length !== previousSources.length ||
      sources.some((s, i) => s !== previousSources[i])
    ) {
      previousNetwork = buildNetwork(sources, maxWalkMeters);
      previousSources = sources.slice();
      previousWalk = maxWalkMeters;
    }
    return previousNetwork;
  }

  async function planJourneys({
    sources,
    origin,
    destination,
    departureAfter,
    maxWalkMeters,
    onProgress,
    windowMode = "adaptive",
    includeCanceled = false,
    arrivalBefore,
  }) {
    if (
      !Number.isFinite(departureAfter) ||
      !Number.isFinite(maxWalkMeters) ||
      maxWalkMeters < 0 ||
      maxWalkMeters > 5000
    )
      throw new Error("Invalid departure time or walking limit (0–5000 m)");
    if (windowMode !== "adaptive" && windowMode !== "full")
      throw new Error("Unknown journey window mode");
    // Arriving by a moment: the window is [departureAfter, arrivalBefore] and
    // is scanned backward from the deadline, so no earliest-arrival pass is
    // needed to size it.
    const arriveBy = arrivalBefore !== undefined;
    if (arriveBy) {
      if (!Number.isFinite(arrivalBefore) || arrivalBefore <= departureAfter)
        throw new Error("Invalid arrival time: it must be after the window start");
      windowMode = "full";
    }
    const maximum = arriveBy ? arrivalBefore : departureAfter + 86400;
    let to = maximum;
    // Canceled trips and skipped stops stay usable in this search, so journeys
    // that depend on them can be found (and flagged by the caller).
    const read = includeCanceled
      ? (job, ...rest) => readPage({ ...job, keepCanceled: true }, ...rest)
      : readPage;
    const network = ensureNetwork(sources, maxWalkMeters);
    const endpoints = createJourneyEndpoints(
      network,
      origin,
      destination,
      maxWalkMeters,
    );
    const fromStop = endpoints.origin;
    const toStop = endpoints.destination;
    if (endpoints.same)
      return {
        found: true,
        options: [
          {
            departure: departureAfter,
            arrival: departureAfter,
            transfers: 0,
            legs: [],
          },
        ],
        totalOptions: 1,
        scanned: 0,
        window: {
          mode: arriveBy ? "arrive-by" : windowMode,
          from: departureAfter,
          to: windowMode === "full" ? maximum : departureAfter + 1,
          earliestArrival: windowMode === "full" ? null : departureAfter,
        },
        diagnostics: {
          pages: 0,
          cacheBytes: cache.bytes,
          forwardMs: 0,
          backwardMs: 0,
        },
      };
    onProgress?.({ phase: "loading", completed: 0, total: 0 });
    network.regionIndex = buildRegionIndex(
      network,
      await Promise.all(
        network.sources.map(async (source) => [
          source,
          await connectionPages(source, departureAfter, maximum, read),
        ]),
      ),
    );
    // Keep query-owned page views across both passes even if the LRU evicts
    // them. Indexed pages have the same cache key regardless of the horizon.
    const queryPages = new Map();
    const load = (job) => {
      if (!queryPages.has(job.url))
        queryPages.set(job.url, read(job, departureAfter, maximum));
      return queryPages.get(job.url);
    };
    let forward = { scanned: 0, pages: 0, regions: 0, loadMs: 0 };
    let earliestArrival;
    let earliestStops;
    let earliestRegions;
    const forwardStart = performance.now();
    if (windowMode === "adaptive") {
      onProgress?.({ phase: "earliest" });
      const scan = createRegionScan(
        network.regionIndex,
        departureAfter,
        maximum,
        false,
        load,
        (progress) => onProgress?.({ phase: "earliest", ...progress }),
      );
      const search = createEarliestSearch(
        network,
        fromStop,
        toStop,
        departureAfter,
        maximum,
        scan.activate,
        endpoints,
      );
      forward = await scan.scan(search.visit, { stopAt: () => search.arrival });
      earliestArrival = search.arrival;
      if (!Number.isFinite(earliestArrival))
        return {
          found: false,
          options: [],
          totalOptions: 0,
          scanned: forward.scanned,
          window: {
            mode: arriveBy ? "arrive-by" : windowMode,
            from: departureAfter,
            to: maximum,
            earliestArrival: null,
          },
          diagnostics: {
            forward,
            pages: queryPages.size,
            cacheBytes: cache.bytes,
            forwardMs: performance.now() - forwardStart,
            backwardMs: 0,
          },
        };
      // One second keeps departures at `from` available for zero-duration
      // rides; positive-duration journeys use exactly twice elapsed time.
      to = Math.min(
        maximum,
        departureAfter + Math.max(1, 2 * (earliestArrival - departureAfter)),
      );
      // The forward pass certifies reachability only before its earliest
      // destination arrival. Cap provisional/unreached bounds at that time:
      // later alternatives may legitimately enter previously unseen regions.
      earliestStops = Float64Array.from(scan.bounds, (time) =>
        Math.min(time, earliestArrival),
      );
      earliestRegions = new Map(
        [...network.regionIndex.forward.keys()].map((region) => [
          region,
          Math.min(scan.regionBounds.get(region) ?? Infinity, earliestArrival),
        ]),
      );
    }
    const forwardMs = performance.now() - forwardStart;
    onProgress?.({ phase: "scanning" });
    const backwardStart = performance.now();
    const scan = createRegionScan(
      network.regionIndex,
      departureAfter,
      to,
      true,
      load,
      (progress) => onProgress?.({ phase: "scanning", ...progress }),
      earliestRegions,
    );
    const walkedLatest = new Float64Array(network.stopCount).fill(-Infinity);
    function reach(stop, latest, canWalk) {
      scan.activate(stop, latest);
      // A root's earlier profiles cannot extend any walking activation.
      // Track boardable bounds separately from through-ride bounds.
      if (!canWalk || latest <= walkedLatest[stop]) return;
      walkedLatest[stop] = latest;
      const neighbors = network.neighbors(stop);
      for (let i = 0; i < neighbors.stops.length; i += 1)
        scan.activate(
          neighbors.stops[i],
          latest - neighbors.meters[i] / WALK_SPEED,
        );
    }
    // Walking egress is one leg. Subsequent walking expansions start only
    // at boardable ride profiles, so walks cannot chain across regions.
    for (const [stop, meters] of endpoints.egress)
      scan.activate(stop, to - meters / WALK_SPEED);
    const seenEdges = new Set();
    let edges = [];
    let lastFlush = performance.now();
    function flushEdges() {
      if (!edges.length) return;
      onProgress?.({ phase: "profiles", edges });
      edges = [];
      lastFlush = performance.now();
    }
    function onConnection(board, alight, kind) {
      if (!onProgress || board === alight) return;
      const key = `${board}/${alight}/${kind}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      const start = endpoints.coordinates(board);
      const end = endpoints.coordinates(alight);
      if (!start || !end) return;
      edges.push({
        from: [start.lon, start.lat],
        to: [end.lon, end.lat],
        kind: kind === 1 ? "walk" : "ride",
      });
      if (edges.length >= 256 || performance.now() - lastFlush >= 40)
        flushEdges();
    }
    const search = createProfileSearch(
      network,
      fromStop,
      toStop,
      departureAfter,
      to,
      reach,
      { ...endpoints, onConnection },
    );
    const backward = await scan.scan(search.visit, {
      accept: (batch, row, dep) =>
        (earliestStops === undefined ||
          dep >=
            earliestStops[
              network.root[batch.source.stopOffset + batch.dS[row]]
            ]) &&
        timeAt(batch, "arr", row) <=
          scan.bounds[network.root[batch.source.stopOffset + batch.aS[row]]],
    });
    const result = search.finish(backward.scanned, { latest: arriveBy });
    flushEdges();
    result.scanned += forward.scanned;
    result.window = {
      mode: arriveBy ? "arrive-by" : windowMode,
      from: departureAfter,
      to,
      earliestArrival: earliestArrival ?? null,
    };
    result.diagnostics.forward = forward;
    result.diagnostics.backward = backward;
    result.diagnostics.forwardMs = forwardMs;
    result.diagnostics.backwardMs = performance.now() - backwardStart;
    result.diagnostics.cacheBytes = cache.bytes;
    result.diagnostics.pages = queryPages.size;
    return result;
  }

  /**
   * One-to-many earliest arrival from an arbitrary clicked point, not a
   * stop: how much of the selected networks is reachable within
   * `maxDurationSeconds`, for isochrone rendering. Walking access to the
   * origin uses the same `maxWalkMeters` setting as journey planning.
   */
  async function planIsochrone({
    sources,
    origin,
    departureAfter,
    maxWalkMeters,
    maxDurationSeconds,
    onProgress,
  }) {
    if (
      !Number.isFinite(departureAfter) ||
      !Number.isFinite(maxWalkMeters) ||
      maxWalkMeters < 0 ||
      maxWalkMeters > 5000
    )
      throw new Error("Invalid departure time or walking limit (0–5000 m)");
    if (
      !Number.isFinite(maxDurationSeconds) ||
      maxDurationSeconds < 60 ||
      maxDurationSeconds > 3 * 3600
    )
      throw new Error("Invalid isochrone duration (1–180 minutes)");
    const to = departureAfter + maxDurationSeconds;
    const network = ensureNetwork(sources, maxWalkMeters);
    network.regionIndex = buildRegionIndex(
      network,
      await Promise.all(
        network.sources.map(async (source) => [
          source,
          await connectionPages(source, departureAfter, to, readPage),
        ]),
      ),
    );
    const scan = createRegionScan(
      network.regionIndex,
      departureAfter,
      to,
      false,
      (job) => readPage(job, departureAfter, to),
      onProgress,
    );
    const search = createIsochroneSearch(
      network,
      origin,
      departureAfter,
      to,
      maxWalkMeters,
      scan.activate,
    );
    onProgress?.({ phase: "scanning" });
    const stats = await scan.scan(search.visit);
    const result = search.finish(stats.scanned);
    result.pages = stats.pages;
    result.diagnostics = stats;
    return result;
  }

  /**
   * Visit every connection of one source that departs in [from, to), in page
   * order (departure order within a page). `visit(batch, row)` reads columns
   * from the batch: `batch.dep[row]` is an offset from `batch.epoch`, so use
   * `timeAt(batch, "dep", row)` for absolute seconds. Pages come from the same
   * cache the journey planner uses.
   */
  async function scanConnections(source, from, to, visit) {
    const pages = await connectionPages(source, from, to, readPage);
    const jobs = [];
    const seen = new Set();
    for (const job of pages) {
      if (job.maxDepartureTime < from || job.minDepartureTime >= to) continue;
      const key = `${job.url}\n${job.region ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
    }
    const loaded = await Promise.all(
      jobs.map((job) => readPage({ ...job, keepCanceled: true })),
    );
    let scanned = 0;
    for (const batches of loaded)
      for (const batch of batches) {
        const hi = lowerBound(batch, to);
        for (let row = lowerBound(batch, from); row < hi; row += 1) {
          scanned += 1;
          visit(batch, row);
        }
      }
    return { scanned, pages: jobs.length };
  }

  // iRail extension data (translations, traffic figures) is loaded on first
  // use. Without it, stations fall back to the timetable's own stop labels.
  const directories = new WeakMap();
  function stationDirectory(source) {
    if (!directories.has(source))
      directories.set(
        source,
        (async () => {
          const rows = await loadStationRows(source.manifestUrl, {
            fetch: fetcher,
            tableFromIPC,
            manifest: source.manifest,
          }).catch(() => null);
          const stations = buildStations({
            rows: rows ?? [],
            ids: source.stops.iri,
            names: source.stops.name,
            searchable: source.stopFamily.searchable,
            lat: source.stops.lat,
            lon: source.stops.lon,
          });
          stations.hasTranslations = rows !== null;
          return stations;
        })(),
      );
    return directories.get(source);
  }

  // The translations of the headsigns, loaded the same way; without them a
  // headsign stays as the timetable published it.
  const headsignTranslations = new WeakMap();
  function headsignDirectory(source) {
    if (!headsignTranslations.has(source))
      headsignTranslations.set(
        source,
        loadHeadsignRows(source.manifestUrl, {
          fetch: fetcher,
          tableFromIPC,
          manifest: source.manifest,
        })
          .catch(() => null)
          .then((rows) => buildHeadsigns(rows ?? [])),
      );
    return headsignTranslations.get(source);
  }

  return {
    discoverSources,
    loadSource,
    loadSmallTable,
    planJourneys,
    planIsochrone,
    scanConnections,
    stationDirectory,
    headsignDirectory,
    refreshRealtime,
    resetRealtime,
    realtimeStop,
    hasDisruptions,
  };
}
