// Double-click zoom is off: its two clicks would also move the report position.
const map = L.map("map", {
  zoomControl: true,
  doubleClickZoom: false,
});
map.setView([58.1467, 7.9956], 11);

const mapStatus = document.querySelector("#mapStatus");
let loadedTiles = 0;
let failedTiles = 0;
const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap-bidragsytere",
});
tiles.on("loading", () => {
  loadedTiles = 0;
  failedTiles = 0;
  mapStatus.textContent = "Laster kart …";
  mapStatus.classList.remove("hidden");
});
tiles.on("tileload", () => { loadedTiles++; });
tiles.on("tileerror", () => { failedTiles++; });
tiles.on("load", () => {
  if (failedTiles > 0 && loadedTiles === 0) {
    mapStatus.textContent = "Kartbildene kunne ikke lastes fra OpenStreetMap. Sjekk internettilgang og eventuell innholdsblokkering.";
    mapStatus.classList.remove("hidden");
  } else {
    mapStatus.classList.add("hidden");
  }
});
tiles.addTo(map);

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
const selectedLocation = document.querySelector("#selectedLocation");
const nearestStop = document.querySelector("#nearestStop");
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
const authState = document.querySelector("#authState");
const authStatus = document.querySelector("#authStatus");
const authToggle = document.querySelector("#authToggle");
const authContent = document.querySelector("#authContent");
const userLevel = document.querySelector("#userLevel");
const userXp = document.querySelector("#userXp");

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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStatus(message, type = "") {
  formStatus.textContent = message;
  formStatus.className = type ? `status ${type}` : "status";
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
}

function updateAuthUi() {
  const loggedIn = Boolean(state.user);
  authForms.classList.toggle("hidden", loggedIn);
  userPanel.classList.toggle("hidden", !loggedIn);
  authState.textContent = loggedIn ? "Frivillig profil aktiv" : "Valgfritt";
  currentUsername.textContent = loggedIn ? state.user.username : "";
  userLevel.textContent = `Level ${state.stats?.level ?? 1}`;
  userXp.textContent = `${state.stats?.xp ?? 0} XP · ${state.stats?.likes_received ?? 0} likes`;
}

function updateSelection(lat, lon) {
  state.selectedLatLng = { lat, lon };
  selectedLocation.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  if (!state.selectionMarker) {
    state.selectionMarker = L.marker([lat, lon], {
      draggable: true,
      icon: makeIcon("bee-dot"),
    }).addTo(map);
    state.selectionMarker.on("dragend", (event) => {
      const point = event.target.getLatLng();
      updateSelection(point.lat, point.lng);
      loadNearbyStop(point.lat, point.lng);
    });
  } else {
    state.selectionMarker.setLatLng([lat, lon]);
  }
}

