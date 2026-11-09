import { resolveDataUrl } from "../src/planner-config.mjs";
import { PlannerClient, createPlannerWorker } from "../src/browser.mjs";
import { dataUrl } from "./config.mjs";
import { createTrainViews } from "./trains.mjs";
import {
  apiConnectionsUrl,
  compareJourneys,
  median,
  normalizeApiConnection,
  normalizePlannerJourney,
  apiStationId,
  stationKey,
  zonedParts,
  zonedToEpoch,
} from "./compare.mjs";
import {
  buildStations,
  findStations,
  loadStationRows,
  normalizeLanguage,
  stationLabel,
} from "./irail/stations.mjs";
import {
  dateInputToIso,
  isoToDateInput,
  isValidTimeInput,
} from "./irail/date-time.mjs";

const el = (id) => document.getElementById(id);
const els = {
  form: el("route-form"),
  from: el("route-from"),
  to: el("route-to"),
  time: el("route-time"),
  date: el("route-date"),
  walk: el("route-walk"),
  window: el("route-window"),
  search: el("route-search"),
  swap: el("route-swap"),
  language: el("language-select"),
  status: el("planner-status"),
  alert: el("route-alert"),
  results: el("route-results"),
  live: el("live-status"),
  liveText: el("live-text"),
  liveToggle: el("live-toggle"),
  liveNow: el("live-now"),
};

const LIVE_INTERVAL_MS = 30_000;

const state = {
  planner: null,
  source: null,
  stations: [],
  byKey: new Map(),
  language: "en",
  lastRun: null,
  from: null,
  to: null,
  initMs: 0,
  coverage: { start: -Infinity, end: Infinity },
  running: false,
  history: [], // one timing record per finished search in this session
  watcher: null, // polls the planner's real-time feed
  pendingRefresh: false, // a feed update arrived while a search was running
  feed: null, // the last real-time status the planner reported
  checkedAt: 0,
};

const pad = (n) => String(n).padStart(2, "0");
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/gu,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Brussels",
});
const formatTime = (seconds) => timeFormat.format(new Date(seconds * 1000));
const clockFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Brussels",
});
const formatClock = (millis) => clockFormat.format(new Date(millis));
const lateMinutes = (seconds) => (seconds > 0 ? Math.round(seconds / 60) : 0);
const delayBadge = (seconds) =>
  lateMinutes(seconds) ? `<span class="delay">+${lateMinutes(seconds)}'</span>` : "";
function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${hours ? `${hours} h ` : ""}${minutes % 60 ? `${minutes % 60} min` : ""}`.trim() || "0 min";
}
const formatMs = (ms) =>
  ms === undefined
    ? "–"
    : ms < 10
      ? `${ms.toFixed(1)} ms`
      : ms < 1000
        ? `${Math.round(ms)} ms`
        : `${(ms / 1000).toFixed(2)} s`;
const transfersLabel = (n) =>
  n === 0 ? "direct" : `${n} transfer${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------- inputs

function validateDateTime(input) {
  const isDate = input.dataset.dateTime === "date";
  const valid = isDate
    ? Boolean(dateInputToIso(input.value))
    : isValidTimeInput(input.value);
  input.setCustomValidity(
    input.value && !valid
      ? isDate
        ? "Use DD/MM/YYYY, for example 08/11/2026."
        : "Use 24-hour time (HH:MM), for example 14:05."
      : "",
  );
}
for (const input of [els.time, els.date])
  input.addEventListener("input", () => validateDateTime(input));

function setDateTime(epochSeconds) {
  const p = zonedParts(epochSeconds);
  els.date.value = isoToDateInput(`${p.year}-${pad(p.month)}-${pad(p.day)}`);
  els.time.value = `${pad(p.hour)}:${pad(p.minute)}`;
}

function departureEpoch() {
  const iso = dateInputToIso(els.date.value);
  const [year, month, day] = iso.split("-").map(Number);
  const [hour, minute] = els.time.value.split(":").map(Number);
  return zonedToEpoch({ year, month, day, hour, minute });
}

/** Station picker with suggestions, backed by the planner's stop list. */
function bindStationPicker(input, side) {
  const menu = el(`${input.id}-menu`);
  let matches = [];
  let active = -1;
  const close = () => {
    menu.classList.remove("is-open");
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };
  const choose = (station) => {
    state[side] = station;
    input.value = stationLabel(station, state.language);
    close();
  };
  const render = () => {
    menu.innerHTML = matches
      .map(
        (station, index) =>
          `<button type="button" class="autocomplete-option${index === active ? " is-active" : ""}" role="option" data-index="${index}">${escapeHtml(stationLabel(station, state.language))}</button>`,
      )
      .join("");
    menu.classList.toggle("is-open", matches.length > 0);
    input.setAttribute("aria-expanded", String(matches.length > 0));
  };
  const suggest = () => {
    matches = findStations(state.stations, input.value);
    active = -1;
    render();
  };
  input.addEventListener("input", () => {
    state[side] = null;
    suggest();
  });
  input.addEventListener("focus", suggest);
  input.addEventListener("keydown", (event) => {
    if (!matches.length || !menu.classList.contains("is-open")) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(active + 1, matches.length - 1);
      render();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      render();
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      choose(matches[active]);
    } else if (event.key === "Escape") close();
  });
  // mousedown beats blur, so the click registers before the menu closes.
  menu.addEventListener("mousedown", (event) => {
    const option = event.target.closest("[data-index]");
    if (!option) return;
    event.preventDefault();
    choose(matches[Number(option.dataset.index)]);
  });
  input.addEventListener("blur", close);
}
bindStationPicker(els.from, "from");
bindStationPicker(els.to, "to");

