import { dataUrl } from "./config.mjs";
import { resolveDataUrl } from "../src/planner-config.mjs";
import { normalizeLanguage, stationKey } from "../src/irail-stations.mjs";
import {
  createTrainViews,
  serviceDayInstant,
  stationRefOf,
} from "./trains.mjs";
import {
  PlannerClient,
  createPlannerWorker,
  sampleIsoSurface,
  walkingRing,
  WALK_SPEED,
} from "../src/browser.mjs";
let planner;
const trains = createTrainViews({
  request: (type, payload) => planner.request(type, payload),
});

const state = {
  // Stop-search metadata only; connections and Arrow tables stay in the worker.
  sources: [],
  origin: null, // { sourceId, stopIdx } | null
  destination: null,
  lastQuery: null, // the plan request on screen, repeated when real-time data changes
  selected: 0, // index of the journey shown on the map
  feed: null, // the last real-time status the planner reported
  checkedAt: 0,
  updatedAt: 0,
  watcher: null,
};
const LIVE_INTERVAL_MS = 30_000;

const el = (id) => document.getElementById(id);
const statusEl = el("status");
let originPicker, destinationPicker;
let journeyRunning = false;
let journeyRevision = 0;
const planButton = el("plan-button");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function renderSourceCheckboxes(containerId = "source-list") {
  const container = el(containerId);
  container.innerHTML = "";
  for (const source of state.sources) {
    const label = document.createElement("label");
    label.className = "source-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.sourceId = source.id;
    label.appendChild(checkbox);
    const text = document.createElement("span");
    text.textContent = source.name;
    if (containerId === "iso-source-list") {
      const dot = document.createElement("span");
      dot.className = "network-dot";
      dot.style.backgroundColor = source.color;
      dot.setAttribute("aria-hidden", "true");
      label.appendChild(dot);
    }
    label.appendChild(text);
    const count = document.createElement("span");
    count.className = "source-count";
    count.textContent = `(${source.manifest.counts.stops.toLocaleString()} stops)`;
    label.appendChild(count);
    container.appendChild(label);
  }
}

function activeSources(containerId = "source-list") {
  const checked = new Set(
    [...el(containerId).querySelectorAll("input:checked")].map(
      (input) => input.dataset.sourceId,
    ),
  );
  return state.sources.filter((source) => checked.has(source.id));
}

function findSource(sourceId) {
  return state.sources.find((source) => source.id === sourceId);
}

// Which stop of a source stands for an NMBS station number.
const stopsByStation = new WeakMap();
function stopOfStation(source, key) {
  let stops = stopsByStation.get(source);
  if (!stops) {
    stops = new Map();
    for (const idx of source.stopFamily.searchable) {
      const stationNumber = stationKey(source.stops.id[idx]);
      if (stationNumber !== null && !stops.has(stationNumber))
        stops.set(stationNumber, idx);
    }
    stopsByStation.set(source, stops);
  }
  return stops.get(key);
}

const stationLanguage =
  (navigator.languages ?? [navigator.language]).map(normalizeLanguage).find(Boolean) ||
  "en";
const SUGGESTIONS = 8;

/**
 * Stops for the text typed: first the planner's station search (names in every
 * language, so "Renaix" finds Ronse; typos tolerated; busiest first), then
 * stops whose own label or id contains the text, for timetables without
 * station data. `[{ source, idx, label? }]`.
 */
async function searchStops(query) {
  const matches = [];
  const seen = new Set();
  const add = (source, idx, label) => {
    const id = `${source.id}\n${idx}`;
    if (matches.length >= SUGGESTIONS || seen.has(id)) return;
    seen.add(id);
    matches.push({ source, idx, label });
  };
  for (const source of activeSources()) {
    try {
      const stations = await planner.request("stations", {
        query,
        limit: SUGGESTIONS,
        sourceId: source.id,
        language: stationLanguage,
      });
      for (const station of stations) {
        const idx = stopOfStation(source, stationKey(station.id));
        if (idx !== undefined) add(source, idx, station.name);
      }
    } catch (error) {
      console.warn("Station search failed", error);
    }
  }
  for (const source of activeSources())
    for (const idx of source.stopFamily.searchable) {
      if (matches.length >= SUGGESTIONS) return matches;
      const name = (source.stops.name[idx] || "").toLowerCase();
      const id = source.stops.id[idx].toLowerCase();
      if (name.includes(query) || id.includes(query)) add(source, idx);
    }
  return matches;
}

function setupAutocomplete(inputId, suggestionsId, onPick) {
  const input = el(inputId);
  const box = el(suggestionsId);
  let selected = null; // { sourceId, stopIdx } | null
  let revision = 0; // only the newest search draws its suggestions

  function render(matches) {
    box.innerHTML = "";
    for (const { source, idx, label } of matches) {
      const button = document.createElement("button");
      button.type = "button";
      const name = source.stops.name[idx] || source.stops.id[idx];
      const suffix = activeSources().length > 1 ? ` · ${source.name}` : "";
      button.innerHTML = `${escapeHtml(label || name)} <span class="stop-id">${escapeHtml(source.stops.id[idx])}${escapeHtml(suffix)}</span>`;
      button.addEventListener("click", () => {
        input.value = name;
        selected = { sourceId: source.id, stopIdx: idx };
        box.innerHTML = "";
        onPick(selected);
      });
      box.appendChild(button);
    }
  }

  input.addEventListener("input", () => {
    selected = null;
    onPick(null);
    const query = input.value.trim().toLowerCase();
    if (query.length < 1) {
      box.innerHTML = "";
      return;
    }
    const mine = (revision += 1);
    searchStops(query).then((matches) => {
      if (mine === revision && !selected) render(matches);
    });
  });

  input.addEventListener("blur", () => {
    // let the click on a suggestion register before we clear the list
    setTimeout(() => (box.innerHTML = ""), 150);
  });

  return {
    get value() {
      return selected;
    },
    setByValue(value) {
      selected = value;
      box.innerHTML = "";
      if (!value) {
        input.value = "";
        return;
      }
      const source = findSource(value.sourceId);
      input.value =
        source.stops.name[value.stopIdx] || source.stops.id[value.stopIdx];
    },
  };
}

