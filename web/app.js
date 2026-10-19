// Double-click zoom is off: its two clicks would also move the report position.
const map = L.map("map", {
  zoomControl: true,
  doubleClickZoom: false,
  minZoom: 2,
  maxZoom: 18,
  maxBounds: [[-85, -Infinity], [85, Infinity]],
  maxBoundsViscosity: 1,
});
map.setView([59.9139, 10.7522], 12); // Oslo until GPS finds the user.

const mapStatus = document.querySelector("#mapStatus");
const tiles = createBasemap(map, mapStatus);

const state = {
  selectedLatLng: null,
  selectionMarker: null,
  currentLocationMarker: null,
  currentLocationAccuracy: null,
  sightingsLayer: L.layerGroup().addTo(map),
  user: null,
  stats: null,
  authOpen: false,
  hasAutoCentered: false,
  watchId: null,
  selectionFollowsGps: false,
  manualChanges: 0, // Spots and stops the user picks or types; a pending button press yields to them.
};

const reportForm = document.querySelector("#reportForm");
const stopInput = document.querySelector("#stopInput");
const routeInput = document.querySelector("#routeInput");
const noteInput = document.querySelector("#noteInput");
const formStatus = document.querySelector("#formStatus");
const feedStatus = document.querySelector("#feedStatus");
const feed = document.querySelector("#feed");
const stopOptions = document.querySelector("#stopOptions");
const routeOptions = document.querySelector("#routeOptions");
const locateBtn = document.querySelector("#locateBtn");
const ttlLabel = document.querySelector("#ttlLabel");
const loginForm = document.querySelector("#loginForm");
const registerForm = document.querySelector("#registerForm");
const logoutBtn = document.querySelector("#logoutBtn");
const authForms = document.querySelector("#authForms");
const userPanel = document.querySelector("#userPanel");
const currentUsername = document.querySelector("#currentUsername");
const authStatus = document.querySelector("#authStatus");
const authToggle = document.querySelector("#authToggle");
const authContent = document.querySelector("#authContent");
const menuToggle = document.querySelector("#menuToggle");
const sidePanel = document.querySelector("#sidePanel");
const menuBackdrop = document.querySelector("#menuBackdrop");
const mobilePublish = document.querySelector("#mobilePublish");
const mobileFormStatus = document.querySelector("#mobileFormStatus");
const shell = document.querySelector(".shell");
const wideLayout = typeof matchMedia === "function" ? matchMedia("(min-width: 1200px)") : null;
let menuOpen = false;

function toggleMenu(open = !menuOpen) {
  menuOpen = open;
  shell.classList.toggle("menu-closed", !open);
  sidePanel.classList.toggle("is-open", open);
  menuBackdrop.hidden = !open;
  menuToggle.hidden = open;
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Lukk meny" : "Åpne meny");
  if (open) toggleAuth(false);
  map.invalidateSize();
}

// On wide screens the sidebar starts open; narrower screens start with the map.
toggleMenu(Boolean(wideLayout?.matches));
wideLayout?.addEventListener("change", (event) => toggleMenu(event.matches));

menuToggle.addEventListener("click", () => {
  toggleMenu(true);
  document.querySelector("#menuClose").focus();
});
document.querySelector("#menuClose").addEventListener("click", () => {
  toggleMenu(false);
  menuToggle.focus();
});
menuBackdrop.addEventListener("click", () => toggleMenu(false));
// Keyboard dismissal also works when focus is inside either panel.
[sidePanel, authContent].forEach((panel) => panel.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (panel === authContent && state.authOpen) {
    toggleAuth(false);
    authToggle.focus();
  } else if (menuOpen) {
    toggleMenu(false);
    menuToggle.focus();
  }
}));
const userLevel = document.querySelector("#userLevel");
const userXp = document.querySelector("#userXp");
const userConfirmations = document.querySelector("#userConfirmations");
const xpProgressWrap = document.querySelector("#xpProgressWrap");
const xpProgress = document.querySelector("#xpProgress");
const xpProgressText = document.querySelector("#xpProgressText");

