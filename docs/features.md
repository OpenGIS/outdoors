---
git_hash: "b7695ba429f1267d7f4e697c9979e83142571555"
modified: "2026-08-05"
---

# Outdoor Feature Tiles (POIs & Routes)

> The outdoor POI and hiking-route vector tiles are generated outside this repository from OpenStreetMap data using [Planetiler](https://github.com/onthegomap/planetiler) and served from the hosted `tile.ogis.app` service. POI tiles are now catalogue-driven: [`pois/catalogue.yml`](../pois/catalogue.yml) is the single source of truth, and the planetiler schema is generated from it. This page records how both layers are produced.

## Overview

Two vector tile overlays are consumed by the style, both derived from OpenStreetMap:

- **`outdoor_pois`** — point features: huts, shelters, water, parking, viewpoints, mountain passes, campsites, trailheads, ranger stations, picnic sites, castles and more (18 kinds, including park).
- **`outdoor_routes`** — line features for hiking route relations (hiking, foot, walking), classified by network tier (iwn/nwn/rwn/lwn).

They are generated with two different approaches, because the underlying OSM data has two different shapes.

## The two approaches

### POIs — generated YAML schema

OSM POIs are individual point features (nodes) carrying tags such as `tourism=alpine_hut` or `amenity=drinking_water`. A declarative **YAML schema** matches each tag combination and maps it to a `kind` attribute:

- `include_when` — the OSM tags that select a feature
- `attributes` — the output properties (`kind`, plus `name` and, for hut/shelter/viewpoint/pass, `ele`)
- `min_zoom` — zoom at which the feature first appears

The schema is no longer hand-maintained. [`pois/catalogue.yml`](../pois/catalogue.yml) declares every POI (source, kind, icon, min_zoom, OSM tags) and [`scripts/generate-poi-schema.mjs`](../scripts/generate-poi-schema.mjs) derives the planetiler schema from its `custom` entries. The pipeline:

```
pois/catalogue.yml → npm run check:pois (gap determination) → npm run pois:schema
  → pois/pois-schema.yml → remote planetiler build → hosted tiles → style.json
```

Schema: [`pois/pois-schema.yml`](../pois/pois-schema.yml) — defines the `outdoor_pois` layer (point geometry). It is generated — edit the catalogue, then run `npm run pois:schema`. See [Outdoor POIs (catalogue-driven)](pois.md) for the full reference.

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

The tiles are generated and hosted outside this project at **`https://tile.ogis.app`**:

- `https://tile.ogis.app/pois/{z}/{x}/{y}.pbf` — source-layer `outdoor_pois`, z12–16
- `https://tile.ogis.app/routes/{z}/{x}/{y}.pbf` — source-layer `outdoor_routes`, z8–14

The style consumes them as plain vector sources; both URLs derive from the single `TILES_BASE_URL` constant in [`scripts/build.mjs`](../scripts/build.mjs) (toggle `OUTDOOR_POI` / `OUTDOOR_ROUTE`, both default `true`). See the [Outdoor routes](../README.md#outdoor-routes) and [Outdoor POIs](../README.md#outdoor-pois) sections of the main README for layer styling details. The POI side is catalogue-driven end-to-end — see [Outdoor POIs (catalogue-driven)](pois.md).

## Related

- [Docs index](README.md)
- [Outdoor POIs (catalogue-driven)](pois.md) — POI catalogue, schema generation and coverage checker
- [`scripts/build.mjs`](../scripts/build.mjs) — `TILES_BASE_URL`, overlay toggles and layers
- [Contours](contours.md) — the third hosted tile overlay, a server-side contour service
