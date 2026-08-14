---
git_hash: "6fd49ab1b6937eb78dc716cd07796bf9d922d112"
modified: "2026-08-14"
---

# Project Documentation

1. [The Style Build](1.build.md) — how the base style and outdoor layers are assembled into `style.json`, and the knobs that control the result
2. [Style Structure](2.style.md) — the full layer stack, bottom to top, and what each section changes over the Liberty base
3. [Low-zoom paths overlay](3.paths.md) — the style-side of the hosted paths overlay that fills the low-zoom gap in the base data
4. [Outdoor POIs](4.pois.md) — the POI system: the conceptual model and the catalogue-driven implementation
5. [Elevation & Terrain](5.dem.md) — the Mapterhorn DEM — hillshade, 3D terrain, and the server-generated contour overlay
6. [Client-side rendering](6.client.md) — how the style is rendered by client mapping libraries: renderer compatibility, metric/imperial unit switching, and the repository's consumers
7. [Tile Server & Hosted Overlays](7.server.md) — the hosted tile.ogis.app services: POIs, paths and contours, and the feeds this repo provides
8. [Hiking Routes](8.activities.md) — the hiking route overlay: the Planetiler profile, how routes are processed, and its rendering in the style
