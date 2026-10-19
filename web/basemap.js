// Keep map rendering separate from reporting, GPS and the observation markers.
function createBasemap(map, status) {
  const showStatus = (message = "") => {
    status.textContent = message;
    status.classList.toggle("hidden", !message);
  };
  const entur = ' · Holdeplasser og linjer: <a href="https://developer.entur.org/stops-and-timetable-data">Entur</a> (<a href="https://data.norge.no/nlod/no/2.0">NLOD</a>)';

  // Older devices without WebGL can still show a conventional map and all observations.
  const rasterFallback = () => {
    let loaded = 0;
    let failed = 0;
    const layer = L.tileLayer("https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.kartverket.no/">Kartverket</a>' + entur,
    });
    layer.on("loading", () => { loaded = failed = 0; showStatus("Laster kart …"); });
    layer.on("tileload", () => { loaded++; });
    layer.on("tileerror", () => { failed++; });
    layer.on("load", () => showStatus(failed && !loaded
      ? "Kartbildene kunne ikke lastes. Sjekk internettilgang og eventuell innholdsblokkering."
      : ""));
    return layer.addTo(map);
  };

  if (typeof maplibregl === "undefined") return rasterFallback();
  let layer;
  try {
    const probe = document.createElement("canvas").getContext("webgl2");
    if (!probe) return rasterFallback();
    probe.getExtension("WEBGL_lose_context")?.loseContext();
    maplibregl.setWorkerUrl("/vendor/maplibre-gl-csp-worker.js?v=5.24.0");
    layer = L.maplibreGL({
      style: "/map-style.json",
      interactive: false,
      attributionControl: {
        customAttribution: '<a href="https://openfreemap.org/">OpenFreeMap</a> · &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> · &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' + entur,
      },
    });
    layer.addTo(map);
    const renderer = layer.getMaplibreMap();
    let failed = false;
    showStatus("Laster kart …");
    renderer.on("error", () => {
      failed = true;
      showStatus("Kartet kunne ikke lastes. Sjekk internettilgang og eventuell innholdsblokkering.");
    });
    renderer.on("sourcedata", (event) => {
      if (event.sourceDataType === "content" && event.isSourceLoaded) failed = false;
    });
    renderer.on("idle", () => {
      if (!failed) showStatus();
    });
    return layer;
  } catch {
    if (layer && map.hasLayer(layer)) {
      // Leaflet registers the layer before WebGL initializes. Clean up a partial start, too.
      if (!layer.getMaplibreMap()) layer.onRemove = () => layer.getContainer()?.remove();
      map.removeLayer(layer);
    }
    return rasterFallback();
  }
}