function showStationNames() {
  els.from.value = state.from ? stationLabel(state.from, state.language) : "";
  els.to.value = state.to ? stationLabel(state.to, state.language) : "";
}

els.swap.addEventListener("click", () => {
  [state.from, state.to] = [state.to, state.from];
  showStationNames();
});

const stationFromInput = (input, picked) =>
  picked ?? findStations(state.stations, input.value, 1)[0] ?? null;

// Like irail.be: the language picks which label is shown, the search covers all.
function readStoredLanguage() {
  try {
    return normalizeLanguage(localStorage.getItem("irail-compare-language"));
  } catch {
    return "";
  }
}
function initialLanguage() {
  return (
    readStoredLanguage() ||
    (navigator.languages?.length ? navigator.languages : [navigator.language])
      .map(normalizeLanguage)
      .find(Boolean) ||
    "en"
  );
}
// Trains and stations of both result lists open their run / liveboard.
const trains = createTrainViews({
  request: (type, payload) => state.planner.request(type, payload),
  language: () => state.language,
});
state.language = initialLanguage();
els.language.value = state.language;
document.documentElement.lang = state.language;
els.language.addEventListener("change", () => {
  state.language = normalizeLanguage(els.language.value) || "en";
  document.documentElement.lang = state.language;
  try {
    localStorage.setItem("irail-compare-language", state.language);
  } catch {
    // Remembering the language is a convenience only.
  }
  showStationNames();
  if (state.lastRun) {
    analyse(state.lastRun);
    render(state.lastRun);
  }
});

// ------------------------------------------------------------- measuring

async function measure(task) {
  const start = performance.now();
  try {
    const value = await task();
    return { ms: performance.now() - start, value };
  } catch (error) {
    return { ms: performance.now() - start, error };
  }
}

async function callApi(url) {
  return measure(async () => {
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error)
      throw new Error(data.message || `HTTP ${response.status}`);
    const list = data.connection;
    return list ? (Array.isArray(list) ? list : [list]) : [];
  });
}

const callPlanner = (query) =>
  measure(() => state.planner.request("plan", query, () => {}));

// ------------------------------------------------------------- rendering

const canceledTag = (canceled) =>
  canceled ? `<span class="canceled-tag">Canceled</span>` : "";

// Stations and trains are plain placeholders here; `enhance` turns them into
// buttons after the results are drawn.
const stationHtml = (point) =>
  point.key
    ? `<span data-station="${escapeHtml(point.key)}" data-name="${escapeHtml(point.name)}">${escapeHtml(point.name)}</span>`
    : escapeHtml(point.name);