function updateCurrentLocation(lat, lon, accuracy) {
  if (!state.currentLocationMarker) {
    state.currentLocationMarker = L.marker([lat, lon], {
      icon: makeIcon("user-dot"),
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
            <span class="tiny">${item.distance_to_stop_m ? `${item.distance_to_stop_m} m fra nærmeste stopp` : "Posisjon manuelt valgt"}</span>
            <button class="ghost like-button" type="button" data-like-id="${escapeHtml(item.id)}">
              ${item.liked_by_me ? "Bekreftet" : "Bekreft"} · ${item.likes_count}
            </button>
          </div>
        </article>
      `
    )
    .join("");
}

function renderSightings(items) {
  state.sightingsLayer.clearLayers();

  items.forEach((item) => {
    const marker = L.marker([item.lat, item.lon], {
      icon: makeIcon(markerAgeClass(item.created_at)),
    });
    marker.bindPopup(`
      <strong>${escapeHtml(item.stop_name || "Ukjent sted")}</strong><br />
      ${item.route ? `Linje ${escapeHtml(item.route)}<br />` : ""}
      ${item.note ? `${escapeHtml(item.note)}<br />` : ""}
      <span>${item.likes_count} bekreftelser · ${escapeHtml(item.reporter || "Anonym")} · ${formatAge(item.created_at)}</span>
    `);
    marker.addTo(state.sightingsLayer);
  });
}

async function loadConfig() {
  const payload = await fetchJson("/api/config");
  ttlLabel.textContent = `Observasjoner vises i ${payload.ttl_hours} timer.`;
}

async function loadCurrentUser() {
  const payload = await fetchJson("/api/me");
  state.user = payload.user;
  state.stats = payload.stats;
  updateAuthUi();
}

async function loadSightings() {
  const payload = await fetchJson("/api/sightings");
  renderFeed(payload.items);
  renderSightings(payload.items);
}

// Only the newest position change or stop search may fill in the stop; older answers are dropped.
let stopRequest = 0;

async function loadNearbyStop(lat, lon) {
  const request = ++stopRequest;
  nearestStop.textContent = "Laster...";
  stopInput.value = "";
  stopInput.dataset.stopId = "";
  try {
    const payload = await fetchJson(`/api/stops/nearby?lat=${lat}&lon=${lon}`);
    if (request !== stopRequest) {
      return;
    }
    const [closest] = payload.items;
    if (!closest) {
      nearestStop.textContent = "Fant ingen holdeplass.";
      return;
    }
    nearestStop.textContent = `${closest.name} (${closest.distance_m} m)`;
    stopInput.value = closest.name;
    stopInput.dataset.stopId = closest.id;
  } catch (error) {
    if (request === stopRequest) {
      nearestStop.textContent = error.message;
    }
  }
}

function renderOptions(datalistEl, items, toLabel) {
  datalistEl.innerHTML = items
    .map((item) => `<option value="${escapeHtml(toLabel(item))}"></option>`)
    .join("");
}

async function likeSighting(id) {
  await fetchJson(`/api/sightings/${encodeURIComponent(id)}/like`, {
    method: "POST",
  });
  await loadSightings();
  if (state.user) {
    await loadCurrentUser();
  }
}

function handleLocationUpdate(position, shouldCenter = false, selectLocation = false) {
  const { latitude, longitude, accuracy } = position.coords;
  updateCurrentLocation(latitude, longitude, accuracy);
  if (selectLocation || !state.selectedLatLng) {
    updateSelection(latitude, longitude);
    loadNearbyStop(latitude, longitude);
  }
  if (shouldCenter || !state.hasAutoCentered) {
    map.flyTo([latitude, longitude], 14);
    state.hasAutoCentered = true;
  }
  locateBtn.disabled = false;
  setStatus("Posisjon hentet fra lokasjonstjenester.", "ok");
}

function startLocationTracking(selectLocation = false) {
  if (!navigator.geolocation) {
    setStatus("Geolokasjon er ikke tilgjengelig i denne nettleseren.", "error");
    return;
  }

  locateBtn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => handleLocationUpdate(position, true, selectLocation),
    () => {
      locateBtn.disabled = false;
      setStatus("Tillat lokasjon i nettleseren for å vise markøren din.", "error");
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
        setStatus("Lokasjonstjenester er blokkert eller utilgjengelige.", "error");
      }
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
  );
}

stopInput.addEventListener("input", async () => {
  const request = ++stopRequest;
  const query = stopInput.value.trim();
  stopInput.dataset.stopId = "";
  if (query.length < 2) {
    stopOptions.innerHTML = "";
    return;
  }
  const payload = await fetchJson(`/api/stops/search?q=${encodeURIComponent(query)}`);
  if (request !== stopRequest) {
    return;
  }
  renderOptions(stopOptions, payload.items, (item) => item.name);
  const exact = payload.items.find((item) => item.name === query);
  if (exact) {
    updateSelection(exact.lat, exact.lon);
    map.panTo([exact.lat, exact.lon]);
    nearestStop.textContent = `${exact.name} (valgt)`;
    stopInput.dataset.stopId = exact.id;
  }
});

routeInput.addEventListener("input", async () => {
  const query = routeInput.value.trim();
  const payload = await fetchJson(`/api/routes?q=${encodeURIComponent(query)}`);
  renderOptions(routeOptions, payload.items, (item) => item.short_name);
});

feed.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-like-id]");
  if (!button) {
    return;
  }
  button.disabled = true;
  try {
    await likeSighting(button.dataset.likeId);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

map.on("click", async (event) => {
  updateSelection(event.latlng.lat, event.latlng.lng);
  await loadNearbyStop(event.latlng.lat, event.latlng.lng);
});

locateBtn.addEventListener("click", () => {
  startLocationTracking(true);
});

reportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedLatLng) {
    setStatus("Velg først en posisjon i kartet eller slå på lokasjonstjenester.", "error");
    return;
  }

  const submitButton = reportForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  setStatus("Publiserer...");

  try {
    await fetchJson("/api/sightings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        lat: state.selectedLatLng.lat,
        lon: state.selectedLatLng.lon,
        stop_name: stopInput.value.trim(),
        stop_id: stopInput.dataset.stopId || "",
        route: routeInput.value.trim(),
        note: noteInput.value.trim(),
      }),
    });

    noteInput.value = "";
    setStatus(state.user ? "Observasjonen er publisert på profilen din." : "Observasjonen er publisert anonymt.", "ok");
    await loadSightings();
    if (state.user) {
      await loadCurrentUser();
    }
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

authToggle.addEventListener("click", () => {
  toggleAuth();
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = document.querySelector("#loginUsername").value.trim();
  const password = document.querySelector("#loginPassword").value;
  try {
    await fetchJson("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });
    await loadCurrentUser();
    await loadSightings();
    toggleAuth(true);
    setAuthStatus("Innlogging vellykket.", "ok");
    loginForm.reset();
  } catch (error) {
    setAuthStatus(error.message, "error");
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = document.querySelector("#registerUsername").value.trim();
  const password = document.querySelector("#registerPassword").value;
  try {
    await fetchJson("/api/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });
    await loadCurrentUser();
    await loadSightings();
    toggleAuth(true);
    setAuthStatus("Profil opprettet.", "ok");
    registerForm.reset();
  } catch (error) {
    setAuthStatus(error.message, "error");
  }
});

logoutBtn.addEventListener("click", async () => {
  await fetchJson("/api/auth/logout", {
    method: "POST",
  });
  state.user = null;
  state.stats = null;
  updateAuthUi();
  setAuthStatus("Du er logget ut. Observasjoner kan fortsatt sendes anonymt.", "ok");
  await loadSightings();
});

// Each part starts on its own, so one failed request cannot stop GPS or refreshing.
const showLoadError = (error) => setStatus(error.message, "error");
loadConfig().catch(showLoadError);
loadCurrentUser().catch((error) => setAuthStatus(error.message, "error"));
loadSightings().catch(showLoadError);
startLocationTracking();
setInterval(() => Promise.all([loadSightings(), loadCurrentUser()]).catch(showLoadError), 20000);
