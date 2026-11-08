export function validatePoint(point) {
  if (
    !point ||
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lon) ||
    Math.abs(point.lat) > 90 ||
    Math.abs(point.lon) > 180
  )
    throw new Error("Coordinates must be valid longitude/latitude values");
  return { lat: point.lat, lon: point.lon };
}

export function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function createJourneyEndpoints(
  network,
  origin,
  destination,
  maxWalkMeters,
) {
  function endpoint(value, virtual) {
    if (value && "sourceId" in value) {
      const stop = network.globalStop(value);
      return {
        stop,
        point: network.coordinates(stop),
        neighbors: network.neighbors(stop),
      };
    }
    const point = validatePoint(value);
    return {
      stop: virtual,
      point,
      neighbors: network.pointNeighbors(point.lat, point.lon, maxWalkMeters),
    };
  }
  const start = endpoint(origin, -1);
  const end = endpoint(destination, -2);
  const direct =
    start.stop >= 0 && end.stop >= 0
      ? end.neighbors.meters[
          Array.from(end.neighbors.stops).indexOf(start.stop)
        ]
      : start.point && end.point
        ? distanceMeters(start.point, end.point)
        : Infinity;
  const directMeters = direct <= maxWalkMeters ? direct : undefined;
  return {
    origin: start.stop,
    destination: end.stop,
    access: start.neighbors,
    egress: new Map(
      Array.from(end.neighbors.stops, (stop, i) => [
        stop,
        end.neighbors.meters[i],
      ]),
    ),
    directMeters,
    localStop: (stop) =>
      stop === -1
        ? start.point
        : stop === -2
          ? end.point
          : network.localStop(stop),
    coordinates: (stop) =>
      stop === -1
        ? start.point
        : stop === -2
          ? end.point
          : network.coordinates(stop),
    same:
      (start.stop >= 0 && start.stop === end.stop) ||
      (!!start.point &&
        !!end.point &&
        start.point.lat === end.point.lat &&
        start.point.lon === end.point.lon),
  };
}
