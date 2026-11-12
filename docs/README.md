---
git_hash: "4ee4926252a7d5b99638e5ecc4f06e24c9aa0d5f"
modified: "2026-11-12"
---

# Project Documentation

> [!IMPORTANT]
> **Proof of Concept.** Expect inaccuracies, mistakes and oversights.

0. [Terminology](0.terminology.md) — the key terms used across these docs, grouped by domain: palette, core concepts, style and MapLibre, build and render order, data and providers, routes and activities, benchmarking and the compare app
1. [Build Script](1.build.md) — how the OpenGIS Basemap style is fetched, cached and mutated into `style.json`, the palette and sprite-lock workflow, and the toggles and constants that control the result
2. [Style Structure](2.style.md) — how the style builds on the OpenGIS Basemap: palette-driven colours and icons, the basemap's sources, and the outdoor modifications applied on top
3. [Paths](3.paths.md) — the outdoor path family on the basemap path layers, and the low-zoom paths overlay that fills the z9–13 gap in the base data
4. [Outdoor POIs](4.pois.md) — the two-tier POI system: the shared config, the icon palette and the coverage checker
5. [Elevation & Terrain](5.dem.md) — the Mapterhorn DEM — hillshade, 3D terrain, and the contour overlay
6. [Client-side rendering](6.client.md) — how the style is rendered by client mapping libraries: renderer compatibility and metric/imperial unit switching
7. [Activities](7.activities.md) — the waymarked hiking- and cycling-route overlays in the style and the design rationale
8. [Performance](8.performance.md) — the Playwright draw and load benchmarks for the compare app, their recorded baselines and findings, and the DEM source and terrain-LOD optimisations
9. [Natural Earth](9.natural-earth.md) — the calibrated natural-earth vector ground: its palette, the retired `ne2_shaded` raster and where the band sits in the render stack
10. [Render Stack](10.render-stack.md) — the bottom-to-top `RENDER_STACK` bands, the step model and the finishing passes
11. [Ground Raster](11.ground-raster.md) — the Esri World Imagery blend, opacity, water tint, retention, legibility and calibration
12. [Sprites & Icons](12.sprites.md) — the two sprite sheets, adding icons, the POI icon rewrite and checker rules
13. [Compare App](13.compare-app.md) — providers, view modes, swipe/sync, DEM overlays and camera handling

---

**[Terminology](0.terminology.md) →**
