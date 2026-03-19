const map = L.map("map", {
  zoomControl: true,
});

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap-bidragsytere",
}).addTo(map);

const state = {
  selectedLatLng: null,
  selectionMarker: null,
  currentLocationMarker: null,
  sightingsLayer: L.layerGroup().addTo(map),
  stopOptions: [],
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

function updateCurrentLocation(lat, lon) {
  if (!state.currentLocationMarker) {
    state.currentLocationMarker = L.marker([lat, lon], {
      icon: makeIcon("user-dot"),
    })
      .addTo(map)
      .bindPopup("Du er her");
  } else {
    state.currentLocationMarker.setLatLng([lat, lon]);
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
  map.setView([payload.center.lat, payload.center.lon], 11);
  ttlLabel.textContent = `Observasjoner vises i ${payload.ttl_hours} timer.`;
}

async function loadCurrentUser() {
  const payload = await fetchJson("/api/me");
  state.user = payload.user;
  state.stats = payload.stats;
  updateAuthUi();
}

async function refreshUserStats() {
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

async function loadNearbyStop(lat, lon) {
  nearestStop.textContent = "Laster...";
  try {
    const payload = await fetchJson(`/api/stops/nearby?lat=${lat}&lon=${lon}`);
    const [closest] = payload.items;
    if (!closest) {
      nearestStop.textContent = "Fant ingen holdeplass.";
      return;
    }
    nearestStop.textContent = `${closest.name} (${closest.distance_m} m)`;
    stopInput.value = closest.name;
    stopInput.dataset.stopId = closest.id;
  } catch (error) {
    nearestStop.textContent = error.message;
  }
}

async function fillDatalist(url, datalistEl, toLabel) {
  const payload = await fetchJson(url);
  datalistEl.innerHTML = payload.items
    .map((item) => `<option value="${escapeHtml(toLabel(item))}"></option>`)
    .join("");
  return payload.items;
}

async function likeSighting(id) {
  await fetchJson(`/api/sightings/${encodeURIComponent(id)}/like`, {
    method: "POST",
  });
  await loadSightings();
  if (state.user) {
    await refreshUserStats();
  }
}

function handleLocationUpdate(position, shouldCenter = false) {
  const { latitude, longitude } = position.coords;
  updateCurrentLocation(latitude, longitude);
  if (!state.selectedLatLng) {
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

function startLocationTracking() {
  if (!navigator.geolocation) {
    setStatus("Geolokasjon er ikke tilgjengelig i denne nettleseren.", "error");
    return;
  }

  locateBtn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => handleLocationUpdate(position, true),
    () => {
      locateBtn.disabled = false;
      setStatus("Tillat lokasjon i nettleseren for å vise markøren din.", "error");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );

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
  const query = stopInput.value.trim();
  stopInput.dataset.stopId = "";
  if (query.length < 2) {
    stopOptions.innerHTML = "";
    return;
  }
  state.stopOptions = await fillDatalist(
    `/api/stops/search?q=${encodeURIComponent(query)}`,
    stopOptions,
    (item) => item.name
  );
  const exact = state.stopOptions.find((item) => item.name === query);
  if (exact) {
    stopInput.dataset.stopId = exact.id;
  }
});

routeInput.addEventListener("input", async () => {
  const query = routeInput.value.trim();
  await fillDatalist(
    `/api/routes?q=${encodeURIComponent(query)}`,
    routeOptions,
    (item) => item.short_name
  );
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
  startLocationTracking();
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
      await refreshUserStats();
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
    const payload = await fetchJson("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });
    state.user = payload.user;
    await refreshUserStats();
    updateAuthUi();
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
    const payload = await fetchJson("/api/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });
    state.user = payload.user;
    await refreshUserStats();
    updateAuthUi();
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
});

await loadConfig();
await loadCurrentUser();
await loadSightings();
startLocationTracking();
setInterval(loadSightings, 20000);