// A suggestion list under a text field, used instead of <datalist>: browsers hide every datalist
// option that does not contain the typed text, such as a stop found by its street or "31 Ruter".
// `choose` gets the picked item.
function suggestionList(input, list, choose) {
  let items = [];
  let active = -1;
  let open = false; // Typing and the Down arrow open the list; Escape, leaving the field and a pick close it.
  function render(index = -1) {
    active = index;
    const shown = open && items.length > 0;
    list.hidden = !shown;
    input.setAttribute("aria-expanded", String(shown));
    input.setAttribute("aria-activedescendant", shown && active >= 0 ? `${list.id}-${active}` : "");
    list.innerHTML = shown
      ? items
        .map((item, i) => `<li id="${list.id}-${i}" role="option" data-index="${i}" aria-selected="${i === active}">` +
          `${escapeHtml(item.label)}</li>`)
        .join("")
      : "";
    list.querySelector(`[aria-selected="true"]`)?.scrollIntoView?.({ block: "nearest" });
  }
  function pick(index) {
    const item = items[index];
    items = [];
    open = false;
    render();
    choose(item);
  }
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      open = false; // Also while a search is loading, so its answer does not open the list.
      render();
      return;
    }
    if (!items.length) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = open ? (active + 1) % items.length : 0;
      open = true;
      render(next);
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      render(active > 0 ? active - 1 : items.length - 1);
    } else if (event.key === "Enter" && open && active >= 0) {
      event.preventDefault(); // Picks the option instead of publishing the report.
      pick(active);
    }
  });
  // Keeps focus in the field while an option is clicked, so the blur below does not close the list first.
  list.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[data-index]");
    if (option) {
      pick(Number(option.dataset.index));
    }
  });
  input.addEventListener("blur", () => {
    open = false;
    render();
  });
  return {
    // What was just typed makes the old suggestions wrong, before the new ones arrive.
    typed() {
      items = [];
      open = true;
      render();
    },
    // A late answer fills a list the user has closed without opening it again.
    show(newItems) {
      items = newItems;
      render();
    },
    close() {
      items = [];
      open = false;
      render();
    },
  };
}

const stopSuggestions = suggestionList(stopInput, stopOptions, (choice) => {
  outdate("stop");
  stopInput.value = choice.label;
  selectStop(choice);
});
let routePicked = false; // A picked line stays; typed text is searched again when the report moves.
const routeSuggestions = suggestionList(routeInput, routeOptions, (route) => {
  outdate("route");
  routeInput.value = route.value;
  routePicked = true;
});

const REQUEST_TIMEOUT_MS = 15000;

