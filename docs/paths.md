---
git_hash: "c9d1316f40b858e30e1619f2aa40b4a36fb21a11"
modified: "2026-08-10"
---

# Low-Zoom Paths Overlay

> The low-zoom paths overlay is implemented end-to-end and live: path/footway/track geometry is generated with Planetiler and served from the hosted `tile.ogis.app/paths` service (z9–13), styled as dashed brown lines that match the promoted base path layer at z14+ — the two sources render as one continuous style.

## 1. Problem

Footpaths (`highway=path` and friends) are styled for high visibility — `road_path_pedestrian` is drawn in the red-brown `#c05a2a` line from z14 (`PATH_BASE_MINZOOM`, set by the `PATH_STYLING` section's `applyPathStyling()` at [`scripts/build.mjs:1940`](../scripts/build.mjs)) — but **nothing renders below z14** because the OpenFreeMap base tileset (unmodified OpenMapTiles schema) contains **no path geometry at low zoom**. For an outdoor map, paths are the bearings you need when zoomed out.

OpenMapTiles zoom-gates path data (verified against `layers/transportation/transportation.sql` and the [schema docs](https://openmaptiles.org/schema/)):

| Zoom  | `transportation` layer content for paths                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------- |
| z9–11 | **None.** Only generalised major roads (`*_gen_*` merge tables)                                                        |
| z12   | `path`/`track` only when **route members** (`route_rank = 1` → iwn/nwn/rwn relations)                                  |
| z13   | `path`/`track` only when **named, routed (rank 1–2), or `sac_scale`-tagged**. `footway`/`cycleway` not included at z13 |
| z14+  | **All** paths, footways, cycleways, steps, bridleway, corridor                                                         |

The Liberty style layer `road_path_pedestrian` sits at `minzoom: 14` because of this data gating; the style cannot fix it — the fix must add data. Generating an overlay of paths at z9–13 is the documented community workaround: OpenMapTiles [issue #271](https://github.com/openmaptiles/openmaptiles/issues/271) ("Show track/path sooner") explicitly recommends _"generating my own vector tiles with the paths and tracks only and use it as an additional source in my style."_

## 2. Approach

**The base map is augmented with a self-hosted vector overlay** — the same pattern as the POI/route overlays (see [features.md](features.md)):

- Source served from `TILES_BASE_URL` (`https://tile.ogis.app`) at **`/paths/{z}/{x}/{y}.pbf`**, source-layer **`outdoor_paths`**, z9–13. The endpoint is live and planet-wide (open CORS) — e.g. <https://tile.ogis.app/paths/12/2183/1450.pbf> and <https://tile.ogis.app/paths/13/4366/2900.pbf> (sampled at Dolomites coords) return gzipped MVT at every zoom z9–13; see [§7](#7-verification) for the per-zoom verification.
- Generated with a **Planetiler Java profile** ([`FootpathOverlay.java`](examples/FootpathOverlay.java)) — network gating below z12 requires relation preprocessing (`preprocessOsmRelation`), which only the Java profile supports. Pattern: [`HikingRouteOverlay.java`](examples/HikingRouteOverlay.java) + Planetiler's [BikeRouteOverlay example](https://github.com/onthegomap/planetiler/blob/main/planetiler-examples/src/main/java/com/onthegomap/planetiler/examples/BikeRouteOverlay.java).
- **Density strategy: route-gated below z12, all paths at z12.** This mirrors the Mapzen/Tilezen proposal ([vector-datasource #596](https://github.com/mapzen/vector-datasource/issues/596)): **iwn → z9, nwn → z10, rwn → z11, lwn → z12**, all paths at z12. It also matches the lesson OpenMapTiles learned: the naive "all paths at z12–13" attempt ([PR #1186](https://github.com/openmaptiles/openmaptiles/pull/1186)) caused a **~20 % tile-size increase at z13** and was abandoned in favour of importance gating ([PR #1190](https://github.com/openmaptiles/openmaptiles/pull/1190), refined by the merged [PR #1334](https://github.com/openmaptiles/openmaptiles/pull/1334), Jan 2022).
- **Coverage: planet-wide with open CORS.** The hosted service is built from the **full planet PBF**, like the `/routes/` and `/pois/` overlays — the same planet data the base OpenFreeMap tiles are built from, so the overlay and the base agree everywhere. The profile's `--area=italy` default and the `--bounds` examples below are **local-dev shortcuts for fast test builds**; see [§5](#5-planet-build--production-notes) for the planet build.

## 3. Data scope

The profile includes **`path` + `track` + `footway`** — the full recommended set, flippable in one line of the profile if the source is ever rebuilt. Volume worldwide (taginfo, 2026-08):

| Option                                            | Ways worldwide (taginfo, 2026-08) | Notes                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path` + `track` + `footway` **(in the profile)** | ~78.4 M                           | Full outdoor coverage: hiking paths, forest/agricultural tracks, urban footways (32.2 M of the total). Footways add urban density but close gaps in towns. |
| `path` + `track` only                             | ~46.2 M                           | The true outdoor subset (16.4 M + 29.8 M). Smallest footprint; urban footpaths absent at low zoom.                                                         |
| `path` only                                       | ~16.4 M                           | Trail focus only; misses forest tracks that are often the only "path" in a region.                                                                         |

The style draws `class ∈ {path, pedestrian}` for paths, and tracks via the `outdoor-local-fill` layer (`minor`/`service`/`track`, minzoom 12 — the earliest zoom where OpenMapTiles tiles carry track geometry) with the darker `COLOURS.ROADS.TRACK_CASING` casing ([`scripts/build.mjs:1547`](../scripts/build.mjs)). The overlay including tracks simply means they appear from z9 (the overlay's minzoom) instead of z12. (The legacy `ROAD_PALETTE` track width/casing ramps and z13 label promotion — `ROAD_TRACK_WIDTH`, `ROAD_TRACK_CASING_WIDTH`, `ROAD_TRACK_LABEL_MINZOOM` — only take effect when that disabled feature is enabled.)

## 4. Planetiler profile — `FootpathOverlay.java`

Profile: [`examples/FootpathOverlay.java`](examples/FootpathOverlay.java) — emits the `outdoor_paths` layer (z9–13), modelled on `HikingRouteOverlay.java`. `isOverlay() = true`, `maxzoom` default **13**, attribution `© OpenStreetMap contributors` (matches `TILES_ATTRIBUTION`).

### Phase 1 — `preprocessOsmRelation`

- Match `type=route|superroute`, `route=hiking|foot|walking` (semicolon-split; same filter as the routes overlay). Cycling/mtb relations are not included — deliberate parity with `outdoor_routes`.
- Extract `network` → tier: `iwn`, `nwn`, `rwn`, `lwn`, else `null`.
- Store per relation: id + tier.

### Phase 2 — `processFeature`

For line features (`sourceFeature.canBeLine()`) with `highway ∈ {path, footway, track}` (semicolon-split):

1. Query `relationInfo(PathRelationInfo.class, true)` for the way's route memberships.
2. Compute the way's **minimum zoom** = lowest zoom among its member relation tiers:

   | Best membership   | min zoom |
   | ----------------- | -------- |
   | iwn               | 9        |
   | nwn               | 10       |
   | rwn               | 11       |
   | lwn               | 12       |
   | none (not routed) | 12       |

3. `features.line("outdoor_paths")`
   - `.setAttr("class", highway value)` — `path`/`footway`/`track`
   - `.setAttr("network", tier)` — `iwn`/`nwn`/`rwn`/`lwn`, omitted for non-routed
   - `.setAttr("name", name)` — nullable
   - `.setAttr("sac_scale", ...)` — nullable
   - `.setZoomRange(minZoom, 13)` — the overlay ends at z13; z14+ is the base map's job (all paths present there)
   - `.setMinPixelSize(0)` — required so short segments survive for merging (same as `HikingRouteOverlay.java`)

### Phase 3 — `postProcessLayerFeatures`

`FeatureMerge.mergeLineStrings(items, 0.5, 0.1, 4)` for `outdoor_paths`. Merging is safe with zoom gating because Planetiler calls this per zoom — only features active at that zoom are merged, so z9 merging only touches iwn members.

### Entrypoint & build command

- `area` argument (Geofabrik, default `italy` — a local-dev shortcut; the hosted tiles are built from the full planet), `--download`, optional `--bounds` (e.g. `10.48,45.27,11.78,46.18` for the Dolomites test), output `paths/outdoor_paths.pmtiles`.
- Run from the project root with Planetiler on the classpath:

```bash
java -cp ../.planetiler/planetiler.jar build/FootpathOverlay.java \
  --area=italy --download --bounds=10.48,45.27,11.78,46.18
```

## 5. Planet build — production notes

> [!NOTE]
> The hosted service is built from the **full planet PBF** — all `tile.ogis.app` overlays are planet-wide with open CORS. The table below documents that production build; the profile's `--area=italy` default is a local-dev shortcut for fast test builds.

| Factor      | Value                                                                                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input       | Planet PBF **~88 GB** ([planet.openstreetmap.org](https://planet.openstreetmap.org/), planet-260727)                                                                                                                                                                                                            |
| Machine     | **≥ 64 GB RAM, ~0.5–1 TB scratch disk** (Planetiler needs disk ≈ 5–10× PBF; RAM ≥ 0.5× PBF). Full OMT-profile reference: 64 CPU/128 GB → 42 min, 32 CPU/64 GB → 1 h 27 m, 16 CPU/32 GB → 2 h 38 m (z0–14, 69–81 GB output) — a paths-only profile is substantially cheaper (no buildings/POIs/landcover passes) |
| Output size | **~1–5 GB pmtiles** with route gating + zoom-tiered simplification + minimal attributes (vs ~5–20 GB for full density). z13 dominates — each zoom roughly doubles tile size (Protomaps); z13 alone is ~67 M tiles worldwide                                                                                     |
| Serving     | Same as `/routes/` and `/pois/`: pmtiles → `/{z}/{x}/{y}.pbf` server on tile.ogis.app behind the CDN (mechanism already in place for the other overlays)                                                                                                                                                        |
| Precedent   | OpenFreeMap itself builds the unmodified OMT schema planet-wide weekly with Planetiler (500 GB SSD, 64 GB RAM, ~5 h); single-purpose planet layers are fast (e.g. Paul Norman's planet-wide trees layer in ~10 min with Tilemaker)                                                                              |

Rebuilds of the planet PBF are cheap for this profile — a paths-only build is substantially cheaper than the full-OMT times above — so the hosted service can be refreshed on demand rather than on a fixed schedule.

## 6. Style-side changes — `scripts/build.mjs`

Both the overlay (z9–13) and the promoted base layer (z14+) are styled from the **same shared constants**, so the two sources hand over seamlessly: same colour `#c05a2a`, same dash `[1, 0.7]`, same round cap/join, and matched widths at the seam (z13 ≈ z14 ≈ 2 px).

1. **Toggle** `LOW_ZOOM_PATHS = true` (default) at [`scripts/build.mjs:91`](../scripts/build.mjs), placed in render order **between `REPLACE_LIBERTY_POIS` and `OUTDOOR_ROUTE`** (toggles follow the build sections bottom→top, so it sits where its section renders). `PATH_STYLING` (default `true`, [`scripts/build.mjs:95`](../scripts/build.mjs)) owns the prominent base-layer path styling at z14+.
2. **Config block** at [`scripts/build.mjs:517`](../scripts/build.mjs):
   - `PATHS_SOURCE_LAYER = "outdoor_paths"`, `PATHS_TILE_URL` = `` `${TILES_BASE_URL}/paths/{z}/{x}/{y}.pbf` `` ([`scripts/build.mjs:525`](../scripts/build.mjs))
   - `PATHS_SOURCE_MINZOOM = 9`, `PATHS_SOURCE_MAXZOOM = 13`
   - `PATHS_LAYER_MAXZOOM = 14` (exclusive — hands off to `road_path_pedestrian` at z14)
   - **Shared path style definitions** — referenced by both the overlay and the promoted base layer, so nothing is duplicated:
      - `PATH_LINE_CAP` / `PATH_LINE_JOIN = "round"` ([`scripts/build.mjs:533`](../scripts/build.mjs))
      - `PATH_DASHARRAY = [1, 0.7]` — matches the Liberty base `road_path_pedestrian` dash ([`scripts/build.mjs:535`](../scripts/build.mjs))
      - `PATH_WIDTH` — the base layer's z14+ width (`["interpolate", ["exponential", 1.2], ["zoom"], 12, 1, 14, 2, 20, 8]`), moved out of the path-styling section where it was previously a hard-coded literal ([`scripts/build.mjs:536`](../scripts/build.mjs))
      - `PATH_WIDTH_LOW_ZOOM` — the overlay's z9–13 width (`9 → 0.6, 11 → 1, 13 → 2`), tuned so **z13 (2 px) ≈ `PATH_WIDTH` at z14 (2 px)** for a seamless handoff ([`scripts/build.mjs:547`](../scripts/build.mjs))
      - `PATH_BASE_MINZOOM = 14` — `road_path_pedestrian` renders from here ([`scripts/build.mjs:558`](../scripts/build.mjs))
3. **Build section — `applyLowZoomPaths()`** ([`scripts/build.mjs:1792`](../scripts/build.mjs), called from `build()` at [`scripts/build.mjs:2614`](../scripts/build.mjs)), between the replaced-liberty-POI step and the outdoor-routes step:
   - Source `outdoor-paths` (vector, tiles `PATHS_TILE_URL`, minzoom 9, maxzoom 13, attribution `TILES_ATTRIBUTION` — `© OpenStreetMap contributors`, [`scripts/build.mjs:505`](../scripts/build.mjs))
   - Line layer `outdoor-paths`: source-layer `outdoor_paths`, `minzoom: 9`, `maxzoom: 14` (exclusive — renders z9–13), `line-cap` / `line-join: round`, paint `line-color: COLOURS.PATHS.PATH` (`#c05a2a`), `line-dasharray: PATH_DASHARRAY`, `line-width: PATH_WIDTH_LOW_ZOOM`
   - Spliced at the POI anchor so the render stack stays **paths → routes → POIs** (paths below route lines, routes below POIs)
4. **Path-styling section (was `PROMOTE_PATHS`, now `PATH_STYLING`) refactored** — `applyPathStyling()` at [`scripts/build.mjs:1937`](../scripts/build.mjs):
   - `road_path_pedestrian.minzoom` is now explicitly `PATH_BASE_MINZOOM` (**14**) — the overlay owns z9–13, the base layer owns z14+, same colour/width family, no double-draw (this also removes the previous useless render attempt below z14, where the OMT source has no data)
   - Paint/layout reference the shared `PATH_WIDTH` / `PATH_DASHARRAY` / `PATH_LINE_CAP` / `PATH_LINE_JOIN` — the width literal is no longer hard-coded in this section
   - `highway-name-path` unchanged (still promoted to `minzoom: 0`, `text-colour: COLOURS.PATHS.PATH`)

## 7. Verification

| #   | Check                             | Status   | Result                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Profile correctness (tile source) | **Done** | `FootpathOverlay.java` verified locally on the Italy extract (Dolomites bounds — local-dev shortcut); tile contents follow the density strategy per zoom (z9 = iwn only → z12+ = all paths)                                                                                                                                  |
| 2   | Serving (tile source)             | **Done** | `curl https://tile.ogis.app/paths/{z}/{x}/{y}.pbf` returns HTTP 200 with gzipped MVT (source-layer `outdoor_paths`) from the planet-wide live service at all zooms z9–13 (sampled at Dolomites coords): z9/272/181 = 5660 B · z10/545/362 = 9244 B · z11/1091/725 = 4496 B · z12/2183/1450 = 9768 B · z13/4366/2900 = 2477 B |
| 3   | Style build                       | **Done** | `npm run build` passes — style.json gains source `outdoor-paths` + layer; both project builds pass (`npm run build` — 95 layers / 7 sources; `npm run demo:build`)                                                                                                                                                           |
| 4   | Visual                            | **Done** | Chrome-verified z11–z13 in the Dolomites: dashed brown paths render, route lines above them, zero console errors                                                                                                                                                                                                             |
| 5   | Handoff                           | **Done** | Clean z13 → z14: no double-draw (overlay `maxzoom: 14` exclusive + base `minzoom: 14`), widths matched (z13 = z14 = 2 px)                                                                                                                                                                                                    |
| 6   | Docs                              | **Done** | This doc describes the shipped state; README + docs index in sync                                                                                                                                                                                                                                                            |

The tile source is live — rows 1–2 were verified against the running `tile.ogis.app/paths` service; rows 3–6 against this repo's builds and the compare app.

## 8. Decisions made

The pipeline (profile → pmtiles → served tiles → style) is live end-to-end; the following choices are fixed facts rather than open questions:

1. **Scope:** `path` + `track` + `footway` — the full recommended set (flippable in one line of the profile if the tile source is ever rebuilt).
2. **Route relations:** hiking/foot/walking only; cycling/mtb not included (parity with `outdoor_routes`).
3. **Serving:** the same pmtiles→zxy server behind `tile.ogis.app` that serves `/routes/` and `/pois/` also serves `/paths/`.
4. **Refresh cadence:** the hosted service is rebuilt from the planet PBF; planet rebuilds are cheap for this profile (§5), so the cadence is on demand.
5. **Build machine:** the ogis.app box, sized for planet builds (≥ 64 GB RAM + ~0.5–1 TB scratch).

## 9. Key references

- OpenMapTiles schema: <https://openmaptiles.org/schema/> — transportation layer zoom gating
- [PR #1334](https://github.com/openmaptiles/openmaptiles/pull/1334) (merged) — fixed z12/z13 path/track gating; and its predecessors [PR #1190](https://github.com/openmaptiles/openmaptiles/pull/1190) (selective rendering) / [PR #1186](https://github.com/openmaptiles/openmaptiles/pull/1186) (abandoned all-paths attempt, ~20 % tile size)
- [Issue #271](https://github.com/openmaptiles/openmaptiles/issues/271) — "Show track/path sooner" — the overlay workaround
- Mapzen/Tilezen zoom-by-network proposal: <https://github.com/mapzen/vector-datasource/issues/596>
- Planetiler: <https://github.com/onthegomap/planetiler> · [BikeRouteOverlay example](https://github.com/onthegomap/planetiler/blob/main/planetiler-examples/src/main/java/com/onthegomap/planetiler/examples/BikeRouteOverlay.java)
- Existing repo profiles: [FootpathOverlay.java](examples/FootpathOverlay.java) · [HikingRouteOverlay.java](examples/HikingRouteOverlay.java) · [pois-schema.yml](../pois/pois-schema.yml) (generated from [pois/catalogue.yml](../pois/catalogue.yml)) · POI reference: [pois.md](pois.md) · generation history: [features.md](features.md) · contours: [contours.md](contours.md)
- Data volume: <https://taginfo.openstreetmap.org/> (`highway=path/footway/track`) · Planet PBF: <https://planet.openstreetmap.org/>
- OpenFreeMap (unmodified OMT schema, weekly Planetiler builds): <https://github.com/hyperknot/openfreemap> · styles: <https://github.com/hyperknot/openfreemap-styles> (Liberty `road_path_pedestrian` at `minzoom: 14`)
- Planet-wide single-layer build precedent: <https://www.openstreetmap.org/user/pnorman/diary/408183> · tile-size/zoom scaling: <https://jeremymax.com/blog/offline-maps-pmtiles> · path-only pmtiles overlays: <https://blog.wxm.be/2023/11/25/osm-to-pmtiles-with-tilemaker.html>
- Alternatives considered: Waymarked Trails raster (<https://waymarkedtrails.org>), MapTiler Outdoor `trail` layer (<https://docs.maptiler.com/schema/outdoor/>) — route-centric or closed; raw OSM + Planetiler remains the source of record