function endpointLabel(value) {
  if (value.lat !== undefined)
    return `${value.lon.toFixed(6)}, ${value.lat.toFixed(6)}`;
  const source = findSource(value.sourceId);
  return `${source.stops.name[value.stopIdx] || source.stops.id[value.stopIdx]} (${source.name})`;
}

function endpointCoordinates(value) {
  if (!value) return null;
  if (value.lat !== undefined) return [value.lon, value.lat];
  const source = findSource(value.sourceId);
  const { stopIdx } = value;
  if (
    !Number.isFinite(source.stops.lat[stopIdx]) ||
    !Number.isFinite(source.stops.lon[stopIdx])
  )
    return null;
  return [source.stops.lon[stopIdx], source.stops.lat[stopIdx]];
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function toLocalDateTimeValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTime(seconds) {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0
    ? `${hours}h${String(remainder).padStart(2, "0")}`
    : `${remainder} min`;
}

const lateMinutes = (seconds) => (seconds > 0 ? Math.round(seconds / 60) : 0);
const delayBadge = (seconds) =>
  lateMinutes(seconds)
    ? `<span class="delay">+${lateMinutes(seconds)}'</span>`
    : "";
const platformBadge = (platform) =>
  platform ? `<span class="platform">${escapeHtml(platform)}</span>` : "";

const canceledTag = (canceled) =>
  canceled ? `<span class="canceled-tag">Canceled</span>` : "";

function renderLeg(source, leg) {
  const stopName = (stop) => source.stops.name[stop] || source.stops.id[stop];
  const vehicle = leg.vehicle ?? { id: "", name: leg.routeName };

  const div = document.createElement("div");
  div.className = `leg${leg.canceled ? " canceled" : ""}`;
  div.innerHTML = `
<div class="row">
  <span class="stop"></span>
  <span class="time">${formatTime(leg.boardTime)}${delayBadge(leg.boardDelay)}${platformBadge(leg.boardPlatform)}${canceledTag(leg.boardCanceled)}</span>
</div>
<div class="row">
  <span class="stop"></span>
  <span class="time">${formatTime(leg.alightTime)}${delayBadge(leg.alightDelay)}${platformBadge(leg.alightPlatform)}${canceledTag(leg.alightCanceled)}</span>
</div>
<div class="trip"><span class="trip-line">${escapeHtml(source.name)} · <span class="trip-vehicle"></span>${leg.headsign ? ` → ${escapeHtml(leg.headsign)}` : ""}</span></div>
<div class="trip-host"></div>
    `;
  // Stations open their liveboard, the train opens its run on this day.
  const [boardCell, alightCell] = div.querySelectorAll(".stop");
  boardCell.replaceChildren(
    trains.stationButton(stationRefOf(leg.boardStopIri, stopName(leg.boardStop))),
  );
  alightCell.replaceChildren(
    trains.stationButton(stationRefOf(leg.alightStopIri, stopName(leg.alightStop))),
  );
  const host = div.querySelector(".trip-host");
  const slot = div.querySelector(".trip-vehicle");
  if (vehicle.id)
    slot.replaceWith(
      trains.vehicleButton({
        vehicle,
        date: serviceDayInstant(leg.serviceDate) ?? new Date(leg.boardTime * 1000),
        highlight: { from: leg.boardStopIri, to: leg.alightStopIri },
        key: `leg|${vehicle.id}|${leg.serviceDate}|${leg.boardStopIri}`,
        panelHost: host,
      }),
    );
  else slot.textContent = vehicle.name || "train";
  return div;
}

function optionHeader(index, startTime, endTime, transfers) {
  const header = document.createElement("div");
  header.className = "option-header";
  header.innerHTML = `
<span class="option-rank">${index + 1}</span>
<span class="option-duration">${formatDuration(endTime - startTime)}</span>
<span class="option-transfers">${transfers === 0 ? "direct" : `${transfers} transfer${transfers > 1 ? "s" : ""}`}</span>
    `;
  return header;
}

/** Which trains make a journey impossible, for the banner on its card. */
function cancellationReason(option) {
  const trains = option.legs
    .filter((leg) => leg.canceled)
    .map((leg) => {
      const source = findSource(leg.sourceId);
      const name = (stop) => source.stops.name[stop] || source.stops.id[stop];
      return `${leg.vehicle?.name || leg.routeName || "train"} ${name(leg.boardStop)} → ${name(leg.alightStop)}`;
    });
  return `Not possible: ${trains.join(" and ")} ${trains.length > 1 ? "are" : "is"} canceled`;
}

function renderOption(option, index) {
  const card = document.createElement("div");
  card.className = `option${option.canceled ? " canceled" : ""}`;
  if (!option.legs.length) {
    card.textContent = "Origin and destination are the same point.";
    return card;
  }
  card.appendChild(
    optionHeader(index, option.departure, option.arrival, option.transfers),
  );
  if (option.canceled) {
    const banner = document.createElement("div");
    banner.className = "cancel-banner";
    banner.setAttribute("role", "alert");
    banner.textContent = cancellationReason(option);
    card.appendChild(banner);
  }
  let previousArrival;
  for (const leg of option.legs) {
    if (previousArrival !== undefined && leg.boardTime > previousArrival) {
      const wait = document.createElement("div");
      wait.className = "transfer";
      wait.textContent = `Wait ${formatDuration(leg.boardTime - previousArrival)}`;
      card.appendChild(wait);
    }
    if (leg.kind === "walk") {
      const walk = document.createElement("div");
      walk.className = "walk";
      walk.textContent = `Walk ${Math.round(leg.distanceMeters)} m (${formatDuration(leg.alightTime - leg.boardTime)}) from ${endpointLabel(leg.from)} to ${endpointLabel(leg.to)}`;
      card.appendChild(walk);
    } else card.appendChild(renderLeg(findSource(leg.sourceId), leg));
    previousArrival = leg.alightTime;
  }
  card.tabIndex = 0;
  card.setAttribute("aria-label", `Show journey ${index + 1} on the map`);
  const select = () => {
    el("results")
      .querySelectorAll(".option")
      .forEach((element) => element.removeAttribute("aria-current"));
    card.setAttribute("aria-current", "true");
    state.selected = index;
    showJourney(option);
  };
  card.addEventListener("click", select);
  card.addEventListener("focus", select);
  return card;
}

// `refresh` redraws after a live update: the journey the reader was looking at
// stays selected (when it still exists) and the map does not jump.
function renderResults(result, { refresh = false, arriveBy = false } = {}) {
  const results = el("results");
  results.innerHTML = "";
  if (!result.options.length) {
    results.textContent = arriveBy
      ? "No journey found that arrives by then, looking back two days, across the selected networks."
      : "No journey found within 24 hours across the selected networks.";
    return;
  }
  if (!result.found) {
    const notice = document.createElement("div");
    notice.className = "cancel-banner";
    notice.setAttribute("role", "alert");
    notice.textContent =
      "No journey is possible: every journey found uses a canceled train.";
    results.appendChild(notice);
  }
  for (const [index, option] of result.options.entries())
    results.appendChild(renderOption(option, index));
  if (result.options.length) {
    // Show on the map the first journey that can be traveled, or when arriving
    // by a time the last one: the latest you can leave.
    const possible = result.options.map((option, i) => (option.canceled ? -1 : i)).filter((i) => i >= 0);
    const best = arriveBy ? possible.at(-1) : possible[0];
    const index = refresh
      ? Math.min(state.selected, result.options.length - 1)
      : Math.max(0, best ?? 0);
    state.selected = index;
    results.querySelectorAll(".option")[index].setAttribute("aria-current", "true");
    showJourney(result.options[index], !refresh);
  }
}

function setIsoStatus(message, isError = false) {
  const element = el("iso-status");
  element.textContent = message;
  element.classList.toggle("error", isError);
}

// Sequential single-hue scale (ColorBrewer Blues, reversed): dark and
// saturated for a short travel time, fading to pale as it grows.
const ISO_COLOR_STOPS = ["#08306b", "#2171b5", "#6baed6", "#9ecae1", "#c6dbef"];

function renderIsoLegend(maxDurationSeconds) {
  const legend = el("iso-legend");
  legend.innerHTML = "";
  const min = document.createElement("span");
  min.textContent = "0 min (dark = closer)";
  const bar = document.createElement("span");
  bar.className = "legend-gradient";
  const max = document.createElement("span");
  max.textContent = `${Math.round(maxDurationSeconds / 60)} min`;
  legend.append(min, bar, max);
}

// Both tabs share a single map-library download.
let maplibreLoading;
function loadMaplibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (!maplibreLoading)
    maplibreLoading = (async () => {
      if (!document.getElementById("maplibre-css")) {
        const link = document.createElement("link");
        link.id = "maplibre-css";
        link.rel = "stylesheet";
        link.href =
          "https://cdn.jsdelivr.net/npm/maplibre-gl@6.9.0/dist/maplibre-gl.css";
        document.head.appendChild(link);
      }
      const lib =
        await import("https://cdn.jsdelivr.net/npm/maplibre-gl@6.9.0/dist/maplibre-gl.mjs");
      window.maplibregl = lib;
      return lib;
    })().catch((error) => {
      maplibreLoading = undefined;
      throw error;
    });
  return maplibreLoading;
}

