---
git_hash: "7b3b115523b73d1f3a054a81e3b7eefbecd141ea"
modified: "2026-08-24"
---

# Project Documentation

> [!IMPORTANT]
> **Proof of Concept.** Expect inaccuracies, mistakes and oversights.

0. [Terminology](0.terminology.md) — the key terms used across these docs: basemap, OpenMapTiles, OpenFreeMap, POI, OpenStreetMap
1. [Build Script](1.build.md) — how the OpenGIS Basemap style is fetched, cached and mutated into `style.json`, and the toggles and constants that control the result
2. [Style Structure](2.style.md) — how the style builds on the OpenGIS Basemap: the basemap's sources and the outdoor modifications applied on top
3. [Paths](3.paths.md) — the outdoor path family on the basemap path layers, and the hosted low-zoom paths overlay that fills the z9–13 gap in the base data
4. [Outdoor POIs](4.pois.md) — the two-tier POI system: the shared config, the generated Planetiler schema and the coverage checker
5. [Elevation & Terrain](5.dem.md) — the Mapterhorn DEM — hillshade, 3D terrain, and the server-generated contour overlay
6. [Client-side rendering](6.client.md) — how the style is rendered by client mapping libraries: renderer compatibility, metric/imperial unit switching, and the compare app
7. [Tile Server](7.server.md) — the hosted tile.ogis.app services: POIs, paths and contours, and the feeds this repo provides
8. [Activities](8.activities.md) — activity-specific overlays considered for the style: hiking routes and MTB scale, and why the style stays activity-agnostic

---

**[Terminology](0.terminology.md) →**
