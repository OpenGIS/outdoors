---
git_hash: "fa4574de3351119e439e2cbd1f6c918aeee9dc7b"
modified: "2026-08-03"
---

# Low-Zoom Paths Overlay

> **Status:** implemented (style-side). Paths now render from z9 via a self-hosted vector overlay (`tiles.ogis.app/paths`), styled as dashed brown lines in the same colour/width family as the promoted base path layer at z14+, so the two render as one continuous style. The style-side integration is complete in [`scripts/build.mjs`](../scripts/build.mjs) — see [§6](#6-style-side-changes--scriptsbuildmjs-implemented) for what landed.
>
> The tile-source work (Planetiler profile → pmtiles → served from tiles.ogis.app) happened outside this repo as planned, the same as the existing POI/route overlays — see [features.md](features.md). Sections 2–5 below are the reference spec for that external work; sections 6–8 reflect the shipped style-side state.

## 1. Problem

Footpaths (`highway=path` and friends) are styled for high visibility — `road_path_pedestrian` is drawn in the red-brown `#c05a2a` line from z14 (`PATH_BASE_MINZOOM`, set by `PROMOTE_PATHS` at [`scripts/build.mjs:1430`](../scripts/build.mjs)) — but **nothing renders below z14** because the OpenFreeMap base tileset (unmodified OpenMapTiles schema) contains **no path geometry at low zoom**. For an outdoor map, paths are the bearings you need when zoomed out.

OpenMapTiles zoom-gates path data (verified against `layers/transportation/transportation.sql` and the [schema docs](https://openmaptiles.org/schema/)):

| Zoom | `transportation` layer content for paths |
|---|---|
| z9–11 | **None.** Only generalised major roads (`*_gen_*` merge tables) |
| z12 | `path`/`track` only when **route members** (`route_rank = 1` → iwn/nwn/rwn relations) |
| z13 | `path`/`track` only when **named, routed (rank 1–2), or `sac_scale`-tagged**. `footway`/`cycleway` not included at z13 |
| z14+ | **All** paths, footways, cycleways, steps, bridleway, corridor |

The Liberty style layer `road_path_pedestrian` sits at `minzoom: 14` because of this data gating; the style cannot fix it — the fix must add data. Generating an overlay of paths at z9–13 is the documented community workaround: OpenMapTiles [issue #271](https://github.com/openmaptiles/openmaptiles/issues/271) ("Show track/path sooner") explicitly recommends *"generating my own vector tiles with the paths and tracks only and use it as an additional source in my style."*

## 2. Approach (agreed)

**Augment the base map with a self-hosted vector overlay** following the exact pattern of the existing overlays:

- New source served from `TILES_BASE_URL` (`https://tiles.ogis.app`) at **`/paths/{z}/{x}/{y}.pbf`**, source-layer **`outdoor_paths`**, z9–13.
- Generated with a **Planetiler Java profile** (not the YAML schema) — network gating below z12 requires relation preprocessing (`preprocessOsmRelation`), which only the Java profile supports. Pattern: [`HikingRouteOverlay.java`](examples/HikingRouteOverlay.java) + Planetiler's [BikeRouteOverlay example](https://github.com/onthegomap/planetiler/blob/main/planetiler-examples/src/main/java/com/onthegomap/planetiler/examples/BikeRouteOverlay.java).
- **Density strategy (locked): route-gated below z13, everything at z13.** This mirrors the Mapzen/Tilezen proposal ([vector-datasource #596](https://github.com/mapzen/vector-datasource/issues/596)): **iwn → z9, nwn → z10, rwn → z11, lwn → z12**, all paths at z13. It also matches the lesson OpenMapTiles learned: the naive "all paths at z12–13" attempt ([PR #1186](https://github.com/openmaptiles/openmaptiles/pull/1186)) caused a **~20 % tile-size increase at z13** and was abandoned in favour of importance gating ([PR #1190](https://github.com/openmaptiles/openmaptiles/pull/1190), refined by the merged [PR #1334](https://github.com/openmaptiles/openmaptiles/pull/1334), Jan 2022).
- **Build scale (locked): test extract first, then planet.** Validate geometry/zooms/sizes on a small Geofabrik extract (minutes), then commit to the planet build.

## 3. Data scope (recommendation — flippable in the profile)

| Option | Ways worldwide (taginfo, 2026-08) | Notes |
|---|---|---|
| `path` + `track` + `footway` **(recommended)** | ~78.4 M | Full outdoor coverage: hiking paths, forest/agricultural tracks, urban footways (32.2 M of the total). Footways add urban density but close gaps in towns. |
| `path` + `track` only | ~46.2 M | The true outdoor subset (16.4 M + 29.8 M). Smallest footprint; urban footpaths absent at low zoom. |
| `path` only | ~16.4 M | Trail focus only; misses forest tracks that are often the only "path" in a region. |

Recommendation: **`path` + `track` + `footway`**. The style draws `class ∈ {path, pedestrian}` for paths, and tracks via `road_service_track` — which the base palette now promotes to render from z12 (the earliest zoom where OpenMapTiles tiles carry track geometry) with a dark casing (`ROAD_TRACK_CASING_WIDTH`) and name labels from z13 (`ROAD_TRACK_LABEL_MINZOOM`). The overlay including tracks simply means they appear from z9 (the overlay's minzoom) instead of z12 — consistent with the outdoor-first palette where tracks are already emphasised (`ROAD_TRACK_WIDTH`, [`scripts/build.mjs:260`](../scripts/build.mjs)).

## 4. Planetiler profile specification (`FootpathOverlay.java`)

New example file `docs/examples/FootpathOverlay.java`, modelled on `HikingRouteOverlay.java`.

### Phase 1 — `preprocessOsmRelation`

- Match `type=route|superroute`, `route=hiking|foot|walking` (same filter as the routes overlay; extending to `cycling|mtb` is a later option — cycling routes often follow the same tracks, but keep parity with `outdoor_routes` initially).
- Extract `network` → tier: `iwn`, `nwn`, `rwn`, `lwn` (map like `HikingRouteOverlay.java:77-84`).
- Store per relation: id, tier.

### Phase 2 — `processFeature`

For line features (`sourceFeature.canBeLine()`) with `highway ∈ {path, footway, track}`:

1. Query `relationInfo(PathRelationInfo.class, true)` for the way's route memberships.
2. Compute the way's **minimum zoom** = lowest zoom among its member relation tiers:

   | Best membership | min zoom |
   |---|---|
   | iwn | 9 |
   | nwn | 10 |
   | rwn | 11 |
   | lwn | 12 |
   | none (not routed) | 13 |

   (Tunable later: named/`sac_scale` ways could be boosted to z12 like OMT does — the agreed strategy keeps pure route gating.)
3. `features.line("outdoor_paths")`
   - `.setAttr("class", highway value)` — `path`/`footway`/`track`
   - `.setAttr("network", tier)` — `iwn`/`nwn`/`rwn`/`lwn`, omitted (or `"none"`) for non-routed
   - `.setAttr("name", name)` — nullable; enables future z13 labels from the overlay
   - (optional: `.setAttr("sac_scale", ...)`, nullable — low cost, useful for emphasis)
   - `.setZoomRange(minZoom, 13)` — the overlay ends at z13; z14+ is the base map's job (all paths present there)
   - `.setMinPixelSize(0)` — required so short segments survive for merging (same as `HikingRouteOverlay.java:129`)

### Phase 3 — `postProcessLayerFeatures`

`FeatureMerge.mergeLineStrings(items, 0.5, 0.1, 4)` for `outdoor_paths` (same params as `HikingRouteOverlay.java:146-151`). Merging is safe with zoom gating because Planetiler calls this per zoom — only features active at that zoom are merged, so z9 merging only touches iwn members.

### Entrypoint & metadata

- `area` argument (Geofabrik), `maxzoom` default **13**, output `paths/outdoor_paths.pmtiles` — mirrors `HikingRouteOverlay.java:182-201`.
- `isOverlay() = true`, attribution `© OpenStreetMap contributors` (matches `TILES_ATTRIBUTION`).

### Build command (test extract)

```bash
java -cp planetiler.jar FootpathOverlay.java \
  --area=italy --download --bounds=10.48,45.27,11.78,46.18
```

## 5. Worldwide build — implications (researched)

| Factor | Value |
|---|---|
| Input | Planet PBF **~88 GB** ([planet.openstreetmap.org](https://planet.openstreetmap.org/), planet-260727) |
| Machine | **≥ 64 GB RAM, ~0.5–1 TB scratch disk** (Planetiler needs disk ≈ 5–10× PBF; RAM ≥ 0.5× PBF). Full OMT-profile reference: 64 CPU/128 GB → 42 min, 32 CPU/64 GB → 1 h 27 m, 16 CPU/32 GB → 2 h 38 m (z0–14, 69–81 GB output) — a paths-only profile is substantially cheaper (no buildings/POIs/landcover passes) |
| Output size | **~1–5 GB pmtiles** with route gating + zoom-tiered simplification + minimal attributes (vs ~5–20 GB for full density). z13 dominates — each zoom roughly doubles tile size (Protomaps); z13 alone is ~67 M tiles worldwide |
| Serving | Same as `/routes/`: pmtiles → `/{z}/{x}/{y}.pbf` server on tiles.ogis.app behind the CDN (mechanism already in place for the other overlays) |
| Precedent | OpenFreeMap itself builds the unmodified OMT schema planet-wide weekly with Planetiler (500 GB SSD, 64 GB RAM, ~5 h); single-purpose planet layers are fast (e.g. Paul Norman's planet-wide trees layer in ~10 min with Tilemaker) |

Refresh cadence is a later decision (planet build is hours on the ogis.app box; weekly would mirror OpenFreeMap).

## 6. Style-side changes — `scripts/build.mjs` (implemented)

All style-side work is done — this section describes the shipped state.

1. **Toggle** `LOW_ZOOM_PATHS = true` (default) at [`scripts/build.mjs:57`](../scripts/build.mjs), placed in render order **between `PROMOTE_LIBERTY_POI` and `OUTDOOR_ROUTE`** (toggles follow the build sections bottom→top, so it sits where its section renders). `PROMOTE_PATHS` keeps its current meaning: prominent path styling for the base layer at z14+.
2. **Config block** after the POI config at [`scripts/build.mjs:471`](../scripts/build.mjs):
   - `PATHS_SOURCE_LAYER = "outdoor_paths"`, `PATHS_TILE_URL = `${TILES_BASE_URL}/paths/{z}/{x}/{y}.pbf``
   - `PATHS_SOURCE_MINZOOM = 9`, `PATHS_SOURCE_MAXZOOM = 13`
   - `PATHS_LAYER_MAXZOOM = 14` (exclusive — hands off to `road_path_pedestrian` at z14)
   - **Shared path style definitions** — referenced by both the overlay and the promoted base layer, so nothing is duplicated:
     - `PATH_LINE_CAP` / `PATH_LINE_JOIN = "round"`
     - `PATH_DASHARRAY = [1, 0.7]` (matches the Liberty base `road_path_pedestrian` dash)
     - `PATH_WIDTH` — the base layer's z14+ width (`["interpolate", ["exponential", 1.2], ["zoom"], 12, 1, 14, 2, 20, 8]`), moved out of the `PROMOTE_PATHS` section where it was previously a hard-coded literal
     - `PATH_WIDTH_LOW_ZOOM` — the overlay's z9–13 width (`9 → 0.6, 11 → 1, 13 → 2`), tuned so **z13 (2 px) ≈ `PATH_WIDTH` at z14 (2 px)** for a seamless handoff
     - `PATH_BASE_MINZOOM = 14` — `road_path_pedestrian` renders from here
3. **Build section "10. Low-zoom paths overlay"** ([`scripts/build.mjs:1226`](../scripts/build.mjs)), between promoted POIs (§9) and outdoor routes (§11):
   - Source `outdoor-paths` (vector, tiles `PATHS_TILE_URL`, minzoom 9, maxzoom 13, attribution `TILES_ATTRIBUTION`)
   - Line layer `outdoor-paths`: source-layer `outdoor_paths`, `minzoom: 9`, `maxzoom: 14` (exclusive — renders z9–13), `line-cap` / `line-join: round`, paint `line-color: COLOURS.PATHS.PATH` (`#c05a2a`), `line-dasharray: PATH_DASHARRAY`, `line-width: PATH_WIDTH_LOW_ZOOM`
   - Spliced at the `poi_r20` anchor so the render stack stays **paths → routes → POIs** (paths below route lines, routes below POIs)
   - The proposed casing/halo and per-network width polish was not needed — the uniform width/colour reads cleanly against the muted palette
4. **§14 (was §13) `PROMOTE_PATHS` refactored** ([`scripts/build.mjs:1430`](../scripts/build.mjs)):
   - `road_path_pedestrian.minzoom` is now explicitly `PATH_BASE_MINZOOM` (**14**) — the revert is in place: the overlay owns z9–13, the base layer owns z14+, same colour/width family, no double-draw (this also removes the previous useless render attempt below z14, where the OMT source has no data)
   - Paint/layout reference the shared `PATH_WIDTH` / `PATH_DASHARRAY` / `PATH_LINE_CAP` / `PATH_LINE_JOIN` — the width literal is no longer hard-coded in this section
   - `highway-name-path` unchanged (still promoted to `minzoom: 0`, `text-colour: COLOURS.PATHS.PATH`)

## 7. Verification

| # | Check | Status | Result |
|---|---|---|---|
| 1 | Profile correctness (tile-source, external) | Open | Test extract (Italy/Alps) → pmtiles; assert tile contents per zoom: z9 = iwn only, z10 = +nwn, z11 = +rwn, z12 = +lwn, z13 = all paths. Measure per-zoom tile bytes (extrapolate to planet) |
| 2 | Serving (tile-source, external) | Open | `curl` a `tiles.ogis.app/paths/{z}/{x}/{y}.pbf` tile at z9/z11/z13; confirm gzipped MVT, layer `outdoor_paths` present |
| 3 | Style build | **Done** | `npm run build` passes — style.json gains source `outdoor-paths` + layer; both project builds pass (`npm run build` — 126 layers / 7 sources; `npm run demo:build`) |
| 4 | Visual | **Done** | Chrome-verified z11–z13 in the Dolomites: dashed brown paths render, route lines above them, zero console errors |
| 5 | Handoff | **Done** | Clean z13 → z14: no double-draw (overlay `maxzoom: 14` exclusive + base `minzoom: 14`), widths matched (z13 = z14 = 2 px) |
| 6 | Docs | **Done** | This doc graduated from proposal to feature doc; README + docs index updated |

Rows 1–2 belong to the tile-source work outside this repo; rows 3–5 are the style-side verification, all passing.

## 8. Open decisions — tile source & serving (outside this repo)

The style side (sections 6–7) is complete. None of the decisions below are resolved by the style work — all five concern the **Planetiler profile and tile serving**, which live outside this repo (tiles.ogis.app, same as the POI/route overlays — see [features.md](features.md)):

1. **Scope:** `path`+`track`+`footway` (recommended) or a subset — flippable in one line of the profile.
2. **Cycling/mtb route relations** in the network gating (default: no, parity with `outdoor_routes`).
3. **Serving mechanism** for `/paths/`: confirm the pmtiles→zxy server used by `/routes/` accepts a second dataset (assumed yes).
4. **Refresh cadence** after the initial planet build.
5. **Build machine**: whether the ogis.app box (or a separate one) runs the planet build; needs ≥ 64 GB RAM + ~0.5–1 TB scratch.

## 9. Key references

- OpenMapTiles schema: <https://openmaptiles.org/schema/> — transportation layer zoom gating
- [PR #1334](https://github.com/openmaptiles/openmaptiles/pull/1334) (merged) — fixed z12/z13 path/track gating; and its predecessors [PR #1190](https://github.com/openmaptiles/openmaptiles/pull/1190) (selective rendering) / [PR #1186](https://github.com/openmaptiles/openmaptiles/pull/1186) (abandoned all-paths attempt, ~20 % tile size)
- [Issue #271](https://github.com/openmaptiles/openmaptiles/issues/271) — "Show track/path sooner" — the overlay workaround
- Mapzen/Tilezen zoom-by-network proposal: <https://github.com/mapzen/vector-datasource/issues/596>
- Planetiler: <https://github.com/onthegomap/planetiler> · [BikeRouteOverlay example](https://github.com/onthegomap/planetiler/blob/main/planetiler-examples/src/main/java/com/onthegomap/planetiler/examples/BikeRouteOverlay.java)
- Existing repo profiles: [HikingRouteOverlay.java](examples/HikingRouteOverlay.java) · [pois-schema.yml](examples/pois-schema.yml) · generation history: [features.md](features.md) · contours: [contours.md](contours.md)
- Data volume: <https://taginfo.openstreetmap.org/> (`highway=path/footway/track`) · Planet PBF: <https://planet.openstreetmap.org/>
- OpenFreeMap (unmodified OMT schema, weekly Planetiler builds): <https://github.com/hyperknot/openfreemap> · styles: <https://github.com/hyperknot/openfreemap-styles> (Liberty `road_path_pedestrian` at `minzoom: 14`)
- Planet-wide single-layer build precedent: <https://www.openstreetmap.org/user/pnorman/diary/408183> · tile-size/zoom scaling: <https://jeremymax.com/blog/offline-maps-pmtiles> · path-only pmtiles overlays: <https://blog.wxm.be/2023/11/25/osm-to-pmtiles-with-tilemaker.html>
- Alternatives considered: Waymarked Trails raster (<https://waymarkedtrails.org>), MapTiler Outdoor `trail` layer (<https://docs.maptiler.com/schema/outdoor/>) — route-centric or closed; raw OSM + Planetiler remains the source of record
