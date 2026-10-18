// Double-click zoom is off: its two clicks would also move the report position.
const map = L.map("map", {
  zoomControl: true,
  doubleClickZoom: false,
});
map.setView([59.9139, 10.7522], 12); // Oslo until GPS finds the user.

// Kartverket's official topographic map of Norway; its cache serves zoom levels up to 18.
L.tileLayer("https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png", {
  maxZoom: 18,
  attribution:
    '&copy; <a href="https://www.kartverket.no/">Kartverket</a> · Holdeplasser og linjer: ' +
    '<a href="https://developer.entur.org/stops-and-timetable-data">Entur</a> ' +
    '(<a href="https://data.norge.no/nlod/no/2.0">NLOD</a>)',
}).addTo(map);

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
};

const reportForm = document.querySelector("#reportForm");
const stopInput = document.querySelector("#stopInput");
const routeInput = document.querySelector("#routeInput");
const noteInput = document.querySelector("#noteInput");
const formStatus = document.querySelector("#formStatus");
const feedStatus = document.querySelector("#feedStatus");
const selectedLocation = document.querySelector("#selectedLocation");
const nearestStop = document.querySelector("#nearestStop");
const feed = document.querySelector("#feed");
const stopOptions = document.querySelector("#stopOptions");
const routeOptions = document.querySelector("#routeOptions");
const locateBtn = document.querySelector("#locateBtn");
const centerBtn = document.querySelector("#centerBtn");
const ttlLabel = document.querySelector("#ttlLabel");
const loginForm = document.querySelector("#loginForm");
const registerForm = document.querySelector("#registerForm");
const logoutBtn = document.querySelector("#logoutBtn");
const authForms = document.querySelector("#authForms");
const userPanel = document.querySelector("#userPanel");
const currentUsername = document.querySelector("#currentUsername");
const authState = document.querySelector("#authState");
const authStatus = document.querySelector("#authStatus");
const authToggle = document.querySelector("#authToggle");
const authContent = document.querySelector("#authContent");
const userLevel = document.querySelector("#userLevel");
const userXp = document.querySelector("#userXp");

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
const routeSuggestions = suggestionList(routeInput, routeOptions, (route) => {
  outdate("route");
  routeInput.value = route.value;
});

async function fetchJson(url, options) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Klarte ikke å hente data.");
  }
  return response.json();
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

function setStatus(message, type = "") {
  statusVersion++;
  formStatus.textContent = message;
  formStatus.className = type ? `status ${type}` : "status";
}

// For answers that can arrive late, such as GPS or suggestions: the returned function shows a
// message only if no newer one, such as a published report, was shown in the meantime.
function lateStatus() {
  const before = statusVersion;
  return (message, type) => statusVersion === before && setStatus(message, type);
}

function setAuthStatus(message, type = "") {
  authStatus.textContent = message;
  authStatus.className = type ? `status ${type}` : "status";
}

