// Trains and stations you can click on a journey: a train (IC 502) opens the
// run it makes that day, a station opens its real-time liveboard. Both are
// answered by the planner's iRail-style calls, so they show the same delays,
// platforms and cancellations as the journeys.

import "./trains.css";
import { stationKey } from "../src/irail-stations.mjs";

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/gu,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const formatClock = (date) => clock.format(date);

const lateMinutes = (seconds) => (seconds > 0 ? Math.round(seconds / 60) : 0);
const delayBadge = (seconds) =>
  lateMinutes(seconds)
    ? `<span class="delay">+${lateMinutes(seconds)}'</span>`
    : "";
const platformBadge = (platform) =>
  platform ? `<span class="platform">${escapeHtml(platform)}</span>` : "";
const canceledTag = (canceled) =>
  canceled ? `<span class="canceled-tag">Canceled</span>` : "";

/** A time with its delay: the scheduled time struck out when late, then the expected one. */
function timeHtml(date, delay) {
  if (!date) return "";
  const late = lateMinutes(delay);
  if (!late) return formatClock(date);
  const expected = new Date(date.getTime() + delay * 1000);
  return `<s class="was">${formatClock(date)}</s> ${formatClock(expected)}${delayBadge(delay)}`;
}

/**
 * What to ask the planner for a stop of a journey: the iRail station (the
 * stop's platform resolves to its station) or, for stops that are not NMBS
 * stations, the stop's name.
 */
export function stationRefOf(stopIri, name) {
  const key = stationKey(stopIri);
  return { id: key ? `BE.NMBS.${key.padStart(9, "0")}` : name, name };
}

export { serviceDayInstant } from "./service-day.mjs";

/**
 * `request` is `(type, payload) => Promise` of the planner (worker client);
 * `language` optionally returns `nl`, `fr`, `en` or `de` for station names.
 * Returns the buttons to put in a journey and `refresh()` for when the
 * real-time feed changed.
 */
