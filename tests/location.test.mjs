import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");

const reply = (payload, ok = true) => Promise.resolve({ ok, json: async () => payload });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// `route(url)` may return a response promise; anything else gets the default reply.
async function setup(route = () => undefined) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      classList: { toggle() {} },
      dataset: {},
      addEventListener(event, handler) { this[event] = handler; },
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
  const mapHandlers = {};
  const context = vm.createContext({
    L: {
      map: () => ({ on(event, handler) { mapHandlers[event] = handler; }, setView() {}, flyTo() {}, panTo() {} }),
      tileLayer: layer, layerGroup: layer, marker: layer, circle: layer,
      divIcon: (options) => options,
    },
    document: { querySelector: element },
    navigator: { geolocation: {
      getCurrentPosition(callback) { currentCallback = callback; },
      watchPosition(callback) { watchCallback = callback; watches++; return 0; },
    } },
    fetch: (url) => route(url) ?? reply({ ttl_hours: 3, user: null, stats: null, items: [] }),
    setInterval() { intervals++; },
    setTimeout,
    clearTimeout,
  });
  const app = vm.runInContext(
    `(() => { ${source}\nreturn { state, updateSelection, loadNearbyStop }; })()`, context,
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
    mapEvent: (event, payload) => mapHandlers[event](payload),
  };
}

test("GPS preserves manual selection; button moves selection to current position", async () => {
  const app = await setup();
  app.updateSelection(58, 8);
  app.current(59, 9);
  assert.equal(app.state.selectedLatLng.lat, 58);
  app.watch(59.1, 9.1);
  assert.equal(app.state.selectedLatLng.lat, 58);
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
  assert.equal(app.element("#formStatus").textContent, "Serveren svarer ikke.");
});

test("double-click zooms without moving the report position", async () => {
  const app = await setup();
  const wait = () => new Promise((resolve) => setTimeout(resolve, 350));
  app.mapEvent("click", { latlng: { lat: 58, lng: 8 } });
  app.mapEvent("click", { latlng: { lat: 58, lng: 8 } });
  app.mapEvent("dblclick");
  await wait();
  assert.equal(app.state.selectedLatLng, null);
  app.mapEvent("click", { latlng: { lat: 59, lng: 9 } });
  await wait();
  assert.equal(app.state.selectedLatLng.lat, 59);
});
