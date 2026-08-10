---
git_hash: "243f8059116f4428422d421331569d002203c41e"
modified: "2026-08-10"
---

# Project Documentation

Developer-focused documentation for the [Outdoors](../README.md) codebase — a MapLibre outdoor map style built on OSM Liberty.

## Reading Order

1. [The Style Build](build.md) — how the base style and outdoor layers are assembled into `style.json`, and the knobs that control the result
2. [Style Structure](style.md) — the full layer stack, bottom to top, and what each section changes over the Liberty base
3. [Contours](contours.md) — the server-generated contour overlay and how the style consumes it
4. [Outdoor feature tiles (POIs & routes)](features.md) — how the hosted POI and hiking-route tile overlays are produced
5. [Outdoor POIs](pois.md) — the POI system: the conceptual model and the catalogue-driven implementation
6. [Low-zoom paths overlay](paths.md) — the hosted paths overlay that fills the low-zoom gap in the base data

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
- The server-generated contour overlay
- The hosted outdoor feature tiles (POIs & routes) and how they are produced
- The POI system: conceptual model and catalogue-driven implementation
- The low-zoom paths overlay and the gap it fills in the base data
