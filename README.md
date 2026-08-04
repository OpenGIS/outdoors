---
last_commit: "fa4574de3351119e439e2cbd1f6c918aeee9dc7b"
---

# Outdoors

A map style for hiking, cycling, and outdoor activities. Built on the Liberty base style ([OpenFreeMap fork](https://github.com/hyperknot/openfreemap-styles)), it adds terrain hillshading, contour lines, outdoor POIs, hiking route overlays, a low-zoom paths overlay (z9–13), and trail/path visibility enhancements. The output follows the [MapLibre/Mapbox Style Spec](https://maplibre.org/maplibre-style-spec/) (version 8) and can be used with any compatible renderer — [MapLibre GL JS](https://maplibre.org/), [MapLibre Native](https://github.com/maplibre/maplibre-native), [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/), and others.

The style is assembled by [`scripts/build.mjs`](scripts/build.mjs) — it downloads the Liberty base from GitHub (cached locally), then layers outdoor-specific sources and layers on top. The output is [`style.json`](style.json) at the project root.

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

- Toggle: `ROAD_PALETTE` (default `true`) — applies the muted colour overrides to Liberty's road fills and casings via `applyRoadPalette()`
- Outdoor-first hierarchy (most visible → most recessive):
  - `COLOURS.ROADS.LOCAL` `rgb(255, 255, 255)` — minor/service/track/street fills (white core that pops against the brown contour lines)
  - `COLOURS.ROADS.MEDIUM` `rgb(223, 211, 188)` — secondary/tertiary/link fills
  - `COLOURS.ROADS.MAJOR` `rgb(228, 219, 201)` — motorway/trunk/primary fills (most recessive)
  - `COLOURS.ROADS.CASING` `rgb(183, 168, 145)` — non-track casing layers
  - `COLOURS.ROADS.TRACK_CASING` `rgb(146, 118, 86)` — track/service road casing (darker warm brown, applied with `ROAD_TRACK_CASING_WIDTH`)
- Tunnel fills render at `ROAD_TUNNEL_OPACITY` (0.55) — faded so their dash patterns stay readable
- Track width/zoom boost: `ROAD_TRACK_WIDTH` (`["interpolate", ["exponential", 1.2], ["zoom"], 12, 1, 13, 1.5, 14, 2, 15, 3, 16, 4, 20, 9.5]`) renders service/track fills from z12 — the earliest zoom where OpenMapTiles tiles include track geometry — roughly 2× thicker at low zoom than the previous ramp
- Track casing: `ROAD_TRACK_CASING_WIDTH` (`["interpolate", ["exponential", 1.2], ["zoom"], 12, 2, 13, 3, 14, 4, 15, 5.5, 16, 7, 20, 12.5]`) draws a ~2px dark outline in `COLOURS.ROADS.TRACK_CASING` (`rgb(146, 118, 86)`) around the three service-track casing layers, so low-zoom tracks read clearly against land and contours
- Track name labels: `ROAD_TRACK_LABEL_MINZOOM` (13) promotes `highway-name-minor` (minor/service/track name labels) from Liberty's z15, so forest roads are labelled as soon as they render
- Paths/pedestrian styling is separate — the path promotion (`COLOURS.PATHS.PATH`, #c05a2a) is untouched by this section (see [Path & trail visibility](#path--trail-visibility))

### DEM — hillshade & terrain

- **[Mapterhorn](https://tiles.mapterhorn.com/)** — raster DEM tiles in Terrarium encoding (512 px, maxzoom 17) with the required `© Mapterhorn` attribution. A single `demSource` raster-dem source is created when the `DEM` toggle below is enabled and feeds both the hillshade layer and 3D terrain. The same Mapterhorn DEM also feeds the ogis.app contour service server-side.
  - Toggle: `DEM` (default `true`) — the master switch; creates the shared `demSource` raster-dem source (Mapterhorn, Terrarium, 512 px, maxzoom 17). Hillshade and terrain both read from it.
  - Toggle: `DEM_HILLSHADE` (default `true`) — a 2D hillshade layer drawn from the DEM source. Fades in from z3 to z5 (hillshade exaggeration 0 → 0.2) and renders above landcover but below contours and water.
  - Toggle: `DEM_TERRAIN` (default `false`) — 3D terrain elevation (`style.terrain.exaggeration`, 1.5) drawn from the DEM source.
  - Configurable via `DEM_SOURCE_URL` — point it at any Terrarium-encoded DEM tile server by changing the constant. `TERRAIN_EXAGGERATION` (default 1.5) and `HILLSHADE_EXAGGERATION` (fade-in ramp `[[3, 0], [5, 0.2], [12, 0.2]]`) tune the two consumers.

### Contours

Gated by the `CONTOURS` boolean toggle in `scripts/build.mjs` (default `true`). See [docs/contours.md](docs/contours.md) for the full implementation reference.

- **Hosted PBF vector tiles** — server-generated Mapbox Vector Tiles from the **ogis.app hosted contour service** (self-hosted [contour-mvt-server](https://github.com/acalcutt/contour-mvt-server), serves z0–17): `https://tiles.ogis.app/terrain/{z}/{x}/{y}.pbf`
  - The contour service renders tiles server-side from the Mapterhorn DEM — the same `tiles.mapterhorn.com` endpoint used by `DEM_SOURCE_URL` — so no client-side contour generation is needed
  - Tile URL is a fixed constant (`CONTOUR_PBF_TILE_URL`), served z9–14 (`CONTOUR_PBF_SOURCE_MINZOOM`/`MAXZOOM`)
  - Three layers — `contour-lines` (minor), `contour-lines-index` (index), `contour-labels` — share the styling constants (`CONTOUR_WIDTH_*`, `CONTOUR_OPACITY_*`, `COLOURS.CONTOURS`)
  - Labels are metric at build time; the compare app converts them to imperial via `applyImperialContours()` in [`dev/src/App.vue`](dev/src/App.vue)

> [!NOTE]
> The local `contours/` tile server and the client-side contour generation plugin have been removed — contours are purely server-generated PBF tiles served from `tiles.ogis.app`.

### Waymarked Trails (raster overlays)

- **[Waymarked Trails](https://waymarkedtrails.org/)** — raster tile overlays for hiking, cycling, and other activities. Used as semi-transparent overlay layers on top of the base map.
  - Toggle: `WAYMARKED_ACTIVITIES` array (default `[]` — disabled)
  - Add items like `'hiking'`, `'cycling'` to enable
  - Free tile service with attribution: © waymarkedtrails.org

### Mountain peak labels

No external source — peak name + elevation labels with a ▲ marker, drawn from Liberty's existing **OpenMapTiles `mountain_peak`** source-layer for the most prominent peaks (`rank == 1`), visible from z7.

- Toggle: `PEAK_LABELS` (default `true`)
- Text-only symbols (no sprite icon) — inserted just below the promoted POI layer in the render stack

### Promoted Liberty POIs

No external source — these are POI classes drawn from Liberty's existing **OpenMapTiles `poi`** source-layer, but promoted to appear at lower zoom (z12–14) instead of waiting for the regular POI layer at z15. Classes include restaurants, cafes, pubs, toilets, drinking water, shelters, picnic sites, parking, bus stops, fuel, pharmacies, and more.

- Toggle: `PROMOTE_LIBERTY_POI` (default `true`)
- Uses Liberty's own Maki sprite for icons — no additional data source

### Low-zoom paths overlay

- **Vector tiles** of path/footway/track geometry from OpenStreetMap, filling the z9–13 gap where the OpenMapTiles base tiles carry no path data. Dashed brown lines (`#c05a2a`, matching the promoted base path style) so the overlay and the z14+ base layer render as one continuous visual family.
  - Source-layer: `outdoor_paths`, tile URL `https://tiles.ogis.app/paths/{z}/{x}/{y}.pbf` (via `TILES_BASE_URL`), zoom range z9–13
  - Inserted at the `poi_r20` anchor — above the promoted POIs, below the outdoor route lines (routes stay on top of paths)
  - Toggle: `LOW_ZOOM_PATHS` (default `true`)

### Outdoor routes

- **Vector tiles** of hiking route relations from OpenStreetMap, with line geometry and network classification (iwn/nwn/rwn/lwn). Coloured per network tier using the Waymarked Trails colour scheme, with casing/halo layers for regional and local routes.
  - Source-layer: `outdoor_routes`, tile URL `https://tiles.ogis.app/routes/{z}/{x}/{y}.pbf` (via `TILES_BASE_URL`), zoom range z8–14
  - Inserted at the `poi_r20` anchor — above roads/water but below base-map POI icons and labels
  - Toggle: `OUTDOOR_ROUTE` (default `true`)

### Outdoor POIs

- **Vector tiles** of outdoor points of interest: huts, shelters, water sources, parking, viewpoints, mountain passes, campsites, trailheads, ranger stations, picnic sites, and more.
  - Source-layer: `outdoor_pois`, tile URL `https://tiles.ogis.app/pois/{z}/{x}/{y}.pbf` (via `TILES_BASE_URL`), zoom range z12–16
  - Icons mapped from the Maki sprite set used by Liberty — kind→icon map in `POI_ICON_BY_KIND` (`POI_ICON_DEFAULT` = `"marker"`); icon/text size, opacity and halo widths tuned via the `POI_ICON_*` / `POI_TEXT_*` consts
  - Inserted at the `poi_r20` anchor — above the outdoor route lines, below base-map POIs and labels
  - Toggle: `OUTDOOR_POI` (default `true`)

### MTB scale & bicycle access

- **OpenMapTiles `transportation`** source-layer overlays that highlight mountain bike difficulty (`mtb_scale`) and bicycle access on tracks.
  - Toggle: `MTB_SCALE` (default `false`)
  - MTB grades: 1 (blue), 2 (red), 3+ (black)
  - Bicycle access: purple overlay
  - Drawn from the base Liberty style's existing data source — no additional tile server

### Path & trail visibility

No additional data source — this section restyles two existing Liberty layers (`road_path_pedestrian`, `highway-name-path`): the path layer renders in the outdoors orange (`#c05a2a`) from z14 (`PATH_BASE_MINZOOM`), while the [low-zoom paths overlay](#low-zoom-paths-overlay) owns z9–13; path name labels are promoted to minzoom 0.

- Toggle: `PROMOTE_PATHS` (default `true`)
- When MTB scale is enabled, paths with an `mtb_scale` tag are hidden under the MTB overlay to avoid double-drawing

---

## Development setup

### Prerequisites

- [Node.js](https://nodejs.org/) 20+ (ESM project)

### Quick start

```bash
npm install            # install dependencies
npm run dev            # start Vite dev server + auto-build watcher
```

Opens the compare app at [localhost:11000](http://localhost:11000) — a comparison map with the Outdoors style on the right and a selectable reference style on the left (Liberty, OpenTopoMap, Thunderforest, or MapTiler). Edit `style.json` directly for quick style tweaks — Vite HMR updates instantly. Change feature flags in [`scripts/build.mjs`](scripts/build.mjs) and the watcher automatically rebuilds `style.json` and triggers HMR.

### Scripts

| Command                | Description                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm run dev`          | Vite dev server + file watcher. HMR on `style.json` change; auto-rebuild on `build.mjs` changes         |
| `npm run build`        | One-shot build `style.json` from `build.mjs` feature flags                                              |
| `npm run watch:build`  | Standalone file watcher (for separate terminal)                                                         |
| `npm run demo:build`   | Build the compare app demo to `demo/` (`vite build`) |
| `npm run demo:preview` | Preview the production build (`vite preview`)                                                           |

### Build Verification

**Run both builds** after any code change to catch import/resolve errors early:

```bash
npm run build        # builds style.json from build.mjs feature flags
npm run demo:build   # builds the Vue compare app to demo/ via Vite
```

### Hosted outdoor tiles

All outdoor tile overlays are served from the hosted `tiles.ogis.app` service — no local tile servers are required:

- Outdoor POI, route and path tile URLs derive from the single `TILES_BASE_URL` constant in `scripts/build.mjs`, pointing at `https://tiles.ogis.app` (`/routes/{z}/{x}/{y}.pbf` for routes, `/pois/{z}/{x}/{y}.pbf` for POIs, `/paths/{z}/{x}/{y}.pbf` for the low-zoom paths overlay)
- Contours are a separate fixed constant (`CONTOUR_PBF_TILE_URL`) pointing at the hosted ogis.app contour service

> [!NOTE]
> The local `features/` tile generator has been removed — POI and route tiles are now generated and hosted outside this project at `tiles.ogis.app`. See [docs/features.md](docs/features.md) for how they were produced (YAML schema for POIs, Java profile for routes).

### Project structure

```
./
├── .cache/              # Liberty style cache (auto-created, gitignored)
│   ├── liberty.json               # Raw fetched style
│   └── liberty-processed.json     # Resolved copy (domain substitutes baked in)
├── index.html           # Compare app entry
├── dev/
│   ├── index.html       # HTML entry
│   ├── index.js         # Vue app bootstrap

│   └── src/
│       ├── App.vue              # Compare app UI
│       ├── providers.json       # Provider configuration (styles, styleUrls, apiKey flags)
│       ├── components/
│       │   └── ProviderSelect.vue   # Grouped provider dropdown component
│       └── styles/
│           ├── reset.css        # CSS reset
│           └── style.css        # App styles
├── style.json           # Generated output (tracked in git)
├── scripts/
│   ├── build.mjs        # Style build script — entry point for all feature flags
│   └── watch.mjs        # File watcher (auto-rebuild on build.mjs changes)
├── demo/                # Production build output (tracked in git)
├── package.json
└── vite.config.js
```

## Comparison map provider system

The compare app (`dev/src/App.vue`) lets you switch the left-hand reference map between multiple providers, configured in [`dev/src/providers.json`](dev/src/providers.json). Providers are grouped into three categories:

| Category          | Description                                                                      | Examples                              |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| **Remote Vector** | Fetched via `styleUrl` at runtime                                                | Thunderforest Atlas, MapTiler Outdoor |
| **Remote Raster** | Inline style definitions with raster tile URLs                                   | OpenTopoMap, Thunderforest Outdoors   |

### API key management

Providers that require an API key have `"apiKey": true` in their config. Their URLs contain a `{apiKey}` token replaced at runtime:

- `ensureApiKey()` in `App.vue` checks `localStorage` (key `outdoors_dev_apiKeys`) for a stored key
- If no key is found when the user **selects** a key-protected provider, a `window.prompt()` asks for one
- The key is then stored in `localStorage` and injected into the provider config via `replaceApiKeyTokens()`
- **No prompt appears on page load** — the default selection is explicitly OpenFreeMap Liberty (constant `DEFAULT_PROVIDER_KEY` in `dev/src/composables/useProviderSelection.js`), falling back to the first provider without `apiKey` if Liberty is unavailable. Stale or invalid saved selections are corrected to the default on load.

## Further Reading

- [Contours](docs/contours.md) - hosted PBF contour implementation reference
- [Full docs index](docs/README.md)