// Loaded on first use of the Isochrones tab only, alongside MapLibre.
let contourLibLoading;
function loadContourLib() {
  if (!contourLibLoading)
    contourLibLoading =
      import("https://cdn.jsdelivr.net/npm/d3-contour@4/+esm").catch(
        (error) => {
          contourLibLoading = undefined;
          throw error;
        },
      );
  return contourLibLoading;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
// Same dark(close)-to-light(far) scale as the point layer and legend,
// sampled at an arbitrary fraction of the max travel time.
function isoColorAt(fraction) {
  fraction = Math.min(1, Math.max(0, fraction));
  const scaled = fraction * (ISO_COLOR_STOPS.length - 1);
  const i = Math.min(ISO_COLOR_STOPS.length - 2, Math.floor(scaled));
  const t = scaled - i;
  const a = hexToRgb(ISO_COLOR_STOPS[i]);
  const b = hexToRgb(ISO_COLOR_STOPS[i + 1]);
  return rgbToHex(a.map((v, idx) => v + (b[idx] - v) * t));
}

const ISO_SURFACE_BANDS = 7;

/**
 * Builds a filled, contoured isochrone surface — like a classic
 * travel-time map — by interpolating travel time over a regular grid
 * (inverse-distance weighting from the reachable stops) and slicing it
 * into nested filled bands with marching squares (d3-contour). This is
 * an interpolated surface between sampled stops, not a measured
 * walkshed: it fills the gaps a raw point layer leaves, the same way
 * the reference map interpolates between railway stations.
 */
async function buildIsoSurface(
  points,
  origin,
  maxDurationSeconds,
  maxWalkMeters,
) {
  const d3 = await loadContourLib();
  const { values, cols, rows, latMin, latMax, lonMin, lonMax } =
    sampleIsoSurface(points, origin, maxDurationSeconds, maxWalkMeters);
  // Negated so d3's native ">= threshold" regions become our "<=
  // threshold" (closer-than) regions, which nest and grow with time.
  const negated = values.map((v) => -v);
  const generator = d3.contours().size([cols, rows]);
  const toLngLat = ([x, y]) => [
    lonMin + (x / (cols - 1)) * (lonMax - lonMin),
    latMax - (y / (rows - 1)) * (latMax - latMin),
  ];

  const features = [];
  for (let band = ISO_SURFACE_BANDS; band >= 1; band -= 1) {
    const threshold = (band / ISO_SURFACE_BANDS) * maxDurationSeconds;
    const polygon = generator.contour(negated, -threshold);
    if (polygon.coordinates.length)
      features.push({
        type: "Feature",
        properties: {
          threshold,
          color: isoColorAt(threshold / maxDurationSeconds),
        },
        geometry: {
          type: "MultiPolygon",
          coordinates: polygon.coordinates.map((polygonRings) =>
            polygonRings.map((ring) => ring.map(toLngLat)),
          ),
        },
      });
    const walkingMeters = Math.min(maxWalkMeters, threshold * WALK_SPEED);
    if (walkingMeters > 0)
      features.push({
        type: "Feature",
        properties: {
          threshold,
          color: isoColorAt(threshold / maxDurationSeconds),
        },
        geometry: {
          type: "Polygon",
          coordinates: [walkingRing(origin, walkingMeters)],
        },
      });
  }
  return { type: "FeatureCollection", features };
}

function mapStyle() {
  return {
    version: 8,
    sources: {
      basemap: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#b9d9ee" },
      },
      { id: "basemap", type: "raster", source: "basemap" },
    ],
  };
}

