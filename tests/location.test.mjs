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
    `(() => { ${source}\nreturn { state, updateSelection, loadNearbyStop, loadCurrentUser }; })()`, context,
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