function stopRow(point, showPlatform = true) {
  return `
    <div class="planner-row${point.canceled ? " is-canceled" : ""}">
      <span class="planner-time"><b>${formatTime(point.time)}</b>${delayBadge(point.delay)}${canceledTag(point.canceled)}</span>
      <span class="planner-station"><b>${stationHtml(point)}</b></span>
      <span class="planner-platform">${showPlatform && point.platform ? `<span class="badge">${escapeHtml(point.platform)}</span>` : ""}</span>
    </div>`;
}

function legLine(leg) {
  if (leg.kind === "walk")
    return `<span class="planner-train">Walk${leg.meters ? ` ${Math.round(leg.meters)} m` : ""}</span>`;
  const train = leg.vehicleId
    ? `<span data-vehicle="${escapeHtml(leg.vehicleId)}" data-name="${escapeHtml(leg.label)}" data-date="${leg.date}" data-from="${escapeHtml(leg.from.key ?? "")}" data-to="${escapeHtml(leg.to.key ?? "")}">${escapeHtml(leg.label)}</span>`
    : escapeHtml(leg.label);
  return `<span class="planner-train${leg.canceled ? " is-canceled" : ""}">${train}${leg.headsign ? ` → ${escapeHtml(leg.headsign)}` : ""}${canceledTag(leg.canceled)}</span><div class="trip-host"></div>`;
}

function timeline(journey) {
  const parts = [];
  journey.legs.forEach((leg, index) => {
    if (index === 0) parts.push(stopRow(leg.from));
    parts.push(legLine(leg));
    const next = journey.legs[index + 1];
    if (next) {
      parts.push(stopRow(leg.to));
      const wait = Math.max(0, next.from.time - leg.to.time);
      parts.push(
        `<span class="planner-switch">${formatDuration(wait) || "0 min"} transfer</span>`,
      );
      parts.push(stopRow(next.from));
    } else parts.push(stopRow(leg.to));
  });
  return parts.join("");
}

const PILL = {
  same: "Identical",
  differs: "Differs",
  "only-api": "Only iRail",
  "only-planner": "Only planner",
  dominated: "Not Pareto-optimal",
  outside: "Outside iRail's window",
  window: "Beyond planner's window",
};

// A card is identified by its side and scheduled times, so it stays open (or
// closed) when live updates redraw the results.
const cardKey = (side, journey) =>
  `${side}:${journey.departure}:${journey.arrival}`;

/** Which trains make a journey impossible. */
function cancellationReason(journey) {
  const trains = journey.legs
    .filter((leg) => leg.canceled)
    .map((leg) => `${leg.label || "train"} ${leg.from.name} → ${leg.to.name}`);
  return trains.length
    ? `Not possible: ${trains.join(" and ")} ${trains.length > 1 ? "are" : "is"} canceled`
    : "Not possible: canceled";
}

function journeyCard(journey, row, open, side) {
  const late = lateMinutes(journey.delay) || lateMinutes(journey.arrivalDelay);
  return `
    <article class="result-card is-${row.status}${journey.canceled ? " is-canceled" : ""}${open ? " is-open" : ""}" data-key="${cardKey(side, journey)}">
      <button class="connection-summary" type="button" data-toggle-panel>
        <span>
          <span class="connection-times">
            ${late || journey.canceled ? `<span class="delay-route">!</span>` : ""}
            <span>${formatTime(journey.departure)}</span>${delayBadge(journey.delay)}<span>-&gt;</span><span>${formatTime(journey.arrival)}</span>${delayBadge(journey.arrivalDelay)}
          </span>
          ${journey.canceled ? `<span class="cancel-banner" role="alert">${escapeHtml(cancellationReason(journey))}</span>` : ""}
          <span class="connection-meta">
            <span>${formatDuration(journey.arrival - journey.departure)}</span>
            <span>${transfersLabel(journey.transfers)}</span>
          </span>
          ${row.notes.length ? `<span class="card-notes">${escapeHtml(row.notes.join("; "))}</span>` : ""}
        </span>
        <span class="summary-right"><span class="pill is-${row.status}">${PILL[row.status]}</span></span>
      </button>
      <div class="connection-body"><div class="timeline">${timeline(journey)}</div></div>
    </article>`;
}