const emptyFeatures = () => ({ type: "FeatureCollection", features: [] });
let routeMap,
  routeMapReady,
  routeMarkers = [];
let profileFeatures = [],
  journeyFeatures = [];
let routeDrawPending = false;

// The route map is only for wide screens; on a phone it is not even loaded.
const mapVisible = window.matchMedia("(min-width: 900px)");
mapVisible.addEventListener("change", () => {
  if (mapVisible.matches && !el("panel-planner").hidden)
    ensureRouteMap()
      .then((map) => {
        map.resize();
        syncRouteMarkers(true);
        scheduleRouteDraw();
      })
      .catch(routeMapError);
});

function routeMapError(error) {
  console.error(error);
  el("route-map-status").textContent = `Map failed to load: ${error.message}`;
}

function ensureRouteMap() {
  if (!routeMapReady)
    routeMapReady = initializeRouteMap().catch((error) => {
      routeMap?.remove();
      routeMap = undefined;
      routeMapReady = undefined;
      throw error;
    });
  return routeMapReady;
}

async function initializeRouteMap() {
  const maplibregl = await loadMaplibre();
  routeMap = new maplibregl.Map({
    container: "route-map",
    style: mapStyle(),
    center: [3.73, 51.04],
    zoom: 11,
  });
  routeMap.addControl(new maplibregl.NavigationControl(), "top-right");
  await new Promise((resolve) => routeMap.on("style.load", resolve));
  for (const id of ["profile-lines", "journey-lines"]) {
    routeMap.addSource(id, { type: "geojson", data: emptyFeatures() });
    routeMap.addLayer({
      id,
      type: "line",
      source: id,
      paint: {
        "line-color": [
          "case",
          ["==", ["get", "kind"], "walk"],
          "#d97706",
          id === "profile-lines" ? "#2171b5" : "#0f6b4c",
        ],
        "line-width": id === "profile-lines" ? 1.5 : 4,
        "line-opacity": id === "profile-lines" ? 0.45 : 0.95,
      },
    });
  }
  el("route-map-status").textContent =
    "Select a journey to show it on the map.";
  syncRouteMarkers(true);
  scheduleRouteDraw();
  return routeMap;
}

function fitCoordinates(points) {
  if (!routeMap || !points.length) return;
  const bounds = new window.maplibregl.LngLatBounds();
  points.forEach((point) => bounds.extend(point));
  routeMap.fitBounds(bounds, { padding: 50, maxZoom: 14, duration: 500 });
}

function syncRouteMarkers(fit = false) {
  if (!routeMap) return;
  routeMarkers.forEach((marker) => marker.remove());
  routeMarkers = [];
  const points = [];
  for (const [endpoint, label] of [
    ["origin", "A"],
    ["destination", "B"],
  ]) {
    const point = endpointCoordinates(state[endpoint]);
    if (!point) continue;
    points.push(point);
    const element = document.createElement("div");
    element.className = `endpoint-marker ${endpoint}`;
    element.textContent = label;
    element.setAttribute(
      "aria-label",
      `${endpoint}: ${endpointLabel(state[endpoint])}`,
    );
    routeMarkers.push(
      new window.maplibregl.Marker({ element })
        .setLngLat(point)
        .addTo(routeMap),
    );
  }
  if (fit) fitCoordinates(points);
}

