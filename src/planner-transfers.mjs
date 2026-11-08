export function buildTransferRules(sources, root, owner) {
  const byRoot = new Map();
  const sensitive = new Map();
  function ancestors(stop) {
    const source = sources[owner[stop]];
    const result = [];
    let local = stop - source.stopOffset;
    do {
      result.push(local);
      local = source.stops.parentIdx[local];
    } while (local >= 0);
    return result;
  }
  for (const source of sources) {
    for (let from = 0; from < source.stops.id.length; from += 1) {
      for (const rule of source.stops.transferRules?.[from] || []) {
        const r = root[source.stopOffset + from];
        if (root[source.stopOffset + rule.to] !== r) continue;
        (byRoot.get(r) || (byRoot.set(r, []), byRoot.get(r))).push({
          ...rule,
          from,
        });
        if (
          source.stopOffset + from !== r ||
          source.stopOffset + rule.to !== r ||
          rule.fromTrip >= 0 ||
          rule.toTrip >= 0 ||
          rule.fromRoute >= 0 ||
          rule.toRoute >= 0
        )
          sensitive.set(
            r,
            Math.max(
              sensitive.get(r) || 1,
              rule.fromTrip >= 0 ||
                rule.toTrip >= 0 ||
                rule.fromRoute >= 0 ||
                rule.toRoute >= 0
                ? 2
                : 1,
            ),
          );
      }
    }
  }
  const ancestorCache = new Map();
  function lineage(stop) {
    if (!ancestorCache.has(stop)) ancestorCache.set(stop, ancestors(stop));
    return ancestorCache.get(stop);
  }
  function transferTime(from, to, fromTrip, toTrip) {
    if (root[from] !== root[to]) return 0; // An actual walking leg has no station buffer.
    const source = sources[owner[from]];
    const rules = byRoot.get(root[from]);
    if (!rules)
      return Math.max(
        source.stops.minTransferTime?.[from - source.stopOffset] || 0,
        source.stops.minTransferTime?.[to - source.stopOffset] || 0,
      );
    const arriving = fromTrip - source.tripOffset;
    const departing = toTrip - source.tripOffset;
    const fromStops = lineage(from),
      toStops = lineage(to);
    let best,
      rank = -1,
      specificity = -Infinity;
    for (const rule of rules) {
      if (
        !fromStops.includes(rule.from) ||
        !toStops.includes(rule.to) ||
        (rule.fromTrip >= 0 && rule.fromTrip !== arriving) ||
        (rule.toTrip >= 0 && rule.toTrip !== departing) ||
        (rule.fromTrip < 0 &&
          rule.fromRoute >= 0 &&
          source.tripRoutes?.[arriving] !== rule.fromRoute) ||
        (rule.toTrip < 0 &&
          rule.toRoute >= 0 &&
          source.tripRoutes?.[departing] !== rule.toRoute)
      )
        continue;
      const trips = Number(rule.fromTrip >= 0) + Number(rule.toTrip >= 0);
      const routes =
        Number(rule.fromTrip < 0 && rule.fromRoute >= 0) +
        Number(rule.toTrip < 0 && rule.toRoute >= 0);
      const priority =
        trips === 2
          ? 5
          : trips && routes
            ? 4
            : trips
              ? 3
              : routes === 2
                ? 2
                : routes
                  ? 1
                  : 0;
      const exact = -fromStops.indexOf(rule.from) - toStops.indexOf(rule.to);
      if (priority > rank || (priority === rank && exact > specificity)) {
        best = rule;
        rank = priority;
        specificity = exact;
      }
    }
    return best?.type === 3
      ? Infinity
      : best?.type === 2
        ? best.seconds
        : best
          ? 0
          : Math.max(
              source.stops.minTransferTime?.[from - source.stopOffset] || 0,
              source.stops.minTransferTime?.[to - source.stopOffset] || 0,
            );
  }
  // Preserve distinct boarding labels when platform/trip/route overrides make
  // them behave differently for a preceding arrival. Ordinary station rules
  // retain the compact shared profile and arrival label.
  const transferClass = (stop, trip) =>
    sensitive.get(root[stop]) === 2
      ? `${stop}/${trip}`
      : sensitive.has(root[stop])
        ? String(stop)
        : 0;
  return { transferTime, transferClass };
}
