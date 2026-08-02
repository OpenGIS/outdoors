# Outdoors

A map style for hiking, cycling, and outdoor activities. Built on the Liberty base style ([OpenFreeMap fork](https://github.com/hyperknot/openfreemap-styles)), it adds terrain hillshading, contour lines, outdoor POIs, hiking route overlays, and trail/path visibility enhancements. The output follows the [MapLibre/Mapbox Style Spec](https://maplibre.org/maplibre-style-spec/) (version 8) and can be used with any compatible renderer — [MapLibre GL JS](https://maplibre.org/), [MapLibre Native](https://github.com/maplibre/maplibre-native), [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/), and others.

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
  - `COLOURS.ROADS` — road palette (major/medium/local fills + casing)
  - `COLOURS.CONTOURS` — contour lines (minor/index) and labels (text + halo)
  - `COLOURS.PEAKS` — mountain peak label text + halo
  - `COLOURS.POI` — outdoor POI label text + halo
  - `COLOURS.ROUTES` — route network tiers (iwn/nwn/rwn/lwn) + rwn casing, lwn halo, default
  - `COLOURS.MTB` — MTB difficulty grades (1/2/3+) and bicycle access
  - `COLOURS.PATHS` — path & trail colour

### Road colour palette

No external source — overrides the Liberty base-layer road colours with a muted warm-taupe palette, replacing Liberty's bright yellow/orange roads with an outdoor-first hierarchy in which local roads and forest tracks are the most visible. Local roads were lightened and desaturated so they read clearly against the brown contour lines, while the contours stay the saturated brown family.

- Toggle: `ROAD_PALETTE` (default `true`) — applies the muted colour overrides to Liberty's road fills and casings via `applyRoadPalette()`
- Outdoor-first hierarchy (darkest/most visible → lightest/most recessive):
  - `COLOURS.ROADS.LOCAL` `rgb(217, 203, 176)` — minor/service/track/street fills
  - `COLOURS.ROADS.MEDIUM` `rgb(223, 211, 188)` — secondary/tertiary/link fills
  - `COLOURS.ROADS.MAJOR` `rgb(228, 219, 201)` — motorway/trunk/primary fills (lightest, most recessive)
  - `COLOURS.ROADS.CASING` `rgb(183, 168, 145)` — all non-path casing layers
- Tunnel fills render at `ROAD_TUNNEL_OPACITY` (0.55) — faded so their dash patterns stay readable
- Track width/zoom boost: `ROAD_TRACK_WIDTH` (`["interpolate", ["exponential", 1.2], ["zoom"], 14, 0.5, 15, 1.5, 16, 3, 20, 9]`) thickens service/track fills so forest tracks appear roughly 1.5 zooms earlier and thicker than Liberty
- Paths/pedestrian styling is separate — the path promotion (`COLOURS.PATHS.PATH`, #c05a2a) is untouched by this section (see [Path & trail visibility](#path--trail-visibility))

### DEM — hillshade & terrain

- **[Mapterhorn](https://tiles.mapterhorn.com/)** — raster DEM tiles in Terrarium encoding (512 px, maxzoom 15). A single `demSource` raster-dem source is created when the `DEM` toggle below is enabled and feeds both the hillshade layer and 3D terrain. In plugin contour mode the same DEM data feeds the maplibre-contour plugin at runtime.
  - Toggle: `DEM` (default `true`) — the master switch; creates the shared `demSource` raster-dem source (Mapterhorn, Terrarium, 512 px, maxzoom 15). Hillshade and terrain both read from it.
  - Toggle: `DEM_HILLSHADE` (default `true`) — a 2D hillshade layer drawn from the DEM source. Fades in from z3 to z5 (hillshade exaggeration 0 → 0.2) and renders above landcover but below contours and water.
  - Toggle: `DEM_TERRAIN` (default `false`) — 3D terrain elevation (`style.terrain.exaggeration`, 1.5) drawn from the DEM source.
  - Configurable via `DEM_SOURCE_URL` — swap to AWS Terrarium or TrailSplits TerrainRGB by changing the constant. `TERRAIN_EXAGGERATION` (default 1.5) and `HILLSHADE_EXAGGERATION` (fade-in ramp `[[3, 0], [5, 0.2], [12, 0.2]]`) tune the two consumers.

### Contours

Three mutually exclusive modes, selected by `CONTOURS_MODE` in `scripts/build.mjs`:

- **PBF mode** (`CONTOURS_MODE = "pbf"`, default) — server-generated PBF vector tiles served as standard Mapbox Vector Tiles from the **ogis.app hosted contour service** (self-hosted [contour-mvt-server](https://github.com/acalcutt/contour-mvt-server), serves up to z14): `https://api.ogis.app/contours/terrain/{z}/{x}/{y}.pbf`
  - Tile URL is a fixed constant (`CONTOUR_PBF_TILE_URL`); to test against a local contour server, edit it manually (see [`CONTOURS_PBF.md`](CONTOURS_PBF.md))

- **Plugin mode** (`CONTOURS_MODE = "plugin"`) — **[maplibre-contour](https://github.com/onthegomap/maplibre-contour)** generates contour vector tiles on the GPU at render time from raw DEM tiles. No server-side contour processing needed.

  - DEM source: Mapterhorn (same DEM source as terrain)
  - Configurable zoom thresholds define contour intervals per zoom level
  - Labels are metric at build time; runtime `setupContours(style, 'imperial')` in [`scripts/contours.js`](scripts/contours.js) patches to imperial
  - Registered at runtime by `registerContourPlugin()` before the map parses the style

- **Disabled** (`CONTOURS_MODE = "disabled"`) — no contour source or layers are added to the style; the runtime skips contour setup entirely.

> [!NOTE]
> Both modes share the same styling (line widths, opacities, colours) defined in `scripts/build.mjs`. Contour labels always use metric at build time — `setupContours(style, 'imperial')` handles the imperial conversion at runtime for both modes.

### Waymarked Trails (raster overlays)

- **[Waymarked Trails](https://waymarkedtrails.org/)** — raster tile overlays for hiking, cycling, and other activities. Used as semi-transparent overlay layers on top of the base map.
  - Toggle: `WAYMARKED_ACTIVITIES` array (default `[]` — disabled)
  - Add items like `'hiking'`, `'cycling'` to enable
  - Free tile service with attribution: © waymarkedtrails.org

### TrailSplits hiking network

- **[TrailSplits hiking network API](https://trailsplits.com/api)** — vector tile overlay of sign-posted hiking/cycling trail networks. Line layers coloured by network tier (iwn/nwn/rwn/lwn), matching the Waymarked Trails colour scheme.
  - Toggle: `TRAILSPLITS_HIKING_TRAILS` (default `false`)
  - Source-layer: `hiking_network`, zoom range z8–12
  - Free, no API key required

### Mountain peak labels

No external source — peak name + elevation labels with a ▲ marker, drawn from Liberty's existing **OpenMapTiles `mountain_peak`** source-layer for the most prominent peaks (`rank == 1`), visible from z7.

- Toggle: `PEAK_LABELS` (default `true`)
- Text-only symbols (no sprite icon) — inserted just below the promoted POI layer in the render stack

### Promoted Liberty POIs

No external source — these are POI classes drawn from Liberty's existing **OpenMapTiles `poi`** source-layer, but promoted to appear at lower zoom (z12–14) instead of waiting for the regular POI layer at z15. Classes include restaurants, cafes, pubs, toilets, drinking water, shelters, picnic sites, parking, bus stops, fuel, pharmacies, and more.

- Toggle: `PROMOTE_LIBERTY_POI` (default `true`)
- Uses Liberty's own Maki sprite for icons — no additional data source

### Outdoor POIs

- **Vector tiles** of outdoor points of interest: huts, shelters, water sources, parking, viewpoints, mountain passes, campsites, trailheads, ranger stations, picnic sites, and more.
  - Source-layer: `outdoor_pois`
  - Source controlled by `POI_SOURCE`:
    - `"local"` — self-hosted **[Planetiler](https://github.com/onthegomap/planetiler) tiles** (see [`features/`](features/README.md)), z12–18
    - `"trailsplits"` (default) — **[TrailSplits outdoor POI API](https://trailsplits.com/api)** (free, no key, z12–14)
  - Icons mapped from the Maki sprite set used by Liberty
  - Toggle: `OUTDOOR_POI` (default `true`)

### Outdoor routes

- **Vector tiles** of hiking route relations from OpenStreetMap, with line geometry and network classification (iwn/nwn/rwn/lwn). Coloured per network tier using the Waymarked Trails colour scheme, with casing/halo layers for regional and local routes.
  - Source-layer: `outdoor_routes` (self-hosted) or `hiking_network` (TrailSplits)
  - Source controlled by `ROUTE_SOURCE`:
    - `"local"` — self-hosted Planetiler tiles (see [`features/`](features/README.md)), z8–14
    - `"trailsplits"` (default) — **[TrailSplits hiking network API](https://trailsplits.com/api)** (free, no key, z8–12)
  - Toggle: `OUTDOOR_ROUTE` (default `true`)

### MTB scale & bicycle access

- **OpenMapTiles `transportation`** source-layer overlays that highlight mountain bike difficulty (`mtb_scale`) and bicycle access on tracks.
  - Toggle: `MTB_SCALE` (default `false`)
  - MTB grades: 1 (blue), 2 (red), 3+ (black)
  - Bicycle access: purple overlay
  - Drawn from the base Liberty style's existing data source — no additional tile server

### Path & trail visibility

No additional data source — this section modifies two existing Liberty layers (`road_path_pedestrian`, `highway-name-path`) to make paths and trails visible at all zoom levels (minzoom 0) with an outdoors-style orange colour.

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

### Self-hosted tile servers

Two sub-projects provide local vector tile serving for development:

- **[`contours/`](contours/README.md)** — self-hosted [contour-mvt-server](https://github.com/acalcutt/contour-mvt-server) for PBF contour mode (port 11001)
- **[`features/`](features/README.md)** — self-hosted [Planetiler](https://github.com/onthegomap/planetiler) tiles for outdoor POIs and hiking routes (port 11002)

Set `POI_SOURCE = "local"` or `ROUTE_SOURCE = "local"` in `scripts/build.mjs` to use them. (PBF contours have no `"local"` source option — point `CONTOUR_PBF_TILE_URL` at a local server manually; see [`CONTOURS_PBF.md`](CONTOURS_PBF.md).)

### Project structure

```
./
├── .cache/              # Liberty style cache (auto-created, gitignored)
│   ├── liberty.json               # Raw fetched style
│   └── liberty-processed.json     # Resolved copy (domain substitutes baked in)
├── contours/            # Self-hosted contour tile server (contour-mvt-server)
├── features/            # Self-hosted feature tile generator (Planetiler) — pois, routes
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
│   ├── watch.mjs        # File watcher (auto-rebuild on build.mjs changes)
│   └── contours.js      # Runtime contour plugin registration & unit conversion
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