function lineFeature(from, to, kind) {
  return {
    type: "Feature",
    properties: { kind },
    geometry: { type: "LineString", coordinates: [from, to] },
  };
}
function addProfileEdges(edges) {
  profileFeatures.push(
    ...edges.map(({ from, to, kind }) => lineFeature(from, to, kind)),
  );
  scheduleRouteDraw();
}
function scheduleRouteDraw() {
  if (routeDrawPending) return;
  routeDrawPending = true;
  requestAnimationFrame(() => {
    routeDrawPending = false;
    routeMap?.getSource("profile-lines")?.setData({
      type: "FeatureCollection",
      features: profileFeatures.slice(),
    });
    routeMap?.getSource("journey-lines")?.setData({
      type: "FeatureCollection",
      features: journeyFeatures.slice(),
    });
  });
}
function clearRouteLines() {
  profileFeatures = [];
  journeyFeatures = [];
  scheduleRouteDraw();
}
function showJourney(option, fit = true) {
  journeyFeatures = [];
  for (const leg of option.legs) {
    const from = endpointCoordinates(
      leg.kind === "walk"
        ? leg.from
        : { sourceId: leg.sourceId, stopIdx: leg.boardStop },
    );
    const to = endpointCoordinates(
      leg.kind === "walk"
        ? leg.to
        : { sourceId: leg.sourceId, stopIdx: leg.alightStop },
    );
    if (leg.geometry)
      journeyFeatures.push({
        type: "Feature",
        properties: { kind: leg.kind },
        geometry: leg.geometry,
      });
    else if (from && to) journeyFeatures.push(lineFeature(from, to, leg.kind));
  }
  scheduleRouteDraw();
  if (fit)
    fitCoordinates(
      journeyFeatures.flatMap((feature) => feature.geometry.coordinates),
    );
}

let isoMap;
let isoMapReady;
let isoOriginMarker;

async function ensureIsoMap() {
  if (!isoMapReady)
    isoMapReady = initializeIsoMap().catch((error) => {
      isoMap?.remove();
      isoMap = undefined;
      isoMapReady = undefined;
      throw error;
    });
  return isoMapReady;
}

async function initializeIsoMap() {
  const maplibregl = await loadMaplibre();
  isoMap = new maplibregl.Map({
    container: "iso-map",
    style: mapStyle(),
    center: [4.47, 50.85], // Belgium
    zoom: 7.3,
  });
  isoMap.addControl(new maplibregl.NavigationControl(), "top-right");
  await new Promise((resolve) => {
    isoMap.on("style.load", () => {
      isoMap.addSource("iso-surface", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      isoMap.addLayer({
        id: "iso-surface",
        type: "fill",
        source: "iso-surface",
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": 0.68,
        },
      });
      isoMap.addSource("iso-points", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      isoMap.addLayer({
        id: "iso-points",
        type: "circle",
        source: "iso-points",
        paint: {
          "circle-radius": 2,
          "circle-color": ["get", "networkColor"],
          "circle-opacity": 0.9,
          "circle-stroke-width": 0,
        },
      });
      isoMap.on("click", "iso-points", (event) => {
        const feature = event.features[0];
        const props = feature.properties;
        new maplibregl.Popup({ maxWidth: "280px" })
          .setLngLat(feature.geometry.coordinates)
          .setHTML(
            `<strong>${escapeHtml(props.name)}</strong><br>${escapeHtml(props.networkName)} · ${escapeHtml(formatDuration(props.durationSeconds))}`,
          )
          .addTo(isoMap);
      });
      isoMap.on("click", async (event) => {
        if (
          isoMap.queryRenderedFeatures(event.point, {
            layers: ["iso-points"],
          }).length
        )
          return;
        await runIsochrone(event.lngLat.lat, event.lngLat.lng);
      });
      resolve();
    });
  });
  return isoMap;
}

function clearIsoPoints() {
  el("iso-legend").innerHTML = "";
  isoMap
    ?.getSource("iso-points")
    ?.setData({ type: "FeatureCollection", features: [] });
  isoMap
    ?.getSource("iso-surface")
    ?.setData({ type: "FeatureCollection", features: [] });
}

function clearIsochrone() {
  isoLastRequestId += 1;
  isoOriginMarker?.remove();
  isoOriginMarker = undefined;
  clearIsoPoints();
  setIsoStatus(
    "Ready — click the map to compute an isochrone from that point.",
  );
}

let isoLastRequestId = 0;

async function runIsochrone(lat, lon) {
  if (!planner || !isoMap) return;
  await ensureIsoMap();
  const departureDate = new Date(el("iso-departure-input").value);
  if (Number.isNaN(departureDate.getTime())) {
    setIsoStatus("Pick a valid departure date/time.", true);
    return;
  }
  const maxDurationSeconds = Number(el("iso-duration-input").value);
  const maxWalkMeters = Number(el("iso-max-walk-input").value);
  if (!Number.isFinite(maxWalkMeters) || maxWalkMeters < 0) {
    setIsoStatus("Max walking distance must be a non-negative number.", true);
    return;
  }

  const requestId = ++isoLastRequestId;
  const maplibregl = await loadMaplibre();
  isoOriginMarker?.remove();
  isoOriginMarker = new maplibregl.Marker({ color: "#0f6b4c" })
    .setLngLat([lon, lat])
    .addTo(isoMap);
  isoOriginMarker.getElement().style.pointerEvents = "none";
  clearIsoPoints();

  const startedAt = performance.now();
  setIsoStatus("Loading connections and scanning the selected networks…");
  try {
    const departureAfter = Math.floor(departureDate.getTime() / 1000);
    const onProgress = ({ phase, completed, total }) => {
      if (requestId !== isoLastRequestId) return;
      setIsoStatus(
        phase === "loading"
          ? `Loading timetable pages: ${completed}/${total}…`
          : "Scanning reachable regions…",
      );
    };
    const result = await planner.request(
      "isochrone",
      {
        origin: { lat, lon },
        departureAfter,
        maxDurationSeconds,
        maxWalkMeters,
        sourceIds: activeSources("iso-source-list").map((source) => source.id),
      },
      onProgress,
    );
    if (requestId !== isoLastRequestId) return; // superseded by a later click

    const features = result.points.map((point) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [point.lon, point.lat] },
      properties: {
        name: point.name,
        networkName: point.networkName,
        networkColor: point.networkColor,
        durationSeconds: point.durationSeconds,
      },
    }));
    isoMap
      .getSource("iso-points")
      .setData({ type: "FeatureCollection", features });
    renderIsoLegend(maxDurationSeconds);
    setIsoStatus("Building the isochrone surface…");
    try {
      const surface = await buildIsoSurface(
        result.points,
        { lat, lon },
        maxDurationSeconds,
        maxWalkMeters,
      );
      if (requestId !== isoLastRequestId) return;
      isoMap.getSource("iso-surface").setData(surface);
    } catch (error) {
      console.error("Isochrone surface failed", error);
      setIsoStatus(
        `Reached ${result.points.length} stops, but the surface failed: ${error.message}`,
        true,
      );
      return;
    }
    const elapsed = Math.round(performance.now() - startedAt);
    setIsoStatus(
      `${result.noAccess ? "Walking area only; no stop is within walking range. " : ""}Reached ${result.points.length.toLocaleString()} stop(s) within ${Math.round(maxDurationSeconds / 60)} min, scanning ${result.scanned.toLocaleString()} connections across ${result.pages} pages in ${elapsed} ms.`,
    );
  } catch (error) {
    if (requestId !== isoLastRequestId) return;
    console.error(error);
    setIsoStatus(`Isochrone failed: ${error.message}`, true);
  }
}

