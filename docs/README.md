---
git_hash: "48536cf1e1d7b297033e2a6b53f8469596c96e44"
modified: "2026-08-10"
---

# Project Documentation

Developer-focused documentation for the [Outdoors](../README.md) codebase — a MapLibre outdoor map style built on OSM Liberty.

## Reading Order

1. [The Style Build](build.md) — how the base style and outdoor layers are assembled into `style.json`, and the knobs that control the result
2. [Style Structure](style.md) — the full layer stack, bottom to top, and what each section changes over the Liberty base
3. [Tile Server & Hosted Overlays](server.md) — the hosted tile.ogis.app services: POIs, routes, paths and contours, and the feeds this repo provides
4. [Contours](contours.md) — the contour overlay styling and how the style consumes the server-generated contour tiles
5. [Outdoor POIs](pois.md) — the POI system: the conceptual model and the catalogue-driven implementation
6. [Low-zoom paths overlay](paths.md) — the style-side of the hosted paths overlay that fills the low-zoom gap in the base data
7. [Client-side rendering](client.md) — how the style is rendered by client mapping libraries: renderer compatibility, metric/imperial unit switching, and the repository's consumers

## Quick Links

- [Main README](../README.md)
- [Style build: scripts/build.mjs](../scripts/build.mjs)
- [Style validation: scripts/validate-style.mjs](../scripts/validate-style.mjs)
- [POI catalogue: pois/catalogue.yml](../pois/catalogue.yml)
- [Compare app: dev/src/App.vue](../dev/src/App.vue)

## Documentation Coverage

This documentation covers:

- The style build pipeline — how `style.json` is assembled and what controls it
- The layer stack and what each section changes over the Liberty base
- The hosted tile.ogis.app services (POIs, routes, paths, contours) and the feeds this repo provides
- The contour overlay styling — how the style consumes the server-generated contour tiles
- The POI system: conceptual model and catalogue-driven implementation
- The style-side of the low-zoom paths overlay and the gap it fills in the base data
