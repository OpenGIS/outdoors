# Outdoors

> A Free and Open-Source map style for the great outdoors.

[![Outdoor POIs](screenshots/cape-scott.png)](https://www.ogis.org/outdoors/#12/50.77365/-128.39317)

[Demo](https://www.ogis.org/outdoors/)

> [!WARNING]
> This project is currently a **Proof of Concept**. It's a work in progress, so please treat it as such.

Outdoors combines a number of Free and Open-Source data sources and software projects, without which this project would not be possible.

## Key Sources

- [OpenFreeMap](https://openfreemap.org/) — Base vector tiles ([OpenMapTiles schema](https://github.com/openmaptiles/openmaptiles)) for the entire planet.
- [Mapterhorn](https://mapterhorn.com/) — powers 3D terrain, hillshading & contour lines.
- [Open GIS](https://tile.ogis.app/) — Outdoor-specific POIs, low-level paths & contour service for the planet. See [Tile Server](docs/7.server.md).

## Key Dependencies

- [OpenStreetMap](https://www.openstreetmap.org/)
- [MapLibre Style Spec](https://maplibre.org/maplibre-style-spec/)
- [OSM Liberty](https://github.com/maputnik/osm-liberty)
  - [Natural Earth Tiles](https://klokantech.github.io/naturalearthtiles/)
  - [Maki](https://www.mapbox.com/maki-icons/)
  - [Orange Mug](https://github.com/orangemug/font-glyphs)
- [OpenMapTiles](https://github.com/openmaptiles/openmaptiles)
- [Planetiler](https://github.com/onthegomap/planetiler)
- [maplibre-contour](https://github.com/onthegomap/maplibre-contour)
- [contour-mvt-server](https://github.com/acalcutt/contour-mvt-server)

## Build

```bash
npm install                           # Install dependencies
npm run build                         # Build `style.json` from `scripts/build.mjs` (also validates)
```

## Development

The dev server uses the same compare app as the demo, with HMR support.

```bash
npm install                           # Install dependencies
npm run dev                           # Start Vite dev server + auto-build watcher
```

### Other Scripts

```bash
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

---

[Read the Docs →](docs/README.md)
