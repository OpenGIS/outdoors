# Outdoor Feature Vector Tiles

Self-hosted vector tiles for outdoor features (POIs, hiking routes) used by the Outdoors style. Uses [Planetiler](https://github.com/onthegomap/planetiler) to generate vector tiles from OSM data.

Two build modes:
- **YAML schema** — for simple point features (POIs). Defined in `pois/schema.yml`.
- **Java profile** — for complex line features from OSM route relations (hiking routes). Defined in `scripts/HikingRouteOverlay.java`.

## Quick start

```bash
cd features
npm install            # one-time setup
npm run build          # generate outdoor_pois.pmtiles (requires JDK 21+)
npm run dev            # starts dev server on port 11002
```

### Prerequisites

- **JDK 21+** (JDK 22+ for Java profile features) — [Adoptium](https://adoptium.net/) / [SDKMAN](https://sdkman.io/)
- **Node.js** 18+

The build script downloads the Planetiler JAR automatically on first run.

## Build

```bash
# Build POIs (default) — YAML schema
npm run build

# Build a specific feature
npm run build:pois
npm run build:routes

# Custom bounding box (default: Venetian Prealps)
node scripts/build.mjs --feature=routes --bounds=10.48,45.27,11.78,46.18

# Custom area (routes only — Java profile accepts any Geofabrik area)
node scripts/build.mjs --feature=routes --area=veneto --bounds=...
```

The shared `.planetiler/` JAR cache and `data/` OSM extracts are reused across all features — no redundant downloads.

## Dev server

```bash
npm run dev            # starts on port 11002
```

Serves all available feature archives on separate paths:

| Path                           | Archive                | Mode         |
|--------------------------------|------------------------|--------------|
| `/pois/{z}/{x}/{y}.pbf`       | `outdoor_pois.pmtiles` | YAML schema  |
| `/routes/{z}/{x}/{y}.pbf`     | `outdoor_routes.pmtiles` | Java profile |

### Verify

```bash
curl http://localhost:11002/health

curl -sS -o /dev/null -w "%{http_code} %{size_download}B" \
  "http://localhost:11002/pois/12/2174/1461.pbf"
# 200 3641B

curl -sS -o /dev/null -w "%{http_code} %{size_download}B" \
  "http://localhost:11002/routes/10/543/364.pbf"
# 200 55526B
```

## Adding a new feature

For **point features** (campsites, fountains, etc.): create a new directory with a `schema.yml` and register it in `FEATURE_MODES` in `scripts/build.mjs`.

For **complex line features from OSM route relations** (hiking, cycling, mtb routes): create a new Java profile in `scripts/` (patterned on `HikingRouteOverlay.java`) and register it in `FEATURE_MODES` and `JAVA_PROFILES` in `scripts/build.mjs`.

## Schemas

### POIs

`pois/schema.yml` defines an `outdoor_pois` layer (point geometry, ~16 kinds): huts,
water, shelter, parking, viewpoint, mountain pass, picnic site, information,
toilets, ranger station, campsite, playground, ski resort, ferry terminal,
bicycle rental, trailhead.

### Routes

**`scripts/HikingRouteOverlay.java`** — a standalone Java profile that processes OSM relations with `type=route|superroute` and `route=hiking|foot|walking`. The profile does three things:

1. **preprocessOsmRelation** — extracts route relation metadata (name, ref, network, osmc:symbol, operator, distance, ascent, descent, cai_scale)
2. **processFeature** — emits line features for each member way with the relation's attributes attached
3. **postProcessLayerFeatures** — merges touching line segments into continuous routes

Output: `routes/outdoor_routes.pmtiles` with `outdoor_routes` source-layer (z8–14).

Can also be run directly:
```bash
cd features
java -cp .planetiler/planetiler.jar scripts/HikingRouteOverlay.java \
  --area=italy --bounds=10.48,45.27,11.78,46.18
```

## Usage in style

The outdoor build script (`scripts/build.mjs`) serves both feature archives from a single configurable endpoint. `TILES_BASE_URL` points at the hosted production service; the route and POI tile URLs derive from it:

```js
const TILES_BASE_URL = "https://api.ogis.app/features";
const ROUTE_TILE_URL = `${TILES_BASE_URL}/routes/{z}/{x}/{y}.pbf`; // source-layer 'outdoor_routes', z8–14
const POI_TILE_URL = `${TILES_BASE_URL}/pois/{z}/{x}/{y}.pbf`;     // source-layer 'outdoor_pois', z12–18
```

Enable the overlays with the `OUTDOOR_ROUTE` and `OUTDOOR_POI` toggles in `scripts/build.mjs` — both default to `true`, so both sections ship in the default `style.json` build.

## Stop

```bash
kill $(lsof -ti:11002)
```
