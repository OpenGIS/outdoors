---
git_hash: "2d0d3a76f06d30267dea006faa6855640dde7dae"
modified: "2026-11-06"
---

# Project Documentation

> [!IMPORTANT]
> **Proof of Concept.** Expect inaccuracies, mistakes and oversights.

0. [Terminology](0.terminology.md) — the key terms used across these docs: palette, basemap, OpenMapTiles, OpenFreeMap, POI, OpenStreetMap
1. [Build Script](1.build.md) — how the OpenGIS Basemap style is fetched, cached and mutated into `style.json`, and the palette and sprite-lock workflow, toggles and constants that control the result
2. [Style Structure](2.style.md) — how the style builds on the OpenGIS Basemap: palette-driven colours and icons, the basemap's sources, and the outdoor modifications applied on top
3. [Paths](3.paths.md) — the outdoor path family on the basemap path layers, and the low-zoom paths overlay that fills the z9–13 gap in the base data
4. [Outdoor POIs](4.pois.md) — the two-tier POI system: the shared config, the icon palette and the coverage checker
5. [Elevation & Terrain](5.dem.md) — the Mapterhorn DEM — hillshade, 3D terrain, and the contour overlay
6. [Client-side rendering](6.client.md) — how the style is rendered by client mapping libraries: renderer compatibility, metric/imperial unit switching, and the compare app
7. [Activities](7.activities.md) — the waymarked hiking- and cycling-route overlays in the style, the MTB scale reference implementation, and the design rationale
8. [Performance](8.performance.md) — the Playwright draw and load benchmarks for the compare app, their recorded baselines and findings, and the DEM source and terrain-LOD optimisations
9. [Natural Earth & the Ground Raster](9.natural-earth.md) — the calibrated natural-earth vector ground, the bottom-to-top `RENDER_STACK`, and how the Esri World Imagery raster is blended over it

---

**[Terminology](0.terminology.md) →**