function activateTab(tabId) {
  for (const [button, panel] of [
    ["tab-planner", "panel-planner"],
    ["tab-isochrones", "panel-isochrones"],
  ]) {
    const isActive = button === tabId;
    el(button).setAttribute("aria-selected", String(isActive));
    el(panel).hidden = !isActive;
  }
  if (tabId === "tab-planner" && mapVisible.matches)
    ensureRouteMap()
      .then((map) => map.resize())
      .catch(routeMapError);
  if (tabId === "tab-isochrones")
    ensureIsoMap()
      .then((map) => map.resize())
      .catch((error) => {
        console.error(error);
        setIsoStatus(`Map failed to load: ${error.message}`, true);
      });
}
el("tab-planner").addEventListener("click", () => activateTab("tab-planner"));
el("tab-isochrones").addEventListener("click", () =>
  activateTab("tab-isochrones"),
);

// Current time, clamped into the span covered by the loaded sources.
function defaultDeparture(sources) {
  const times = (key) =>
    sources
      .map((source) => Date.parse(source.manifest[key]))
      .filter(Number.isFinite);
  const start = Math.min(...times("coverageStart"));
  const end = Math.max(...times("coverageEnd"));
  const now = Date.now();
  if (now < start) return new Date(start);
  if (now > end) return new Date(Math.max(start, end - 24 * 3600 * 1000));
  return new Date(now);
}

// Pre-select a familiar Gent → Liège pair when a source names those stations
// (in Dutch, French or English); otherwise leave the endpoints empty.
function defaultEndpoints(sources) {
  const names = [
    /^(gent-sint-pieters|gand-saint-pierre|ghent-sint-pieters)$/i,
    /^li[eè]ge-guillemins$/i,
  ];
  for (const source of sources) {
    const found = names.map((pattern) =>
      source.stopFamily.searchable.find((idx) =>
        pattern.test(source.stops.name[idx] || ""),
      ),
    );
    if (found.every((idx) => idx !== undefined))
      return found.map((stopIdx) => ({ sourceId: source.id, stopIdx }));
  }
  return null;
}