function column(kind, title, subtitle, side, rows, error, openKeys) {
  const cards = rows
    .filter((row) => row[side])
    .map((row, index) =>
      journeyCard(
        row[side],
        row,
        openKeys ? openKeys.has(cardKey(side, row[side])) : index === 0,
        side,
      ),
    );
  const body = error
    ? `<div class="alert alert-danger">${escapeHtml(error.message)}</div>`
    : cards.length
      ? `<div class="connections-list">${cards.join("")}</div>`
      : `<div class="empty-column">No journeys found.</div>`;
  return `<div class="compare-column is-${kind}"><h2>${title} <small>${subtitle}</small></h2>${body}</div>`;
}

function verdictHtml(summary, api, planner) {
  if (api.error || planner.error) {
    const failed = [api.error && "iRail API", planner.error && "planner"]
      .filter(Boolean)
      .join(" and ");
    return `<section class="compare-section"><div class="compare-panel verdict is-bad"><strong>${failed} failed</strong><span>The other side's results are still shown below.</span></div></section>`;
  }
  const { apiCount, plannerCount } = summary;
  if (!apiCount && !plannerCount)
    return `<section class="compare-section"><div class="compare-panel verdict is-warn"><strong>Neither found a journey</strong><span>Try another time or date.</span></div></section>`;
  const agree = summary.sameEarliestArrival;
  const clean = !summary.differs && !summary.onlyApi && !summary.onlyPlanner;
  const level = agree && clean ? "" : agree ? "is-warn" : "is-bad";
  const headline = agree
    ? `Same earliest arrival: ${formatTime(summary.apiEarliestArrival)}`
    : `Different earliest arrival: iRail ${summary.apiEarliestArrival ? formatTime(summary.apiEarliestArrival) : "–"}, planner ${summary.plannerEarliestArrival ? formatTime(summary.plannerEarliestArrival) : "–"}`;
  const details = [
    `${summary.same} of ${apiCount} iRail journeys found identically`,
    summary.differs ? `${summary.differs} with another arrival` : "",
    summary.dominated
      ? `${summary.dominated} slower ${summary.dominated === 1 ? "one" : "ones"} omitted by the planner`
      : "",
    summary.beyondWindow
      ? `${summary.beyondWindow} beyond the planner's search window`
      : "",
    summary.onlyApi ? `${summary.onlyApi} only in iRail` : "",
    summary.onlyPlanner ? `${summary.onlyPlanner} only in planner` : "",
    summary.outside
      ? `${summary.outside} planner ${summary.outside === 1 ? "journey" : "journeys"} outside iRail's window`
      : "",
  ].filter(Boolean);
  return `<section class="compare-section"><div class="compare-panel verdict ${level}"><strong>${headline}</strong><span>${details.join(" · ")}</span></div></section>`;
}

function barRow(title, subtitle, kind, bars, max) {
  return `
    <div class="timing-row is-${kind}">
      <h3>${title}<small>${subtitle}</small></h3>
      <div class="timing-bars">${bars
        .map(
          ({ label, ms, note }) => `
        <div class="timing-item">
          <span class="label">${escapeHtml(label)}${note ? ` · ${escapeHtml(note)}` : ""}</span>
          <div class="timing-bar">
            <span class="track"><span class="fill" style="width:${ms === undefined ? 0 : Math.max(0.5, (ms / max) * 100).toFixed(1)}%"></span></span>
            <span class="value">${formatMs(ms)}</span>
          </div>
        </div>`,
        )
        .join("")}</div>
    </div>`;
}

