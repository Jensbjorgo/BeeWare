# Lokale kartbiblioteker

- Leaflet 1.9.4 (BSD-2-Clause): `leaflet.js` og `leaflet.css`.
- MapLibre GL JS 5.24.0 (BSD-3-Clause og inkluderte tredjepartslisenser):
  `maplibre-gl-csp.js`, `maplibre-gl-csp-worker.js`, `maplibre-gl.css`.
  Lisens: `maplibre-LICENSE.txt`.
- MapLibre GL Leaflet 0.1.4 (ISC): `leaflet-maplibre-gl.js`.
  Lisens: `leaflet-maplibre-gl-LICENSE.txt`.

MapLibre-filene kommer fra npm-pakken `maplibre-gl@5.24.0`; Leaflet-integrasjonen
fra `@maplibre/maplibre-gl-leaflet@0.1.4`. Oppdater hovedfil og worker sammen.
CSP-utgaven bruker en lokal worker og trenger ikke `blob:` i `worker-src`.
Kartstilen i `../map-style.json` er tilpasset BeeWare og bruker OpenFreeMap-data.
