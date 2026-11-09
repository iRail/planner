import { createIrailApi, vehicleOf, vehicleView } from "./irail-api.mjs";
import { IrailApiError } from "./irail-errors.mjs";
import { normalizeLanguage } from "./irail-stations.mjs";

const IRAIL_CALLS = new Set(["stations", "liveboard", "connections", "vehicle"]);
const FILL_HORIZON = 2 * 86400; // how far past the request to look for more options
const FILL_ROUNDS = 8;
const ARRIVE_STEP = 3 * 3600; // how far before the deadline an arrive-by search first looks

export function createPlannerService(planner) {
  let sources = [];
  const irail = createIrailApi(planner);

  // The headsign of a leg, in the reader's language when there is one (and then
  // the texts in every language, so a page can switch without planning again).
  function headsignsOf(headsigns, source, text) {
    const directory = headsigns?.directories.get(source);
    if (!directory) return { headsign: text };
    return {
      headsign: directory.translate(text, headsigns.language),
      headsigns: directory.all(text),
    };
  }

  // Route and stop identifiers, real-time delays and platforms on every ride
  // leg, and whether the leg can be used: a ride is canceled when its trip is,
  // and either end is when the stop is skipped. Times are already real-time
  // adjusted; the delays say by how much.
  function label(result, selected, headsigns) {
    for (const option of result.options) {
      for (const leg of option.legs) {
        if (leg.kind !== "ride") continue;
        const source = selected.find((source) => source.id === leg.sourceId);
        const trip = source.tables.trips.get(leg.trip);
        const route = source.tables.routes.get(trip.routeIdx);
        const board = planner.realtimeStop?.(
          source,
          leg.trip,
          leg.serviceDate,
          leg.boardStop,
          "dep",
        );
        const alight = planner.realtimeStop?.(
          source,
          leg.trip,
          leg.serviceDate,
          leg.alightStop,
          "arr",
        );
        Object.assign(leg, {
          boardDelay: board?.delay ?? 0,
          alightDelay: alight?.delay ?? 0,
          boardPlatform: board?.platform ?? null,
          alightPlatform: alight?.platform ?? null,
          boardCanceled: board?.canceled ?? false,
          alightCanceled: alight?.canceled ?? false,
          canceled: Boolean(board?.canceled || alight?.canceled),
          routeName: route.shortName || route.longName || "",
          routeType: route.routeType,
          ...headsignsOf(headsigns, source, trip.headsign || ""),
          vehicle: vehicleView(vehicleOf(source, leg.trip)),
          tripIri: trip.iri,
          routeIri: route.iri,
          boardStopIri: source.stops.iri[leg.boardStop],
          alightStopIri: source.stops.iri[leg.alightStop],
        });
      }
      option.canceled = option.legs.some((leg) => leg.canceled);
    }
    return result;
  }

  // Journeys with route and stop identifiers resolved. With `minOptions`, a
  // search that found fewer alternatives continues after the last departure
  // until enough are found or nothing more departs within two days.
  //
  // Journeys that cannot be traveled because a train is canceled (or skips the
  // stop they need) are returned too, unless `includeCanceled` is false: each
  // flagged `canceled: true`, among the others by departure time. They never
  // count toward `minOptions` or `found`, and never push a possible journey out.
  async function planLabeled(payload, selected, onProgress) {
    const {
      minOptions = 0,
      includeCanceled = true,
      arrivalBefore,
      language,
      ...query
    } = payload;
    // Headsigns in the reader's language; as the timetable published them without.
    let headsigns;
    if (language !== undefined && language !== "") {
      const lang = normalizeLanguage(language);
      if (!lang) throw new Error("language must be one of nl, fr, en, de");
      const directories = new Map(
        await Promise.all(
          selected.map(async (source) => [
            source,
            await planner.headsignDirectory?.(source),
          ]),
        ),
      );
      headsigns = { language: lang, directories };
    }
    const arriveBy = arrivalBefore !== undefined;
    if (arriveBy && query.departureAfter !== undefined)
      throw new Error("Give departureAfter or arrivalBefore, not both");
    const search = (departureAfter, extra) =>
      planner.planJourneys({
        ...query,
        departureAfter,
        sources: selected,
        onProgress,
        ...extra,
      });
    // Journeys that arrive by `latest` and leave within `lookback` before it.
    const searchBack = (latest, lookback, extra) =>
      search(latest - lookback, { arrivalBefore: latest, ...extra });
    const merge = (first, second) => ({
      ...first,
      options: [...first.options, ...second.options],
      totalOptions: first.totalOptions + second.totalOptions,
      scanned: first.scanned + second.scanned,
      window: {
        ...first.window,
        from: Math.min(first.window.from, second.window.from),
        to: Math.max(first.window.to, second.window.to),
      },
    });
    let result;
    let extended = false; // a forward search that went on past its first window
    let reachedBack = 0; // how far before the deadline the search looked
    if (arriveBy) {
      let lookback = ARRIVE_STEP;
      result = await searchBack(arrivalBefore, lookback);
      // Nothing in the window: look further back, up to two days.
      while (!result.found && lookback < FILL_HORIZON) {
        lookback = Math.min(lookback * 2, FILL_HORIZON);
        result = await searchBack(arrivalBefore, lookback);
      }
      reachedBack = lookback;
      // Fewer than asked for: journeys that arrive before the earliest found,
      // which can only leave earlier than it (or the earliest would not be best).
      for (
        let round = 0;
        round < FILL_ROUNDS &&
        result.found &&
        result.options.length < minOptions;
        round += 1
      ) {
        const latest = result.options[0].arrival - 1;
        let step = ARRIVE_STEP;
        let next = await searchBack(latest, step);
        while (!next.options.length && step < FILL_HORIZON) {
          step = Math.min(step * 2, FILL_HORIZON);
          next = await searchBack(latest, step);
        }
        if (!next.options.length || arrivalBefore - latest >= FILL_HORIZON)
          break;
        reachedBack = arrivalBefore - (latest - step);
        result = merge(next, result);
      }
      // The number asked for: those closest to the deadline.
      if (result.options.length > minOptions && minOptions > 0)
        result = { ...result, options: result.options.slice(-minOptions) };
    } else {
      result = await search(query.departureAfter);
      for (
        let round = 0;
        round < FILL_ROUNDS &&
        result.found &&
        result.options.length < minOptions;
        round += 1
      ) {
        const cursor = result.options.at(-1).departure + 1;
        if (cursor >= query.departureAfter + FILL_HORIZON) break;
        const next = await search(cursor);
        if (!next.options.length) break;
        extended = true;
        result = merge(result, next);
      }
      // A search that had to continue returns the number asked for, not a few more.
      if (result.options.length > minOptions && minOptions > 0 && extended)
        result = { ...result, options: result.options.slice(0, minOptions) };
    }
    onProgress?.({ phase: "labels" });
    label(result, selected, headsigns);
    result.canceledOptions = 0;
    if (includeCanceled && planner.hasDisruptions?.(selected)) {
      // The same search with canceled trains left in. Only what depends on them
      // is new; it is shown as far as the possible journeys reach.
      const extra = { includeCanceled: true, onProgress: undefined };
      let withCanceled;
      let within;
      if (arriveBy) {
        const lower = result.options[0]?.departure ?? arrivalBefore - reachedBack;
        withCanceled = await search(lower, { arrivalBefore, ...extra });
        within = (option) => option.departure >= lower;
      } else {
        withCanceled = await search(query.departureAfter, extra);
        const reach = result.options.at(-1)?.departure ?? Infinity;
        within = (option) => option.departure <= reach;
      }
      label(withCanceled, selected, headsigns);
      const impossible = withCanceled.options.filter(
        (option) => option.canceled && within(option),
      );
      result.options = [...result.options, ...impossible].sort(
        (a, b) => a.departure - b.departure || a.arrival - b.arrival,
      );
      result.canceledOptions = impossible.length;
    }
    return result;
  }

  return async function handle(type, payload, onProgress) {
    if (type === "init") {
      const descriptors = await planner.discoverSources(payload?.dataUrl);
      const results = await Promise.allSettled(
        descriptors.map(planner.loadSource),
      );
      for (const r of results) if (r.status === "rejected") throw r.reason;
      const loaded = results.map((r) => r.value);
      if (!loaded.length) throw new Error("No source could be loaded");
      if (new Set(loaded.map((source) => source.id)).size !== loaded.length)
        throw new Error("Source IDs must be unique");
      sources = loaded;
      // Real-time data is on unless asked otherwise, and never blocks a start.
      planner.resetRealtime?.();
      if (payload?.realtime !== false)
        await planner.refreshRealtime?.(sources).catch(() => {});
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        color: source.color,
        manifest: {
          counts: source.manifest.counts,
          schemaVersion: source.manifest.schemaVersion,
          releaseId: source.manifest.releaseId,
          coverageStart: source.manifest.coverageStart,
          coverageEnd: source.manifest.coverageEnd,
          timeZone: source.manifest.timeZone,
        },
        stops: {
          id: source.stops.id,
          name: source.stops.name,
          lat: source.stops.lat,
          lon: source.stops.lon,
        },
        stopFamily: { searchable: source.stopFamily.searchable },
      }));
    }
    if (type === "realtime") {
      if (!sources.length)
        throw new Error("Initialize the planner before querying");
      return planner.refreshRealtime(sources);
    }
    if (IRAIL_CALLS.has(type)) {
      if (!sources.length)
        throw new IrailApiError(400, "Initialize the planner before querying");
      return irail[type](
        sources,
        payload ?? {},
        payload?.now ?? Date.now() / 1000,
        planLabeled,
      );
    }
    if (type !== "plan" && type !== "isochrone")
      throw new Error(`Unknown planner request: ${type}`);
    if (!sources.length)
      throw new Error("Initialize the planner before querying");
    const active = new Set(payload.sourceIds || sources.map((s) => s.id));
    const selected = sources.filter((s) => active.has(s.id));
    if (!selected.length || selected.length !== active.size)
      throw new Error("Select at least one known source");
    if (type === "isochrone") {
      const result = await planner.planIsochrone({
        ...payload,
        sources: selected,
        onProgress,
      });
      const bySource = new Map(selected.map((s) => [s.id, s]));
      const points = result.reachable
        .map((r) => {
          const source = bySource.get(r.sourceId);
          return {
            sourceId: r.sourceId,
            networkName: source.name,
            networkColor: source.color,
            name: source.stops.name[r.stopIdx] || source.stops.id[r.stopIdx],
            lat: source.stops.lat[r.stopIdx],
            lon: source.stops.lon[r.stopIdx],
            durationSeconds: r.durationSeconds,
          };
        })
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      return {
        found: result.found,
        noAccess: result.noAccess,
        origin: result.origin,
        maxWalkMeters: result.maxWalkMeters,
        points,
        scanned: result.scanned,
        pages: result.pages,
        diagnostics: result.diagnostics,
      };
    }
    return planLabeled(payload, selected, onProgress);
  };
}
