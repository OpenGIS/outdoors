---
last_commit: "48536cf1e1d7b297033e2a6b53f8469596c96e44"
---

# Outdoors

A free and Open-Source outdoors map style.

_No API keys!_

> [!WARNING]
> This style is a Proof of Concept, not a finished product.

[`scripts/build.mjs`](scripts/build.mjs) assembles the style: it fetches the Liberty base from GitHub (cached locally), layers the outdoor sections on top, and writes the result to [`style.json`](style.json) at the project root. Every build validates the output against the MapLibre spec, so an invalid style fails the build instead of shipping. How the build works — the pipeline, the knobs that control it, and why the style is assembled rather than hand-edited — is explained in [The Style Build](docs/1.build.md).

## Sources

- **[OpenFreeMap](https://openfreemap.org/)** -
- **[Mapterhorn](https://mapterhorn.com/)** - Powers 3D terrain, hillshading & contour lines.
- **[Open GIS](https://tile.ogis.app/)** - Additional outdoor-specific POIs and low-level paths.

## Dependencies

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