export function createTrainViews({ request: ask, language }) {
  // `language` (a function) picks the language of the station names.
  const request = (type, payload) =>
    ask(type, language ? { ...payload, language: language() } : payload);
  const openTrips = new Set(); // keys of trip panels the reader opened
  const livePanels = new Set(); // panels on screen, to refresh them

  // ------------------------------------------------------------------- trips

  /**
   * The stops of a train on one day. `highlight` ({ from, to }, station ids)
   * marks the part a journey rides; each is a station id or stop IRI.
   */
  function tripPanel({ vehicle, date, highlight }) {
    const panel = document.createElement("div");
    panel.className = "trip-panel";
    let revision = 0;
    async function load() {
      const mine = (revision += 1);
      try {
        const result = await request("vehicle", { id: vehicle.id, date });
        if (mine !== revision) return;
        panel.innerHTML = tripHtml(result, highlight);
        wireStations(panel);
      } catch (error) {
        if (mine !== revision) return;
        panel.textContent = `Could not load ${vehicle.name}: ${error.message}`;
      }
    }
    panel.textContent = `Loading ${vehicle.name}…`;
    panel.refresh = load;
    livePanels.add(panel);
    load();
    return panel;
  }

  function tripHtml(result, highlight) {
    const stops = result.stops;
    const sameStation = (stop, wanted) =>
      stop.station.id === wanted ||
      (stationKey(wanted) !== null &&
        stationKey(stop.station.id) === stationKey(wanted));
    const first = highlight
      ? stops.findIndex((stop) => sameStation(stop, highlight.from))
      : -1;
    const last =
      first < 0
        ? -1
        : stops.findIndex((stop, i) => i > first && sameStation(stop, highlight.to));
    const rows = stops.map((stop, i) => {
      const ridden = first >= 0 && last >= 0 && i >= first && i <= last;
      const classes = [
        ridden ? "ridden" : "",
        stop.canceled ? "canceled" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const arrival = stop.arrival
        ? timeHtml(stop.arrival, stop.arrivalDelay)
        : "";
      const departure = stop.departure
        ? timeHtml(stop.departure, stop.departureDelay)
        : "";
      // The time of a stop is when the train leaves it; the last one has only an arrival.
      const time = departure || arrival;
      return `<li class="${classes}">
  <span class="trip-time">${time}</span>
  <button type="button" class="stop-link" data-station="${escapeHtml(stop.station.id)}" data-name="${escapeHtml(stop.station.name)}">${escapeHtml(stop.station.name)}</button>
  ${platformBadge(stop.platform)}${canceledTag(stop.canceled)}
</li>`;
    });
    const day = stops[0]?.departure?.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    return `<div class="trip-head">${escapeHtml(result.vehicle.name)}${day ? ` · ${escapeHtml(day)}` : ""}</div><ol class="trip-stops">${rows.join("")}</ol>`;
  }

  /**
   * A button with the train's name. Clicking it shows or hides the run of the
   * train on that day in `panelHost` (an element right after the button's row).
   * `key` keeps the panel open when the journeys are drawn again.
   */
  function vehicleButton({ vehicle, date, highlight, key, panelHost }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vehicle-link";
    button.textContent = vehicle.name || vehicle.id;
    button.title = `Show the trip of ${vehicle.name} on this day`;
    button.setAttribute("aria-expanded", "false");
    let panel = null;
    const open = () => {
      panel = tripPanel({ vehicle, date, highlight });
      panelHost.appendChild(panel);
      button.setAttribute("aria-expanded", "true");
      openTrips.add(key);
    };
    const close = () => {
      livePanels.delete(panel);
      panel.remove();
      panel = null;
      button.setAttribute("aria-expanded", "false");
      openTrips.delete(key);
    };
    button.addEventListener("click", (event) => {
      event.stopPropagation(); // the card around it selects the journey
      if (panel) close();
      else open();
    });
    if (openTrips.has(key)) open();
    return button;
  }

  // ---------------------------------------------------------------- liveboard

  const dialog = document.createElement("dialog");
  dialog.className = "liveboard";
  dialog.setAttribute("aria-labelledby", "liveboard-title");
  dialog.innerHTML = `
<div class="liveboard-head">
  <h2 id="liveboard-title"></h2>
  <button type="button" class="liveboard-close" aria-label="Close">×</button>
</div>
<div class="liveboard-tabs" role="group" aria-label="Board type">
  <button type="button" data-type="departure" aria-pressed="true">Departures</button>
  <button type="button" data-type="arrival" aria-pressed="false">Arrivals</button>
</div>
<div class="liveboard-body" aria-live="polite"></div>
<p class="liveboard-foot"></p>`;
  document.body.appendChild(dialog);
  const title = dialog.querySelector("#liveboard-title");
  const body = dialog.querySelector(".liveboard-body");
  const foot = dialog.querySelector(".liveboard-foot");
  const board = { station: null, name: "", type: "departure", revision: 0 };

  dialog
    .querySelector(".liveboard-close")
    .addEventListener("click", () => dialog.close());
  // A click on the backdrop is a click on the dialog element itself.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  for (const tab of dialog.querySelectorAll(".liveboard-tabs button"))
    tab.addEventListener("click", () => {
      board.type = tab.dataset.type;
      for (const other of dialog.querySelectorAll(".liveboard-tabs button"))
        other.setAttribute("aria-pressed", String(other === tab));
      loadBoard();
    });

  async function loadBoard({ quiet = false } = {}) {
    const mine = (board.revision += 1);
    if (!quiet) body.textContent = "Loading…";
    try {
      const result = await request("liveboard", {
        station: board.station,
        type: board.type,
      });
      if (mine !== board.revision) return;
      title.textContent = result.station.name;
      board.name = result.station.name;
      renderBoard(result);
      foot.textContent = `Next hour · updated ${formatClock(new Date())}`;
    } catch (error) {
      if (mine !== board.revision) return;
      body.textContent = `Could not load the liveboard: ${error.message}`;
      foot.textContent = "";
    }
  }

  function renderBoard(result) {
    const arrivals = result.type === "arrival";
    body.innerHTML = "";
    if (!result.entries.length) {
      body.textContent = `No ${arrivals ? "arrivals" : "departures"} in the next hour.`;
      return;
    }
    const list = document.createElement("ul");
    list.className = "board-list";
    for (const entry of result.entries) {
      const item = document.createElement("li");
      item.className = entry.canceled ? "canceled" : "";
      const other = arrivals ? entry.origin : entry.destination;
      const row = document.createElement("div");
      row.className = "board-row";
      row.innerHTML = `<span class="trip-time">${timeHtml(entry.time, entry.delay)}</span>`;
      const train = document.createElement("span");
      train.className = "board-train";
      const host = document.createElement("div");
      train.appendChild(
        vehicleButton({
          vehicle: entry.vehicle,
          date: entry.time,
          key: `board|${entry.vehicle.id}|${entry.time.getTime()}`,
          panelHost: host,
        }),
      );
      row.appendChild(train);
      row.appendChild(
        stationButton(other, { className: "board-place" }),
      );
      const tail = document.createElement("span");
      tail.className = "board-tail";
      tail.innerHTML = `${platformBadge(entry.platform)}${canceledTag(entry.canceled)}`;
      row.appendChild(tail);
      item.append(row, host);
      list.appendChild(item);
    }
    body.appendChild(list);
  }

  /** Show the real-time liveboard of a station (`{ id, name }`). */
  function openLiveboard(station) {
    board.station = station.id;
    board.name = station.name;
    title.textContent = station.name;
    if (!dialog.open) dialog.showModal();
    loadBoard();
  }

  function stationButton(station, { className = "stop-link" } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className === "stop-link" ? className : `stop-link ${className}`;
    button.textContent = station.name;
    button.title = `Liveboard of ${station.name}`;
    button.addEventListener("click", (event) => {
      event.stopPropagation(); // the card around it selects the journey
      openLiveboard(station);
    });
    return button;
  }

  // Stations in an already rendered trip panel carry their id in data attributes.
  function wireStations(root) {
    for (const button of root.querySelectorAll("button.stop-link")) {
      button.title = `Liveboard of ${button.dataset.name}`;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        openLiveboard({ id: button.dataset.station, name: button.dataset.name });
      });
    }
  }

  /** The real-time feed changed: load what is open again. */
  function refresh() {
    for (const panel of livePanels) {
      if (panel.isConnected) panel.refresh();
      else livePanels.delete(panel);
    }
    refreshBoard();
  }

  /** The board covers the next hour, so it moves on with every check. */
  function refreshBoard() {
    if (dialog.open) loadBoard({ quiet: true });
  }

  return { vehicleButton, stationButton, refresh, refreshBoard };
}