function timingHtml(t) {
  const load = (result) => {
    const d = result?.value?.diagnostics;
    const ms = (d?.forward?.loadMs ?? 0) + (d?.backward?.loadMs ?? 0);
    return ms >= 5 ? `${formatMs(ms)} loading timetable pages` : "";
  };
  const scanned = t.plan1?.value?.scanned;
  const values = [t.api1.ms, t.api2?.ms, t.plan1.ms, t.plan2?.ms].filter(
    (v) => v !== undefined,
  );
  const max = Math.max(...values, 1);
  const rows = [
    barRow(
      "iRail API",
      "api.irail.be · realtime",
      "api",
      [
        {
          label: "first request",
          ms: t.api1.error ? undefined : t.api1.ms,
          note: t.api1.error ? "failed" : `${t.api1.value.length} results`,
        },
        {
          label: "same request again",
          ms: t.api2 && !t.api2.error ? t.api2.ms : undefined,
        },
      ],
      max,
    ),
    barRow(
      "Planner",
      "in your browser · realtime",
      "planner",
      [
        {
          label: "first search",
          ms: t.plan1.error ? undefined : t.plan1.ms,
          note: t.plan1.error
            ? "failed"
            : [scanned ? `${scanned.toLocaleString()} connections scanned` : "", load(t.plan1)]
                .filter(Boolean)
                .join(", "),
        },
        {
          label: "same search again (timetable pages cached)",
          ms: t.plan2 && !t.plan2.error ? t.plan2.ms : undefined,
        },
      ],
      max,
    ),
  ];
  const notes = [];
  const apiRepeat = t.api2 && !t.api2.error ? t.api2.ms : undefined;
  const planRepeat = t.plan2 && !t.plan2.error ? t.plan2.ms : undefined;
  if (apiRepeat !== undefined && planRepeat !== undefined) {
    const ratio = apiRepeat / planRepeat;
    notes.push(
      ratio >= 1
        ? `Repeated, the planner answered ${ratio.toFixed(1)}× faster than the API.`
        : `Repeated, the API answered ${(1 / ratio).toFixed(1)}× faster than the planner.`,
    );
  }
  if (t.api1.ms !== undefined && t.plan1.ms !== undefined && !t.api1.error && !t.plan1.error)
    notes.push(
      t.plan1.ms <= t.api1.ms
        ? `First requests: the planner was ${(t.api1.ms / t.plan1.ms).toFixed(1)}× faster.`
        : `First requests: the API was ${(t.plan1.ms / t.api1.ms).toFixed(1)}× faster, because the planner first had to download timetable pages.`,
    );
  notes.push(
    `Planner start-up took ${formatMs(state.initMs)} once per page load (manifest, stations, routes and trips).`,
  );
  const apis = state.history.map((h) => h.api).filter((v) => v !== undefined);
  const plans = state.history.map((h) => h.planner).filter((v) => v !== undefined);
  if (state.history.length > 1 && apis.length && plans.length)
    notes.push(
      `Median over ${state.history.length} searches in this session (repeat requests): API ${formatMs(median(apis))}, planner ${formatMs(median(plans))}.`,
    );
  notes.push(
    "Network speed, your device and server load change these numbers; treat them as one sample.",
  );
  return `
    <section class="compare-section">
      <h2>Speed</h2>
      <div class="compare-panel">
        <div class="timing-rows">${rows.join("")}</div>
        <div class="timing-notes">${notes.map((n) => `<p>${escapeHtml(n)}</p>`).join("")}</div>
      </div>
    </section>`;
}

// Station names shown for a journey come from the station table, in the chosen
// language (the two sources spell and translate stations differently), then the
// two result sets are diffed.
function analyse(run) {
  for (const journey of [...run.apiJourneys, ...run.plannerJourneys])
    for (const leg of journey.legs)
      for (const point of [leg.from, leg.to]) {
        const station = state.byKey.get(point.key);
        if (station) point.name = stationLabel(station, state.language);
      }
  run.comparison = compareJourneys(run.apiJourneys, run.plannerJourneys, {
    plannerWindow: run.planner.error ? undefined : run.planner.value.window,
  });
}

function render(run, openKeys) {
  const { api, planner, comparison, timings } = run;
  const rows = comparison.rows;
  els.results.innerHTML = [
    verdictHtml(comparison.summary, api, planner),
    timingHtml(timings),
    `<section class="compare-section"><div class="compare-columns">${column("api", "iRail API", "realtime", "api", rows, api.error, openKeys)}${column("planner", "Planner", "realtime", "planner", rows, planner.error, openKeys)}</div></section>`,
  ].join("");
  enhance();
}

