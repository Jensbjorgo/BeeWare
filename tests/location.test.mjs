import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/basemap.js", import.meta.url), "utf8")
  + "\n" + await readFile(new URL("../web/app.js", import.meta.url), "utf8");

const reply = (payload, ok = true) => Promise.resolve({ ok, json: async () => payload });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// `route(url, options)` may return a response promise; anything else gets the default reply.
async function setup(route = () => undefined, { vectorSupport = true, vectorFailure = false } = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      id: selector.slice(1),
      value: "",  // Like an empty input.
      classList: {
        toggle(name, value) { this[name] = value; },
        add() { this.hidden = true; },
        remove() { this.hidden = false; },
      },
      dataset: {},
      addEventListener(event, handler) { this[event] = handler; },
      setAttribute() {},
      querySelector: element,
    });
    return elements.get(selector);
  };
  const layer = (point, options) => ({
    point, options,
    addTo() { return this; },
    getMaplibreMap() { return this; },
    bindPopup() { return this; },
    events: {},
    on(event, handler) { this.events[event] = handler; return this; },
    clearLayers() {},
    setLatLng(value) { this.point = value; return this; },
    setRadius(value) { this.options.radius = value; return this; },
    setIcon(icon) { this.options.icon = icon; return this; },
    setPopupContent(html) { this.popup = html; return this; },
    removeLayer(child) { child.removed = true; },
  });
  let currentCallback;
  let currentError;
  let watchCallback;
  let watchError;
  let watches = 0;
  let intervals = 0;
  let poll;
  const rasterLayers = [];
  const timeouts = new Map();
  let elapsed = 0;
  const context = vm.createContext({
    maplibregl: { setWorkerUrl() {} },
    L: {
      map: () => ({
        on() {}, setView() {}, flyTo() {}, panTo() {}, invalidateSize() {},
        hasLayer: (child) => !child.removed, removeLayer(child) { child.removed = true; },
        getCenter: () => ({ lat: 59.91, lng: 10.75 }), wrapLatLng: (point) => point,
      }),
      maplibreGL: (options) => {
        if (vectorFailure) throw new Error("WebGL initialization failed");
        return layer(null, options);
      },
      tileLayer: (url, options) => { rasterLayers.push(layer(url, options)); return rasterLayers.at(-1); },
      layerGroup: layer, marker: layer, circle: layer,
      divIcon: (options) => options,
    },
    document: {
      querySelector: element,
      createElement: () => ({ getContext: () => vectorSupport ? { getExtension: () => null } : null }),
    },
    navigator: { geolocation: {
      getCurrentPosition(callback, onError) { currentCallback = callback; currentError = onError; },
      watchPosition(callback, onError) { watchCallback = callback; watchError = onError; watches++; return 0; },
      clearWatch() {},
    } },
    // Like the browser, an aborted request rejects at once even if its answer never comes.
    fetch: (url, options) => Promise.race([
      route(url, options) ?? reply({ ttl_hours: 3, user: null, stats: null, items: [] }),
      new Promise((resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")))),
    ]),
    AbortController,
    setInterval(callback) { intervals++; poll = callback; },
    setTimeout(callback, delay) { timeouts.set(callback, elapsed + delay); return callback; },
    confirm: () => true,
    clearTimeout(callback) { timeouts.delete(callback); },
  });
  const app = vm.runInContext(
    `(() => { ${source}\nreturn { state, updateSelection, loadNearbyStop, loadCurrentUser, loadSightings, sightingMarkers, tiles, refresh }; })()`, context,
  );
  await settle();
  return {
    ...app,
    element,
    click: () => element("#locateBtn").click(),
    current: (lat, lon, accuracy = 25) => currentCallback({ coords: { latitude: lat, longitude: lon, accuracy } }),
    currentFails: (code = 3) => currentError({ code }),
    watch: (lat, lon, accuracy = 25) => watchCallback({ coords: { latitude: lat, longitude: lon, accuracy } }),
    watches: () => watches,
    watchDenied: () => watchError({ code: 1, PERMISSION_DENIED: 1 }),
    intervals: () => intervals,
    poll: () => poll(),
    rasterLayers,
    timeOut: () => [...timeouts.keys()].forEach((callback) => { timeouts.delete(callback); callback(); }),
    advanceTime: (milliseconds) => {
      elapsed += milliseconds;
      for (const [callback, deadline] of [...timeouts]) {
        if (deadline <= elapsed) {
          timeouts.delete(callback);
          callback();
        }
      }
    },
  };
}

test("profile XP progress uses server thresholds, resets at a new level, and hides after logout", async () => {
  let user = { username: "alice" };
  let stats = { xp: 65, level: 3, level_start_xp: 40, next_level_xp: 90 };
  const app = await setup((url) => url === "/api/me" ? reply({ user, stats }) : undefined);
  const progress = app.element("#xpProgress");
  const wrapper = app.element("#xpProgressWrap");
  assert.equal(wrapper.hidden, false);
  assert.equal(progress.value, 25);
  assert.equal(progress.max, 50);
  assert.equal(app.element("#xpProgressText").textContent, "25 XP til level 4");
  stats = { xp: 90, level: 4, level_start_xp: 90, next_level_xp: 160 };
  await app.loadCurrentUser();
  assert.equal(progress.value, 0);
  assert.equal(progress.max, 70);
  assert.equal(app.element("#userLevel").textContent, "Level 4");
  assert.equal(app.element("#xpProgressText").textContent, "70 XP til level 5");
  user = null;
  stats = null;
  await app.loadCurrentUser();
  assert.equal(wrapper.hidden, true);
});

test("GPS preserves manual selection; button moves selection to current position", async () => {
  const app = await setup();
  app.updateSelection(58, 8);
  app.current(59, 9);
  assert.equal(app.state.selectedLatLng.lat, 58);
  const status = app.element("#formStatus");
  status.textContent = "Publisering feilet.";
  app.watch(59.1, 9.1);
  assert.equal(app.state.selectedLatLng.lat, 58);
  assert.equal(status.textContent, "Publisering feilet.");  // Background GPS keeps other messages.
  app.click();
  app.updateSelection(57, 7);  // Picked by hand while GPS is still answering ...
  app.current(56, 6);
  assert.equal(app.state.selectedLatLng.lat, 57);  // ... so the late GPS answer does not move it.
  app.click();
  app.current(60, 10);
  assert.equal(app.state.selectedLatLng.lat, 60);
  assert.equal(app.state.selectedLatLng.lon, 10);
  app.watch(60.1, 10.1);
  assert.equal(app.state.selectedLatLng.lat, 60.1);  // A position from GPS keeps following GPS.
  assert.equal(app.watches(), 1);
});

test("a GPS fix clears an earlier location warning from both layouts", async () => {
  const app = await setup();
  app.currentFails(1);
  assert.match(app.element("#formStatus").textContent, /Tillat lokasjon/);
  app.watch(59.91, 10.75);
  assert.equal(app.element("#formStatus").textContent, "");
  assert.equal(app.element("#mobileFormStatus").textContent, "");
});

test("a timed-out initial GPS request does not warn when the watch already found a position", async () => {
  const app = await setup();
  app.watch(59.91, 10.75);
  app.currentFails();
  assert.ok(app.state.currentLocationMarker);
  assert.ok(!app.element("#formStatus").textContent);
  assert.ok(!app.element("#mobileFormStatus").textContent);
});

test("GPS recovery preserves a newer form error and timeouts do not claim permission was denied", async () => {
  const app = await setup();
  app.currentFails();
  const status = app.element("#formStatus");
  assert.match(status.textContent, /Fant ikke oppdatert posisjon/);
  await app.element("#reportForm").submit({ preventDefault() {} });
  assert.match(status.textContent, /Velg først en posisjon/);
  const message = status.textContent;
  app.watch(59.91, 10.75);
  assert.equal(status.textContent, message);
  assert.equal(app.element("#mobileFormStatus").textContent, message);
});

test("form messages disappear after three seconds in both layouts, but errors stay", async () => {
  const app = await setup();
  const submit = () => app.element("#reportForm").submit({ preventDefault() {} });
  const status = app.element("#formStatus");
  const mobileStatus = app.element("#mobileFormStatus");
  await submit();
  assert.match(status.textContent, /Velg først en posisjon/);
  app.advanceTime(10000);
  assert.match(status.textContent, /Velg først en posisjon/);  // An error says what to fix.
  app.updateSelection(58, 8);
  await submit();
  assert.match(status.textContent, /publisert/);
  assert.equal(mobileStatus.textContent, status.textContent);
  app.advanceTime(2999);
  assert.ok(status.textContent);
  app.advanceTime(1);
  assert.equal(status.textContent, "");
  assert.equal(mobileStatus.textContent, "");
});

test("a new message restarts the three seconds, and hiding an old one keeps late errors", async () => {
  let answerRoutes;
  const app = await setup((url) => url.startsWith("/api/routes") ? new Promise((resolve) => { answerRoutes = resolve; }) : undefined);
  const submit = () => app.element("#reportForm").submit({ preventDefault() {} });
  const status = app.element("#formStatus");
  app.updateSelection(58, 8);
  await submit();
  app.advanceTime(2000);
  await submit();
  app.advanceTime(2999);
  assert.match(status.textContent, /publisert/);
  const route = app.element("#routeInput");
  route.value = "3";
  route.input();  // Starts while the message is shown ...
  app.advanceTime(1);
  assert.equal(status.textContent, "");
  answerRoutes(reply({ error: "Linjesøket feilet" }, false));  // ... and fails after it is gone.
  await settle();
  assert.match(status.textContent, /Linjesøket feilet/);
});

test("an automatic GPS position and its stop follow newer fixes until the user types a stop", async () => {
  const app = await setup((url) => url.startsWith("/api/stops/nearby")
    ? reply({ items: [url.includes("lat=59.915") ? { id: "B", name: "Bislett", distance_m: 3 } : { id: "A", name: "Alfa", distance_m: 9 }] })
    : undefined);
  const stop = app.element("#stopInput");
  app.watch(59.911, 10.75, 1000);  // A rough first fix ...
  await settle();
  assert.equal(stop.value, "Alfa");
  app.current(59.915, 10.765, 5);  // ... then a precise one moves both the report and its stop.
  await settle();
  assert.deepEqual([app.state.selectedLatLng.lat, stop.value, stop.dataset.stopId], [59.915, "Bislett", "B"]);
  stop.value = "Bergen";
  stop.input();
  app.watch(59.911, 10.75, 20);
  await settle();
  assert.equal(stop.value, "Bergen");  // A stop the user typed stays.
});

test("a poll waits for the previous one, so answers slower than the interval still arrive", async () => {
  const answers = [];
  const app = await setup((url) => url === "/api/sightings" ? new Promise((resolve) => answers.push(resolve)) : undefined);
  answers.shift()(reply({ items: [] }));  // Startup.
  await settle();
  app.poll();
  app.poll();  // 20 s later, while the first poll still waits.
  assert.equal(answers.length, 1);
  answers.shift()(reply({ items: [{ id: "s1", lat: 58, lon: 8, created_at: new Date().toISOString(), likes_count: 0 }] }));
  await settle();
  assert.ok(app.sightingMarkers.has("s1"));
  app.poll();
  assert.equal(answers.length, 1);  // The next poll starts once the previous one is done.
});

test("a vector map error stays visible until fresh content loads successfully", async () => {
  const app = await setup();
  const status = app.element("#mapStatus");
  assert.equal(app.tiles.options.style, "/map-style.json");
  app.tiles.events.data({ dataType: "source", tile: {} });  // The map has shown something ...
  app.tiles.events.error();  // ... so a later error keeps it and says so.
  app.tiles.events.idle();
  assert.match(status.textContent, /Kartet kunne ikke lastes/);
  assert.equal(status.classList.hidden, false);
  app.tiles.events.data({ dataType: "source", tile: {}, isSourceLoaded: true });  // As MapLibre sends a loaded tile.
  app.tiles.events.idle();
  assert.equal(status.textContent, "");
  assert.equal(status.classList.hidden, true);
});

test("an unreachable vector map before any tile switches to Kartverket's map", async () => {
  const app = await setup();
  app.tiles.events.error();
  assert.equal(app.tiles.removed, true);
  assert.match(app.rasterLayers.at(-1).point, /cache\.kartverket\.no/);
  assert.doesNotMatch(app.element("#mapStatus").textContent, /Kartet kunne ikke lastes/);
});

test("Escape closes an open suggestion list without closing the menu", async () => {
  const app = await setup((url) => url.startsWith("/api/stops/search")
    ? reply({ items: [{ id: "A", name: "Alfa", lat: 59.9, lon: 10.7 }, { id: "B", name: "Alfabet", lat: 59.9, lon: 10.7 }] })
    : undefined);
  const stop = app.element("#stopInput");
  stop.value = "Alf";
  await stop.input();
  let bubbled = 0;
  const escape = () => stop.keydown({ key: "Escape", preventDefault() {}, stopPropagation() { bubbled--; } });
  bubbled++; escape();
  assert.equal(bubbled, 0);  // The open list took this Escape.
  assert.equal(app.element("#stopOptions").hidden, true);
  bubbled++; escape();
  assert.equal(bubbled, 1);  // With the list closed, Escape reaches the menu.
});

test("a renderer startup failure falls back without stopping GPS or reporting", async () => {
  const app = await setup(undefined, { vectorFailure: true });
  assert.match(app.tiles.point, /cache\.kartverket\.no/);
  app.current(59.91, 10.75);
  assert.ok(app.state.currentLocationMarker);
  app.updateSelection(58, 8);
  assert.equal(app.state.selectedLatLng.lat, 58);
});

test("the simplified color map labels only places and omits buildings, shops and terrain detail", async () => {
  const style = JSON.parse(await readFile(new URL("../web/map-style.json", import.meta.url), "utf8"));
  const labels = style.layers.filter((layer) => layer.type === "symbol");
  assert.ok(labels.length > 0);
  assert.ok(labels.every((layer) => layer["source-layer"] === "place"));
  assert.ok(style.layers.every((layer) => !["building", "poi", "transportation_name", "contour"].includes(layer["source-layer"])));
  assert.ok(style.layers.some((layer) => layer["source-layer"] === "water" && layer.type === "fill"));
  assert.ok(style.layers.some((layer) => layer["source-layer"] === "park" && layer.type === "fill"));
});

test("GPS creates and updates the accuracy circle in metres", async () => {
  const app = await setup();
  app.current(58, 8, 35);
  const circle = app.state.currentLocationAccuracy;
  assert.equal(circle.options.radius, 35);
  app.watch(59, 9, 12);
  assert.equal(app.state.currentLocationAccuracy, circle);
  assert.equal(circle.point[0], 59);
  assert.equal(circle.options.radius, 12);
});

test("a late nearest-stop answer cannot overwrite a newer position", async () => {
  const pending = [];
  const app = await setup((url) => url.startsWith("/api/stops/nearby")
    ? new Promise((resolve) => pending.push(resolve)) : undefined);
  const stop = app.element("#stopInput");
  const first = app.loadNearbyStop(58, 8);
  const second = app.loadNearbyStop(59, 9);
  pending[1](reply({ items: [{ id: "B", name: "B", distance_m: 5 }] }));
  await second;
  pending[0](reply({ items: [{ id: "A", name: "A", distance_m: 5 }] }));
  await first;
  assert.equal(stop.value, "B");
  const third = app.loadNearbyStop(60, 10);
  pending[2](reply({ items: [] }));
  await third;
  assert.equal(stop.value, "");
  assert.equal(stop.dataset.stopId, "");
});

test("choosing a stop from the search moves the report position", async () => {
  const app = await setup((url) => url.startsWith("/api/stops/search")
    ? reply({ items: [{ id: "S", name: "Sentrum", lat: 58.2, lon: 8.1 }] }) : undefined);
  const stop = app.element("#stopInput");
  stop.value = "Sentrum";
  await stop.input();
  assert.equal(app.state.selectedLatLng.lat, 58.2);
  assert.equal(app.state.selectedLatLng.lon, 8.1);
  assert.equal(stop.dataset.stopId, "S");
});

test("startup keeps GPS and refreshing when the first API calls fail", async () => {
  const app = await setup((url) => url === "/api/me" || url === "/api/sightings"
    ? reply({ error: "Serveren svarer ikke." }, false) : undefined);
  assert.equal(app.watches(), 1);
  assert.equal(app.intervals(), 1);
  assert.equal(app.element("#feedStatus").textContent, "Serveren svarer ikke.");
});

test("a late stop-search answer cannot move the report position", async () => {
  const pending = [];
  const app = await setup((url) => url.startsWith("/api/stops/search")
    ? new Promise((resolve) => pending.push(resolve)) : undefined);
  const stop = app.element("#stopInput");
  stop.value = "Alfa";
  const first = stop.input();
  stop.value = "Beta";
  const second = stop.input();
  pending[1](reply({ items: [{ id: "B", name: "Beta", lat: 59, lon: 9 }] }));
  await second;
  pending[0](reply({ items: [{ id: "A", name: "Alfa", lat: 58, lon: 8 }] }));
  await first;
  assert.equal(app.state.selectedLatLng.lat, 59);
  assert.equal(stop.dataset.stopId, "B");
});

test("stops sharing a name get distinct suggestions, and the keyboard picks one", async () => {
  const app = await setup((url) => url.startsWith("/api/stops/search") ? reply({ items: [
    { id: "A", name: "Sentrum", platform: "1", lat: 58, lon: 8 },
    { id: "B", name: "Sentrum", platform: "2", lat: 59, lon: 9 },
    { id: "C", name: "Torget", platform: "", lat: 57, lon: 7 },
    { id: "D", name: "Skolen", platform: "", lat: 59.9, lon: 10.7, distance_m: 850 },
    { id: "E", name: "Skolen", platform: "", lat: 63.4, lon: 10.4, distance_m: 391507 },
    { id: "F", name: "Jernbanetorget", mode: "T-bane", description: "", lat: 59.912, lon: 10.751, distance_m: 120 },
    { id: "G", name: "Jernbanetorget", mode: "buss", description: "foran Oslo S", lat: 59.911, lon: 10.75, distance_m: 180 },
  ] }) : undefined);
  const stop = app.element("#stopInput");
  stop.value = "Sentrum";
  await stop.input();
  const list = app.element("#stopOptions");
  assert.match(list.innerHTML, />Sentrum \(plattform 1\)<.*>Sentrum \(plattform 2\)<.*>Torget</s);
  assert.match(list.innerHTML, />Skolen \(850 m\)<.*>Skolen \(391,5 km\)</s);
  assert.match(list.innerHTML, />Jernbanetorget \(T-bane, 120 m\)<.*>Jernbanetorget \(buss, foran Oslo S, 180 m\)</s);
  assert.equal(list.hidden, false);
  const key = (name) => stop.keydown({ key: name, preventDefault() {}, stopPropagation() {} });
  key("ArrowUp");
  assert.match(list.innerHTML, /aria-selected="true">Jernbanetorget \(buss/);  // Up from the field wraps to the last.
  key("ArrowDown");
  key("ArrowDown");
  key("Enter");
  assert.equal(stop.value, "Sentrum (plattform 2)");
  assert.equal(app.state.selectedLatLng.lat, 59);
  assert.equal(stop.dataset.stopId, "B");
  assert.equal(list.hidden, true);
  // Picking a spot on the map closes old suggestions, which carry platforms near the old map centre.
  stop.value = "Sentrum";
  await stop.input();
  await app.loadNearbyStop(58, 8);
  assert.equal(list.hidden, true);
  assert.equal(list.innerHTML, "");
});

test("a late /api/me answer cannot log the user back in after logout", async () => {
  let hold = false;
  let answerMe;
  const app = await setup((url) => url === "/api/me" && hold
    ? new Promise((resolve) => { hold = false; answerMe = resolve; }) : undefined);
  app.state.user = { username: "alice" };
  hold = true;
  const pending = app.loadCurrentUser();
  await app.element("#logoutBtn").click();
  answerMe(reply({ user: { username: "alice" }, stats: null }));
  await pending;
  assert.equal(app.state.user, null);
});

test("a published report stays reported as published when the refresh fails", async () => {
  const app = await setup((url, options) => {
    if (url === "/api/sightings" && options?.method === "POST") return reply({ reporter: "alice" });
    if (url === "/api/sightings") return reply({ error: "Serveren svarer ikke." }, false);
  });
  app.updateSelection(58, 8);
  for (const id of ["#stopInput", "#routeInput", "#noteInput"]) app.element(id).value = "";
  await app.element("#reportForm").submit({ preventDefault() {} });
  await settle();
  assert.equal(app.element("#formStatus").textContent, "Observasjonen er publisert som alice.");
  assert.equal(app.element("#feedStatus").textContent, "Serveren svarer ikke.");
});

test("typing a stop while the nearest stop loads keeps the text", async () => {
  const pending = [];
  const app = await setup((url) => url.startsWith("/api/stops/nearby")
    ? new Promise((resolve) => pending.push(resolve)) : undefined);
  const stop = app.element("#stopInput");
  const nearby = app.loadNearbyStop(58, 8);
  stop.value = "Mitt sted";
  await stop.input();
  pending[0](reply({ items: [{ id: "A", name: "Alfa", distance_m: 40 }] }));
  await nearby;
  assert.equal(stop.value, "Mitt sted");
  assert.equal(stop.dataset.stopId, "");
});

test("refreshing updates sighting markers in place and removes expired ones", async () => {
  const sighting = (id, stop_name, likes_count = 0) => ({
    id, stop_name, likes_count, lat: 58, lon: 8, route: "", note: "", reporter: "Anonym",
    created_at: new Date().toISOString(), distance_to_stop_m: null, liked_by_me: false,
  });
  let items = [sighting("a", "Alfa"), sighting("b", "Beta")];
  const app = await setup((url) => url === "/api/sightings" ? reply({ items }) : undefined);
  const alfa = app.sightingMarkers.get("a");
  const beta = app.sightingMarkers.get("b");
  assert.match(alfa.popup, /Alfa/);
  assert.equal(alfa.options.title, "Observasjon ved Alfa");
  items = [sighting("a", "Alfa", 2)];
  await app.loadSightings();
  assert.equal(app.sightingMarkers.get("a"), alfa);
  assert.match(alfa.popup, /2 bekreftelser/);
  assert.equal(app.sightingMarkers.has("b"), false);
  assert.equal(beta.removed, true);
});

test("a note typed while the previous one is sent is kept", async () => {
  let answer;
  const app = await setup((url, options) => options?.method === "POST"
    ? new Promise((resolve) => { answer = resolve; }) : undefined);
  app.updateSelection(58, 8);
  for (const id of ["#stopInput", "#routeInput"]) app.element(id).value = "";
  const note = app.element("#noteInput");
  note.value = "Første";
  const sent = app.element("#reportForm").submit({ preventDefault() {} });
  await settle();
  note.value = "Andre";
  answer(reply({ reporter: "Anonym" }));
  await sent;
  assert.equal(note.value, "Andre");
});

test("login, registration and logout run one at a time", async () => {
  const logins = [];
  const app = await setup((url) => url === "/api/auth/login"
    ? new Promise((resolve) => logins.push(resolve)) : undefined);
  const form = app.element("#loginForm");
  form.querySelectorAll = () => [{ value: "alice" }, { value: "secret1" }];
  form.reset = () => {};
  const first = form.submit({ preventDefault() {} });
  form.submit({ preventDefault() {} });
  await app.element("#logoutBtn").click();
  assert.equal(logins.length, 1);  // The double click and the logout wait for the first login.
  logins[0](reply({ user: { username: "alice" } }));
  await first;
  assert.equal(app.state.user.username, "alice");
});

test("publishing waits for a pending stop search that moves the position", async () => {
  let answerSearch;
  let posted;
  const app = await setup((url, options) => {
    if (url.startsWith("/api/stops/search")) return new Promise((resolve) => { answerSearch = resolve; });
    if (options?.method === "POST") {
      posted = JSON.parse(options.body);
      return reply({ reporter: "Anonym" });
    }
  });
  app.updateSelection(58, 8);
  for (const id of ["#routeInput", "#noteInput"]) app.element(id).value = "";
  const stop = app.element("#stopInput");
  stop.value = "Bergen";
  stop.input();
  const sent = app.element("#reportForm").submit({ preventDefault() {} });
  answerSearch(reply({ items: [{ id: "BGO", name: "Bergen", lat: 60.39, lon: 5.32 }] }));
  await sent;
  assert.deepEqual([posted.lat, posted.lon, posted.stop_id], [60.39, 5.32, "BGO"]);
});

test("a late GPS answer keeps a newer message from the user's own action", async () => {
  const app = await setup();
  await app.element("#reportForm").submit({ preventDefault() {} });  // Fails: no position chosen yet.
  const message = app.element("#formStatus").textContent;
  assert.match(message, /Velg først/);
  app.current(59, 9);  // The automatic GPS lookup from startup answers afterwards.
  assert.equal(app.element("#formStatus").textContent, message);
});

test("publishing waits for a stop search started while it was already waiting", async () => {
  const searches = [];
  let posted;
  const app = await setup((url, options) => {
    if (url.startsWith("/api/stops/search")) return new Promise((resolve) => searches.push(resolve));
    if (options?.method === "POST") {
      posted = JSON.parse(options.body);
      return reply({ reporter: "Anonym" });
    }
  });
  app.updateSelection(58, 8);
  for (const id of ["#routeInput", "#noteInput"]) app.element(id).value = "";
  const stop = app.element("#stopInput");
  stop.value = "Ber";
  stop.input();
  const sent = app.element("#reportForm").submit({ preventDefault() {} });
  stop.value = "Bergen";
  stop.input();
  searches[0](reply({ items: [] }));
  await settle();
  searches[1](reply({ items: [{ id: "BGO", name: "Bergen", lat: 60.39, lon: 5.32 }] }));
  await sent;
  assert.deepEqual([posted.lat, posted.lon, posted.stop_name], [60.39, 5.32, "Bergen"]);
});

test("publishing does not wait for a stop search a newer one replaced", async () => {
  const searches = [];
  let posted;
  const app = await setup((url, options) => {
    if (url.startsWith("/api/stops/search")) return new Promise((resolve) => searches.push(resolve));
    if (options?.method === "POST") {
      posted = JSON.parse(options.body);
      return reply({ reporter: "Anonym" });
    }
  });
  app.updateSelection(58, 8);
  for (const id of ["#routeInput", "#noteInput"]) app.element(id).value = "";
  const stop = app.element("#stopInput");
  stop.value = "Ber";
  stop.input();
  const sent = app.element("#reportForm").submit({ preventDefault() {} });
  stop.value = "Bergen";
  stop.input();
  searches[1](reply({ items: [{ id: "BGO", name: "Bergen", lat: 60.39, lon: 5.32 }] }));
  await sent;  // The search for "Ber" never answers.
  assert.deepEqual([posted.lat, posted.lon, posted.stop_id], [60.39, 5.32, "BGO"]);
});

test("old suggestions cannot be picked once the text changes, and closed lists stay closed", async () => {
  const searches = [];
  const app = await setup((url) => url.startsWith("/api/stops/search")
    ? new Promise((resolve) => searches.push(resolve)) : undefined);
  const stop = app.element("#stopInput");
  const list = app.element("#stopOptions");
  const key = (name) => stop.keydown({ key: name, preventDefault() {}, stopPropagation() {} });
  stop.value = "Oslo S";
  const first = stop.input();
  searches[0](reply({ items: [{ id: "OSL", name: "Oslo S", lat: 59.91, lon: 10.75 }] }));
  await first;
  key("ArrowDown");
  stop.value = "Trondheim";
  const second = stop.input();
  assert.equal(list.hidden, true);  // Typing clears the old suggestions at once ...
  key("Enter");
  assert.notEqual(stop.dataset.stopId, "OSL");  // ... so Enter cannot pick Oslo S.
  stop.blur();
  searches[1](reply({ items: [{ id: "TRD", name: "Trondheim S", lat: 63.44, lon: 10.4 }] }));
  await second;
  assert.equal(list.hidden, true);  // The late answer does not reopen a list the user left.
  key("ArrowDown");  // The Down arrow opens it again.
  assert.equal(list.hidden, false);
  key("Escape");
  assert.equal(list.hidden, true);
  key("ArrowDown");
  key("Enter");
  assert.equal(stop.dataset.stopId, "TRD");
  stop.value = "Bod";
  const third = stop.input();
  key("Escape");  // Escape while the search is loading ...
  searches[2](reply({ items: [{ id: "BOO", name: "Bodø", lat: 67.28, lon: 14.4 }] }));
  await third;
  assert.equal(list.hidden, true);  // ... keeps its answer from opening the list.
});

test("a stop typed while the GPS button waits wins over its answer", async () => {
  let answerSearch;
  let posted;
  const app = await setup((url, options) => {
    if (url.startsWith("/api/stops/search")) return new Promise((resolve) => { answerSearch = resolve; });
    if (options?.method === "POST") {
      posted = JSON.parse(options.body);
      return reply({ reporter: "Anonym" });
    }
  });
  app.current(59.91, 10.75);  // The startup fix: the report follows GPS.
  await settle();
  for (const id of ["#routeInput", "#noteInput"]) app.element(id).value = "";
  app.click();
  const stop = app.element("#stopInput");
  stop.value = "Dragvoll";
  stop.input();
  const sent = app.element("#reportForm").submit({ preventDefault() {} });
  app.current(59.92, 10.76);  // The button's fix arrives after the user started typing.
  assert.equal(stop.value, "Dragvoll");
  answerSearch(reply({ items: [{ id: "DRV", name: "Dragvoll", lat: 63.41, lon: 10.47 }] }));
  await sent;
  assert.deepEqual([posted.lat, posted.lon, posted.stop_id], [63.41, 10.47, "DRV"]);
});

test("GPS fixes faster than nearby answers still get a stop, for the newest fix", async () => {
  const lookups = [];
  const app = await setup((url) => url.startsWith("/api/stops/nearby")
    ? new Promise((resolve) => lookups.push({ url, resolve })) : undefined);
  app.watch(59.91, 10.75);
  app.watch(59.92, 10.75);
  app.watch(59.93, 10.75);
  assert.equal(lookups.length, 1);  // One lookup at a time, none aborted ...
  lookups[0].resolve(reply({ items: [{ id: "A", name: "Alfa", distance_m: 5 }] }));
  await settle();
  assert.equal(lookups.length, 2);
  assert.match(lookups[1].url, /lat=59.93/);  // ... then the newest fix.
  lookups[1].resolve(reply({ items: [{ id: "C", name: "Cesar", distance_m: 5 }] }));
  await settle();
  assert.equal(app.element("#stopInput").value, "Cesar");
});

test("GPS tracking starts again after permission was denied and then allowed", async () => {
  const app = await setup();
  app.watchDenied();
  app.click();
  assert.equal(app.watches(), 2);
});

test("a refresh holds the poll until both requests are done, even when one fails", async () => {
  const sightings = [];
  let failMe = false;
  const app = await setup((url) => {
    if (url === "/api/sightings" && failMe) return new Promise((resolve) => sightings.push(resolve));
    if (url === "/api/me" && failMe) return reply({ error: "Feil" }, false);
  });
  failMe = true;
  app.poll();
  await settle();
  app.poll();  // /api/me failed at once, but /api/sightings is still loading.
  assert.equal(sightings.length, 1);
  sightings[0](reply({ items: [] }));
  await settle();
  app.poll();
  assert.equal(sightings.length, 2);
});

test("a fully typed name picks its stop whatever the case", async () => {
  const app = await setup((url) => url.startsWith("/api/stops/search")
    ? reply({ items: [{ id: "GLO", name: "Gløshaugen", lat: 63.418, lon: 10.404 }] }) : undefined);
  const stop = app.element("#stopInput");
  stop.value = "gløshaugen";
  await stop.input();
  assert.deepEqual([stop.dataset.stopId, app.state.selectedLatLng.lat], ["GLO", 63.418]);
});

test("publishing waits for the GPS button unless the user picks a spot meanwhile", async () => {
  const posted = [];
  const app = await setup((url, options) => {
    if (options?.method === "POST") {
      posted.push(JSON.parse(options.body));
      return reply({ reporter: "Anonym" });
    }
  });
  for (const id of ["#stopInput", "#routeInput", "#noteInput"]) app.element(id).value = "";
  app.updateSelection(63.418, 10.404);
  app.click();
  let sent = app.element("#reportForm").submit({ preventDefault() {} });
  await settle();
  assert.equal(posted.length, 0);  // Still waiting for the position.
  app.current(63.436, 10.401);
  await sent;
  assert.equal(posted[0].lat, 63.436);
  app.click();
  sent = app.element("#reportForm").submit({ preventDefault() {} });
  app.updateSelection(58, 8);  // A spot picked by hand ends the wait.
  await sent;
  assert.equal(posted[1].lat, 58);
});

test("GPS fixes do not hold up publishing, and the server picks the stop for the position sent", async () => {
  let posted;
  const app = await setup((url, options) => {
    if (url.startsWith("/api/stops/nearby")) return new Promise(() => {});  // Lookups slower than the fixes.
    if (options?.method === "POST") {
      posted = JSON.parse(options.body);
      return reply({ reporter: "Anonym" });
    }
  });
  for (const id of ["#routeInput", "#noteInput"]) app.element(id).value = "";
  const stop = app.element("#stopInput");
  Object.assign(stop, { value: "Storgata" });
  Object.assign(stop.dataset, { stopId: "SG", fromGps: "true" });  // Filled in from an earlier fix.
  app.watch(59.91, 10.75);
  app.watch(59.92, 10.76);
  await app.element("#reportForm").submit({ preventDefault() {} });
  assert.deepEqual([posted.lat, posted.lon, posted.stop_name, posted.stop_id], [59.92, 10.76, "", ""]);
});

test("the GPS button's position wins over a stop search started before it", async () => {
  let answerSearch;
  let posted;
  const app = await setup((url, options) => {
    if (url.startsWith("/api/stops/search")) return new Promise((resolve) => { answerSearch = resolve; });
    if (url.startsWith("/api/stops/nearby")) return new Promise(() => {});  // A slow lookup.
    if (options?.method === "POST") {
      posted = JSON.parse(options.body);
      return reply({ reporter: "Anonym" });
    }
  });
  for (const id of ["#routeInput", "#noteInput"]) app.element(id).value = "";
  app.watch(63.43, 10.39);  // Its lookup is still running, so the button's lookup will wait its turn.
  const stop = app.element("#stopInput");
  stop.value = "Gløshaugen";
  stop.input();
  app.click();
  const sent = app.element("#reportForm").submit({ preventDefault() {} });
  app.current(63.436, 10.4006);
  answerSearch(reply({ items: [{ id: "GLO", name: "Gløshaugen", lat: 63.4168, lon: 10.4076 }] }));
  await sent;
  assert.deepEqual([posted.lat, posted.lon, posted.stop_id], [63.436, 10.4006, ""]);
});

test("a report waiting for the GPS button is not sent from the old spot when GPS fails", async () => {
  let posted;
  const app = await setup((url, options) => {
    if (options?.method === "POST") {
      posted = JSON.parse(options.body);
      return reply({ reporter: "Anonym" });
    }
  });
  for (const id of ["#stopInput", "#routeInput", "#noteInput"]) app.element(id).value = "";
  app.updateSelection(63.4168, 10.4076);
  app.click();
  const sent = app.element("#reportForm").submit({ preventDefault() {} });
  app.currentFails();
  await sent;
  assert.equal(posted, undefined);
  assert.match(app.element("#formStatus").textContent, /Fant ikke posisjonen din/);
  await app.element("#reportForm").submit({ preventDefault() {} });  // Publishing again uses the spot shown.
  assert.equal(posted.lat, 63.4168);
});

test("a failed stop search stops publishing until the user searches again or picks a spot", async () => {
  let posted;
  const app = await setup((url, options) => {
    if (url.startsWith("/api/stops/search")) return reply({ error: "Serveren er opptatt." }, false);
    if (options?.method === "POST") {
      posted = JSON.parse(options.body);
      return reply({ reporter: "Anonym" });
    }
  });
  for (const id of ["#routeInput", "#noteInput"]) app.element(id).value = "";
  app.updateSelection(63.436, 10.4006);
  const stop = app.element("#stopInput");
  stop.value = "Gløshaugen";
  stop.input();
  await app.element("#reportForm").submit({ preventDefault() {} });
  assert.equal(posted, undefined);  // "Gløshaugen" would be stored at Trondheim S.
  assert.match(app.element("#formStatus").textContent, /Holdeplassøket feilet/);
  app.updateSelection(63.4168, 10.4076);
  await app.loadNearbyStop(63.4168, 10.4076);  // A spot picked on the map.
  await app.element("#reportForm").submit({ preventDefault() {} });
  assert.equal(posted.lat, 63.4168);
});

test("a stop name with several matches must be picked before publishing", async () => {
  let posted;
  const app = await setup((url, options) => {
    if (url.startsWith("/api/stops/search")) return reply({ items: [
      { id: "TSB", name: "Trondheim S", mode: "buss", lat: 63.4361, lon: 10.4011, distance_m: 2100 },
      { id: "TST", name: "Trondheim S", mode: "tog", lat: 63.4365, lon: 10.4005, distance_m: 2150 },
    ] });
    if (options?.method === "POST") {
      posted = JSON.parse(options.body);
      return reply({ reporter: "Anonym" });
    }
  });
  for (const id of ["#routeInput", "#noteInput"]) app.element(id).value = "";
  app.updateSelection(63.4168, 10.4076);  // Gløshaugen, picked on the map.
  const stop = app.element("#stopInput");
  stop.value = "Trondheim S";
  stop.input();
  await app.element("#reportForm").submit({ preventDefault() {} });
  assert.equal(posted, undefined);  // Would store "Trondheim S" at Gløshaugen.
  assert.match(app.element("#formStatus").textContent, /Velg holdeplassen/);
  stop.keydown({ key: "ArrowDown", preventDefault() {} });
  stop.keydown({ key: "ArrowDown", preventDefault() {} });
  stop.keydown({ key: "Enter", preventDefault() {} });
  await app.element("#reportForm").submit({ preventDefault() {} });
  assert.deepEqual([posted.stop_id, posted.lat], ["TST", 63.4365]);
});

test("typing a stop drops a GPS stop lookup still waiting its turn", async () => {
  const lookups = [];
  const app = await setup((url) => {
    if (url.startsWith("/api/stops/nearby")) return new Promise((resolve) => lookups.push(resolve));
    if (url.startsWith("/api/stops/search")) return reply({ items: [{ id: "PG", name: "Prinsens gate", lat: 63.43, lon: 10.39 }] });
  });
  app.watch(63.43, 10.40);  // A lookup is running ...
  app.click();
  app.current(63.436, 10.401);  // ... so the button's lookup waits its turn.
  const stop = app.element("#stopInput");
  stop.value = "Prinsen";
  await stop.input();
  lookups[0](reply({ items: [{ id: "TS", name: "Trondheim S", distance_m: 5 }] }));
  await settle();
  assert.equal(lookups.length, 1);
  assert.equal(stop.value, "Prinsen");
});

test("the first GPS fix leaves a stop search the user already started alone", async () => {
  let answerSearch;
  let posted;
  const app = await setup((url, options) => {
    if (url.startsWith("/api/stops/search")) return new Promise((resolve) => { answerSearch = resolve; });
    if (options?.method === "POST") {
      posted = JSON.parse(options.body);
      return reply({ reporter: "Anonym" });
    }
  });
  for (const id of ["#routeInput", "#noteInput"]) app.element(id).value = "";
  const stop = app.element("#stopInput");
  stop.value = "Bergen";
  stop.input();
  const sent = app.element("#reportForm").submit({ preventDefault() {} });
  app.current(58.1, 7.9);  // The automatic GPS lookup answers before the search.
  assert.equal(stop.value, "Bergen");
  answerSearch(reply({ items: [{ id: "BGO", name: "Bergen", lat: 60.39, lon: 5.32 }] }));
  await sent;
  assert.deepEqual([posted.lat, posted.lon, posted.stop_name], [60.39, 5.32, "Bergen"]);
});

test("a late route-search error does not replace a published report's message", async () => {
  let answerRoutes;
  const app = await setup((url, options) => {
    if (url.startsWith("/api/routes")) return new Promise((resolve) => { answerRoutes = resolve; });
    if (options?.method === "POST") return reply({ reporter: "Anonym" });
  });
  app.updateSelection(58, 8);
  for (const id of ["#stopInput", "#noteInput"]) app.element(id).value = "";
  const route = app.element("#routeInput");
  route.value = "M1";
  const search = route.input();
  await app.element("#reportForm").submit({ preventDefault() {} });
  answerRoutes(reply({ error: "Failed to fetch" }, false));
  await search;
  assert.equal(app.element("#formStatus").textContent, "Observasjonen er publisert anonymt.");
});

test("stop searches send the map centre, and every line found is offered with its operator", async () => {
  const urls = [];
  const app = await setup((url) => {
    urls.push(url);
    if (url.startsWith("/api/routes")) {
      return reply({ items: [
        { label: "31 Snarøya - Grorud · Ruter", value: "31 · Ruter" },
        { label: "48 Høllen - Nodelandsheia · Agder", value: "48 Høllen - Nodelandsheia · Agder" },
      ] });
    }
  });
  const stop = app.element("#stopInput");
  stop.value = "Sentrum";
  await stop.input();
  assert.ok(urls.includes("/api/stops/search?q=Sentrum&lat=59.91&lon=10.75"), urls);
  const route = app.element("#routeInput");
  // A browser datalist would hide both, since neither contains the typed "31 Ruter".
  route.value = "31 Ruter";
  await route.input();
  const list = app.element("#routeOptions");
  assert.equal(
    list.innerHTML,
    '<li id="routeOptions-0" role="option" data-index="0" aria-selected="false">31 Snarøya - Grorud · Ruter</li>' +
    '<li id="routeOptions-1" role="option" data-index="1" aria-selected="false">48 Høllen - Nodelandsheia · Agder</li>'
  );
  list.click({ target: { closest: () => ({ dataset: { index: "1" } }) } });
  assert.equal(route.value, "48 Høllen - Nodelandsheia · Agder");  // The value says which line 48 it was.
  assert.equal(list.hidden, true);
});

test("a request without an answer fails after the timeout with a message", async () => {
  const app = await setup((url) => url.startsWith("/api/routes") ? new Promise(() => {}) : undefined);
  const route = app.element("#routeInput");
  route.value = "31";
  route.input();
  await settle();
  app.timeOut();
  await settle();
  assert.match(app.element("#formStatus").textContent, /Fikk ikke svar fra serveren/);
});

test("the line search sends the report position, so nearby lines come first", async () => {
  const urls = [];
  const app = await setup((url) => { urls.push(url); });
  app.updateSelection(63.4168, 10.4076);
  const route = app.element("#routeInput");
  route.value = "3";
  route.input();
  await settle();
  assert.ok(urls.includes("/api/routes?q=3&lat=63.4168&lon=10.4076"));
});

test("devices without WebGL keep a raster map, with error recovery and working GPS", async () => {
  const app = await setup(undefined, { vectorSupport: false });
  assert.match(app.tiles.point, /cache\.kartverket\.no/);
  app.current(59.91, 10.75);
  assert.ok(app.state.currentLocationMarker);
  const status = app.element("#mapStatus");
  app.tiles.events.loading();
  app.tiles.events.tileerror();
  app.tiles.events.load();
  assert.match(status.textContent, /Kartbildene kunne ikke lastes/);
  app.tiles.events.loading();
  app.tiles.events.tileerror();
  app.tiles.events.tileload();
  app.tiles.events.load();
  assert.equal(status.textContent, "");  // Some images arrived, so the map works.
});

test("owners can delete their sighting and logged-in users can report others", async () => {
  const posts = [];
  const items = [
    { id: "own", lat: 58, lon: 8, created_at: new Date().toISOString(), likes_count: 0, mine: true },
    { id: "other", lat: 58, lon: 8, created_at: new Date().toISOString(), likes_count: 0, mine: false },
  ];
  const app = await setup((url, options) => {
    if (options?.method === "POST") {
      posts.push(url);
      return reply({ ok: true });
    }
    if (url === "/api/me") return reply({ user: { username: "bob" }, stats: { xp: 0, likes_received: 0, sightings_count: 0 } });
    if (url === "/api/sightings") return reply({ items });
  });
  await app.refresh();
  const feed = app.element("#feed");
  assert.match(feed.innerHTML, /data-delete-id="own"/);
  assert.match(feed.innerHTML, /data-report-id="other"/);
  assert.doesNotMatch(feed.innerHTML, /data-report-id="own"|data-delete-id="other"/);
  const click = (dataset) => feed.click({ target: { closest: () => ({ dataset }) } });
  await click({ reportId: "other" });
  await click({ deleteId: "own" });
  assert.deepEqual(posts, ["/api/sightings/other/report", "/api/sightings/own/delete"]);
  assert.equal(app.element("#formStatus").textContent, "Observasjonen er slettet.");
});

test("line suggestions follow the report position until a line is picked", async () => {
  const answers = [];
  const app = await setup((url) => url.startsWith("/api/routes") ? new Promise((resolve) => answers.push({ url, resolve })) : undefined);
  const route = app.element("#routeInput");
  const options = app.element("#routeOptions");
  const lines = (value) => reply({ items: [{ value, label: value }] });
  app.updateSelection(59.91, 10.75);
  route.value = "3";
  route.input();
  app.updateSelection(63.4168, 10.4076, true);  // GPS moves the report before the answer for Oslo comes.
  assert.match(answers[1].url, /lat=63.4168&lon=10.4076/);
  answers[0].resolve(lines("3 · Ruter"));
  answers[1].resolve(lines("3 · AtB"));
  await settle();
  assert.match(options.innerHTML, /3 · AtB/);
  assert.doesNotMatch(options.innerHTML, /Ruter/);
  options.click({ target: { closest: () => ({ dataset: { index: "0" } }) } });
  assert.equal(route.value, "3 · AtB");
  app.updateSelection(59.91, 10.75);
  assert.equal(answers.length, 2);  // A picked line is not searched again.
});

test("the map centre button sets the report position, for keyboard users without GPS", async () => {
  const app = await setup();
  app.element("#centerBtn").click();
  assert.deepEqual([app.state.selectedLatLng.lat, app.state.selectedLatLng.lon], [59.91, 10.75]);
});

test("a stop search that works again removes its earlier error, but not other messages", async () => {
  let fail = true;
  const app = await setup((url) => url.startsWith("/api/stops/search")
    ? (fail ? reply({ error: "Holdeplassøket feilet." }, false) : reply({ items: [{ id: "A", name: "Alfa", lat: 59.9, lon: 10.7 }] }))
    : undefined);
  const stop = app.element("#stopInput");
  const status = app.element("#formStatus");
  stop.value = "Alfa";
  await stop.input();
  assert.match(status.textContent, /Holdeplassøket feilet/);
  fail = false;
  await stop.input();
  assert.doesNotMatch(status.textContent, /feilet/);
  assert.equal(stop.dataset.stopId, "A");
  await app.element("#reportForm").submit({ preventDefault() {} });  // Another message ...
  await stop.input();
  assert.ok(status.textContent);  // ... stays when the search works.
});