// A request that gets no answer, such as on a dead mobile connection, fails after REQUEST_TIMEOUT_MS.
async function fetchJson(url, { signal, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort());
  try {
    const response = await fetch(url, { credentials: "same-origin", ...options, signal: controller.signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Klarte ikke å hente data.");
    }
    return await response.json();
  } catch (error) {
    // A timeout aborts, and fetch rejects with a TypeError when the network fails.
    if (!signal?.aborted && (error.name === "AbortError" || error instanceof TypeError)) {
      throw new Error("Fikk ikke svar fra serveren. Sjekk nettet og prøv igjen.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function postJson(url, body) {
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Only the newest request of each kind may update the page; older answers are dropped.
const latest = { me: 0, sightings: 0, nearby: 0, stop: 0, route: 0 };
const controllers = {};

// Outdates the running request of this kind and aborts it, so nothing waits for its answer.
function outdate(kind) {
  latest[kind]++;
  controllers[kind]?.abort();
}

async function fetchLatest(kind, url) {
  outdate(kind);
  const request = latest[kind];
  const controller = (controllers[kind] = new AbortController());
  try {
    const payload = await fetchJson(url, { signal: controller.signal });
    return request === latest[kind] ? payload : null;
  } catch (error) {
    if (request === latest[kind]) {
      throw error;
    }
    return null;
  }
}

function formatAge(isoString) {
  const deltaMinutes = Math.max(0, Math.round((Date.now() - new Date(isoString).getTime()) / 60000));
  if (deltaMinutes < 1) {
    return "akkurat nå";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes} min siden`;
  }
  const hours = Math.floor(deltaMinutes / 60);
  const minutes = deltaMinutes % 60;
  return minutes ? `${hours} t ${minutes} min siden` : `${hours} t siden`;
}

function confirmations(count) {
  return `${count} ${count === 1 ? "bekreftelse" : "bekreftelser"}`;
}

function formatDistance(metres) {
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1).replace(".", ",")} km`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

let statusVersion = 0;
let statusSource = "";
let statusTimer;

function setStatus(message, type = "", source = "") {
  clearTimeout(statusTimer);
  statusVersion++;
  statusSource = source;
  formStatus.textContent = message;
  formStatus.className = type ? `status ${type}` : "status";
  mobileFormStatus.textContent = message;
  mobileFormStatus.className = formStatus.className;
  if (message) {
    const version = statusVersion;
    statusTimer = setTimeout(() => {
      if (statusVersion === version) setStatus("");
    }, 3000);
  }
}

// For answers that can arrive late, such as GPS or suggestions: the returned function shows a
// message only if no newer one, such as a published report, was shown in the meantime.
function lateStatus(source = "") {
  const before = statusVersion;
  return (message, type) => statusVersion === before && setStatus(message, type, source);
}

function setAuthStatus(message, type = "") {
  authStatus.textContent = message;
  authStatus.className = type ? `status ${type}` : "status";
}

function makeIcon(className) {
  return L.divIcon({
    className: "",
    html: `<div class="${className}">${className.startsWith("bee-dot") ? '<svg viewBox="0 0 40 40" aria-hidden="true"><use href="#bee-mark" /></svg>' : ""}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function markerAgeClass(isoString) {
  const ageMinutes = Math.max(0, (Date.now() - new Date(isoString).getTime()) / 60000);
  if (ageMinutes <= 10) {
    return "bee-dot danger";
  }
  if (ageMinutes <= 30) {
    return "bee-dot warning";
  }
  return "bee-dot safe";
}

function toggleAuth(open = !state.authOpen) {
  if (open && menuOpen && !wideLayout?.matches) toggleMenu(false);
  state.authOpen = open;
  authContent.hidden = !open;
  authContent.classList.toggle("hidden", !open);
  authToggle.setAttribute("aria-expanded", String(open));
  authToggle.setAttribute("aria-label", open ? "Lukk profil" : "Åpne profil");
}

function setUser(user, stats = null) {
  state.user = user;
  state.stats = stats;
  updateAuthUi();
}

function updateAuthUi() {
  const loggedIn = Boolean(state.user);
  authContent.classList.toggle("is-logged-in", loggedIn);
  authForms.classList.toggle("hidden", loggedIn);
  userPanel.classList.toggle("hidden", !loggedIn);
  currentUsername.textContent = loggedIn ? state.user.username : "";
  userLevel.textContent = `Level ${state.stats?.level ?? 1}`;
  userXp.textContent = `${state.stats?.xp ?? 0} XP`;
  userConfirmations.textContent = confirmations(state.stats?.likes_received ?? 0);
  const xp = state.stats?.xp ?? 0;
  const start = state.stats?.level_start_xp;
  const next = state.stats?.next_level_xp;
  const hasProgress = loggedIn && Number.isFinite(start) && Number.isFinite(next) && next > start;
  xpProgressWrap.hidden = !hasProgress;
  if (hasProgress) {
    const level = state.stats.level;
    xpProgress.max = next - start;
    xpProgress.value = Math.max(0, Math.min(xp - start, next - start));
    xpProgressText.textContent = `${Math.max(0, next - xp)} XP til level ${level + 1}`;
    xpProgress.setAttribute("aria-valuetext", `${xp - start} av ${next - start} XP til level ${level + 1}`);
  }
}

// A position from GPS keeps following GPS; any other choice stays until the user changes it.
function updateSelection(lat, lon, fromGps = false) {
  state.selectedLatLng = { lat, lon };
  state.selectionFollowsGps = fromGps;
  if (!fromGps) {
    userChoseManually();
  }
  // Line suggestions are ranked by the report position, so they are replaced when it moves.
  if (!routePicked && routeInput.value.trim()) {
    routeSuggestions.show([]);
    searchRoute();
  }
  if (!state.selectionMarker) {
    state.selectionMarker = L.marker([lat, lon], {
      draggable: true,
      icon: makeIcon("bee-dot"),
      title: "Valgt rapportposisjon",
    }).addTo(map);
    state.selectionMarker.on("dragend", (event) => selectPoint(event.target.getLatLng()));
  } else {
    state.selectionMarker.setLatLng([lat, lon]);
  }
}

function selectPoint(point) {
  // Panning past the date line shows copies of the world; wrap back to -180..180.
  const { lat, lng } = map.wrapLatLng(point);
  updateSelection(lat, lng);
  loadNearbyStop(lat, lng);
}

function updateCurrentLocation(lat, lon, accuracy) {
  if (!state.currentLocationMarker) {
    state.currentLocationMarker = L.marker([lat, lon], {
      icon: makeIcon("user-dot"),
      title: "Din posisjon",
    })
      .addTo(map)
      .bindPopup("Du er her");
  } else {
    state.currentLocationMarker.setLatLng([lat, lon]);
  }
  if (Number.isFinite(accuracy) && accuracy >= 0) {
    if (!state.currentLocationAccuracy) {
      state.currentLocationAccuracy = L.circle([lat, lon], {
        radius: accuracy,
        color: "#2563eb",
        fillOpacity: 0.1,
        weight: 1,
        interactive: false,
      }).addTo(map);
    } else {
      state.currentLocationAccuracy.setLatLng([lat, lon]).setRadius(accuracy);
    }
  }
}

function renderFeed(items) {
  // The list is rebuilt on every refresh, so keyboard focus returns to the same like button.
  const focusedId = document.activeElement?.dataset?.likeId;
  if (!items.length) {
    feed.innerHTML = "<p class='tiny'>Ingen aktive observasjoner akkurat nå.</p>";
    return;
  }

  feed.innerHTML = items
    .map(
      (item) => `
        <div class="feed-card">
          <article class="feed-item" data-sighting-id="${escapeHtml(item.id)}">
            <header>
              <strong>${escapeHtml(item.stop_name || "Ukjent sted")}</strong>
              <span class="tiny">${formatAge(item.created_at)}</span>
            </header>
            ${item.route ? `<div class="pill">Linje ${escapeHtml(item.route)}</div>` : ""}
            ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}
            <p class="tiny">Meldt inn av ${escapeHtml(item.reporter || "Anonym")}</p>
            <div class="feed-actions">
              <div class="feed-buttons">
                <button class="ghost like-button${item.liked_by_me ? " is-selected" : ""}" type="button" aria-pressed="${Boolean(item.liked_by_me)}" data-like-id="${escapeHtml(item.id)}">
                  <svg class="icon" aria-hidden="true"><use href="#i-check" /></svg>${item.liked_by_me ? "Bekreftet" : "Bekreft"}<span class="action-count">${item.likes_count}</span>
                </button>
                ${item.mine
                  ? `<button class="ghost like-button" type="button" data-delete-id="${escapeHtml(item.id)}"><svg class="icon" aria-hidden="true"><use href="#i-trash" /></svg>Slett</button>`
                  : `<button class="ghost like-button" type="button" data-report-id="${escapeHtml(item.id)}"><svg class="icon" aria-hidden="true"><use href="#i-flag" /></svg>Rapporter</button>`}
              </div>
            </div>
          </article>
        </div>
      `
    )
    .join("");
  if (focusedId) {
    feed.querySelector(`[data-like-id="${CSS.escape(focusedId)}"]`)?.focus();
  }
}

// Markers are updated in place, so a refresh does not close an open popup.
const sightingMarkers = new Map();

function renderSightings(items) {
  const current = new Set(items.map((item) => item.id));
  sightingMarkers.forEach((marker, id) => {
    if (!current.has(id)) {
      state.sightingsLayer.removeLayer(marker);
      sightingMarkers.delete(id);
    }
  });

  items.forEach((item) => {
    const ageClass = markerAgeClass(item.created_at);
    let marker = sightingMarkers.get(item.id);
    if (!marker) {
      marker = L.marker([item.lat, item.lon], {
        icon: makeIcon(ageClass),
        title: `Observasjon ved ${item.stop_name || "ukjent sted"}`,
      })
        .bindPopup("")
        .addTo(state.sightingsLayer);
      sightingMarkers.set(item.id, marker);
    } else if (marker.ageClass !== ageClass) {
      marker.setIcon(makeIcon(ageClass));
    }
    marker.ageClass = ageClass;
    marker.setPopupContent(`
      <strong>${escapeHtml(item.stop_name || "Ukjent sted")}</strong><br />
      ${item.route ? `Linje ${escapeHtml(item.route)}<br />` : ""}
      ${item.note ? `${escapeHtml(item.note)}<br />` : ""}
      <span>${confirmations(item.likes_count)} · ${escapeHtml(item.reporter || "Anonym")} · ${formatAge(item.created_at)}</span>
    `);
  });
}

async function loadConfig() {
  const payload = await fetchJson("/api/config");
  ttlLabel.textContent = `Siste ${payload.ttl_hours} timer`;
}

async function loadCurrentUser() {
  const payload = await fetchLatest("me", "/api/me");
  if (payload) {
    setUser(payload.user, payload.stats);
  }
}

async function loadSightings() {
  const payload = await fetchLatest("sightings", "/api/sightings");
  if (payload) {
    feedStatus.textContent = "";
    renderFeed(payload.items);
    renderSightings(payload.items);
  }
}

let refreshing = null;
// A refresh replaces an older one; the 20 s poll waits for a running refresh instead of aborting it.
function refresh() {
  const run = (async () => {
    try {
      const results = await Promise.allSettled([loadSightings(), loadCurrentUser()]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
    } finally {
      if (refreshing === run) {
        refreshing = null;
      }
    }
  })();
  refreshing = run;
  return run;
}
// Load errors are shown by the list, so they never hide the result of an action.
const showLoadError = (error) => {
  feedStatus.textContent = error.message;
};

// Empties the stop field, and outdates its pending searches and suggestions.
function clearStop() {
  outdate("stop");
  stopSearch = Promise.resolve(); // A failed search no longer stops publishing.
  stopSuggestions.close();
  stopInput.value = "";
  stopInput.dataset.stopId = "";
  stopInput.dataset.fromGps = "false";
}

async function loadNearbyStop(lat, lon, replaceStop = true) {
  const setNearbyStatus = lateStatus();
  if (replaceStop) {
    clearStop(); // A newer position also outdates pending stop searches.
  }
  try {
    const payload = await fetchLatest("nearby", `/api/stops/nearby?lat=${lat}&lon=${lon}`);
    if (!payload) {
      return;
    }
    const [closest] = payload.items;
    // Fill in the stop unless the user has started typing one meanwhile.
    if (closest && !stopInput.value) {
      stopInput.value = closest.name;
      stopInput.dataset.stopId = closest.id;
      stopInput.dataset.fromGps = String(state.selectionFollowsGps);
    }
  } catch (error) {
    setNearbyStatus(error.message, "error");
  }
}

// Stops that share a name, such as "Sentrum" in many towns or the bus, tram and metro stations at
// Jernbanetorget, get their mode, description, platform and distance, or else their ID, so each
// option is one stop.
function stopChoices(stops) {
  const count = (values, value) => values.filter((other) => other === value).length;
  const names = stops.map((stop) => stop.name);
  const labels = stops.map((stop) => {
    const details = [
      stop.mode,
      stop.description,
      stop.platform && `plattform ${stop.platform}`,
      stop.distance_m != null && formatDistance(stop.distance_m),
    ].filter(Boolean);
    return count(names, stop.name) > 1 && details.length ? `${stop.name} (${details.join(", ")})` : stop.name;
  });
  return stops.map((stop, index) => ({
    stop,
    label: count(labels, labels[index]) > 1 ? `${stop.name} (${stop.id})` : labels[index],
  }));
}

function selectStop({ stop }) {
  outdate("nearby"); // The position moves to this stop, so a pending nearby answer is outdated.
  updateSelection(stop.lat, stop.lon);
  map.panTo([stop.lat, stop.lon]);
  stopInput.dataset.stopId = stop.id;
  stopInput.dataset.fromGps = "false";
}

// GPS fixes can come faster than nearby answers, so one lookup runs at a time and then catches up
// with the newest fix, instead of each fix aborting the last.
let gpsFix = null;
let gpsLookup = null;
// Publishing waits for the GPS button's answer, unless the user picks a spot or types a stop meanwhile.
let gpsWait = Promise.resolve();
let releaseGpsWait = () => {};
let gpsButtonFailures = 0;

// A spot the user picks or a stop they type wins over GPS answers and lookups still pending.
function userChoseManually() {
  state.manualChanges++;
  gpsFix = null;
  releaseGpsWait();
}

function lookUpStopForGps(lat, lon, fromButton) {
  gpsFix = { lat, lon, fromButton: fromButton || Boolean(gpsFix?.fromButton) };
  gpsLookup ??= (async () => {
    while (gpsFix) {
      const fix = gpsFix;
      gpsFix = null;
      // A stop GPS filled in follows too, but GPS leaves a stop the user is typing, and its search, alone.
      const replaceStop = fix.fromButton || !stopInput.value || stopInput.dataset.fromGps === "true";
      await loadNearbyStop(fix.lat, fix.lon, replaceStop);
    }
    gpsLookup = null;
  })();
}

function handleLocationUpdate(position, shouldCenter = false, selectLocation = false) {
  const { latitude, longitude, accuracy } = position.coords;
  updateCurrentLocation(latitude, longitude, accuracy);
  // A recovered fix clears only a GPS warning, preserving publishing and other form messages.
  if (statusSource === "gps") setStatus("");
  if (selectLocation || !state.selectedLatLng || state.selectionFollowsGps) {
    updateSelection(latitude, longitude, true);
    if (selectLocation) {
      clearStop(); // At once, so an older stop search cannot move the report while the lookup waits its turn.
    }
    lookUpStopForGps(latitude, longitude, selectLocation);
  }
  if (shouldCenter || !state.hasAutoCentered) {
    map.flyTo([latitude, longitude], 14);
    state.hasAutoCentered = true;
  }
}

function startLocationTracking(selectLocation = false) {
  if (!navigator.geolocation) {
    setStatus("Geolokasjon er ikke tilgjengelig i denne nettleseren.", "error", "gps");
    return;
  }

  locateBtn.disabled = true;
  const changesBefore = state.manualChanges;
  const setGpsStatus = lateStatus("gps");
  let release = () => {};
  if (selectLocation) {
    gpsWait = new Promise((resolve) => (release = resolve));
    releaseGpsWait = release;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      locateBtn.disabled = false;
      // A spot picked or a stop typed by hand while GPS was answering wins over the button press.
      handleLocationUpdate(position, true, selectLocation && state.manualChanges === changesBefore);
      release();
    },
    (error) => {
      locateBtn.disabled = false;
      // The watch may already have succeeded while this separate request timed out.
      if (selectLocation || !state.currentLocationMarker) {
        setGpsStatus(
          error.code === 1
            ? "Tillat lokasjon i nettleseren for å vise markøren din."
            : "Fant ikke oppdatert posisjon. Prøv igjen eller velg et sted i kartet.",
          "error"
        );
      }
      if (selectLocation && state.manualChanges === changesBefore) {
        gpsButtonFailures++; // A report waiting for this position is not sent from the old one.
      }
      release();
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );

  if (state.watchId !== null) {
    return;
  }
  state.watchId = navigator.geolocation.watchPosition(
    (position) => handleLocationUpdate(position, false),
    (error) => {
      if (error.code === error.PERMISSION_DENIED) {
        // The browser has ended this watch, so the next button press starts a new one.
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
      }
      if (!state.currentLocationMarker) {
        setGpsStatus("Lokasjonstjenester er blokkert eller utilgjengelige.", "error");
      }
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
  );
}

// Publishing waits for this, since a search may still move the report position.
let stopSearch = Promise.resolve();

stopInput.addEventListener("input", () => (stopSearch = searchStop()));

async function searchStop() {
  const setStopStatus = lateStatus();
  const query = stopInput.value.trim();
  userChoseManually();
  stopInput.dataset.stopId = "";
  stopInput.dataset.fromGps = "false";
  stopSuggestions.typed();
  try {
    // Results closest to what the map shows come first.
    const { lat, lng } = map.wrapLatLng(map.getCenter());
    const payload = await fetchLatest("stop", `/api/stops/search?q=${encodeURIComponent(query)}&lat=${lat}&lon=${lng}`);
    if (!payload) {
      return;
    }
    const choices = stopChoices(payload.items);
    stopSuggestions.show(choices);
    // A fully typed name, in any case, picks its stop when no other stop in the list shares it.
    const exact = choices.filter((choice) => choice.label.toLowerCase() === query.toLowerCase());
    if (exact.length === 1) {
      selectStop(exact[0]);
    }
    // With stops found but none picked, publishing asks for one; a name with no stop found is kept as typed.
    return choices.length && exact.length !== 1 ? "unpicked" : "ok";
  } catch (error) {
    stopSuggestions.show([]);
    setStopStatus(error.message, "error");
    return "failed"; // Publishing stops rather than send this name with a position it may not belong to.
  }
}

routeInput.addEventListener("input", () => {
  routePicked = false;
  routeSuggestions.typed();
  return searchRoute();
});

async function searchRoute() {
  const setRouteStatus = lateStatus();
  try {
    // Lines stopping near the report come first, so "3" by Gløshaugen is AtB's line 3.
    const center = map.wrapLatLng(map.getCenter());
    const { lat, lon } = state.selectedLatLng ?? { lat: center.lat, lon: center.lng };
    const query = encodeURIComponent(routeInput.value.trim());
    const payload = await fetchLatest("route", `/api/routes?q=${query}&lat=${lat}&lon=${lon}`);
    if (payload) {
      routeSuggestions.show(payload.items); // Each value keeps its operator: line 1 in Oslo is not line 1 in Trondheim.
    }
  } catch (error) {
    routeSuggestions.show([]);
    setRouteStatus(error.message, "error");
  }
}

// Likes, reports and deletes are idempotent on the server, so the buttons stay enabled.
const feedActions = {
  likeId: { action: "like" },
  reportId: {
    action: "report",
    question: "Rapportere observasjonen som feil eller upassende? Den skjules for deg nå, og for alle etter tre rapporter.",
    done: "Observasjonen er rapportert og skjult for deg.",
  },
  deleteId: { action: "delete", question: "Slette observasjonen din?", done: "Observasjonen er slettet." },
};

feed.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-like-id], [data-report-id], [data-delete-id]");
  if (!button) {
    return;
  }
  const key = Object.keys(feedActions).find((name) => button.dataset[name]);
  const { action, question, done } = feedActions[key];
  // Logged out, the server's answer asks the user to log in, so there is nothing to confirm.
  if (question && state.user && !confirm(question)) {
    return;
  }
  try {
    await fetchJson(`/api/sightings/${encodeURIComponent(button.dataset[key])}/${action}`, { method: "POST" });
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }
  if (done) {
    setStatus(done, "ok");
  }
  refresh().catch(showLoadError);
});

map.on("click", (event) => selectPoint(event.latlng));

locateBtn.addEventListener("click", () => {
  startLocationTracking(true);
});

reportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = reportForm.querySelector("button[type='submit']");
  submitButton.disabled = mobilePublish.disabled = true;
  // Wait until no newer stop search or GPS button press has started meanwhile, then read the form in one go.
  const failuresBefore = gpsButtonFailures;
  let waits;
  let search;
  do {
    waits = [stopSearch, gpsWait];
    [search] = await Promise.all(waits);
  } while (waits[0] !== stopSearch || waits[1] !== gpsWait);
  const searchProblem = search === "failed"
    ? "Holdeplassøket feilet, så observasjonen ble ikke sendt. Prøv igjen, eller velg et sted i kartet."
    : search === "unpicked" && !stopInput.dataset.stopId
      ? "Velg holdeplassen i forslagslisten, eller velg et sted i kartet."
      : "";
  if (searchProblem) {
    submitButton.disabled = mobilePublish.disabled = false;
    setStatus(searchProblem, "error");
    return;
  }
  if (gpsButtonFailures !== failuresBefore) {
    submitButton.disabled = mobilePublish.disabled = false;
    setStatus("Fant ikke posisjonen din. Velg et sted i kartet eller trykk «Bruk min posisjon» igjen.", "error");
    return;
  }
  if (!state.selectedLatLng) {
    submitButton.disabled = mobilePublish.disabled = false;
    setStatus("Velg først en posisjon i kartet eller slå på lokasjonstjenester.", "error");
    return;
  }
  setStatus("Publiserer...");

  const note = noteInput.value.trim();
  // A stop GPS filled in may be one fix behind; the server picks the stop nearest the position sent.
  const stopFromGps = stopInput.dataset.fromGps === "true";
  let item;
  try {
    item = await postJson("/api/sightings", {
      lat: state.selectedLatLng.lat,
      lon: state.selectedLatLng.lon,
      stop_name: stopFromGps ? "" : stopInput.value.trim(),
      stop_id: stopFromGps ? "" : stopInput.dataset.stopId || "",
      route: routeInput.value.trim(),
      note,
    });
  } catch (error) {
    setStatus(error.message, "error");
    return;
  } finally {
    submitButton.disabled = mobilePublish.disabled = false;
  }
  if (noteInput.value.trim() === note) {
    noteInput.value = ""; // Keep a new note typed while this one was sent.
  }
  setStatus(
    item.reporter === "Anonym" ? "Observasjonen er publisert anonymt." : `Observasjonen er publisert som ${item.reporter}.`,
    "ok"
  );
  refresh().catch(showLoadError);
});

authToggle.addEventListener("click", () => {
  toggleAuth();
});

// Login, registration and logout run one at a time: a late answer would set its cookie anyway.
let authBusy = false;

async function runAuth(action) {
  if (authBusy) {
    return;
  }
  authBusy = true;
  try {
    await action();
  } finally {
    authBusy = false;
  }
}

function handleAuthForm(form, url, message) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    return runAuth(async () => {
      const [username, password] = form.querySelectorAll("input");
      try {
        const payload = await postJson(url, { username: username.value.trim(), password: password.value });
        setUser(payload.user);
      } catch (error) {
        setAuthStatus(error.message, "error");
        return;
      }
      setAuthStatus(message, "ok");
      form.reset();
      refresh().catch(showLoadError);
    });
  });
}

handleAuthForm(loginForm, "/api/auth/login", "Innlogging vellykket.");
handleAuthForm(registerForm, "/api/auth/register", "Profil opprettet.");

logoutBtn.addEventListener("click", () =>
  runAuth(async () => {
    try {
      await fetchJson("/api/auth/logout", { method: "POST" });
    } catch (error) {
      setAuthStatus(error.message, "error");
      return;
    }
    setUser(null);
    setAuthStatus("Du er logget ut. Observasjoner kan fortsatt sendes anonymt.", "ok");
    refresh().catch(showLoadError);
  })
);

// Each part starts on its own, so one failed request cannot stop GPS or refreshing.
loadConfig().catch(showLoadError);
loadCurrentUser().catch((error) => setAuthStatus(error.message, "error"));
loadSightings().catch(showLoadError);
startLocationTracking();
setInterval(() => {
  if (!refreshing) {
    refresh().catch(showLoadError);
  }
}, 20000);