/**
 * Turn the placeholders of a drawn result list into buttons: a station opens
 * its liveboard, a train the run it makes that day (under its leg). Which runs
 * are open survives a redraw.
 */
function enhance() {
  for (const card of els.results.querySelectorAll(".result-card")) {
    for (const node of card.querySelectorAll("[data-station]"))
      node.replaceChildren(
        trains.stationButton({
          id: apiStationId(node.dataset.station),
          name: node.dataset.name,
        }),
      );
    for (const node of card.querySelectorAll("[data-vehicle]")) {
      const { vehicle: id, name, date, from, to } = node.dataset;
      const line = node.closest(".planner-train");
      node.replaceChildren(
        trains.vehicleButton({
          vehicle: { id, name },
          date: new Date(Number(date)),
          highlight: from && to ? { from: apiStationId(from), to: apiStationId(to) } : undefined,
          key: `cmp|${card.dataset.key}|${id}|${from}`,
          panelHost: line.nextElementSibling,
        }),
      );
    }
  }
}

els.results.addEventListener("click", (event) => {
  const button = event.target.closest("[data-toggle-panel]");
  if (button) button.closest(".result-card").classList.toggle("is-open");
});

// ---------------------------------------------------------------- search

function showAlert(type, message) {
  els.alert.innerHTML = `<div class="alert alert-${type}">${escapeHtml(message)}</div>`;
}

function updateUrl(from, to, epoch) {
  const p = new URLSearchParams(location.search);
  const parts = zonedParts(epoch);
  p.set("from", from.key);
  p.set("to", to.key);
  p.set("date", `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`);
  p.set("time", `${pad(parts.hour)}:${pad(parts.minute)}`);
  try {
    history.replaceState(null, "", `?${p}`);
  } catch {
    // The address bar is a convenience only.
  }
}

/** Both result sets in the shape the diff and the cards use, analysed. */
function buildRun(api, planner, extra) {
  const names = state.source.stops.name;
  const ids = state.source.stops.id;
  const run = {
    ...extra,
    api,
    planner,
    apiJourneys: api.error ? [] : api.value.map(normalizeApiConnection),
    plannerJourneys: planner.error
      ? []
      : planner.value.options.map((option) =>
          normalizePlannerJourney(option, { names, ids }),
        ),
  };
  analyse(run);
  return run;
}

async function search() {
  if (state.running || !state.planner) return;
  els.alert.innerHTML = "";
  for (const input of [els.time, els.date]) validateDateTime(input);
  if (!els.form.reportValidity()) return;
  const from = stationFromInput(els.from, state.from);
  const to = stationFromInput(els.to, state.to);
  if (!from || !to) {
    showAlert(
      "danger",
      "We could not translate your text to a station. Pick a suggested station and try again.",
    );
    return;
  }
  if (from.key === to.key) {
    showAlert("info", "The departure and destination station are the same.");
    return;
  }
  Object.assign(state, { from, to });
  showStationNames();
  const departureAfter = departureEpoch();
  const maxWalkMeters = Math.min(
    5000,
    Math.max(0, Math.round(Number(els.walk.value) || 0)),
  );
  updateUrl(from, to, departureAfter);

  state.running = true;
  els.search.disabled = true;
  els.results.innerHTML = `<div class="compare-panel loading-inline"><div class="loader">Loading...</div><span id="run-step">Asking api.irail.be…</span></div>`;
  const step = (text) => {
    const target = el("run-step");
    if (target) target.textContent = text;
  };
  try {
    const apiUrl = apiConnectionsUrl({
      fromKey: from.key,
      toKey: to.key,
      departureAfter,
      language: state.language,
    });
    const query = {
      origin: { sourceId: state.source.id, stopIdx: from.stopIdx },
      destination: { sourceId: state.source.id, stopIdx: to.stopIdx },
      departureAfter,
      maxWalkMeters,
      windowMode: els.window.value,
      // Like the API's six results: keep searching past the window until found.
      minOptions: 6,
      sourceIds: [state.source.id],
    };
    // Sequential on purpose: concurrent runs would distort each other's timing.
    const api1 = await callApi(apiUrl);
    step("Planning with the planner library…");
    const plan1 = await callPlanner(query);

    const run = buildRun(api1, plan1, { timings: { api1, plan1 }, apiUrl, query });
    state.lastRun = run;
    render(run);

    // Repeat both so each side is also measured warm (connection reuse for the
    // API, cached timetable pages for the planner).
    const api2 = await callApi(apiUrl);
    const plan2 = await callPlanner(query);
    run.timings = { api1, plan1, api2, plan2 };
    state.history.push({
      api: api2.error ? undefined : api2.ms,
      planner: plan2.error ? undefined : plan2.ms,
    });
    render(run);
  } catch (error) {
    console.error(error);
    els.results.innerHTML = "";
    showAlert("danger", error.message || "Request failed");
  } finally {
    state.running = false;
    els.search.disabled = false;
    if (state.pendingRefresh) refreshResults();
  }
}

