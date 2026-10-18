import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");

const reply = (payload, ok = true) => Promise.resolve({ ok, json: async () => payload });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// `route(url, options)` may return a response promise; anything else gets the default reply.
async function setup(route = () => undefined) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      classList: { toggle() {} },
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
    bindPopup() { return this; },
    on() { return this; },
    clearLayers() {},
    setLatLng(value) { this.point = value; return this; },
    setRadius(value) { this.options.radius = value; return this; },
    setIcon(icon) { this.options.icon = icon; return this; },
    setPopupContent(html) { this.popup = html; return this; },
    removeLayer(child) { child.removed = true; },
  });
  let currentCallback;
  let watchCallback;
  let watches = 0;
  let intervals = 0;
  const context = vm.createContext({
    L: {
      map: () => ({ on() {}, setView() {}, flyTo() {}, panTo() {} }),
      tileLayer: layer, layerGroup: layer, marker: layer, circle: layer,
      divIcon: (options) => options,
    },
    document: { querySelector: element },
    navigator: { geolocation: {
      getCurrentPosition(callback) { currentCallback = callback; },
      watchPosition(callback) { watchCallback = callback; watches++; return 0; },
    } },
    fetch: (url, options) => route(url, options) ?? reply({ ttl_hours: 3, user: null, stats: null, items: [] }),
    setInterval() { intervals++; },
  });
  const app = vm.runInContext(
    `(() => { ${source}\nreturn { state, updateSelection, loadNearbyStop, loadCurrentUser, loadSightings, sightingMarkers }; })()`, context,
  );
  await settle();
  return {
    ...app,
    element,
    click: () => element("#locateBtn").click(),
    current: (lat, lon, accuracy = 25) => currentCallback({ coords: { latitude: lat, longitude: lon, accuracy } }),
    watch: (lat, lon, accuracy = 25) => watchCallback({ coords: { latitude: lat, longitude: lon, accuracy } }),
    watches: () => watches,
    intervals: () => intervals,
  };
}

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
  assert.equal(app.state.selectedLatLng.lat, 60);
  assert.equal(app.watches(), 1);
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

test("stops sharing a name get distinct options, and picking one selects that stop", async () => {
  const app = await setup((url) => url.startsWith("/api/stops/search") ? reply({ items: [
    { id: "A", name: "Sentrum", platform: "1", lat: 58, lon: 8 },
    { id: "B", name: "Sentrum", platform: "2", lat: 59, lon: 9 },
    { id: "C", name: "Torget", platform: "", lat: 57, lon: 7 },
  ] }) : undefined);
  const stop = app.element("#stopInput");
  stop.value = "Sentrum";
  await stop.input();
  assert.match(app.element("#stopOptions").innerHTML, /Sentrum \(plattform 1\).*Sentrum \(plattform 2\).*"Torget"/s);
  stop.value = "Sentrum (plattform 2)";
  await stop.input();
  assert.equal(app.state.selectedLatLng.lat, 59);
  assert.equal(stop.dataset.stopId, "B");
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

test("typing a stop while the nearest stop loads keeps the text and still shows the nearest stop", async () => {
  const pending = [];
  const app = await setup((url) => url.startsWith("/api/stops/nearby")
    ? new Promise((resolve) => pending.push(resolve)) : undefined);
  const stop = app.element("#stopInput");
  const nearby = app.loadNearbyStop(58, 8);
  stop.value = "Mitt sted";
  await stop.input();
  pending[0](reply({ items: [{ id: "A", name: "Alfa", distance_m: 40 }] }));
  await nearby;
  assert.equal(app.element("#nearestStop").textContent, "Alfa (40 m)");
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
