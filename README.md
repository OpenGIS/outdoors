# Outdoors

> A Free and Open-Source map style for the great outdoors.

[View Demo →](https://www.ogis.org/outdoors/)

> [!WARNING]
> This project is currently a **Proof of Concept**. It's a work in progress, so please treat it as such.

---

## Screenshots

[![Helvellyn](screenshots/helvellyn.png)](https://www.ogis.org/outdoors/#12/54.52653/-3.01724)
[![Dolomites 3D](screenshots/dolomites-3d.png)](https://www.ogis.org/outdoors/#13.03/45.81048/11.73434/-27.6/60)
[![Sunshine Coast](screenshots/sunshine-coast.png)](https://www.ogis.org/outdoors/#12/49.97661/-124.45956)
[![Cape Scott](screenshots/cape-scott.png)](https://www.ogis.org/outdoors/#12.93/50.77868/-128.39204)
[![Vancouver Island](screenshots/vancouver-island.png)](https://www.ogis.org/outdoors/#6.82/49.617/-126.76)

---

## Dependencies

### Sources

- [© OpenStreetMap Contributors](https://www.openstreetmap.org/copyright)
- [OpenFreeMap](https://openfreemap.org/) — Base vector tiles ([OpenMapTiles schema](https://github.com/openmaptiles/openmaptiles)) for the entire planet.
- [© Mapterhorn](https://mapterhorn.com/) — Powers 3D terrain, hillshading & contour lines.
- [© Esri World Imagery](https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer) — Satellite ground raster.
- [Open GIS](https://tile.ogis.app/)
  - [Tile Server](docs/7.server.md) - Outdoor-specific POIs, low-level paths & contours.
  - [Style Assets](https://www.ogis.org/basemap/) - Basemap style glyphs & sprites.

### Other

- [OpenMapTiles](https://github.com/openmaptiles/openmaptiles)
  - [Schema](https://openmaptiles.org/schema)
  - [OSM Style](https://github.com/openmaptiles/openmaptiles/tree/master/style)
- [MapLibre Style Spec](https://maplibre.org/maplibre-style-spec/)
- [Planetiler](https://github.com/onthegomap/planetiler)
- [maplibre-contour](https://github.com/onthegomap/maplibre-contour)

## Run

### Build

```bash
npm install                           # Install dependencies
npm run build                         # Build `style.json` from `scripts/build.mjs` (also validates)
```

### Other

```bash
# Validate
npm run validate:style                # Validate `style.json` (MapLibre style spec)

# Sprites
npm run sprite:build                  # Build the outdoors sprite sheet from `icons/` into `dev/public/`

# POIs
npm run pois:schema                   # Regenerate `pois/pois-schema.yml` from `scripts/poi-config.mjs`
npm run check:pois                    # Sprite / kind-coverage / schema-sync checks

# Demo
npm run demo:build                    # Build demo (`demo/`)
npm run demo:preview                  # Preview demo

# Screenshots
npx playwright install chromium
npm run screenshots                   # Regenerate every shot in shots.json
npm run screenshots -- --name <id>    # Regenerate a single shot by id
```

### Development

Compare app with HMR support.

```bash
npm install                           # Install dependencies
npm run dev                           # Start Vite dev server + auto-build watcher
```

---

[Read the Docs →](docs/README.md)