// ----------------------------------------------------------- live updates

/**
 * Ask both sides again for the search on screen and redraw in place: cards the
 * reader opened stay open, and the speed figures of the first search stay.
 */
async function refreshResults() {
  const previous = state.lastRun;
  if (!previous?.query || !state.planner) return;
  if (state.running) {
    state.pendingRefresh = true;
    return;
  }
  state.pendingRefresh = false;
  state.running = true;
  try {
    // One after the other, like the first search, so neither slows the other.
    const api = await callApi(previous.apiUrl);
    const planner = await callPlanner(previous.query);
    const open = new Set(
      [...els.results.querySelectorAll(".result-card.is-open")].map(
        (card) => card.dataset.key,
      ),
    );
    const run = buildRun(api, planner, {
      timings: previous.timings,
      apiUrl: previous.apiUrl,
      query: previous.query,
      updatedAt: Date.now(),
    });
    state.lastRun = run;
    render(run, open);
    showLive("live", "flash");
  } catch (error) {
    console.error(error);
  } finally {
    state.running = false;
    if (state.pendingRefresh) refreshResults();
  }
}

function liveSummary() {
  const feed = state.feed;
  if (!feed?.supported) return "";
  return `Real-time feed of ${formatClock(feed.timestamp * 1000)} · ${feed.delayed} delayed and ${feed.canceled} canceled trips`;
}

// kind: live | stale | off
function showLive(kind, flash) {
  els.live.hidden = false;
  els.live.classList.toggle("is-live", kind === "live");
  els.live.classList.toggle("is-stale", kind === "stale");
  const parts = [liveSummary()];
  if (kind === "stale")
    parts.push("could not reach the feed, showing the last data");
  else if (kind === "off") parts.push("automatic updates are off");
  else {
    if (state.checkedAt) parts.push(`checked ${formatClock(state.checkedAt)}`);
    if (state.lastRun?.updatedAt)
      parts.push(`results updated ${formatClock(state.lastRun.updatedAt)}`);
    if (kind === "live") parts.push("checking every 30 s");
  }
  els.liveText.textContent = parts.filter(Boolean).join(" · ");
  if (flash) {
    els.live.classList.add("is-flash");
    setTimeout(() => els.live.classList.remove("is-flash"), 1500);
  }
}

function startWatching({ immediate = false } = {}) {
  stopWatching();
  if (!els.liveToggle.checked || document.hidden || !state.feed?.supported)
    return;
  const watcher = state.planner.watchRealtime({
    intervalMs: LIVE_INTERVAL_MS,
    immediate,
  });
  watcher.addEventListener("poll", (event) => {
    state.feed = event.detail[0];
    state.checkedAt = Date.now();
    showLive("live");
    trains.refreshBoard();
  });
  watcher.addEventListener("update", () => {
    refreshResults();
    trains.refresh();
  });
  watcher.addEventListener("error", () => showLive("stale"));
  state.watcher = watcher;
}

function stopWatching() {
  state.watcher?.stop();
  state.watcher = null;
}

