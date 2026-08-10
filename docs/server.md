---
git_hash: "48536cf1e1d7b297033e2a6b53f8469596c96e44"
modified: "2026-08-10"
---

# Tile Server & Hosted Overlays

> The style renders over the OpenFreeMap/OpenMapTiles base tileset and augments it with outdoor overlays loaded from the hosted `tile.ogis.app` service — POIs, hiking routes, low-zoom paths and contours. The tile server implementation lives outside this repository; this repo feeds the server with [`pois/pois-schema.yml`](../pois/pois-schema.yml), [`examples/FootpathOverlay.java`](examples/FootpathOverlay.java) and [`examples/HikingRouteOverlay.java`](examples/HikingRouteOverlay.java), and wires the tile URLs into the style.

## Scope boundary

Two worlds meet here — the style repository, and the server that hosts the tiles:

- **This repo produces the feeds.** The three tile generators live here as source artifacts: the POI schema (`pois/pois-schema.yml`, generated from the catalogue) and the two Planetiler Java profiles (`examples/HikingRouteOverlay.java`, `examples/FootpathOverlay.java`).
- **This repo consumes the tile URLs.** `TILES_BASE_URL` in [`scripts/build.mjs`](../scripts/build.mjs) is the single base for the POI, route and path endpoints; the contour endpoint is a fixed `CONTOUR_PBF_TILE_URL` constant pointing at the same host.
- **The server build lives outside.** The Planetiler runs, the hosting and the pmtiles → zxy serving all happen on the ogis.app side; nothing in this repo starts, stops or deploys the tile server.

## Services & endpoints

Four services run behind `tile.ogis.app`, all planet-wide with open CORS:

| Service  | Endpoint                   | Source-layer     | Geometry | Zooms  | Fed by                                                                 |
| -------- | -------------------------- | ---------------- | -------- | ------ | ---------------------------------------------------------------------- |
| POIs     | `/pois/{z}/{x}/{y}.pbf`    | `outdoor_pois`   | point    | z12–16 | [`pois/pois-schema.yml`](../pois/pois-schema.yml)                      |
| Routes   | `/routes/{z}/{x}/{y}.pbf`  | `outdoor_routes` | line     | z8–14  | [`examples/HikingRouteOverlay.java`](examples/HikingRouteOverlay.java) |
| Paths    | `/paths/{z}/{x}/{y}.pbf`   | `outdoor_paths`  | line     | z9–13  | [`examples/FootpathOverlay.java`](examples/FootpathOverlay.java)       |
| Contours | `/terrain/{z}/{x}/{y}.pbf` | `contours`       | line     | z9–14  | the contour service — on demand, not fed by this repo                  |

The first three URLs derive from the single `TILES_BASE_URL` constant in [`scripts/build.mjs`](../scripts/build.mjs); the contour URL is the separate fixed `CONTOUR_PBF_TILE_URL` constant. The style consumes all four as plain vector sources — the wiring is covered in [The Style Build](build.md).

## The feeds

### `pois/pois-schema.yml` — the POI schema

[`pois/pois-schema.yml`](../pois/pois-schema.yml) is a **GENERATED** Planetiler YAML schema — do not edit it by hand — defining the `outdoor_pois` layer with point geometry. [`scripts/generate-poi-schema.mjs`](../scripts/generate-poi-schema.mjs) (`npm run pois:schema`) writes it from the `custom` entries of [`pois/catalogue.yml`](../pois/catalogue.yml): one planetiler feature per entry, with `include_when` and `min_zoom` copied from the entry, and attributes `kind` and `name` (plus `ele` for hut/shelter/viewpoint/pass). The source is `osm` with the extract area `geofabrik:italy` unless overridden (`--area` / `POI_AREA`). The catalogue side is documented in [Outdoor POIs (catalogue-driven)](pois.md).

### `HikingRouteOverlay.java` — the routes profile

[`examples/HikingRouteOverlay.java`](examples/HikingRouteOverlay.java) is a Planetiler Java profile emitting the `outdoor_routes` layer (z8–14), patterned on Planetiler's [BikeRouteOverlay example](https://github.com/onthegomap/planetiler/blob/main/planetiler-examples/src/main/java/com/onthegomap/planetiler/examples/BikeRouteOverlay.java). Processing works in three phases:

