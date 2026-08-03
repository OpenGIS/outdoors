---
git_hash: "c585e5ec09c36013b705d4ac796127e1667b185a"
modified: "2026-08-02"
---

# Outdoor Feature Tiles (POIs & Routes)

> The outdoor POI and hiking-route vector tiles were originally generated in this repository from OpenStreetMap data using [Planetiler](https://github.com/onthegomap/planetiler). The local generator has been removed — the layers are now served from the hosted `tiles.ogis.app` service. This page records how they were produced.

## Overview

Two vector tile overlays are consumed by the style, both derived from OpenStreetMap:

- **`outdoor_pois`** — point features: huts, shelters, water, parking, viewpoints, mountain passes, campsites, trailheads, ranger stations, picnic sites and more (~16 kinds).
- **`outdoor_routes`** — line features for hiking route relations (hiking, foot, walking), classified by network tier (iwn/nwn/rwn/lwn).

They are generated with two different approaches, because the underlying OSM data has two different shapes.

## The two approaches

### POIs — YAML schema

OSM POIs are individual point features (nodes) carrying tags such as `tourism=alpine_hut` or `amenity=drinking_water`. A declarative **YAML schema** matches each tag combination and maps it to a `kind` attribute:

- `include_when` — the OSM tags that select a feature
- `attributes` — the output properties (`kind`, plus optional `name`/`ele` from OSM tag values)
- `min_zoom` — zoom at which the feature first appears

Schema: [`pois-schema.yml`](examples/pois-schema.yml) — defines the `outdoor_pois` layer (point geometry).

### Routes — Java profile

OSM hiking routes are **relations** — ordered collections of ways with shared metadata (name, ref, network, `osmc:symbol`, ascent, descent, etc.). The route data lives on the relation, but the geometry lives on the member ways, so a declarative schema cannot express it. An imperative **Java profile** (Planetiler's extension point) works in three phases:

1. `preprocessOsmRelation` — capture relation metadata for matched relations (`type=route|superroute`, `route=hiking|foot|walking`)
2. `processFeature` — emit a line feature for every member way, attaching the relation's attributes
3. `postProcessLayerFeatures` — merge touching line segments into continuous routes for cleaner rendering and label placement

Profile: [`HikingRouteOverlay.java`](examples/HikingRouteOverlay.java) — emits the `outdoor_routes` layer (z8–14).

## Key dependencies

- [Planetiler](https://github.com/onthegomap/planetiler) — the tile generator (YAML schema + Java profile modes). The route profile is patterned on its [BikeRouteOverlay example](https://github.com/onthegomap/planetiler/blob/main/planetiler-examples/src/main/java/com/onthegomap/planetiler/examples/BikeRouteOverlay.java).
- [Geofabrik](https://download.geofabrik.de/) — regional OSM extracts used as input (`geofabrik:italy` etc.)
- [OpenStreetMap](https://www.openstreetmap.org/) — source data and tags (`tourism`, `amenity`, `route` relations)
- **JDK 21+** — required to run Planetiler's Java profiles

## Where it lives now

The tiles are generated and hosted outside this project at **`https://tiles.ogis.app`**:

- `https://tiles.ogis.app/pois/{z}/{x}/{y}.pbf` — source-layer `outdoor_pois`, z12–16
- `https://tiles.ogis.app/routes/{z}/{x}/{y}.pbf` — source-layer `outdoor_routes`, z8–14

The style consumes them as plain vector sources; both URLs derive from the single `TILES_BASE_URL` constant in [`scripts/build.mjs`](../scripts/build.mjs) (toggle `OUTDOOR_POI` / `OUTDOOR_ROUTE`, both default `true`). See the [Outdoor routes](../README.md#outdoor-routes) and [Outdoor POIs](../README.md#outdoor-pois) sections of the main README for layer styling details.

## Related

- [Docs index](README.md)
- [`scripts/build.mjs`](../scripts/build.mjs) — `TILES_BASE_URL`, overlay toggles and layers
- [Contours](contours.md) — the third hosted tile overlay, a server-side contour service
