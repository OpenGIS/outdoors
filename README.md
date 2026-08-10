---
last_commit: "c9d1316f40b858e30e1619f2aa40b4a36fb21a11"
---

# Outdoors

A map style for hiking, cycling, and outdoor activities. Built on the Liberty base style ([OpenFreeMap fork](https://github.com/hyperknot/openfreemap-styles)), it adds terrain hillshading, contour lines, outdoor POIs, hiking route overlays, a low-zoom paths overlay (z9–13), and trail/path visibility enhancements. The output follows the [MapLibre/Mapbox Style Spec](https://maplibre.org/maplibre-style-spec/) (version 8) and can be used with any compatible renderer — [MapLibre GL JS](https://maplibre.org/), [MapLibre Native](https://github.com/maplibre/maplibre-native), [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/), and others.

The style is assembled by [`scripts/build.mjs`](scripts/build.mjs) — it downloads the Liberty base from GitHub (cached locally), then layers outdoor-specific sources and layers on top. The output is [`style.json`](style.json) at the project root. Every build validates the generated style against the MapLibre Style Specification, so an invalid `style.json` fails the build.

## Style dependencies

Dependencies are listed in render order (bottom to top). Each entry includes the data source, any sub-dependencies it inherits, and toggle/configuration notes.

### Base map

- **[OSM Liberty (OpenFreeMap fork)](https://github.com/hyperknot/openfreemap-styles)** — the base map style, a fork of [OSM Liberty](https://github.com/maputnik/osm-liberty) served via [OpenFreeMap](https://github.com/hyperknot/openfreemap)'s free vector tile infrastructure. Provides the full OpenMapTiles schema: land, water, roads, buildings, landuse, admin boundaries, and base POIs.
  - Sub-dependencies inherited from Liberty:
    - **OpenMapTiles vector schema** — the tile layer structure ([reference](https://openmaptiles.org/schema/))
    - **[Maki icons](https://github.com/maputnik/osm-liberty#dependencies)** — POI sprite icons from the [Maki](https://github.com/mapbox/maki) icon set
    - **Natural Earth** — coastline, country, and ocean polygon data ([reference](https://www.naturalearthdata.com/))
    - **Noto fonts** — glyphs for map labels ([Noto Sans](https://fonts.google.com/noto))
    - **OpenFreeMap tile servers** — `{a,b,c}.tiles.openfreemap.org` for vector tiles, glyphs, and sprites
  - Fetched from GitHub at build time, cached in `.cache/liberty.json`. Uses HTTP ETag for cache invalidation — auto-updates when upstream changes.
  - A **resolved copy** (`liberty-processed.json`) with `__TILEJSON_DOMAIN__` placeholders baked in is written to `.cache/` for subsequent builds.

### Base terrain palette

No external source — overrides the Liberty base-layer colours with muted, reference-inspired colours (MapTiler terrain reference) so the outdoor overlays read clearly on top.

- Toggle: `TERRAIN_PALETTE` (default `true`) — applies the muted colour overrides to Liberty's base layers: background, water/waterways, landcover grass/wood/ice/sand, park, landuse residential, and buildings (2D fill and 3D extrusion)
- Opacity knobs (flat constants in the palette config block) soften the opaque base fills: `PALETTE_PARK_OPACITY` (0.53), `PALETTE_GRASS_OPACITY` (0.45), `PALETTE_WOOD_OPACITY` (0.6), `PALETTE_SAND_OPACITY` (0.3), `PALETTE_RESIDENTIAL_OPACITY` (0.7)
- All colours are customisable via the nested `COLOURS` object in [`scripts/build.mjs`](scripts/build.mjs), grouped by feature:
  - `COLOURS.TERRAIN` — base terrain palette (background, water, waterways, grass, wood, park, sand, ice, residential, buildings)
  - `COLOURS.ROADS` — road palette (major/medium/local fills + casing, track casing)
  - `COLOURS.CONTOURS` — contour lines (minor/index) and labels (text + halo)
  - `COLOURS.PEAKS` — mountain peak label text + halo
  - `COLOURS.POI` — outdoor POI label text + halo
  - `COLOURS.ROUTES` — route network tiers (iwn/nwn/rwn/lwn) + rwn casing, lwn halo, default
  - `COLOURS.MTB` — MTB difficulty grades (1/2/3+) and bicycle access
  - `COLOURS.PATHS` — path & trail colour

### Road colour palette

No external source — overrides the Liberty base-layer road colours with a muted warm-taupe palette, replacing Liberty's bright yellow/orange roads with an outdoor-first hierarchy in which local roads and forest tracks are the most visible. Local roads were lightened and desaturated so they read clearly against the brown contour lines, while the contours stay the saturated brown family.

- Toggle: `ROAD_PALETTE` (default `false` — superseded by `ROAD_SURFACE_AWARE`) — applies the muted colour overrides to Liberty's road fills and casings via `applyRoadPalette()`

> [!NOTE]
> `ROAD_PALETTE` is disabled in the default build — everything below (including the `ROAD_TRACK_*` constants) describes this legacy feature and does **not** apply to the shipped style. The active road styling is `ROAD_SURFACE_AWARE` (see [docs/5.style-structure.md §10](docs/5.style-structure.md#10-road_surface_aware)).

- Outdoor-first hierarchy (most visible → most recessive):
  - `COLOURS.ROADS.LOCAL` `rgb(255, 255, 255)` — minor/service/track/street fills (white core that pops against the brown contour lines)
  - `COLOURS.ROADS.MEDIUM` `rgb(223, 211, 188)` — secondary/tertiary/link fills
  - `COLOURS.ROADS.MAJOR` `rgb(228, 219, 201)` — motorway/trunk/primary fills (most recessive)
  - `COLOURS.ROADS.CASING` `rgb(183, 168, 145)` — non-track casing layers
  - `COLOURS.ROADS.TRACK_CASING` `rgb(146, 118, 86)` — track/service road casing (darker warm brown, applied with `ROAD_TRACK_CASING_WIDTH`)
- Tunnel fills render at `ROAD_TUNNEL_OPACITY` (0.55) — faded so their dash patterns stay readable
- Track width/zoom boost: `ROAD_TRACK_WIDTH` (`["interpolate", ["exponential", 1.2], ["zoom"], 12, 1, 13, 1.5, 14, 2, 15, 3, 16, 4, 20, 9.5]`) renders service/track fills from z12 — the earliest zoom where OpenMapTiles tiles include track geometry
- Track casing: `ROAD_TRACK_CASING_WIDTH` (`["interpolate", ["exponential", 1.2], ["zoom"], 12, 2, 13, 3, 14, 4, 15, 5.5, 16, 7, 20, 12.5]`) draws a ~2px dark outline in `COLOURS.ROADS.TRACK_CASING` (`rgb(146, 118, 86)`) around the three service-track casing layers, so low-zoom tracks read clearly against land and contours
- Track name labels: `ROAD_TRACK_LABEL_MINZOOM` (13) promotes `highway-name-minor` (minor/service/track name labels) from Liberty's z15, so forest roads are labelled as soon as they render
- Paths/pedestrian styling is separate — the path promotion (`COLOURS.PATHS.PATH`, #c05a2a) is untouched by this section (see [Path & trail visibility](#path--trail-visibility))

### DEM — hillshade & terrain

- **[Mapterhorn](https://mapterhorn.com/)** — raster DEM tiles in Terrarium encoding (512 px, maxzoom 17) with the required `© Mapterhorn` attribution. A single `demSource` raster-dem source is created when the `DEM` toggle below is enabled and feeds both the hillshade layer and 3D terrain. The same Mapterhorn DEM also feeds the ogis.app contour service server-side.
  - Toggle: `DEM` (default `true`) — the master switch; creates the shared `demSource` raster-dem source (Mapterhorn, Terrarium, 512 px, maxzoom 17). Hillshade and terrain both read from it.
  - Toggle: `DEM_HILLSHADE` (default `true`) — a 2D hillshade layer drawn from the DEM source. Fades in from z3 to z5 (hillshade exaggeration 0 → 0.2) and renders above landcover but below contours and water.
  - Toggle: `DEM_TERRAIN` (default `true`) — 3D terrain elevation (`style.terrain.exaggeration`, 1.5) drawn from the DEM source.
  - Configurable via `DEM_SOURCE_URL` — point it at any Terrarium-encoded DEM tile server by changing the constant. `TERRAIN_EXAGGERATION` (default 1.5) and `HILLSHADE_EXAGGERATION` (fade-in ramp `[[3, 0], [5, 0.2], [12, 0.2]]`) tune the two consumers.

### Contours

Gated by the `CONTOURS` boolean toggle in `scripts/build.mjs` (default `true`). See [docs/contours.md](docs/contours.md) for the full implementation reference.

- **Hosted PBF vector tiles** — server-generated Mapbox Vector Tiles from the **ogis.app hosted contour service** (self-hosted [contour-mvt-server](https://github.com/acalcutt/contour-mvt-server), serves z0–17): `https://tile.ogis.app/terrain/{z}/{x}/{y}.pbf`
  - The contour service renders tiles server-side from the Mapterhorn DEM — the same `tiles.mapterhorn.com` endpoint used by `DEM_SOURCE_URL` — so no client-side contour generation is needed
  - Tile URL is a fixed constant (`CONTOUR_PBF_TILE_URL`), served z9–14 (`CONTOUR_PBF_SOURCE_MINZOOM`/`MAXZOOM`)
  - Two layers — `contour-lines` (minor + index merged into one layer via a `case` on `ele % 100`) and `contour-labels` — share `COLOURS.CONTOURS`; width and opacity ramps are inline in the layer paint
  - Labels are metric at build time; the compare app converts them to imperial via `applyImperialContours()` in [`dev/src/App.vue`](dev/src/App.vue)

### Mountain peak labels

No external source — peak name + elevation labels with a ▲ marker, drawn from Liberty's existing **OpenMapTiles `mountain_peak`** source-layer for the most prominent peaks (`rank == 1`), visible from z7.

- Toggle: `PEAK_LABELS` (default `true`)
- Text-only symbols (no sprite icon) — inserted just below the park-label / POI layers in the render stack

### Low-zoom paths overlay

- **Vector tiles** of path/footway/track geometry from OpenStreetMap, filling the z9–13 gap where the OpenMapTiles base tiles carry no path data. Dashed brown lines (`#c05a2a`, matching the promoted base path style) so the overlay and the z14+ base layer render as one continuous visual family.
  - Source-layer: `outdoor_paths`, tile URL `https://tile.ogis.app/paths/{z}/{x}/{y}.pbf` (via `TILES_BASE_URL`), zoom range z9–13
  - Inserted at the base-map POI anchor (where Liberty's `poi_r20` sat) — below the outdoor route lines so routes stay on top of paths
  - Toggle: `LOW_ZOOM_PATHS` (default `true`)

See [docs/paths.md](docs/paths.md) for the full implementation reference.

### Outdoor routes

- **Vector tiles** of hiking route relations from OpenStreetMap, with line geometry and network classification (iwn/nwn/rwn/lwn). Coloured per network tier using the Waymarked Trails colour scheme, with casing/halo layers for regional and local routes.
  - Source-layer: `outdoor_routes`, tile URL `https://tile.ogis.app/routes/{z}/{x}/{y}.pbf` (via `TILES_BASE_URL`), zoom range z8–14
  - Inserted at the base-map POI anchor (where Liberty's `poi_r20` sat) — above roads/water but below base-map POI icons and labels
  - Toggle: `OUTDOOR_ROUTE` (default `true`)

### Outdoor POIs

- **Vector tiles** of outdoor points of interest: huts, shelters, water sources, parking, viewpoints, mountain passes, campsites, trailheads, ranger stations, picnic sites, parks, castles, and more (18 kinds).
  - Source-layer: `outdoor_pois`, tile URL `https://tile.ogis.app/pois/{z}/{x}/{y}.pbf` (via `TILES_BASE_URL`), zoom range z12–16
  - Icon map generated from the [POI catalogue](pois/catalogue.yml) — kind→Maki-sprite-icon match with `"marker"` fallback; all kinds carry name labels
  - Inserted at the base-map POI anchor (where Liberty's `poi_r20` sat) — above the outdoor route lines, below base-map POIs and labels
  - Toggle: `OUTDOOR_POI` (default `false`)
- The whole POI pipeline is catalogue-driven: `pois/catalogue.yml` → `npm run check:pois` (gap determination) → `npm run pois:schema` (generated planetiler schema) → remote build → hosted tiles → `style.json`. See [docs/pois-concepts.md](docs/pois-concepts.md) for how the POI system works and [docs/pois.md](docs/pois.md) for the implementation reference.

### MTB scale & bicycle access

- **OpenMapTiles `transportation`** source-layer overlays that highlight mountain bike difficulty (`mtb_scale`) and bicycle access on tracks.
  - Toggle: `MTB_SCALE` (default `false`)
  - MTB grades: 1 (blue), 2 (red), 3+ (black)
  - Bicycle access: purple overlay
  - Drawn from the base Liberty style's existing data source — no additional tile server

### Path & trail visibility

No additional data source — this section restyles two existing Liberty layers (`road_path_pedestrian`, `highway-name-path`): the path layer renders in the outdoors orange (`#c05a2a`) from z14 (`PATH_BASE_MINZOOM`), while the [low-zoom paths overlay](#low-zoom-paths-overlay) owns z9–13; path name labels are promoted to minzoom 0.

- Toggle: `PATH_STYLING` (default `true`)
- When MTB scale is enabled, paths with an `mtb_scale` tag are hidden under the MTB overlay to avoid double-drawing

---

## Development

```bash
npm install            # install dependencies
npm run dev            # start Vite dev server + auto-build watcher
```

Opens the compare app at [localhost:11000](http://localhost:11000) — a comparison map with the Outdoors style on the right and a selectable reference style on the left (Liberty, OpenTopoMap, Thunderforest, or MapTiler). Edit `style.json` directly for quick style tweaks — Vite HMR updates instantly. Change feature flags in [`scripts/build.mjs`](scripts/build.mjs) and the watcher automatically rebuilds `style.json` and triggers HMR.

### Scripts

| Command                | Description                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run dev`          | Vite dev server + file watcher. HMR on `style.json` change; auto-rebuild on `build.mjs` changes                |
| `npm run build`        | One-shot build `style.json` from `build.mjs` feature flags                                                     |
| `npm run watch:build`  | Standalone file watcher (for separate terminal)                                                                |
| `npm run pois:schema`  | Generate `pois/pois-schema.yml` from the POI catalogue (`--area=` / `POI_AREA` override)                       |
| `npm run check:pois`   | POI coverage check: catalogue vs OMT schema, style coverage, sprite icons, gap report (exit 0 only when green) |
| `npm run validate:style` | Validate `style.json` against the MapLibre GL style spec (exit 1 listing errors; also runs automatically on every build) |
| `npm run demo:build`   | Build the compare app demo to `demo/` (`vite build`)                                                           |
| `npm run demo:preview` | Preview the production build (`vite preview`)                                                                  |

### Build Verification

**Run both builds** after any code change to catch import/resolve errors early:

```bash
npm run build        # builds style.json from build.mjs feature flags
npm run demo:build   # builds the Vue compare app to demo/ via Vite
```

### Hosted outdoor tiles

All outdoor tile overlays are served from the hosted `tile.ogis.app` service, built from the full planet with open CORS — no local tile servers are required:

- Outdoor POI, route and path tile URLs derive from the single `TILES_BASE_URL` constant in `scripts/build.mjs`, pointing at `https://tile.ogis.app` (`/routes/{z}/{x}/{y}.pbf` for routes, `/pois/{z}/{x}/{y}.pbf` for POIs, `/paths/{z}/{x}/{y}.pbf` for the low-zoom paths overlay)
- Contours are a separate fixed constant (`CONTOUR_PBF_TILE_URL`) pointing at the hosted ogis.app contour service

### Deployment

The compare app demo is deployed to **GitHub Pages** by [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) — on every push to `master` (or manual `workflow_dispatch`), the workflow runs `npm ci` + `npm run demo:build` and publishes the `demo/` directory via `actions/deploy-pages`. CI does not rebuild the style: `style.json` is tracked in git and built locally (see [Scripts](#scripts)).

## Comparison App

Switch the left-hand reference map between multiple providers, configured in [`dev/src/providers.json`](dev/src/providers.json). Providers are declared in two groups in `providers.json` and grouped by category (Misc, Outdoor, Topo, Satellite, Sports, Terrain, Waymarked Trails) into the dropdown:

| Group             | Description                                    | Examples                                                     |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| **Remote Vector** | Fetched via `styleUrl` at runtime              | OpenFreeMap Liberty, Thunderforest Atlas, MapTiler Outdoor   |
| **Remote Raster** | Inline style definitions with raster tile URLs | OpenTopoMap, Thunderforest Outdoors, Waymarked Trails Hiking |