1. `preprocessOsmRelation` — captures relation metadata for matched relations (`type=route|superroute`, `route=hiking|foot|walking`): name, ref, network (iwn/nwn/rwn/lwn), osmc:symbol, operator, distance, ascent, descent, cai_scale and roundtrip.
2. `processFeature` — emits a line feature for every member way, carrying the relation's attributes.
3. `postProcessLayerFeatures` — merges touching line segments into continuous routes for cleaner rendering and label placement via `FeatureMerge.mergeLineStrings`.

### `FootpathOverlay.java` — the paths profile

[`examples/FootpathOverlay.java`](examples/FootpathOverlay.java) is a Planetiler Java profile emitting the `outdoor_paths` layer (z9–13), modelled on `HikingRouteOverlay.java`. It matches `highway=path|footway|track` and uses the same three-phase structure. The overlay exists because the OpenMapTiles base schema zoom-gates path data — nothing below z12, only route members at z12–13, all paths from z14 — so the base map renders no paths at low zoom and the overlay supplies the z9–13 window.

The **density strategy** mirrors the Mapzen/Tilezen proposal ([vector-datasource #596](https://github.com/mapzen/vector-datasource/issues/596)): route-gated below z12 — iwn → z9, nwn → z10, rwn → z11, lwn → z12, no membership → z12 (all paths from z12). Each emitted feature carries `class`, `network`, and optional `name` / `sac_scale`.

- **Scope:** path + track + footway — the full recommended set, flippable in one line of the profile if the source is ever rebuilt (~78 M ways worldwide, taginfo 2026-08).
- **Route relations:** hiking/foot/walking only — cycling/mtb deliberately excluded, in parity with `outdoor_routes`.
- **Local-dev shortcut:** the profile's `--area=italy` default is for fast test builds; production builds run from the full planet PBF.

Tile-side references behind the paths overlay:

- OpenMapTiles schema: <https://openmaptiles.org/schema/> — transportation layer zoom gating
- [PR #1334](https://github.com/openmaptiles/openmaptiles/pull/1334) (merged) — fixed z12/z13 path/track gating; and its predecessors [PR #1190](https://github.com/openmaptiles/openmaptiles/pull/1190) (selective rendering) / [PR #1186](https://github.com/openmaptiles/openmaptiles/pull/1186) (abandoned all-paths attempt)
- [Issue #271](https://github.com/openmaptiles/openmaptiles/issues/271) — "Show track/path sooner" — the overlay workaround
- Data volume: <https://taginfo.openstreetmap.org/> · Planet PBF: <https://planet.openstreetmap.org/>
- OpenFreeMap (unmodified OMT schema, weekly Planetiler builds): <https://github.com/hyperknot/openfreemap> · styles: <https://github.com/hyperknot/openfreemap-styles>
- Alternatives considered: Waymarked Trails raster (<https://waymarkedtrails.org>), MapTiler Outdoor `trail` layer (<https://docs.maptiler.com/schema/outdoor/>) — route-centric or closed; raw OSM + Planetiler remains the source of record

## Why two generation approaches

The POIs and the routes/paths use different generators because the underlying OSM data has two different shapes:

- **POIs are individual point features with tags** (`tourism=alpine_hut`, `amenity=drinking_water`), so a declarative **YAML schema** can match each tag combination: `include_when` selects the feature, `attributes` maps it to a `kind`.
- **Routes and paths are relations** — the data lives on the relation, the geometry on the member ways — so a declarative schema cannot express them. An imperative **Java profile** works in three phases: preprocess the relation, emit a line feature per member way, then merge touching line segments.

## The contour service

The fourth service — contours — is separate: an on-demand service, not fed by this repo. The hosted [contour-mvt-server](https://github.com/acalcutt/contour-mvt-server) at `tile.ogis.app` rasterises contours with marching squares over the **Mapterhorn DEM**:

- DEM endpoint: `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` — Terrarium-encoded WebP, standard Web Mercator XYZ
- DEM source: Copernicus GLO-30 global base + national/regional LiDAR layers on top
- Attribution required: `© Mapterhorn` (per their TileJSON attribution)

The **same** Mapterhorn endpoint is consumed in two places — client-side as the `demSource` raster-dem that feeds the hillshade layer, and server-side by the contour service — so one provider serves the whole terrain stack:

```mermaid
flowchart LR
    DEM["Mapterhorn DEM<br/>tiles.mapterhorn.com"] -->|"1. client fetch"| HILL["demSource raster-dem<br/>→ hillshade"]
    DEM -->|"2. server fetch"| SERVER["ogis.app contour-mvt-server<br/>marching squares"]
    SERVER -->|"z/x/y.pbf"| STYLE["contour-source<br/>2 contour layers"]
```

The same tile URL is therefore fetched twice — once by the client, once by the tile server — but the CDN serves the second request from cache, so the extra fetch is effectively free.

**Server configuration gotchas** when replicating the service with contour-mvt-server: the source must point at Mapterhorn's Terrarium WebP tiles and its key must match the URL path the style requests (`terrain`); the config must emit source-layer `contours` with `ele`/`level` properties and per-zoom thresholds; and the blank-tile size must match Mapterhorn's own tile size — the server ships with a smaller blank-tile size that would render blank contour tiles at the wrong scale. See the project's own [documentation](https://github.com/acalcutt/contour-mvt-server) for the full configuration reference.

**Zoom ceiling rationale:** PBF contours are generated by marching squares over the raster DEM's pixel grid, and geometry follows pixel boundaries. Beyond the supported zoom the underlying DEM grid becomes visible as stair-stepping — a fundamental limit of server-side contour generation from raster DEM data. The style-side consequence (including the "do not raise the source maxzoom above z14" warning) is documented in [Contours — style side](contours.md).

## Production notes

The hosted services are built from the **full planet PBF** on a machine sized for planet builds (Planetiler needs substantial RAM and scratch disk). The output is a pmtiles archive served by a pmtiles → zxy server behind `tile.ogis.app` serving `/pois/`, `/routes/` and `/paths/`. A paths-only build is substantially cheaper than a full OMT profile (no buildings/POIs/landcover passes), so the hosted service can be refreshed on demand rather than on a fixed schedule. Precedent: OpenFreeMap itself builds the unmodified OMT schema planet-wide weekly with Planetiler.

Tile output is verified live on `tile.ogis.app`: profiles are checked locally on the Italy extract (Dolomites bounds), and the hosted endpoints return gzipped MVT at every zoom in their range.

**Attribution** is declared server-side: the Java profiles set `isOverlay() = true` with attribution `© OpenStreetMap contributors`, while the style-side `TILES_ATTRIBUTION` constant in [`scripts/build.mjs`](../scripts/build.mjs) is blank so the attribution control does not duplicate the OSM credit.

## Key dependencies

- [Planetiler](https://github.com/onthegomap/planetiler) — the tile generator (YAML schema + Java profile modes); the route profile is patterned on its [BikeRouteOverlay example](https://github.com/onthegomap/planetiler/blob/main/planetiler-examples/src/main/java/com/onthegomap/planetiler/examples/BikeRouteOverlay.java)
- [Geofabrik](https://download.geofabrik.de/) — regional OSM extracts used as input (`geofabrik:italy` etc.)
- [OpenStreetMap](https://www.openstreetmap.org/) — source data and tags (`tourism`, `amenity`, `highway`, `route` relations)
- **JDK 21+** — required to run Planetiler's Java profiles
- [contour-mvt-server](https://github.com/acalcutt/contour-mvt-server) + [Mapterhorn DEM](https://mapterhorn.com) — the contour service

## Related

- [Docs index](README.md)
- [Outdoor POIs (catalogue-driven)](pois.md)
- [Low-zoom paths overlay — style side](paths.md)
- [Contours — style side](contours.md)
- [The Style Build](build.md) — the tile endpoints and overlay toggles
- [`scripts/build.mjs`](../scripts/build.mjs) — `TILES_BASE_URL`, `CONTOUR_PBF_TILE_URL` and the overlay sections
