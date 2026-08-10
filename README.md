---
last_commit: "54e9b5ff4be7f762624cc5e7eaa2903b1aaa276b"
---

# Outdoors

A map style for hiking, cycling, and outdoor activities, built on the [Liberty base style](https://github.com/hyperknot/openfreemap-styles) (OpenFreeMap fork). Where Liberty is a general-purpose street map, this style is tuned for being outside: the shape of the land comes through in terrain and contours, roads and paths read clearly at the scales you actually use, and the points of interest are the ones that matter on a walk or a ride.

On top of the Liberty base the style adds terrain hillshading and 3D terrain, contour lines, outdoor POIs (huts, shelters, water sources, viewpoints, passes, and more), hiking route overlays, a low-zoom paths layer, and trail/path visibility enhancements. The output follows the [MapLibre Style Specification](https://maplibre.org/maplibre-style-spec/) and works with any compatible renderer — [MapLibre GL JS](https://maplibre.org/), [MapLibre Native](https://github.com/maplibre/maplibre-native), [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/), and others.

[`scripts/build.mjs`](scripts/build.mjs) assembles the style: it fetches the Liberty base from GitHub (cached locally), layers the outdoor sections on top, and writes the result to [`style.json`](style.json) at the project root. Every build validates the output against the MapLibre spec, so an invalid style fails the build instead of shipping. How the build works — the pipeline, the knobs that control it, and why the style is assembled rather than hand-edited — is explained in [The Style Build](docs/build.md).

## Style dependencies

The style is best understood as a stack of layers rendered bottom to top. Each group below does one job for an outdoor audience; the values it uses — colours, zoom ranges, widths — live in the build script, not in this README.

- **Land base** — Liberty's background, landcover, landuse, and park fills, retuned with a muted terrain palette so the outdoor layers read clearly on top.
- **Terrain** — hillshade and 3D terrain from a hosted DEM source, giving the map physical relief.
- **Water** — Liberty's water fills and labels kept intact, with water styling that differentiates swimming pools.
- **Roads** — Liberty's road network replaced with an outdoor-first hierarchy: roads grouped by class and distinguished by paved vs unpaved surface, so forest tracks and local roads stay readable.
- **Outdoor overlays** — the outdoor-specific layers — contours, mountain peak labels, hiking routes, outdoor POIs, and the low-zoom paths overlay — inserted above the base.
- **Labels** — Liberty's place, road, and water labels kept, extended with peak names and park labels.

Sections are applied in this same order at build time, and each is gated by its own feature toggle, so any group can be switched on or off independently for comparison.

> [!NOTE]
> The full layer stack, section by section, lives in [Style Structure](docs/style.md); the knobs that control it — toggles, colours, per-feature config, tile endpoints — are documented in [The Style Build](docs/build.md).

## Repository layout

- [`scripts/`](scripts/) — the build pipeline: the style assembler, the file watcher, style validation, and the POI schema/coverage tooling.
- [`dev/`](dev/) — the Vue compare app (Vite), with the reference providers in [`dev/src/providers.json`](dev/src/providers.json).
- [`pois/`](pois/) — the POI catalogue (single source of truth for POI rendering) and the generated tile schema.
- [`docs/`](docs/) — developer documentation, indexed from [docs/README.md](docs/README.md).
- [`.github/workflows/`](.github/workflows/) — the GitHub Pages deployment workflow.

## Development

```bash
npm install            # install dependencies
npm run dev            # start Vite dev server + auto-build watcher
```

The dev server opens the compare app at [localhost:11000](http://localhost:11000) — the Outdoors style on the right, a selectable reference style on the left. The compare loop is the primary workflow, and it supports two edit paths:

- **Knob edits** — change a feature toggle, colour, or config value in [`scripts/build.mjs`](scripts/build.mjs); the watcher rebuilds `style.json` and the app hot-reloads the result.
- **Direct style edits** — edit `style.json` itself; Vite HMR applies the change instantly, no rebuild needed.

See the [dev loop](docs/build.md#the-dev-loop) in the build doc for how the watcher and the compare app fit together.

### Scripts

| Command                  | Description                                                            |
| ------------------------ | ---------------------------------------------------------------------- |
| `npm run dev`            | Vite dev server + file watcher — the compare loop                      |
| `npm run build`          | One-shot build of `style.json` from `scripts/build.mjs`                |
| `npm run watch:build`    | Standalone file watcher (for a separate terminal)                      |
| `npm run pois:schema`    | Generate the POI tile schema from the POI catalogue                    |
| `npm run check:pois`     | Cross-check POI coverage across catalogue, style, and sprite           |
| `npm run validate:style` | Validate `style.json` against the MapLibre style spec                  |
| `npm run demo:build`     | Build the compare app demo to `demo/`                                  |
| `npm run demo:preview`   | Preview the production demo build locally                              |

The POI commands form a pipeline: `pois:schema` regenerates the tile schema from the catalogue, and `check:pois` verifies coverage before the hosted tiles are rebuilt. See [Outdoor POIs](docs/pois.md).

### Build verification

**Run both builds** after any code change to catch import/resolve errors early:

```bash
npm run build        # builds style.json from build.mjs feature flags
npm run demo:build   # builds the Vue compare app to demo/ via Vite
```

> [!NOTE]
> This is a project requirement (see AGENTS.md) — both builds must pass before a change is considered complete.

### Hosted outdoor tiles

The outdoor overlays are generated from OpenStreetMap data outside this repository and served from the hosted `tile.ogis.app` service with open CORS — no local tile servers required:

- **POIs** — outdoor points of interest with icons and name labels.
- **Routes** — hiking route lines classified by network tier, drawn as one visual family.
- **Paths** — low-zoom path geometry styled to match the base path layer, so the two render continuously.

All three tile URLs derive from a single `TILES_BASE_URL` constant in [`scripts/build.mjs`](scripts/build.mjs); the contour overlay is a separate fixed constant pointing at the same hosted service. See [Outdoor feature tiles](docs/features.md) for how the POI and route tiles are produced, and the [Low-zoom paths overlay](docs/paths.md) for the paths tile source.

### Deployment

The compare app demo is deployed to **GitHub Pages** by [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on every push to `master` (or a manual trigger): the workflow runs the demo build and publishes the `demo/` directory. CI does **not** rebuild the style — `style.json` is built locally and committed, so what gets deployed is exactly what was tested.

## Comparison App

The compare loop needs reference styles to measure against, and those are declared in [`dev/src/providers.json`](dev/src/providers.json) in two groups:

- **Remote vector** — styles fetched by URL at runtime (e.g. OpenFreeMap Liberty, MapTiler Outdoor).
- **Remote raster** — inline style definitions with raster tile URLs (e.g. OpenTopoMap, Waymarked Trails Hiking).

Each provider also carries a category (Misc, Outdoor, Topo, Satellite, Sports, Terrain, Waymarked Trails) that groups the dropdown, so comparable styles sit next to each other.

To evaluate a change, pick the closest reference style, flip the relevant knob in `build.mjs`, and watch the two maps update side by side.

## Related docs

- [Full docs index](docs/README.md) — reading order for all project docs
- [The Style Build](docs/build.md) — how the style is assembled and the knobs that control it
- [Style Structure](docs/style.md) — the layer stack, section by section
- [Outdoor feature tiles](docs/features.md) — how the hosted POI and route tiles are produced
- [Low-zoom paths overlay](docs/paths.md) — the hosted paths tile source