async function init() {
  try {
    planner = new PlannerClient(createPlannerWorker());
    const configuredUrl = resolveDataUrl(
      dataUrl,
      window.location.href,
      document.baseURI,
    );
    el("data-url").value = configuredUrl;
    setStatus("Discovering sources…");
    state.sources = await planner.request("init", {
      dataUrl: resolveDataUrl(dataUrl, window.location.href, document.baseURI),
    });
    if (state.sources.length === 0) {
      throw new Error("no source could be loaded");
    }
    // The planner loaded real-time data while starting; read its status and
    // keep checking.
    try {
      state.feed = summarizeFeeds(await planner.refreshRealtime());
      state.checkedAt = Date.now();
    } catch (error) {
      console.warn("Real-time feed unavailable:", error);
    }
    if (state.feed?.supported) {
      showLive("live");
      startWatching();
    }

    renderSourceCheckboxes();
    renderSourceCheckboxes("iso-source-list");

    const origin = (originPicker = setupAutocomplete(
      "origin-input",
      "origin-suggestions",
      (value) => {
        state.origin = value;
        syncRouteMarkers(true);
      },
    ));
    const destination = (destinationPicker = setupAutocomplete(
      "destination-input",
      "destination-suggestions",
      (value) => {
        state.destination = value;
        syncRouteMarkers(true);
      },
    ));

    // Selected stops belong to a specific source, so changing which
    // sources are active can invalidate the current picks.
    el("source-list")
      .querySelectorAll("input")
      .forEach((input) =>
        input.addEventListener("change", () => {
          const ids = new Set(activeSources().map((source) => source.id));
          if (state.origin?.sourceId && !ids.has(state.origin.sourceId)) {
            state.origin = null;
            origin.setByValue(null);
          }
          if (
            state.destination?.sourceId &&
            !ids.has(state.destination.sourceId)
          ) {
            state.destination = null;
            destination.setByValue(null);
          }
          clearRouteLines();
          syncRouteMarkers();
        }),
      );

    const totalStops = state.sources.reduce(
      (sum, source) => sum + source.manifest.counts.stops,
      0,
    );
    el("footer").textContent =
      `${state.sources.length} source(s) · ${totalStops.toLocaleString()} stops total. ` +
      `Journeys use all selected networks, with walking at the start, between rides, and at the end.`;
    el("iso-footer").textContent =
      `The colored surface interpolates travel time between reachable stops (dots) — a smoothed ` +
      `estimate, not a measured walking catchment. Loads the map library, contouring library and ` +
      `OpenStreetMap tiles from a CDN on first use.`;

    el("swap-button").addEventListener("click", () => {
      const originValue = state.origin;
      const destinationValue = state.destination;
      origin.setByValue(destinationValue ?? null);
      destination.setByValue(originValue ?? null);
      state.origin = destinationValue ?? null;
      state.destination = originValue ?? null;
      syncRouteMarkers();
    });

    const example = state.sources.find(
      (source) => source.manifest.releaseId === "illustrative-20261108",
    );
    // The bundled sample is a fixed day; real feeds start at the current time,
    // clamped into their published coverage.
    const initialTime = example
      ? new Date(example.manifest.coverageStart)
      : defaultDeparture(state.sources);
    el("departure-input").value = toLocalDateTimeValue(initialTime);
    el("iso-departure-input").value = toLocalDateTimeValue(initialTime);
    const endpoints = example
      ? [
          { sourceId: example.id, stopIdx: 0 },
          { sourceId: example.id, stopIdx: 3 },
        ]
      : defaultEndpoints(state.sources);
    if (endpoints) {
      [state.origin, state.destination] = endpoints;
      origin.setByValue(state.origin);
      destination.setByValue(state.destination);
    }

    setStatus(
      `Ready — ${totalStops.toLocaleString()} stops loaded across ${state.sources.length} source(s).`,
    );
    planButton.disabled = false;
    planButton.textContent = "Plan journey";

    el("iso-source-list")
      .querySelectorAll("input")
      .forEach((input) =>
        input.addEventListener("change", () => clearIsochrone()),
      );
    setIsoStatus(
      `Ready — click the map to compute an isochrone from that point.`,
    );
  } catch (error) {
    console.error(error);
    setStatus(
      `Could not load data: ${error.message}. Enter an LC 2.0-alpha manifest URL or use the iRail CDN default.`,
      true,
    );
    setIsoStatus(`Could not load data: ${error.message}`, true);
  }
}

el("journey-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (journeyRunning) return;
  if (!state.origin || !state.destination) {
    setStatus(
      "Choose both stations from the suggestions.",
      true,
    );
    return;
  }
  const departureDate = new Date(el("departure-input").value);
  const arriveBy = el("time-mode-input").value === "arrive";
  if (Number.isNaN(departureDate.getTime())) {
    setStatus(`Pick a valid ${arriveBy ? "arrival" : "departure"} date/time.`, true);
    return;
  }
  // Walking between stations is not part of iRail, so journeys are by train only.
  const maxWalkMeters = 0;

  journeyRunning = true;
  const revision = ++journeyRevision;
  planButton.disabled = true;
  const startedAt = performance.now();
  el("results").innerHTML = "";
  state.lastQuery = null;
  clearRouteLines();
  try {
    const seconds = Math.floor(departureDate.getTime() / 1000);
    const windowMode = el("journey-window-input").value;
    const onProgress = ({ phase, completed, total, edges }) => {
      if (revision !== journeyRevision) return;
      if (edges) {
        addProfileEdges(edges);
        return;
      }
      setStatus(
        phase === "loading"
          ? `Loading timetable pages: ${completed}/${total}…`
          : phase === "earliest"
            ? "Finding the earliest arrival…"
            : phase === "labels"
              ? "Loading journey details…"
              : "Building journey profiles…",
      );
    };

    setStatus("Loading connections and planning the journey…");
    const query = {
      origin: state.origin,
      destination: state.destination,
      // Leaving after a time, or arriving by it (then the window is scanned
      // backward from the deadline and needs no earliest-arrival pass).
      ...(arriveBy
        ? // The window before a deadline is arbitrary, so ask for a few journeys.
          { arrivalBefore: seconds, minOptions: 6 }
        : { departureAfter: seconds }),
      maxWalkMeters,
      windowMode,
      sourceIds: activeSources().map((source) => source.id),
    };
    const result = await planner.request("plan", query, onProgress);

    if (revision !== journeyRevision) return;
    const elapsed = Math.round(performance.now() - startedAt);
    const canceledCount = result.options.filter((option) => option.canceled).length;
    const shown = result.options.length - canceledCount;
    const canceledNote = canceledCount
      ? `, plus ${canceledCount} canceled (not possible)`
      : "";
    const hiddenNote =
      result.totalOptions > shown
        ? ` (showing the ${arriveBy ? "last" : "first"} ${shown} of ${result.totalOptions} Pareto-optimal alternatives)`
        : "";
    const windowNote =
      result.window && result.found && !arriveBy
        ? ` Search window: ${formatDuration(result.window.to - result.window.from)}${result.window.mode === "adaptive" ? " (twice earliest journey time, capped at 24 h)" : ""}.`
        : "";
    setStatus(
      result.found
        ? `Found ${shown} journey option${shown === 1 ? "" : "s"}${canceledNote}${hiddenNote} across the selected networks, scanning ${result.scanned.toLocaleString()} connections in ${elapsed} ms.${windowNote}`
        : canceledCount
          ? `No journey is possible: ${canceledCount} found, all canceled.`
          : `No journey found across the selected networks after scanning ${result.scanned.toLocaleString()} connections in ${elapsed} ms.`,
      !result.found,
    );
    renderResults(result, { arriveBy });
    state.lastQuery = query;
    state.updatedAt = 0;
    if (state.feed?.supported) showLive(state.watcher ? "live" : "off");
  } catch (error) {
    if (revision !== journeyRevision) return;
    console.error(error);
    setStatus(`Route planning failed: ${error.message}`, true);
  } finally {
    journeyRunning = false;
    planButton.disabled = false;
    if (livePending) refreshJourneys();
  }
});

