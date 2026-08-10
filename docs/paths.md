---
git_hash: "243f8059116f4428422d421331569d002203c41e"
modified: "2026-08-10"
---

# Low-Zoom Paths Overlay

> The low-zoom paths overlay is implemented in the tile service and the build pipeline: path/footway/track geometry is generated with Planetiler and served from the hosted `tile.ogis.app/paths` service (z9–13), styled as dashed brown lines that match the promoted base path layer at z14+ — the two sources render as one continuous style. The style-side overlay is gated by the `LOW_ZOOM_PATHS` toggle in [`scripts/build.mjs`](../scripts/build.mjs): with the toggle on, the build emits an `outdoor-paths` source and layer; with it off, neither is present.

## 1. Problem

Footpaths (`highway=path` and friends) are styled for high visibility — but **nothing renders below z14** because the OpenFreeMap base tileset (unmodified OpenMapTiles schema) contains **no path geometry at low zoom**. OMT zoom-gates path data (verified against the [schema docs](https://openmaptiles.org/schema/)): nothing below z12, only route members at z12–13, all paths from z14. For an outdoor map, paths are the bearings you need when zoomed out.

The Liberty base layer `road_path_pedestrian` sits at `minzoom: 14` because of this data gating; the style cannot fix it — the fix must add data. Generating an overlay of paths at z9–13 is the documented community workaround: OpenMapTiles [issue #271](https://github.com/openmaptiles/openmaptiles/issues/271) ("Show track/path sooner") explicitly recommends _"generating my own vector tiles with the paths and tracks only and use it as an additional source in my style."_

## 2. Approach

**The base map is augmented with a self-hosted vector overlay** — the same pattern as the POI/route overlays (see [features.md](features.md)):

- Source served from `TILES_BASE_URL` (`https://tile.ogis.app`) at **`/paths/{z}/{x}/{y}.pbf`**, source-layer **`outdoor_paths`**, z9–13. The endpoint is live and planet-wide with open CORS.
- Generated with a **Planetiler Java profile** ([`examples/FootpathOverlay.java`](examples/FootpathOverlay.java)) — network gating below z12 requires relation preprocessing (`preprocessOsmRelation`), which only the Java profile supports. Pattern: [`HikingRouteOverlay.java`](examples/HikingRouteOverlay.java) + Planetiler's [BikeRouteOverlay example](https://github.com/onthegomap/planetiler/blob/main/planetiler-examples/src/main/java/com/onthegomap/planetiler/examples/BikeRouteOverlay.java).
- **Density strategy: route-gated below z12, all paths at z12.** This mirrors the Mapzen/Tilezen proposal ([vector-datasource #596](https://github.com/mapzen/vector-datasource/issues/596)): **iwn → z9, nwn → z10, rwn → z11, lwn → z12**, all paths at z12. It also matches the lesson OpenMapTiles learned: the naive "all paths at z12–13" attempt ([PR #1186](https://github.com/openmaptiles/openmaptiles/pull/1186)) caused a large tile-size increase at z13 and was abandoned in favour of importance gating ([PR #1190](https://github.com/openmaptiles/openmaptiles/pull/1190), refined by the merged [PR #1334](https://github.com/openmaptiles/openmaptiles/pull/1334)).
- **Coverage: planet-wide with open CORS** — built from the **full planet PBF**, like the `/routes/` and `/pois/` overlays, so the overlay and the base agree everywhere. The profile's `--area=italy` setting is a **local-dev shortcut** for fast test builds.

## 3. Data scope

The profile includes **`path` + `track` + `footway`** — the full recommended set, flippable in one line of the profile if the source is ever rebuilt. Volume worldwide is ~78 M ways (taginfo, 2026-08).

## 4. Planetiler profile — `FootpathOverlay.java`

Profile: [`examples/FootpathOverlay.java`](examples/FootpathOverlay.java) — emits the `outdoor_paths` layer (z9–13), modelled on `HikingRouteOverlay.java`. `isOverlay() = true`, attribution `© OpenStreetMap contributors` — declared by the Java profile, while the style-side `TILES_ATTRIBUTION` constant is blank (`""` in [`scripts/build.mjs`](../scripts/build.mjs)) so the attribution control does not duplicate the OSM credit. Built with Planetiler on the classpath: `java -cp <planetiler.jar> build/FootpathOverlay.java --area=<extract> --download`, with an optional `--bounds` for test regions.

### Phase 1 — `preprocessOsmRelation`

Match `type=route|superroute`, `route=hiking|foot|walking` (same filter as the routes overlay; cycling/mtb relations deliberately excluded) and extract each relation's `network` tier: `iwn`, `nwn`, `rwn`, `lwn`.

### Phase 2 — `processFeature`

For line features with `highway ∈ {path, footway, track}`: query the way's route memberships and compute its **minimum zoom** as the lowest zoom among its member relation tiers (iwn → z9, nwn → z10, rwn → z11, lwn → z12, none → z12). Emit an `outdoor_paths` line feature carrying `class` (path/footway/track), `network` tier, and optional `name` / `sac_scale`, with a zoom range up to 13 — z14+ is the base map's job.

### Phase 3 — `postProcessLayerFeatures`

`FeatureMerge.mergeLineStrings(...)` merges touching line segments into continuous paths. Merging is safe with zoom gating because Planetiler calls this per zoom — only features active at that zoom are merged, so the z9 pass only touches iwn members.

## 5. Planet build — production notes

The hosted service is built from the **full planet PBF** on a machine sized for planet builds (Planetiler needs substantial RAM and scratch disk). Output is a pmtiles archive served by the same pmtiles → zxy server behind `tile.ogis.app` that serves `/routes/` and `/pois/`. A paths-only build is substantially cheaper than a full OMT profile (no buildings/POIs/landcover passes), so the hosted service can be refreshed on demand rather than on a fixed schedule. Precedent: OpenFreeMap itself builds the unmodified OMT schema planet-wide weekly with Planetiler.

## 6. Style-side changes — `scripts/build.mjs`

Both the overlay (z9–13) and the promoted base layer (z14+) are styled from the **same shared constants** in [`scripts/build.mjs`](../scripts/build.mjs), so the two sources hand over seamlessly: same colour family, same dash pattern, same round cap/join, and matched widths at the seam. See [The Style Build](build.md) for how sections, toggles and constants work.

- Gated by the `LOW_ZOOM_PATHS` toggle; the prominent base-layer path styling lives in the `PATH_STYLING` section.
- The overlay adds a vector source (`outdoor-paths`) and one line layer, gated to low zoom with a low-zoom width ramp, spliced at the POI anchor so the render stack stays **paths → routes → POIs** (paths below route lines, routes below POIs).
- The base layer `road_path_pedestrian` is promoted to render from z14 with the shared width/dash/join constants — no double-draw, because the overlay's exclusive maxzoom hands off exactly where the base layer begins.

## 7. Verification

The tile side is verified live on `tile.ogis.app`: the profile was checked locally on the Italy extract (Dolomites bounds), and the hosted endpoint returns gzipped MVT at every zoom z9–13. Both project builds pass. With the `LOW_ZOOM_PATHS` toggle on, the build emits the `outdoor-paths` source and layer and the compare app renders the dashed brown overlay; the z13 → z14 handoff code is built for no double-draw, with widths matched at the seam.

## 8. Decisions made

The pipeline (profile → pmtiles → served tiles → style) is fully implemented; the style-side overlay is included in `style.json` when the `LOW_ZOOM_PATHS` toggle is on. The following choices are fixed facts rather than open questions:

1. **Scope:** `path` + `track` + `footway` — the full recommended set (flippable in one line of the profile if the tile source is ever rebuilt).
2. **Route relations:** hiking/foot/walking only; cycling/mtb not included (parity with `outdoor_routes`).
3. **Serving:** the same pmtiles → zxy server behind `tile.ogis.app` that serves `/routes/` and `/pois/` also serves `/paths/`.
4. **Refresh cadence:** planet rebuilds are cheap for this profile, so the cadence is on demand.
5. **Build machine:** the ogis.app box, sized for planet builds.

## 9. Key references

- OpenMapTiles schema: <https://openmaptiles.org/schema/> — transportation layer zoom gating
- [PR #1334](https://github.com/openmaptiles/openmaptiles/pull/1334) (merged) — fixed z12/z13 path/track gating; and its predecessors [PR #1190](https://github.com/openmaptiles/openmaptiles/pull/1190) (selective rendering) / [PR #1186](https://github.com/openmaptiles/openmaptiles/pull/1186) (abandoned all-paths attempt)
- [Issue #271](https://github.com/openmaptiles/openmaptiles/issues/271) — "Show track/path sooner" — the overlay workaround
- Mapzen/Tilezen zoom-by-network proposal: <https://github.com/mapzen/vector-datasource/issues/596>
- Planetiler: <https://github.com/onthegomap/planetiler> · [BikeRouteOverlay example](https://github.com/onthegomap/planetiler/blob/main/planetiler-examples/src/main/java/com/onthegomap/planetiler/examples/BikeRouteOverlay.java)
- Repo profiles: [FootpathOverlay.java](examples/FootpathOverlay.java) · [HikingRouteOverlay.java](examples/HikingRouteOverlay.java) · POI reference: [pois.md](pois.md) · generation: [features.md](features.md) · contours: [contours.md](contours.md)
- Data volume: <https://taginfo.openstreetmap.org/> · Planet PBF: <https://planet.openstreetmap.org/>
- OpenFreeMap (unmodified OMT schema, weekly Planetiler builds): <https://github.com/hyperknot/openfreemap> · styles: <https://github.com/hyperknot/openfreemap-styles>
- Alternatives considered: Waymarked Trails raster (<https://waymarkedtrails.org>), MapTiler Outdoor `trail` layer (<https://docs.maptiler.com/schema/outdoor/>) — route-centric or closed; raw OSM + Planetiler remains the source of record
