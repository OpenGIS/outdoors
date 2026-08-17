---
last_commit: "48536cf1e1d7b297033e2a6b53f8469596c96e44"
---

# Outdoors

> A Free and Open-Source map style for the great outdoors!

> [!WARNING]
> This project is currently a **Proof of Concept**. It's a work in-progress, so please treat it as such.

## Aims

This style aims to be an

## Activities

This style does not

## Sources

- [OpenFreeMap](https://openfreemap.org/) -
- [Natural Earth Tiles](https://klokantech.github.io/naturalearthtiles/) for relief shading.
- [Mapterhorn](https://mapterhorn.com/) - Powers 3D terrain, hillshading & contour lines.
- [Open GIS](https://tile.ogis.app/) - Additional outdoor-specific [OpenStreetMap](https://www.openstreetmap.org/) POIs and low-level paths extracted from [Geofabrik](https://download.geofabrik.de/).

## Key Dependencies

- [OSM Liberty](https://github.com/maputnik/osm-liberty)
  - [Maki](https://www.mapbox.com/maki-icons/) as icon set
  - [Orange Mug](https://github.com/orangemug/font-glyphs) as font glyphs
- [OpenMapTiles](https://github.com/openmaptiles/openmaptiles)
- [Planetiler](https://github.com/onthegomap/planetiler)
- [contour-mvt-server](https://github.com/acalcutt/contour-mvt-server)

## Development

Run the compare app.

```bash
npm install                           # Install dependencies
npm run dev                           # Start Vite dev server + auto-build watcher
```

### Scripts

```bash
# Development
npm run dev                           # Comprare app with hot reloading

# Build
npm run build                         # Build `style.json` from `scripts/build.mjs` (also validates)
npm run watch:build                   # Standalone file watcher (for a separate terminal)

# Validate
npm run validate:style                # Validate `style.json` (MapLibre style spec)

# Demo
npm run demo:build                    # Build demo (`demo/`)
npm run demo:preview                  # Preview demo

# Screenshots
npx playwright install chromium
npm run screenshots                   # Regenerate every shot in shots.json
npm run screenshots -- --name <id>    # Regenerate a single shot by id
```

## Known Issues / Quirks

- The map is showing too much, making it crowded. My focus has been on sourcing and displaying outdoor data "loud and proud" - it isn't subtle.
- The "handoff" between z13-14 shows inconsistent styling, some geometries vanish/reappear and the stacking order is wrong (e.g. paths shown above bridges but actually goes under).
- DEM features are limited by [Mapterhorn Coverage](https://mapterhorn.com/coverage/), many areas do not show contours at higher zooms. Might be worth comparing with [Mapzen dataset](https://github.com/hyperknot/openfreemap/issues/19#issuecomment-3392131908).
- Not all icons make sense - the [trailhead](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dtrailhead) icon is an escalator! But the mechanism for setting custom Icons is the point.
- Contour lines
  - Need to find nice major/minor index values for both metric and imperial support.
  - Issues with MapLibre GL v5 filter syntax not supporting modulo i.e. "%".
  - Contour labelling is too sparse.
- Bridge/tunnels may not render correctly, better variation support needed.
- Outdoor POIs can obscure more important information, like peak heights.
- The style is metric-only. See [Metric vs Imperial](docs/6.client.md#metric-vs-imperial).