els.liveToggle.addEventListener("change", () => {
  if (els.liveToggle.checked) {
    startWatching({ immediate: true });
    showLive("live");
  } else {
    stopWatching();
    showLive("off");
  }
});

els.liveNow.addEventListener("click", async () => {
  els.liveNow.disabled = true;
  try {
    // Re-ask both sides, even if the planner's feed has not changed: the
    // iRail API may have.
    const [status] = await state.planner.refreshRealtime();
    state.feed = status;
    state.checkedAt = Date.now();
    await refreshResults();
    showLive(els.liveToggle.checked ? "live" : "off");
  } catch (error) {
    console.error(error);
    showLive("stale");
  } finally {
    els.liveNow.disabled = false;
  }
});

// A hidden tab does not poll; coming back checks at once.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopWatching();
  else startWatching({ immediate: true });
});

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  search();
});

// ------------------------------------------------------------------ init

function clampToCoverage(now) {
  const { start, end } = state.coverage;
  if (now < start) return start;
  if (now > end) return Math.max(start, end - 24 * 3600);
  return now;
}

async function init() {
  setDateTime(Math.floor(Date.now() / 1000));
  try {
    const url = resolveDataUrl(dataUrl, location.href, document.baseURI);
    el("data-source").innerHTML = `Planner data: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    state.planner = new PlannerClient(createPlannerWorker());
    const started = performance.now();
    // The station table (translations, traffic) loads next to the timetable.
    const stationRows = loadStationRows(url).catch((error) => {
      console.warn("Station translations unavailable:", error);
      return null;
    });
    const [source] = await state.planner.request("init", { dataUrl: url });
    state.initMs = performance.now() - started;
    if (!source) throw new Error("no source could be loaded");
    state.source = source;
    const rows = await stationRows;
    state.stations = buildStations({
      rows: rows ?? [],
      ids: source.stops.id,
      names: source.stops.name,
      searchable: source.stopFamily.searchable,
    });
    state.byKey = new Map(state.stations.map((s) => [s.key, s]));
    if (!state.stations.length)
      throw new Error(
        "this timetable has no NMBS/SNCB stations, which the iRail API needs. Use the iRail CDN data",
      );
    state.coverage = {
      start: Date.parse(source.manifest.coverageStart) / 1000,
      end: Date.parse(source.manifest.coverageEnd) / 1000,
    };

    const params = new URLSearchParams(location.search);
    const byKey = (key) => state.byKey.get(key);
    const fromParam = byKey(stationKey(`/stops/${params.get("from")}`) ?? "");
    const toParam = byKey(stationKey(`/stops/${params.get("to")}`) ?? "");
    const date = dateInputToIso(isoToDateInput(params.get("date") ?? ""));
    const time = isValidTimeInput(params.get("time") ?? "") ? params.get("time") : "";
    if (date && time) {
      els.date.value = isoToDateInput(date);
      els.time.value = time;
    } else setDateTime(clampToCoverage(Math.floor(Date.now() / 1000)));
    // Gent-Sint-Pieters → Liège-Guillemins unless the address says otherwise.
    state.from = fromParam ?? byKey("8892007") ?? null;
    state.to = toParam ?? byKey("8841004") ?? null;
    showStationNames();
    for (const input of [els.from, els.to, els.search]) input.disabled = false;

    els.status.textContent = `Planner ready: ${state.stations.length.toLocaleString()} stations loaded in ${formatMs(state.initMs)}${rows ? "" : "; station translations unavailable, showing the timetable's own names"}.`;
    // The planner loaded the real-time feed while starting; this reads its
    // status (and checks for anything newer), then keeps checking.
    try {
      [state.feed] = await state.planner.refreshRealtime();
      state.checkedAt = Date.now();
    } catch (error) {
      console.warn("Real-time feed unavailable:", error);
    }
    if (state.feed?.supported) {
      showLive("live");
      startWatching();
    } else
      els.status.textContent +=
        " This timetable has no real-time feed, so results use the schedule.";
    if (fromParam && toParam) search();
  } catch (error) {
    console.error(error);
    els.status.className = "alert alert-danger";
    els.status.textContent = `Could not load the planner's timetable: ${error.message}`;
  }
}

init();