// ----------------------------------------------------------- live updates

let livePending = false;
const clockFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Brussels",
});
const formatClock = (millis) => clockFormat.format(new Date(millis));

/** One status for all sources: their counts added up. */
function summarizeFeeds(statuses) {
  const live = statuses.filter((status) => status.supported);
  if (!live.length) return { supported: false, changed: false };
  return {
    supported: true,
    changed: live.some((status) => status.changed),
    timestamp: Math.max(...live.map((status) => status.timestamp)),
    delayed: live.reduce((sum, status) => sum + status.delayed, 0),
    canceled: live.reduce((sum, status) => sum + status.canceled, 0),
  };
}

// kind: live | stale | off
function showLive(kind, flash = false) {
  const strip = el("live-status");
  strip.hidden = false;
  strip.classList.toggle("is-live", kind === "live");
  strip.classList.toggle("is-stale", kind === "stale");
  const feed = state.feed;
  const parts = [
    feed?.supported
      ? `Real-time feed of ${formatClock(feed.timestamp * 1000)} · ${feed.delayed} delayed and ${feed.canceled} canceled trips`
      : "",
  ];
  if (kind === "stale")
    parts.push("could not reach the feed, showing the last data");
  else if (kind === "off") parts.push("automatic updates are off");
  else {
    if (state.checkedAt) parts.push(`checked ${formatClock(state.checkedAt)}`);
    if (state.updatedAt)
      parts.push(`journeys updated ${formatClock(state.updatedAt)}`);
    parts.push("checking every 30 s");
  }
  el("live-text").textContent = parts.filter(Boolean).join(" · ");
  if (flash) {
    strip.classList.add("is-flash");
    setTimeout(() => strip.classList.remove("is-flash"), 1500);
  }
}

/**
 * Plan the journeys on screen again with the newest real-time data and redraw
 * in place. The query is the one the reader asked for; a new search in the
 * meantime wins, and its results are never overwritten by an older refresh.
 */
async function refreshJourneys() {
  if (!state.lastQuery) return;
  if (journeyRunning) {
    livePending = true;
    return;
  }
  livePending = false;
  const revision = journeyRevision;
  try {
    const result = await planner.request("plan", state.lastQuery);
    if (revision !== journeyRevision || journeyRunning) return;
    renderResults(result, {
      refresh: true,
      arriveBy: state.lastQuery.arrivalBefore !== undefined,
    });
    state.updatedAt = Date.now();
    showLive(state.watcher ? "live" : "off", true);
  } catch (error) {
    console.error(error);
  }
}

function startWatching({ immediate = false } = {}) {
  stopWatching();
  if (!el("live-toggle").checked || document.hidden || !state.feed?.supported)
    return;
  const watcher = planner.watchRealtime({
    intervalMs: LIVE_INTERVAL_MS,
    immediate,
  });
  watcher.addEventListener("poll", (event) => {
    state.feed = summarizeFeeds(event.detail);
    state.checkedAt = Date.now();
    showLive("live");
    trains.refreshBoard();
  });
  watcher.addEventListener("update", () => {
    refreshJourneys();
    trains.refresh();
  });
  watcher.addEventListener("error", () => showLive("stale"));
  state.watcher = watcher;
}

function stopWatching() {
  state.watcher?.stop();
  state.watcher = null;
}

el("live-toggle").addEventListener("change", () => {
  if (el("live-toggle").checked) {
    startWatching({ immediate: true });
    showLive("live");
  } else {
    stopWatching();
    showLive("off");
  }
});

el("live-now").addEventListener("click", async () => {
  const button = el("live-now");
  button.disabled = true;
  try {
    state.feed = summarizeFeeds(await planner.refreshRealtime());
    state.checkedAt = Date.now();
    await refreshJourneys();
    trains.refresh();
    showLive(state.watcher ? "live" : "off");
  } catch (error) {
    console.error(error);
    showLive("stale");
  } finally {
    button.disabled = false;
  }
});

// A hidden tab does not poll; coming back checks at once.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopWatching();
  else startWatching({ immediate: true });
});

if (mapVisible.matches) ensureRouteMap().catch(routeMapError);
init();

// Arriving by a time needs no search window: it is scanned back from the deadline.
el("time-mode-input").addEventListener("change", () => {
  el("journey-window-input").disabled = el("time-mode-input").value === "arrive";
});
