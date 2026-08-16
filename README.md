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

Run the compare app.

```bash
npm install            # install dependencies
npm run dev            # start Vite dev server + auto-build watcher
```

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
npx playwright install chromium
npm run screenshots                  # regenerate every shot in shots.json
npm run screenshots -- --name <id>   # regenerate a single shot by id
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
- Not all icons make sense - the [trailhead](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dtrailhead) icon is an escalator! But the mechanism for setting custom Icons is the point.
- Contour lines - need to find nice major/minor index values for both metric and imperial support. Also ran into issues with MapLibre GL v5 filter syntax not supporting modulo i.e. "%".
- Bridge/tunnels may not render correctly, better variation support needed.
- Outdoor POIs can obscure more important information, like peak heights.