function makeIcon(className) {
  return L.divIcon({
    className: "",
    html: `<div class="${className}"></div>`,
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
  state.authOpen = open;
  authContent.classList.toggle("hidden", !open);
  authToggle.setAttribute("aria-expanded", String(open));
}

function setUser(user, stats = null) {
  state.user = user;
  state.stats = stats;
  updateAuthUi();
}

function updateAuthUi() {
  const loggedIn = Boolean(state.user);
  authForms.classList.toggle("hidden", loggedIn);
  userPanel.classList.toggle("hidden", !loggedIn);
  authState.textContent = loggedIn ? "Frivillig profil aktiv" : "Valgfritt";
  currentUsername.textContent = loggedIn ? state.user.username : "";
  userLevel.textContent = `Nivå ${state.stats?.level ?? 1}`;
  userXp.textContent = `${state.stats?.xp ?? 0} XP · ${confirmations(state.stats?.likes_received ?? 0)}`;
}

// A position from GPS keeps following GPS; any other choice stays until the user changes it.
function updateSelection(lat, lon, fromGps = false) {
  state.selectedLatLng = { lat, lon };
  state.selectionFollowsGps = fromGps;
  selectedLocation.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
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
        <article class="feed-item" data-sighting-id="${escapeHtml(item.id)}">
          <header>
            <strong>${escapeHtml(item.stop_name || "Ukjent sted")}</strong>
            <span class="tiny">${formatAge(item.created_at)}</span>
          </header>
          ${item.route ? `<div class="pill">Linje ${escapeHtml(item.route)}</div>` : ""}
          ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}
          <p class="tiny">Meldt inn av ${escapeHtml(item.reporter || "Anonym")}</p>
          <div class="feed-actions">
            <span class="tiny">${item.distance_to_stop_m != null ? `${formatDistance(item.distance_to_stop_m)} fra nærmeste stopp` : "Ingen holdeplass innen 2 km"}</span>
            <button class="ghost like-button" type="button" data-like-id="${escapeHtml(item.id)}">
              ${item.liked_by_me ? "Bekreftet" : "Bekreft"} · ${item.likes_count}
            </button>
          </div>
        </article>
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
  ttlLabel.textContent = `Observasjoner vises i ${payload.ttl_hours} timer.`;
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

const refresh = () => Promise.all([loadSightings(), loadCurrentUser()]);
// Load errors are shown by the list, so they never hide the result of an action.
const showLoadError = (error) => {
  feedStatus.textContent = error.message;
};

async function loadNearbyStop(lat, lon, replaceStop = true) {
  if (replaceStop) {
    outdate("stop"); // A newer position also outdates pending stop searches and their suggestions.
    stopSuggestions.close();
    stopInput.value = "";
    stopInput.dataset.stopId = "";
    stopInput.dataset.fromGps = "false";
  }
  nearestStop.textContent = "Laster...";
  try {
    const payload = await fetchLatest("nearby", `/api/stops/nearby?lat=${lat}&lon=${lon}`);
    if (!payload) {
      return;
    }
    const [closest] = payload.items;
    nearestStop.textContent = closest
      ? `${closest.name} (${formatDistance(closest.distance_m)})`
      : "Fant ingen holdeplass innen 2 km.";
    // Fill in the stop unless the user has started typing one meanwhile.
    if (closest && !stopInput.value) {
      stopInput.value = closest.name;
      stopInput.dataset.stopId = closest.id;
      stopInput.dataset.fromGps = String(state.selectionFollowsGps);
    }
  } catch (error) {
    nearestStop.textContent = error.message;
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

function selectStop({ stop, label }) {
  outdate("nearby"); // The position moves to this stop, so a pending nearby answer is outdated.
  updateSelection(stop.lat, stop.lon);
  map.panTo([stop.lat, stop.lon]);
  nearestStop.textContent = `${label} (valgt)`;
  stopInput.dataset.stopId = stop.id;
  stopInput.dataset.fromGps = "false";
}

function handleLocationUpdate(position, shouldCenter = false, selectLocation = false) {
  const { latitude, longitude, accuracy } = position.coords;
  updateCurrentLocation(latitude, longitude, accuracy);
  if (selectLocation || !state.selectedLatLng || state.selectionFollowsGps) {
    updateSelection(latitude, longitude, true);
    // A stop GPS filled in follows too, but GPS leaves a stop the user is typing, and its search, alone.
    loadNearbyStop(latitude, longitude, selectLocation || !stopInput.value || stopInput.dataset.fromGps === "true");
  }
  if (shouldCenter || !state.hasAutoCentered) {
    map.flyTo([latitude, longitude], 14);
    state.hasAutoCentered = true;
  }
}

function startLocationTracking(selectLocation = false) {
  if (!navigator.geolocation) {
    setStatus("Geolokasjon er ikke tilgjengelig i denne nettleseren.", "error");
    return;
  }

  locateBtn.disabled = true;
  const selectionBefore = state.selectedLatLng;
  const setGpsStatus = lateStatus();
  navigator.geolocation.getCurrentPosition(
    (position) => {
      locateBtn.disabled = false;
      setGpsStatus("Posisjon hentet fra lokasjonstjenester.", "ok");
      // A spot picked by hand while GPS was answering wins over the button press.
      handleLocationUpdate(position, true, selectLocation && state.selectedLatLng === selectionBefore);
    },
    () => {
      locateBtn.disabled = false;
      setGpsStatus("Tillat lokasjon i nettleseren for å vise markøren din.", "error");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );

  if (state.watchId !== null) {
    return;
  }
  state.watchId = navigator.geolocation.watchPosition(
    (position) => handleLocationUpdate(position, false),
    () => {
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
  const query = stopInput.value.trim();
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
    // A fully typed name picks its stop when no other stop in the list shares it.
    const exact = choices.find((choice) => choice.label === query);
    if (exact) {
      selectStop(exact);
    }
  } catch (error) {
    stopSuggestions.show([]);
    nearestStop.textContent = error.message;
  }
}

routeInput.addEventListener("input", async () => {
  const setRouteStatus = lateStatus();
  routeSuggestions.typed();
  try {
    const payload = await fetchLatest("route", `/api/routes?q=${encodeURIComponent(routeInput.value.trim())}`);
    if (payload) {
      routeSuggestions.show(payload.items); // Each value keeps its operator: line 1 in Oslo is not line 1 in Trondheim.
    }
  } catch (error) {
    routeSuggestions.show([]);
    setRouteStatus(error.message, "error");
  }
});

feed.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-like-id]");
  if (!button) {
    return;
  }
  // A like is idempotent on the server, so the button stays enabled and keeps keyboard focus.
  try {
    await fetchJson(`/api/sightings/${encodeURIComponent(button.dataset.likeId)}/like`, { method: "POST" });
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }
  refresh().catch(showLoadError);
});

map.on("click", (event) => selectPoint(event.latlng));

centerBtn.addEventListener("click", () => selectPoint(map.getCenter()));

locateBtn.addEventListener("click", () => {
  startLocationTracking(true);
});

reportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = reportForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  // Wait until no newer search has started meanwhile, then read the form in one go.
  let pending;
  do {
    pending = stopSearch;
    await pending;
  } while (pending !== stopSearch);
  if (!state.selectedLatLng) {
    submitButton.disabled = false;
    setStatus("Velg først en posisjon i kartet eller slå på lokasjonstjenester.", "error");
    return;
  }
  setStatus("Publiserer...");

  const note = noteInput.value.trim();
  let item;
  try {
    item = await postJson("/api/sightings", {
      lat: state.selectedLatLng.lat,
      lon: state.selectedLatLng.lon,
      stop_name: stopInput.value.trim(),
      stop_id: stopInput.dataset.stopId || "",
      route: routeInput.value.trim(),
      note,
    });
  } catch (error) {
    setStatus(error.message, "error");
    return;
  } finally {
    submitButton.disabled = false;
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
// A poll waits for the previous one, since starting a new one would abort answers slower than 20 s.
let polling = null;
setInterval(() => {
  polling ??= refresh().catch(showLoadError).finally(() => (polling = null));
}, 20000);
