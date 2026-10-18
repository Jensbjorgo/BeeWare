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
      id: selector.slice(1),
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
  let currentError;
  let watchCallback;
  let watchError;
  let watches = 0;
  let intervals = 0;
  let poll;
  const context = vm.createContext({
    L: {
      map: () => ({
        on() {}, setView() {}, flyTo() {}, panTo() {},
        getCenter: () => ({ lat: 59.91, lng: 10.75 }), wrapLatLng: (point) => point,
      }),
      tileLayer: layer, layerGroup: layer, marker: layer, circle: layer,
      divIcon: (options) => options,
    },
    document: { querySelector: element },
    navigator: { geolocation: {
      getCurrentPosition(callback, onError) { currentCallback = callback; currentError = onError; },
      watchPosition(callback, onError) { watchCallback = callback; watchError = onError; watches++; return 0; },
      clearWatch() {},
    } },
    // Like the browser, an aborted request rejects at once even if its answer never comes.
    fetch: (url, options) => Promise.race([
      route(url, options) ?? reply({ ttl_hours: 3, user: null, stats: null, items: [] }),
      new Promise((resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    ]),
    AbortController,
    setInterval(callback) { intervals++; poll = callback; },
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
    currentFails: () => currentError({ code: 3 }),
    watch: (lat, lon, accuracy = 25) => watchCallback({ coords: { latitude: lat, longitude: lon, accuracy } }),
    watches: () => watches,
    watchDenied: () => watchError({ code: 1, PERMISSION_DENIED: 1 }),
    intervals: () => intervals,
    poll: () => poll(),
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
  assert.equal(app.state.selectedLatLng.lat, 60.1);  // A position from GPS keeps following GPS.
  assert.equal(app.watches(), 1);
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
  const key = (name) => stop.keydown({ key: name, preventDefault() {} });
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
  const key = (name) => stop.keydown({ key: name, preventDefault() {} });
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
