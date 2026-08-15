---
last_commit: "48536cf1e1d7b297033e2a6b53f8469596c96e44"
---

# Outdoors

> A Free and Open-Source map style for the great outdoors!

> [!WARNING]
> This project is currently a **Proof of Concept**. It's a work in-progress, so please treat it as such.

[`scripts/build.mjs`](scripts/build.mjs) assembles the style: it fetches the Liberty base from GitHub (cached locally), layers the outdoor sections on top, and writes the result to [`style.json`](style.json) at the project root. Every build validates the output against the MapLibre spec, so an invalid style fails the build instead of shipping. How the build works — the pipeline, the toggles and constants that control it, and why the style is assembled rather than hand-edited — is explained in [The Style Build](docs/1.build.md).

`npm run screenshots` renders the current style to PNGs in `screenshots/` with a headless-Chromium runner driven by an editable shot list — see [Screenshots](docs/9.screenshots.md).

## Aims

This style aims to be an

## Activities

This style does not

## Sources

- **[OpenFreeMap](https://openfreemap.org/)** -
- **[Mapterhorn](https://mapterhorn.com/)** - Powers 3D terrain, hillshading & contour lines.
- **[Open GIS](https://tile.ogis.app/)** - Additional outdoor-specific POIs and low-level paths.

## Key Dependencies

- [OSM Liberty](https://github.com/maputnik/osm-liberty)
  - [Maki Icons](https://github.com/mapbox/maki/)
- [OpenMapTiles](https://github.com/openmaptiles/openmaptiles)
- [Planetiler](https://github.com/onthegomap/planetiler)
- [contour-mvt-server](https://github.com/acalcutt/contour-mvt-server)

## Development

```bash
npm install            # install dependencies
npm run dev            # start Vite dev server + auto-build watcher
```

The dev server opens the compare app at [localhost:12345](http://localhost:12345).

### Scripts

```bash
# Development
npm run dev             # Comprare app with hot reloading

# Build
npm run build           # Build `style.json` from `scripts/build.mjs` (also validates)
npm run watch:build     # Standalone file watcher (for a separate terminal)

# Validate
npm run validate:style  # Validate `style.json` (MapLibre style spec)

# Demo
npm run demo:build      # Build demo (`demo/`)
npm run demo:preview    # Preview demo

# Screenshots
npm run screenshots     # Render `style.json` to PNGs in `screenshots/` (see docs/9.screenshots.md)
```

## The Future

- Starting with Liberty as a base was a great way to get started, but has also complicated things.
- Variations: metric/imperial units and light/dark colour schemes.
- More data sources: wikidata.org
- Generated "key".
- Improve known issues / quirks...

## Known Issues / Quirks

- The map is showing too much, making it crowded. My focus has been on sourcing and displaying outdoor data "loud and proud" - it isn't subtle.
- The "handoff" between z13-14 shows inconsistent styling, some geometries vanish/reappear and the stacking order is wrong (e.g. paths shown above bridges but actually goes under).
- DEM features are limited by [Mapterhorn Coverage](https://mapterhorn.com/coverage/), many areas do not show contours at higher zooms. Might be worth comparing with [Mapzen dataset](https://github.com/hyperknot/openfreemap/issues/19#issuecomment-3392131908).
- Not all icons make sense - the [trailhead](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dtrailhead) icon is an elevator! But the mechanism for setting custom Icons is the point.
- Contour lines - need to find nice major/minor index values for both metric and imperial support. Also MapLibre GL v5 filter syntax can't express modulo, so off-cadence lines are painted invisible rather than filtered out.
