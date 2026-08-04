---
git_hash: "fa4574de3351119e439e2cbd1f6c918aeee9dc7b"
modified: "2026-08-03"
---

# Project Documentation

Developer-focused documentation for the [Outdoors](../README.md) codebase — a MapLibre outdoor map style built on OSM Liberty.

## Reading Order

1. [Contours](contours.md) - Hosted PBF contour implementation reference (tile endpoint, layers, zoom ceiling, units)
2. [Outdoor feature tiles (POIs & routes)](features.md) - How the outdoor POI and hiking-route layers are generated (schema vs profile)
3. [Low-zoom paths overlay](paths.md) - Self-hosted paths vector source (tiles.ogis.app/paths) filling the z9-13 gap below the base map's z14 path data; style-side integration implemented in scripts/build.mjs

## Quick Links

- [Main README](../README.md)
- [Style build: scripts/build.mjs](../scripts/build.mjs)
- [Compare app: dev/src/App.vue](../dev/src/App.vue)

## Documentation Coverage

This documentation covers:

- The hosted PBF contour implementation
- The outdoor POI and hiking-route tile generation (YAML schema vs Java profile)
- The implemented low-zoom paths overlay (z9-13, route-gated; style-side integration in scripts/build.mjs)
