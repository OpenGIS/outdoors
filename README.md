---
last_commit: "48536cf1e1d7b297033e2a6b53f8469596c96e44"
---

# Outdoors

> A Free and Open-Source map style for the great outdoors!

> [!WARNING]
> This project is currently a **Proof of Concept**. It's a work in-progress, so please treat it as such.

[`scripts/build.mjs`](scripts/build.mjs) assembles the style: it fetches the Liberty base from GitHub (cached locally), layers the outdoor sections on top, and writes the result to [`style.json`](style.json) at the project root. Every build validates the output against the MapLibre spec, so an invalid style fails the build instead of shipping. How the build works — the pipeline, the knobs that control it, and why the style is assembled rather than hand-edited — is explained in [The Style Build](docs/1.build.md).

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
npm run build           # Build `style.json` from `scripts/build.mjs`
npm run watch:build     # Standalone file watcher (for a separate terminal)

# Style
npm run pois:schema     # Generate the POI tile schema
npm run check:pois      # Cross-check POI catalogue/style/sprite coverage
npm run validate:style  # Validate `style.json` (MapLibre style spec)

# Demo
npm run demo:build      # Build demo (`demo/`)
npm run demo:preview    # Preview demo
```

## Known Issues / Quirks

- The "handoff" between z13-14 shows inconsistent styling, some geometries vanish/reappear and the stacking order is wrong (e.g. paths shown above bridges but actually goes under).
- My focus has been on sourcing and displaying outdoor data "loud and proud". Right now the map is busy and I have not put much thought into rendering performance :0)

## The Future

- Starting with Liberty as a base was a great way to get started, but has also complicated things
- Variations: metric/imperial units and light/dark colour schemes.
