import { WALK_SPEED } from "./planner-network.mjs";

// Initial access walking is a measured radius, independent of whether a
// station happened to be sampled nearby by the transit surface.
export function walkingTimeAt(origin, lat, lon, radius) {
  const radians = Math.PI / 180;
  const a =
    Math.sin(((lat - origin.lat) * radians) / 2) ** 2 +
    Math.cos(lat * radians) *
      Math.cos(origin.lat * radians) *
      Math.sin(((lon - origin.lon) * radians) / 2) ** 2;
  const meters = 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
  return meters <= radius ? meters / WALK_SPEED : Infinity;
}

// Keep the initial walking area visible even when a nationwide transit grid
// has cells wider than the entire access radius.
export function walkingRing(origin, meters) {
  const phi = (origin.lat * Math.PI) / 180;
  const lambda = (origin.lon * Math.PI) / 180;
  const distance = meters / 6371000;
  const coordinates = [];
  for (let i = 0; i < 64; i += 1) {
    const bearing = (i * 2 * Math.PI) / 64;
    const lat = Math.asin(
      Math.sin(phi) * Math.cos(distance) +
        Math.cos(phi) * Math.sin(distance) * Math.cos(bearing),
    );
    const lon =
      lambda +
      Math.atan2(
        Math.sin(bearing) * Math.sin(distance) * Math.cos(phi),
        Math.cos(distance) - Math.sin(phi) * Math.sin(lat),
      );
    coordinates.push([(lon * 180) / Math.PI, (lat * 180) / Math.PI]);
  }
  coordinates.push(coordinates[0]);
  return coordinates;
}

const ISO_SURFACE_MAX_SAMPLES = 500;
export function sampleIsoSurface(
  points,
  origin,
  maxDurationSeconds,
  maxWalkMeters,
) {
  const samples = points.map((p) => ({
    lat: p.lat,
    lon: p.lon,
    duration: p.durationSeconds,
  }));

  const thinned =
    samples.length > ISO_SURFACE_MAX_SAMPLES
      ? samples.filter(
          (_, i) =>
            i % Math.ceil(samples.length / ISO_SURFACE_MAX_SAMPLES) === 0,
        )
      : samples;

  const radius = Math.min(maxWalkMeters, maxDurationSeconds * WALK_SPEED);
  const latitudeRadius = radius / 111320;
  const longitudeRadius =
    latitudeRadius / Math.max(0.01, Math.cos((origin.lat * Math.PI) / 180));
  let latMin = origin.lat - latitudeRadius,
    latMax = origin.lat + latitudeRadius,
    lonMin = origin.lon - longitudeRadius,
    lonMax = origin.lon + longitudeRadius;
  for (const s of thinned) {
    latMin = Math.min(latMin, s.lat);
    latMax = Math.max(latMax, s.lat);
    lonMin = Math.min(lonMin, s.lon);
    lonMax = Math.max(lonMax, s.lon);
  }
  // Pad so the surface doesn't end abruptly right at the outermost stop.
  const latPad = Math.max((latMax - latMin) * 0.15, 0.0005);
  const lonPad = Math.max((lonMax - lonMin) * 0.15, 0.0005);
  latMin -= latPad;
  latMax += latPad;
  lonMin -= lonPad;
  lonMax += lonPad;

  const cols = 90;
  const midLat = (latMin + latMax) / 2;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180);
  const aspect =
    ((latMax - latMin) * metersPerDegLat) /
    Math.max(1, (lonMax - lonMin) * Math.abs(metersPerDegLon));
  const rows = Math.max(20, Math.min(160, Math.round(cols * aspect)));

  // How far apart stops typically are, so the surface can stop short of
  // cells nowhere near any sample instead of extrapolating a flat plateau
  // across empty space. Scales with the network's own density.
  function averageNearestNeighborMeters(list) {
    if (list.length < 2) return null;
    let total = 0;
    for (const a of list) {
      let nearest = Infinity;
      for (const b of list) {
        if (a === b) continue;
        const dLat = (a.lat - b.lat) * metersPerDegLat;
        const dLon = (a.lon - b.lon) * metersPerDegLon;
        nearest = Math.min(nearest, Math.hypot(dLat, dLon));
      }
      total += nearest;
    }
    return total / list.length;
  }
  const bboxDiagonal = Math.hypot(
    (latMax - latMin) * metersPerDegLat,
    (lonMax - lonMin) * metersPerDegLon,
  );
  // Co-located platforms/operators must not collapse the mask radius.
  const distinctSamples = [
    ...new Map(
      thinned.map((sample) => [`${sample.lat}/${sample.lon}`, sample]),
    ).values(),
  ];
  const averageSpacing = averageNearestNeighborMeters(distinctSamples);
  const maskRadius =
    averageSpacing !== null ? averageSpacing * 2.5 : bboxDiagonal * 0.25;

  // Inverse-distance weighting: closer known stops dominate a cell's
  // estimate, so the surface passes near-exactly through sampled points.
  // Masked cells use a finite value beyond every threshold. Infinity
  // causes NaN coordinates when d3 interpolates a contour boundary.
  const values = new Float64Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    const lat = latMax - (row / (rows - 1)) * (latMax - latMin);
    for (let col = 0; col < cols; col += 1) {
      const lon = lonMin + (col / (cols - 1)) * (lonMax - lonMin);
      let weightSum = 0;
      let valueSum = 0;
      let nearestDistSq = Infinity;
      let exact;
      for (const s of thinned) {
        const dLat = (lat - s.lat) * metersPerDegLat;
        const dLon = (lon - s.lon) * metersPerDegLon;
        const distSq = dLat * dLat + dLon * dLon;
        if (distSq < nearestDistSq) nearestDistSq = distSq;
        if (distSq < 25) {
          exact = s.duration;
          break;
        }
        const weight = 1 / (distSq * distSq);
        weightSum += weight;
        valueSum += weight * s.duration;
      }
      values[row * cols + col] = Math.min(
        !thinned.length || Math.sqrt(nearestDistSq) > maskRadius
          ? maxDurationSeconds * 4
          : (exact ?? valueSum / weightSum),
        walkingTimeAt(origin, lat, lon, radius),
      );
    }
  }
  return { values, cols, rows, latMin, latMax, lonMin, lonMax };
}
