---
git_hash: "d4a5ead9b15bac8e28c419ff6b4cf2b33cc9d54d"
modified: "2026-08-17"
---

# Project Documentation

> [!IMPORTANT]
> **Proof of Concept.** Expect inaccuracies, mistajes and oversights.

0. [Terminology](0.terminology.md) — the key terms used across these docs: zoom levels, Liberty, OpenMapTiles, POI, OpenStreetMap
1. [Build Script](1.build.md) — how the base style and outdoor layers are assembled into `style.json`, and the toggles and constants that control the result
2. [Style Structure](2.style.md) — how the style builds on the OSM Liberty base: why it's the starting point, its sources, and the modifications that turn it into an outdoor map
3. [Paths](3.paths.md) — the style-side of the hosted paths overlay that fills the low-zoom gap in the base data
4. [Outdoor POIs](4.pois.md) — the POI system: the conceptual model and the catalogue-driven implementation
5. [Elevation & Terrain](5.dem.md) — the Mapterhorn DEM — hillshade, 3D terrain, and the server-generated contour overlay
6. [Client-side rendering](6.client.md) — how the style is rendered by client mapping libraries: renderer compatibility, metric/imperial unit switching, and the repository's consumers
7. [Tile Server](7.server.md) — the hosted tile.ogis.app services: POIs, paths and contours, and the feeds this repo provides
8. [Activities](8.activities.md) — activity-specific overlays considered for the style: hiking routes and MTB scale, and why the style stays activity-agnostic

---

**[Terminology](0.terminology.md) →**
