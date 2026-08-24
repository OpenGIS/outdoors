#!/usr/bin/env node

/**
 * Build the outdoor style from the OpenGIS basemap style (v2.0 refactor).
 *
 * Downloads the OpenGIS basemap style — the vendored OpenMapTiles OSM style
 * v3.16 pointed at OpenFreeMap planet tiles — with local caching, and writes
 * the built style to style.json at the project root. Slice 1 set the
 * top-level `name` field; slice 2 recolours the muted base with the
 * project's outdoor palette (terrain, water and park colour overrides only
 * — no layers added or removed); slice 3 adds the Mapterhorn raster-dem
 * source, the hillshade layer and the 3D terrain config; slice 4 adds the
 * hosted contour vector source, the contour line layer and the contour
 * elevation labels; slice 5 adds the outdoor path family and the low-zoom
 * paths overlay; slice 6 replaces the Liberty POI tiers with the single
 * config-driven outdoor-POI overlay. The basemap's own
 * sources, glyphs, sprite and attribution pass through untouched, since the
 * published basemap is already fully rewritten (glyphs & sprite point at
 * www.ogis.org/basemap, tiles at tiles.openfreemap.org/planet, attribution
 * baked into the style).
 *
 * Later slices add the remaining outdoor mutations (paths, routes, POIs, …)
 * inside applyModifications().
 *
 * Cache: the downloaded basemap style is cached in .cache/basemap.json, with
 * the response ETag in .cache/basemap-etag.txt. Cache invalidation uses the
 * HTTP ETag — see fetchBasemap() below.
 *
 * Usage:
 *   node scripts/build.mjs           # one-shot build
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStyle } from "./validate-style.mjs";
import { OUTDOOR_POI, PLANET_POI } from "./poi-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUTDOOR_STYLE = resolve(ROOT, "style.json");

// ═════════════════════════════════════════════════════════════════════════
// CONFIG — base style source & cache paths
// ═════════════════════════════════════════════════════════════════════════
// The OpenGIS basemap style is the single source of truth for this build.
// The URL tracks the upstream `main` branch. Cache invalidation uses the
// HTTP ETag from the response — a new version is auto-detected on the next
// build.

const BASE_STYLE_URL = "https://www.ogis.org/basemap/style.json";

const CACHE_DIR = resolve(__dirname, "..", ".cache");
const CACHE_FILE = resolve(CACHE_DIR, "basemap.json");
const CACHE_META_FILE = resolve(CACHE_DIR, "basemap-etag.txt");

// Root style identity — written into the generated style.json as the
// top-level `name` property (see the style spec's Root section). The
// published basemap carries its own name ("Basemap"); it is overridden here.
const STYLE_NAME = "Outdoors";

// ═════════════════════════════════════════════════════════════════════════
// Modification — outdoor-specific mutations, gated by feature toggles
// ═════════════════════════════════════════════════════════════════════════
// Each modification reads the basemap's human-readable layer ids and overrides
// their paint colours in place. The published basemap is already muted, so
// slice 2 recolours only — no layers added or removed, no layout changes.
// Slice 3 adds the DEM source, the hillshade layer and the terrain config
// instead. Layers are matched by exact id; a missing layer is skipped, so
// the build stays robust if upstream renames or removes it.

const FEATURES = {
  // Muted landcover & landuse fills (terrain palette).
  TERRAIN_PALETTE: true,
  // Muted water fills & lines (water palette).
  WATER_PALETTE: true,
  // Distinct treatment for park fills, national park boundaries & park labels.
  PARK_DIFFERENTIATION: true,
  // Hillshade shading from the Mapterhorn raster-dem source.
  DEM_HILLSHADE: true,
  // 3D terrain exaggeration from the Mapterhorn raster-dem source.
  DEM_TERRAIN: true,
  // Hosted PBF contour vector tiles + elevation labels.
  CONTOURS: true,
  // Paved/unpaved road hierarchy — surface-aware restyle of the basemap roads.
  ROAD_SURFACE_AWARE: true,
  // Outdoor path family on the basemap path layers (footpath prominence).
  PATH_STYLING: true,
  // Hosted low-zoom paths overlay filling the z9–13 gap where OMT has no paths.
  LOW_ZOOM_PATHS: true,
  // Hosted outdoor POI overlay — config-driven symbol layer (see poi-config.mjs).
  OUTDOOR_POI: true,
};

// Every colour literal used by the modifications, nested by feature. Values are
// ported from the pre-refactor build (the project's established outdoor
// look), adapted where the new basemap's layer structure differs.
const COLOURS = {
  // Terrain fills (TERRAIN_PALETTE)
  TERRAIN: {
    BACKGROUND: "hsl(47, 26%, 88%)", // warm pale base
    GRASS: "hsl(82, 46%, 72%)", // muted yellow-green — grass, meadow, wetland, garden
    WOOD: "hsl(82, 46%, 72%)", // muted yellow-green — wood, forest, mangrove
    ICE: "hsl(47, 22%, 94%)", // warm pale — glacier
    RESIDENTIAL: "hsl(47, 13%, 86%)", // warm pale — residential
    SAND: "hsl(45, 55%, 82%)", // muted sand (old value was a bright yellow tuned for 30% opacity)
  },

  // Landcover accents (TERRAIN_PALETTE)
  LANDCOVER: {
    ROCK: "hsl(40, 15%, 78%)", // pale taupe — rock, scree, bare rock
    FARMLAND: "hsl(75, 35%, 88%)", // pale yellow-green — farmland, farm, orchard
    HEATH: "hsl(60, 30%, 78%)", // muted yellow — heath, scrub
  },

  // Landuse accents (TERRAIN_PALETTE)
  LANDUSE: {
    MILITARY: "hsl(0, 55%, 90%)", // muted red tint (old value was an rgba wash)
    QUARRY: "hsl(25, 15%, 82%)", // muted brown tint (old value was an rgba wash)
  },

  // Water (WATER_PALETTE)
  WATER: {
    WATER: "hsl(205, 56%, 73%)", // muted blue — fills & lines
    GLACIER_OUTLINE: "hsl(205, 45%, 78%)", // soft ice blue — glacier outline
  },

  // Parks (PARK_DIFFERENTIATION)
  PARK: {
    NATIONAL_PARK: "rgb(170, 210, 140)", // darker green — national park boundaries
    DEFAULT: "rgb(210, 225, 175)", // lighter green — park fill
    LABEL_TEXT: "#3d5c28", // dark green — park labels
  },

  // Roads (ROAD_SURFACE_AWARE) — muted warm-taupe paved road palette, with
  // the slightly darker unpaved variants (drawn dashed & thinner).
  ROADS: {
    MAJOR: "rgb(228, 219, 201)", // lightest, most recessive — motorway/trunk/primary (+ motorway links)
    MEDIUM: "rgb(223, 211, 188)", // secondary/tertiary/links
    LOCAL: "rgb(255, 255, 255)", // minor/service/track/raceway
    TRACK_CASING: "rgb(146, 118, 86)", // darker warm brown — low-zoom track outline
    UNPAVED_MAJOR: "rgb(210, 200, 180)", // unpaved motorway/trunk/primary
    UNPAVED_MEDIUM: "rgb(210, 197, 175)", // unpaved secondary/tertiary
    UNPAVED_LOCAL: "rgb(237, 230, 218)", // unpaved minor/service/track
  },

  // Paths (PATH_STYLING & LOW_ZOOM_PATHS) — the outdoor trail colour shared
  // by the low-zoom overlay and the basemap path layers.
  PATHS: { PATH: "#c05a2a" },

  // Contours (CONTOURS)
  CONTOURS: {
    MINOR: "rgb(198, 170, 138)", // soft sand-brown — minor contour lines
    INDEX: "rgb(164, 130, 94)", // medium topo brown — index contour lines
    LABEL: "#5c4634", // dark umber — elevation labels
    HALO: "rgba(255, 255, 255, 0.5)", // semi-transparent white — label halo
  },
};

// DEM — Mapterhorn raster-dem source, hillshade layer & 3D terrain.
// Values ported from the pre-refactor build. The raster-dem source feeds
// both the hillshade layer and the terrain. Mapterhorn serves
// Terrarium-encoded WebP tiles at 512px, maxzoom 17 (service max; z0-12
// global, z13-17 regional only). The source is added when either DEM
// toggle is enabled.
const DEM_SOURCE_ID = "demSource";
const DEM_SOURCE_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const DEM_SOURCE_ENCODING = "terrarium";
const DEM_SOURCE_TILESIZE = 512;
const DEM_SOURCE_ATTRIBUTION =
  '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>';
const DEM_SOURCE_MAXZOOM = 17;

// style.terrain.exaggeration — ratio by which the terrain is exaggerated
// relative to the real world.
const TERRAIN_EXAGGERATION = 1.5;

// hillshade-exaggeration — intensity of the hillshade (fades in z3 → z5,
// held constant from z12).
const HILLSHADE_EXAGGERATION = [
  "interpolate",
  ["linear"],
  ["zoom"],
  3,
  0,
  5,
  0.2,
  12,
  0.2,
];

// CONTOURS — hosted PBF contour vector source, line layer & elevation labels.
// Values ported from the pre-refactor build. The ogis.app hosted contour
// service (contour-mvt-server) serves standard Mapbox Vector Tiles rendered
// server-side from the Mapterhorn DEM — the same tiles.mapterhorn.com
// endpoint used by DEM_SOURCE_URL, so the client and the tile server fetch
// the same Mapterhorn tile; the CDN sees it twice and serves the second
// request from cache.
const CONTOUR_SOURCE_ID = "contour-source";
const CONTOUR_TILE_URL = "https://tile.ogis.app/terrain/{z}/{x}/{y}.pbf";
const CONTOUR_SOURCE_LAYER = "contours";
const CONTOUR_SOURCE_MINZOOM = 9;
const CONTOUR_SOURCE_MAXZOOM = 14;
const CONTOUR_LAYER_MAXZOOM = 20;

// Label expression — always metric at build time. The compare app
// (dev/src/App.vue) converts "m" → "ft" for imperial units.
const CONTOUR_LABEL_EXPR = [
  "concat",
  ["number-format", ["round", ["get", "ele"]], {}],
  "m",
];

// Contour line rendering — width (px) and opacity at the zoom-ramp stops
// (low = z9, mid = CONTOUR_MID_ZOOM, high = z14). Index = every 100 m
// (ele % 100 === 0) drawn bold; minor = intermediate contours, decimated to
// the CONTOUR_MINOR_EVERY cadence and drawn thin. Opacity uses the original
// 0.4→0.7 (index) / 0.35→0.5 (minor) ramps — emphasis comes from width and
// line count, not transparency.
const CONTOUR_MID_ZOOM = 13;
const CONTOUR_WIDTH_INDEX = { low: 0.75, mid: 1.1, high: 1.6 };
const CONTOUR_WIDTH_MINOR = { low: 0.4, mid: 0.45, high: 0.7 };
const CONTOUR_OPACITY_INDEX = { low: 0.4, mid: 0.64, high: 0.7 };
const CONTOUR_OPACITY_MINOR = { low: 0.35, mid: 0.47, high: 0.5 };
// Minor cadence — must divide the 100 m index interval evenly so minor
// lines sit symmetric between index lines (100 / 20 = 5). The condition uses
// offset 0 (ele % 20 === 0) so lines land on the server's 20 m grid at
// z10-12: all minors there, every 2nd at z13 (10 m), every 4th at z14 (5 m).
const CONTOUR_MINOR_EVERY = 20;

// Tier conditions used by the paint `case` expressions — index contours
// every 100 m of elevation (ele % 100 === 0) drawn bold; minor contours on
// the CONTOUR_MINOR_EVERY cadence drawn thin. contourCase() is a three-branch
// case per zoom stop — index style, minor style, or hidden (opacity 0 /
// width 0). The hidden branch is what decimates: features off the cadence
// are painted invisible rather than filtered, because v5 filter syntax
// cannot express modulo.
const contourIndexCond = ["==", ["%", ["get", "ele"], 100], 0];
const contourMinorCond = ["==", ["%", ["get", "ele"], CONTOUR_MINOR_EVERY], 0];
const contourCase = (idxValue, minorValue) => [
  "case",
  contourIndexCond,
  idxValue,
  contourMinorCond,
  minorValue,
  0,
];

// ROADS — surface-aware paved/unpaved road hierarchy (applied by
// applyRoadSurfaceAware). ROAD_TUNNEL_OPACITY fades the basemap's road
// tunnel fills so their dashes read clearly. Width stops are [zoom, px] —
// see surfaceWidthExpr() below.
const ROAD_TUNNEL_OPACITY = 0.55; // line-opacity for tunnel fills (faded, dashes preserved)
const ROAD_UNPAVED_STOPS = [
  [12, 0.8],
  [14, 1.5],
  [20, 4],
];
const ROAD_UNPAVED_DASHARRAY = ["literal", [2, 1.5]];
const ROAD_MAJOR_STOPS = [
  [5, 0.8],
  [12, 3],
  [20, 14],
];
const ROAD_MEDIUM_STOPS = [
  [8, 0.6],
  [12, 2],
  [20, 10],
];
const ROAD_LOCAL_STOPS = [
  [12, 1],
  [14, 2],
  [20, 8],
];

// The basemap's road fill layers, grouped by hierarchy tier. Each tier
// carries its paved/unpaved colours and the width ramp applied to every
// layer in the group. Links join their parent tier (they carry the same
// class + surface tags); the under-construction & rail layers are left to
// the basemap's own rendering.
const ROAD_TIERS = {
  major: {
    layers: [
      "Highway road",
      "Trunk road",
      "Primary road",
      "Highway road link",
      "Trunk road link",
      "Primary road link",
    ],
    paved: COLOURS.ROADS.MAJOR,
    unpaved: COLOURS.ROADS.UNPAVED_MAJOR,
    stops: ROAD_MAJOR_STOPS,
  },
  medium: {
    layers: ["Secondary road", "Tertiary road"],
    paved: COLOURS.ROADS.MEDIUM,
    unpaved: COLOURS.ROADS.UNPAVED_MEDIUM,
    stops: ROAD_MEDIUM_STOPS,
  },
  local: {
    layers: ["Minor road", "Service road", "Raceway road"],
    paved: COLOURS.ROADS.LOCAL,
    unpaved: COLOURS.ROADS.UNPAVED_LOCAL,
    stops: ROAD_LOCAL_STOPS,
  },
};

// Road tunnel fills faded by ROAD_TUNNEL_OPACITY — the basemap's own
// tunnel layers (path & rail tunnels are styled separately).
const ROAD_TUNNEL_LAYERS = [
  "Highway tunnel",
  "Trunk tunnel",
  "Primary tunnel",
  "Secondary tunnel",
  "Tertiary tunnel",
  "Minor tunnel",
  "Service tunnel",
  "Highway link tunnel",
  "Link tunnel",
];

// Build a v5-valid line-width expression where zoom is the top-level
// interpolate and surface-awareness lives at each stop value. Unpaved width
// ramps at different zooms than paved — merge the two stop sets:
//   ["interpolate", …, ["zoom"],
//    z0, ["case", ["==", ["get", "surface"], "unpaved"], u0, p0],
//    z1, ["case", ["==", ["get", "surface"], "unpaved"], u1, p1], …]
function surfaceWidthExpr(pavedStops) {
  const unpaved = ROAD_UNPAVED_STOPS;
  const zooms = new Set(pavedStops.map(([z]) => z));
  unpaved.forEach(([z]) => zooms.add(z));
  const sorted = [...zooms].sort((a, b) => a - b);
  // Linearly interpolate a stop set at any zoom (extrapolates outside the
  // set's range, where the value is clamped by the renderer anyway).
  function lerp(stops, z) {
    let lo = stops[0],
      hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (stops[i][0] <= z && stops[i + 1][0] >= z) {
        lo = stops[i];
        hi = stops[i + 1];
        break;
      }
    }
    if (hi[0] === lo[0]) return lo[1];
    return lo[1] + (hi[1] - lo[1]) * ((z - lo[0]) / (hi[0] - lo[0]));
  }
  const expr = ["interpolate", ["exponential", 1.2], ["zoom"]];
  for (const z of sorted) {
    const p = Math.round(lerp(pavedStops, z) * 10) / 10;
    const u = Math.round(lerp(unpaved, z) * 10) / 10;
    expr.push(z, ["case", ["==", ["get", "surface"], "unpaved"], u, p]);
  }
  return expr;
}

// PATHS — styling shared between the low-zoom overlay (z9–13) and the
// basemap path layers (z12+), so the two render as one continuous visual
// family — no duplicated literals. BUTT (not round) cap: with round caps +
// an interpolated line-width, MapLibre fails to apply line-dasharray —
// paths render solid instead of dashed (same quirk as the road family).
const PATH_LINE_CAP = "butt";
const PATH_LINE_JOIN = "round";
const PATH_DASHARRAY = [1, 0.7]; // outdoor trail dash
const PATH_WIDTH = [
  "interpolate",
  ["exponential", 1.2],
  ["zoom"],
  12,
  1,
  14,
  2,
  20,
  8,
]; // basemap path width z14+ (the overlay owns z9–13)
const PATH_WIDTH_LOW_ZOOM = [
  "interpolate",
  ["exponential", 1.2],
  ["zoom"],
  9,
  0.6,
  11,
  1,
  13,
  2,
]; // overlay width z9–13; z13 ≈ PATH_WIDTH at z14 for a seamless handoff
const PATH_BASE_MINZOOM = 14; // the basemap path layers render from here; the overlay owns z9–13

// Hosted low-zoom paths overlay — vector tiles with path/footway/track
// geometry from OSM, filling the z9–13 gap where the OpenMapTiles base
// tiles carry no path data (route-gated below z12, all paths at z12).
// Source-layer: 'outdoor_paths'. Self-hosted Planetiler tiles (z9–13).
const PATHS_SOURCE_ID = "outdoor-paths";
const PATHS_SOURCE_LAYER = "outdoor_paths";
const PATHS_TILE_URL = "https://tile.ogis.app/paths/{z}/{x}/{y}.pbf";
const PATHS_SOURCE_MINZOOM = 9;
const PATHS_SOURCE_MAXZOOM = 13;
const PATHS_LAYER_MAXZOOM = 14; // exclusive — hands off to the basemap path layers at z14

// Path & footway ways render from z9; track-class ways are handled
// separately (PATHS_OVERLAY_TRACK_CLASSES).
const PATHS_OVERLAY_CLASSES = ["path", "footway"];

// Tracks are re-drawn from the overlay at z12–13 because OMT tiles carry
// only a subset of track geometry below z14; styled as local roads (paved
// look, no surface attribute).
const PATHS_OVERLAY_TRACK_CLASSES = ["track"];
const PATHS_TRACK_MINZOOM = 12; // below z12 nothing renders, matching the basemap local-road family's own start
const PATH_TRACK_WIDTH_LOW_ZOOM = [
  "interpolate",
  ["exponential", 1.2],
  ["zoom"],
  12,
  1,
  13,
  2,
  14,
  2,
]; // fill width; z13=2 matches the local road fill at z14 for a seamless handoff
const PATH_TRACK_CASING_WIDTH_LOW_ZOOM = [
  "interpolate",
  ["exponential", 1.2],
  ["zoom"],
  12,
  4,
  13,
  5,
  14,
  5,
]; // casing = fill + ~3px outline (mirrors the local road casing at z14)

// POIs — the config-driven outdoor-poi overlay (see poi-config.mjs). All
// expressions below are derived from OUTDOOR_POI.kinds so the filter, icon
// and elevation-label kind sets can never drift from the schema.
//
// Filter: per-kind handoff. A kind with a handoffZoom renders only below
// that zoom; a null handoffZoom renders at every zoom (the basemap never
// draws those kinds). The basemap's own POI layers — Attraction z15,
// Campsite z16, Accommodation z17, Waste z18 — take over at/above the
// handoff, so there are no duplicates and no gaps.
const POI_FILTER = [
  "any",
  ...OUTDOOR_POI.kinds.map((k) =>
    k.handoffZoom === null
      ? ["==", ["get", "kind"], k.kind]
      : [
          "all",
          ["==", ["get", "kind"], k.kind],
          ["<", ["zoom"], k.handoffZoom],
        ],
  ),
];

// Sprite sheet wiring — the outdoors-owned sheet (built by
// scripts/build-sprite.mjs) loads as its own sprite id ("outdoors"), so its
// icons are referenced with an "outdoors:" prefix. This list MUST contain
// every icon in the outdoors sheet: MapLibre keys images from a non-default
// sheet as "<id>:<name>", while bare names only resolve against the default
// sheet — style.getImage() is a direct lookup with no fallback. An icon in
// the outdoors sheet referenced bare would never render (styleimagemissing).
// Every other POI icon comes from the basemap's "default" sheet and stays
// unprefixed. See the style.sprite array in build().
const OUTDOOR_SPRITE_ID = "outdoors";
const OUTDOOR_SPRITE_ICONS = ["trailhead", "pass", "dot", "park", "skiing"];
const outdoorIcon = (name) =>
  OUTDOOR_SPRITE_ICONS.includes(name) ? `${OUTDOOR_SPRITE_ID}:${name}` : name;

// Icon match — each kind maps to its sprite icon (basemap icons unprefixed,
// outdoors-owned icons prefixed), with a "dot" fallback for any unmatched
// kind. ("marker" does not exist in the basemap sprite.) The fallback never
// renders: every kind in OUTDOOR_POI.kinds has an explicit icon.
const POI_ICON_MATCH = [
  "match",
  ["get", "kind"],
  ...OUTDOOR_POI.kinds.flatMap((k) => [k.kind, outdoorIcon(k.icon)]),
  outdoorIcon("dot"),
];

// Elevation in the label — showEle kinds carry ele from the tiles, rendered
// as "{name} {ele}m" like the peak labels. number-format(round(ele))
// mirrors the contour-label approach (to-string would print raw decimals).
const POI_ELE_KINDS = OUTDOOR_POI.kinds
  .filter((k) => k.showEle)
  .map((k) => k.kind);
const POI_TEXT_EXPR = [
  "case",
  ["all", ["has", "ele"], ["in", ["get", "kind"], ["literal", POI_ELE_KINDS]]],
  [
    "concat",
    ["get", "name"],
    " ",
    ["number-format", ["round", ["get", "ele"]], {}],
    "m",
  ],
  ["get", "name"],
];

// PLANET_POI — amenities rendered from the basemap's OpenMapTiles `poi`
// source-layer (planet tiles, no hosted extract). Like the outdoor-poi
// overlay, the filter, icon match and title expression are derived from
// PLANET_POI.kinds so they can never drift from the config. Icons live in
// the basemap's "default" sprite; the "dot" fallback (outdoors sheet) is
// used for any unmatched class.
const PLANET_POI_FILTER = [
  "in",
  ["get", "class"],
  ["literal", PLANET_POI.kinds.map((k) => k.class)],
];
const PLANET_POI_ICON_MATCH = [
  "match",
  ["get", "class"],
  ...PLANET_POI.kinds.flatMap((k) => [k.class, k.icon]),
  outdoorIcon("dot"),
];
const PLANET_POI_TEXT_FIELD = [
  "case",
  ...PLANET_POI.kinds.flatMap((k) => [
    ["==", ["get", "class"], k.class],
    k.showTitle ? ["get", "name"] : "",
  ]),
  "",
];

/**
 * Override a paint property on a layer, matched by exact id. Layers missing
 * from the base style are skipped silently so the build stays robust against
 * upstream renames.
 */
function setPaint(style, id, paintKey, value) {
  const layer = style.layers.find((l) => l.id === id);
  if (!layer) return;
  layer.paint = layer.paint || {};
  layer.paint[paintKey] = value;
}

/**
 * Insert a layer immediately after the layer with the given anchor id.
 * Returns true if the anchor was found (layer inserted); false otherwise.
 */
function insertAfter(style, layer, anchorId) {
  const idx = style.layers.findIndex((l) => l.id === anchorId);
  if (idx === -1) return false;
  style.layers.splice(idx + 1, 0, layer);
  return true;
}

/**
 * Insert a layer immediately before the layer with the given anchor id.
 * Returns true if the anchor was found (layer inserted); false otherwise.
 */
function insertBefore(style, layer, anchorId) {
  const idx = style.layers.findIndex((l) => l.id === anchorId);
  if (idx === -1) return false;
  style.layers.splice(idx, 0, layer);
  return true;
}

/**
 * Apply outdoor-specific mutations to the basemap style.
 *
 * Slice 2 recolours the muted base with the project's terrain, water and
 * park palettes; slice 3 adds the DEM source, the hillshade layer and the
 * terrain config; slice 4 adds the hosted contour vector source, the contour
 * line layer and the contour elevation labels. Each is gated by its FEATURES
 * toggle. Later slices add the remaining outdoor sections (paths, routes,
 * POIs, …) here, mutating `style` in place and returning it.
 */
function applyModifications(style) {
  if (FEATURES.TERRAIN_PALETTE) applyTerrainPalette(style);
  if (FEATURES.WATER_PALETTE) applyWaterPalette(style);
  if (FEATURES.PARK_DIFFERENTIATION) applyParkDifferentiation(style);
  if (FEATURES.DEM_HILLSHADE || FEATURES.DEM_TERRAIN) applyDemSource(style);
  if (FEATURES.DEM_HILLSHADE) applyDemHillshade(style);
  if (FEATURES.DEM_TERRAIN) applyDemTerrain(style);
  if (FEATURES.CONTOURS) applyContours(style);
  if (FEATURES.CONTOURS) applyContourLabels(style);
  if (FEATURES.OUTDOOR_POI) applyOutdoorPoi(style);
  if (FEATURES.ROAD_SURFACE_AWARE) applyRoadSurfaceAware(style);
  if (FEATURES.LOW_ZOOM_PATHS) applyLowZoomPaths(style);
  if (FEATURES.PATH_STYLING) applyPathStyling(style);
  return style;
}

/**
 * Recolour the muted landcover & landuse fills with the terrain palette.
 * Gated by TERRAIN_PALETTE.
 */
function applyTerrainPalette(style) {
  setPaint(style, "Background", "background-color", COLOURS.TERRAIN.BACKGROUND);

  // Grass-family fills
  setPaint(style, "Grass (medium scale)", "fill-color", COLOURS.TERRAIN.GRASS);
  setPaint(style, "Grass", "fill-color", COLOURS.TERRAIN.GRASS);
  setPaint(style, "Meadow", "fill-color", COLOURS.TERRAIN.GRASS);
  setPaint(style, "Garden", "fill-color", COLOURS.TERRAIN.GRASS);
  setPaint(style, "Recreation ground", "fill-color", COLOURS.TERRAIN.GRASS);
  setPaint(style, "Cemetery", "fill-color", COLOURS.TERRAIN.GRASS);
  setPaint(
    style,
    "Wetland (medium scale)",
    "fill-color",
    COLOURS.TERRAIN.GRASS,
  );
  setPaint(style, "Wetland and swamp", "fill-color", COLOURS.TERRAIN.GRASS);
  setPaint(style, "Marsh", "fill-color", COLOURS.TERRAIN.GRASS);

  // Wood-family fills
  setPaint(style, "Wood (medium scale)", "fill-color", COLOURS.TERRAIN.WOOD);
  setPaint(style, "Wood", "fill-color", COLOURS.TERRAIN.WOOD);
  setPaint(style, "Forest", "fill-color", COLOURS.TERRAIN.WOOD);
  setPaint(style, "Mangrove", "fill-color", COLOURS.TERRAIN.WOOD);

  // Rock & sand fills
  setPaint(style, "Rock (medium scale)", "fill-color", COLOURS.LANDCOVER.ROCK);
  setPaint(style, "Scree", "fill-color", COLOURS.LANDCOVER.ROCK);
  setPaint(style, "Bare rock", "fill-color", COLOURS.LANDCOVER.ROCK);
  setPaint(style, "Sand (medium scale)", "fill-color", COLOURS.TERRAIN.SAND);
  setPaint(style, "Sand", "fill-color", COLOURS.TERRAIN.SAND);
  setPaint(style, "Dune", "fill-color", COLOURS.TERRAIN.SAND);
  setPaint(style, "Beach", "fill-color", COLOURS.TERRAIN.SAND);

  // Farmland & heath fills
  setPaint(
    style,
    "Farmland (medium scale)",
    "fill-color",
    COLOURS.LANDCOVER.FARMLAND,
  );
  setPaint(style, "Farmland", "fill-color", COLOURS.LANDCOVER.FARMLAND);
  setPaint(style, "Farm", "fill-color", COLOURS.LANDCOVER.FARMLAND);
  setPaint(
    style,
    "Orchard and vineyard",
    "fill-color",
    COLOURS.LANDCOVER.FARMLAND,
  );
  setPaint(style, "Heath", "fill-color", COLOURS.LANDCOVER.HEATH);
  setPaint(style, "Scrub", "fill-color", COLOURS.LANDCOVER.HEATH);

  // Cultivated & built-up landuse fills
  setPaint(style, "Allotments", "fill-color", COLOURS.TERRAIN.GRASS);
  setPaint(style, "Stadium", "fill-color", COLOURS.TERRAIN.GRASS);
  setPaint(style, "Residential", "fill-color", COLOURS.TERRAIN.RESIDENTIAL);
  setPaint(style, "Military", "fill-color", COLOURS.LANDUSE.MILITARY);
  setPaint(style, "Quarry", "fill-color", COLOURS.LANDUSE.QUARRY);

  // Ice & outlines
  setPaint(style, "Glacier", "fill-color", COLOURS.TERRAIN.ICE);
  setPaint(
    style,
    "Glacier outline",
    "line-color",
    COLOURS.WATER.GLACIER_OUTLINE,
  );
}

/**
 * Recolour the muted water fills & lines with the water palette.
 * Gated by WATER_PALETTE.
 */
function applyWaterPalette(style) {
  setPaint(style, "Water", "fill-color", COLOURS.WATER.WATER);
  setPaint(style, "Water intermittent", "fill-color", COLOURS.WATER.WATER);
  setPaint(style, "River", "line-color", COLOURS.WATER.WATER);
  setPaint(style, "River intermittent", "line-color", COLOURS.WATER.WATER);
  setPaint(style, "Other waterway", "line-color", COLOURS.WATER.WATER);
  setPaint(
    style,
    "Other waterway intermittent",
    "line-color",
    COLOURS.WATER.WATER,
  );
  setPaint(style, "River tunnel", "line-color", COLOURS.WATER.WATER);
  setPaint(style, "River bridge", "line-color", COLOURS.WATER.WATER);
}

/**
 * Differentiate parks: lighter local park fill, darker national park
 * boundaries, dark green park labels. Gated by PARK_DIFFERENTIATION.
 */
function applyParkDifferentiation(style) {
  setPaint(style, "Park", "fill-color", COLOURS.PARK.DEFAULT);
  setPaint(style, "National parks", "line-color", COLOURS.PARK.NATIONAL_PARK);
  setPaint(
    style,
    "National park outline",
    "line-color",
    COLOURS.PARK.NATIONAL_PARK,
  );
  setPaint(style, "Local park", "text-color", COLOURS.PARK.LABEL_TEXT);
  setPaint(
    style,
    "National park labels",
    "text-color",
    COLOURS.PARK.LABEL_TEXT,
  );
}

/**
 * Add the shared raster-dem source. Added when either DEM_HILLSHADE or
 * DEM_TERRAIN is enabled.
 */
function applyDemSource(style) {
  style.sources[DEM_SOURCE_ID] = {
    type: "raster-dem",
    tiles: [DEM_SOURCE_URL],
    encoding: DEM_SOURCE_ENCODING,
    tileSize: DEM_SOURCE_TILESIZE,
    maxzoom: DEM_SOURCE_MAXZOOM,
    attribution: DEM_SOURCE_ATTRIBUTION,
  };
}

/**
 * Find the index of the first water layer — the insertion anchor for the
 * hillshade layer, which sits above the landcover/landuse fills and below
 * the water lines & fills.
 */
function waterStackIndex(style) {
  return style.layers.findIndex(
    (l) => l.id.startsWith("Water") || l.id.startsWith("River"),
  );
}

/**
 * Add the 2D hillshade layer above landcover/landuse, below water.
 * Gated by DEM_HILLSHADE.
 */
function applyDemHillshade(style) {
  const hillshadeIdx = waterStackIndex(style);
  const hillshadeLayer = {
    id: "hillshade-layer",
    type: "hillshade",
    source: DEM_SOURCE_ID,
    paint: {
      "hillshade-exaggeration": HILLSHADE_EXAGGERATION,
    },
  };
  if (hillshadeIdx !== -1) {
    style.layers.splice(hillshadeIdx, 0, hillshadeLayer);
  } else {
    style.layers.push(hillshadeLayer);
  }
}

/**
 * Add the 3D terrain exaggeration from the DEM source.
 * Gated by DEM_TERRAIN.
 */
function applyDemTerrain(style) {
  style.terrain = {
    source: DEM_SOURCE_ID,
    exaggeration: TERRAIN_EXAGGERATION,
  };
}

/**
 * Add the hosted contour vector source and the contour line layer.
 * Gated by CONTOURS. The single line layer merges the minor + index contours
 * into one layer — v5 filter syntax can't express ["%", …] expressions, so
 * tiering is done with expression-based paint. The layer is inserted after
 * the river bridge outline and before the first road outline layer, so
 * contours sit above the landcover/water fills but yield to the road & path
 * stack.
 */
function applyContours(style) {
  style.sources[CONTOUR_SOURCE_ID] = {
    type: "vector",
    minzoom: CONTOUR_SOURCE_MINZOOM,
    tiles: [CONTOUR_TILE_URL],
    maxzoom: CONTOUR_SOURCE_MAXZOOM,
  };

  const contourLinesLayer = {
    id: "contour-lines",
    type: "line",
    source: CONTOUR_SOURCE_ID,
    "source-layer": CONTOUR_SOURCE_LAYER,
    minzoom: CONTOUR_SOURCE_MINZOOM,
    maxzoom: CONTOUR_LAYER_MAXZOOM,
    filter: [">", ["get", "ele"], 0],
    paint: {
      "line-color": [
        "case",
        contourIndexCond,
        COLOURS.CONTOURS.INDEX,
        contourMinorCond,
        COLOURS.CONTOURS.MINOR,
        COLOURS.CONTOURS.MINOR,
      ],
      // v5 requires zoom at the top level — case at each stop, not
      // interpolate inside case.
      "line-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        CONTOUR_SOURCE_MINZOOM,
        contourCase(CONTOUR_OPACITY_INDEX.low, CONTOUR_OPACITY_MINOR.low),
        CONTOUR_MID_ZOOM,
        contourCase(CONTOUR_OPACITY_INDEX.mid, CONTOUR_OPACITY_MINOR.mid),
        CONTOUR_SOURCE_MAXZOOM,
        contourCase(CONTOUR_OPACITY_INDEX.high, CONTOUR_OPACITY_MINOR.high),
      ],
      "line-width": [
        "interpolate",
        ["exponential", 1.2],
        ["zoom"],
        CONTOUR_SOURCE_MINZOOM,
        contourCase(CONTOUR_WIDTH_INDEX.low, CONTOUR_WIDTH_MINOR.low),
        CONTOUR_MID_ZOOM,
        contourCase(CONTOUR_WIDTH_INDEX.mid, CONTOUR_WIDTH_MINOR.mid),
        CONTOUR_SOURCE_MAXZOOM,
        contourCase(CONTOUR_WIDTH_INDEX.high, CONTOUR_WIDTH_MINOR.high),
      ],
    },
  };

  const inserted =
    insertAfter(style, contourLinesLayer, "River bridge outline") ||
    insertBefore(style, contourLinesLayer, "Highway link bridge outline");
  if (!inserted) style.layers.push(contourLinesLayer);
}

/**
 * Contour elevation labels — index (100 m) labels placed along the contour
 * lines. The layer is inserted just below the peak label layers, so contour
 * labels beat the POI symbol layers in collisions but still yield to peaks.
 * Gated by CONTOURS.
 */
function applyContourLabels(style) {
  const layer = {
    id: "contour-labels",
    type: "symbol",
    source: CONTOUR_SOURCE_ID,
    "source-layer": CONTOUR_SOURCE_LAYER,
    minzoom: CONTOUR_SOURCE_MINZOOM,
    maxzoom: CONTOUR_LAYER_MAXZOOM,
    filter: [">", ["get", "ele"], 0],
    layout: {
      "symbol-placement": "line",
      "symbol-avoid-edges": true,
      "text-rotation-alignment": "map",
      "text-size": ["interpolate", ["linear"], ["zoom"], 12, 11, 14, 13],
      // Only show labels on index contours; v5 filter syntax can't express
      // ["%", ["get","ele"], 100] so we use a conditional text-field.
      "text-field": [
        "case",
        ["==", ["%", ["get", "ele"], 100], 0],
        CONTOUR_LABEL_EXPR,
        "",
      ],
      "text-font": ["Noto Sans Regular"],
      "text-padding": 4,
    },
    paint: {
      "text-color": COLOURS.CONTOURS.LABEL,
      "text-halo-color": COLOURS.CONTOURS.HALO,
      "text-halo-width": 1.25,
    },
  };

  // Insert just below whichever peak label layer comes first in the stack,
  // so contour labels sit below both peak label layers.
  const peakIdx = style.layers.findIndex((l) =>
    ["Volcano peak labels", "Mountain peak labels"].includes(l.id),
  );
  if (peakIdx !== -1) {
    style.layers.splice(peakIdx, 0, layer);
  } else {
    style.layers.push(layer);
  }
}

/**
 * Paved/unpaved road hierarchy — restyles the basemap's road fills by the
 * surface tag. Each tier's fill layers get a surface-aware line-colour and
 * line-width (paved vs unpaved ramps), a dashed line-dasharray for unpaved
 * ways, and the butt cap that lets dasharrays render at interpolated
 * widths. The basemap's road tunnel fills are faded so their dashes read
 * clearly. Outlines, bridges, rails & pedestrian areas keep the basemap's
 * own rendering. Gated by ROAD_SURFACE_AWARE.
 */
function applyRoadSurfaceAware(style) {
  for (const tier of Object.values(ROAD_TIERS)) {
    for (const id of tier.layers) {
      const layer = style.layers.find((l) => l.id === id);
      if (!layer) continue;
      const unpaved = ["==", ["get", "surface"], "unpaved"];
      layer.paint = layer.paint || {};
      layer.paint["line-color"] = ["case", unpaved, tier.unpaved, tier.paved];
      layer.paint["line-width"] = surfaceWidthExpr(tier.stops);
      layer.paint["line-dasharray"] = [
        "case",
        unpaved,
        ROAD_UNPAVED_DASHARRAY,
        ["literal", [1]],
      ];
      layer.layout = layer.layout || {};
      // BUTT cap: with round caps + an interpolated width, MapLibre fails to
      // apply line-dasharray — unpaved roads would render solid instead of
      // dashed (same quirk as the path family).
      layer.layout["line-cap"] = "butt";
      layer.layout["line-join"] = "round";
    }
  }

  for (const id of ROAD_TUNNEL_LAYERS) {
    setPaint(style, id, "line-opacity", ROAD_TUNNEL_OPACITY);
  }
}

/**
 * Hosted low-zoom paths overlay — adds the outdoor-paths vector source and
 * three line layers covering the z9–13 gap where the OpenMapTiles base
 * tiles carry no path data. Path & footway ways render from z9; track-class
 * ways (only partially present below z14) are re-drawn at z12–13 styled as
 * local roads. Layers are inserted just above the contour/water stack and
 * below the basemap's own path layers, so the native z12+ path layers take
 * over seamlessly at the overlay's exclusive maxzoom. Gated by LOW_ZOOM_PATHS.
 */
function applyLowZoomPaths(style) {
  style.sources[PATHS_SOURCE_ID] = {
    type: "vector",
    tiles: [PATHS_TILE_URL],
    minzoom: PATHS_SOURCE_MINZOOM,
    maxzoom: PATHS_SOURCE_MAXZOOM,
  };

  // Track-class ways — casing renders lowest, then the fill, with the path
  // layer above. Both share the exclusive maxzoom.
  const trackCasingLayer = {
    id: "outdoor-paths-track-casing",
    type: "line",
    source: PATHS_SOURCE_ID,
    "source-layer": PATHS_SOURCE_LAYER,
    minzoom: PATHS_TRACK_MINZOOM,
    maxzoom: PATHS_LAYER_MAXZOOM,
    filter: ["in", "class", ...PATHS_OVERLAY_TRACK_CLASSES],
    layout: {
      "line-cap": PATH_LINE_CAP,
      "line-join": PATH_LINE_JOIN,
    },
    paint: {
      "line-color": COLOURS.ROADS.TRACK_CASING,
      "line-width": PATH_TRACK_CASING_WIDTH_LOW_ZOOM,
    },
  };

  const trackFillLayer = {
    id: "outdoor-paths-track-fill",
    type: "line",
    source: PATHS_SOURCE_ID,
    "source-layer": PATHS_SOURCE_LAYER,
    minzoom: PATHS_TRACK_MINZOOM,
    maxzoom: PATHS_LAYER_MAXZOOM,
    filter: ["in", "class", ...PATHS_OVERLAY_TRACK_CLASSES],
    layout: {
      "line-cap": PATH_LINE_CAP,
      "line-join": PATH_LINE_JOIN,
    },
    paint: {
      "line-color": COLOURS.ROADS.LOCAL,
      "line-width": PATH_TRACK_WIDTH_LOW_ZOOM,
    },
  };

  const pathsLayer = {
    id: "outdoor-paths",
    type: "line",
    source: PATHS_SOURCE_ID,
    "source-layer": PATHS_SOURCE_LAYER,
    minzoom: PATHS_SOURCE_MINZOOM,
    maxzoom: PATHS_LAYER_MAXZOOM,
    filter: ["in", "class", ...PATHS_OVERLAY_CLASSES],
    layout: {
      "line-cap": PATH_LINE_CAP,
      "line-join": PATH_LINE_JOIN,
    },
    paint: {
      "line-color": COLOURS.PATHS.PATH,
      "line-dasharray": PATH_DASHARRAY,
      "line-width": PATH_WIDTH_LOW_ZOOM,
    },
  };

  // Insert above the road fills and below the basemap's own path layers —
  // "Footway path" is the last of the basemap path stack. Casing renders
  // lowest, paths on top.
  const anchorIdx = style.layers.findIndex((l) => l.id === "Footway path");
  if (anchorIdx !== -1) {
    style.layers.splice(
      anchorIdx,
      0,
      trackCasingLayer,
      trackFillLayer,
      pathsLayer,
    );
  } else {
    style.layers.push(trackCasingLayer, trackFillLayer, pathsLayer);
  }
}

/**
 * Apply the outdoor path family to the basemap's path layers — the distinct
 * Footway/Bridleway/Cycleway/Steps layers and their tunnel & bridge variants
 * all render in the outdoor trail colour, dash and width ramp, and from the
 * overlay's exclusive maxzoom so the low-zoom overlay owns z9–13. The
 * basemap's single "Road labels" layer covers every road class (not just
 * paths), so labels keep their basemap colour. Gated by PATH_STYLING.
 */
function applyPathStyling(style) {
  const pathFamily = [
    {
      id: "Footway path",
      tunnel: "Footway path tunnel",
      bridge: "Footway bridge",
    },
    {
      id: "Bridleway path",
      tunnel: "Bridleway path tunnel",
      bridge: "Bridleway bridge",
    },
    {
      id: "Cycleway path",
      tunnel: "Cycleway path tunnel",
      bridge: "Cycleway bridge",
    },
    { id: "Steps path" },
  ];

  for (const variant of pathFamily) {
    for (const key of ["id", "tunnel", "bridge"]) {
      const id = variant[key];
      if (!id) continue;
      const layer = style.layers.find((l) => l.id === id);
      if (!layer) continue;
      layer.paint = layer.paint || {};
      layer.paint["line-color"] = COLOURS.PATHS.PATH;
      layer.paint["line-dasharray"] = PATH_DASHARRAY;
      layer.paint["line-width"] = PATH_WIDTH;
      if (key === "tunnel") {
        layer.paint["line-opacity"] = ROAD_TUNNEL_OPACITY;
      }
      layer.layout = layer.layout || {};
      layer.layout["line-cap"] = PATH_LINE_CAP;
      layer.layout["line-join"] = PATH_LINE_JOIN;
      layer.minzoom = PATH_BASE_MINZOOM;
    }
  }
}

/**
 * Outdoor POI overlay — one config-driven symbol layer (see
 * poi-config.mjs) replacing the old Liberty tier layers. Renders the 9
 * outdoor kinds from the hosted outdoor_pois tiles below their per-kind
 * handoff zooms, handing off to the basemap's own POI layers (Attraction
 * z15, Campsite z16, Accommodation z17, Waste z18) at/above them. Layout
 * and paint mirror the basemap's own POI symbol layers (see "Campsite"):
 * icon-allow-overlap false, top-anchored label with a halo, no icon-size.
 * The layer is inserted just above "Zoo" — the last of the basemap POI
 * symbol stack — so overlay POIs beat basemap POIs in collisions, contour
 * labels (added below the peaks) beat overlay POIs, and peaks beat
 * contours. Gated by OUTDOOR_POI.
 */
function applyOutdoorPoi(style) {
  style.sources[OUTDOOR_POI.sourceId] = {
    type: "vector",
    tiles: [OUTDOOR_POI.tileUrl],
    minzoom: OUTDOOR_POI.sourceMinzoom,
    maxzoom: OUTDOOR_POI.sourceMaxzoom,
  };

  const layer = {
    id: "outdoor-poi",
    type: "symbol",
    source: OUTDOOR_POI.sourceId,
    "source-layer": OUTDOOR_POI.sourceLayer,
    minzoom: OUTDOOR_POI.sourceMinzoom,
    filter: POI_FILTER,
    layout: {
      "icon-allow-overlap": false,
      "icon-image": POI_ICON_MATCH,
      "text-anchor": "top",
      "text-field": POI_TEXT_EXPR,
      "text-font": ["Noto Sans Regular"],
      "text-max-width": 9,
      "text-offset": [0, 1.2],
      "text-padding": 2,
      "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 20, 11],
    },
    paint: {
      "icon-halo-blur": 1,
      "icon-halo-color": "hsl(0, 0%, 100%)",
      "icon-halo-width": 0.5,
      "icon-opacity": 1,
      "text-color": "hsl(216, 100%, 50%)",
      "text-halo-blur": 0.5,
      "text-halo-color": "hsl(0, 0%, 100%)",
      "text-halo-width": 1,
    },
  };

  // Planet-tile amenities layer — built from PLANET_POI config, sits
  // immediately below the outdoor-poi overlay (so overlay POIs beat it in
  // collisions). Shares the outdoor-poi layer's layout/paint conventions.
  const planetLayer = {
    id: PLANET_POI.layerId,
    type: "symbol",
    source: PLANET_POI.sourceId,
    "source-layer": PLANET_POI.sourceLayer,
    minzoom: PLANET_POI.minzoom,
    filter: PLANET_POI_FILTER,
    layout: {
      "icon-allow-overlap": false,
      "icon-image": PLANET_POI_ICON_MATCH,
      "text-anchor": "top",
      "text-field": PLANET_POI_TEXT_FIELD,
      "text-font": ["Noto Sans Regular"],
      "text-max-width": 9,
      "text-offset": [0, 1.2],
      "text-padding": 2,
      "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 20, 11],
    },
    paint: {
      "icon-halo-blur": 1,
      "icon-halo-color": "hsl(0, 0%, 100%)",
      "icon-halo-width": 0.5,
      "icon-opacity": 1,
      "text-color": "hsl(216, 100%, 50%)",
      "text-halo-blur": 0.5,
      "text-halo-color": "hsl(0, 0%, 100%)",
      "text-halo-width": 1,
    },
  };

  // Just above the basemap POI stack ("Zoo") and below the contour labels.
  const inserted =
    insertAfter(style, planetLayer, "Zoo") ||
    insertBefore(style, planetLayer, "outdoor-poi") ||
    insertBefore(style, planetLayer, "contour-labels");
  if (!inserted) style.layers.push(planetLayer);

  insertAfter(style, layer, PLANET_POI.layerId) ||
    insertBefore(style, layer, "contour-labels") ||
    style.layers.push(layer);
}

// ═════════════════════════════════════════════════════════════════════════
// Basemap fetch — download from ogis.org with local cache
// ═════════════════════════════════════════════════════════════════════════

/**
 * Fetch the basemap base style — from local cache if up-to-date,
 * otherwise from ogis.org.
 *
 * Cache invalidation uses the HTTP ETag from the response. On each build:
 *   1. Send a conditional GET with `If-None-Match` set to the cached ETag.
 *   2. If the server returns 304 (Not Modified), the cache is fresh.
 *   3. If it returns 200, the file changed — download and re-cache.
 *   4. If the network is unavailable, fall back to cache with a warning.
 *
 * This means the style auto-updates when upstream changes, works offline
 * (when cached), and requires no manual version management.
 */
async function fetchBasemap() {
  const headers = {};
  const cachedEtag = existsSync(CACHE_META_FILE)
    ? readFileSync(CACHE_META_FILE, "utf8").trim()
    : null;

  if (cachedEtag) {
    headers["If-None-Match"] = cachedEtag;
  }

  let res;
  try {
    res = await fetch(BASE_STYLE_URL, { headers });
  } catch (err) {
    if (existsSync(CACHE_FILE)) {
      console.warn(
        `[build] network error, using cached basemap style: ${err.message}`,
      );
      return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    }
    throw new Error(
      `Failed to fetch basemap style (no cache available): ${err.message}`,
    );
  }

  if (res.status === 304 && existsSync(CACHE_FILE)) {
    console.log("[build] basemap style unchanged (304), using cache");
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  }

  if (!res.ok) {
    if (existsSync(CACHE_FILE)) {
      console.warn(
        `[build] server returned ${res.status}, using cached basemap style`,
      );
      return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    }
    throw new Error(
      `Failed to fetch basemap style: ${res.status} ${res.statusText}`,
    );
  }

  console.log("[build] basemap style updated, fetching from ogis.org");
  const text = await res.text();
  const etag = res.headers.get("etag") || "";

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, text, "utf8");
  writeFileSync(CACHE_META_FILE, etag, "utf8");
  console.log(`[build] cached basemap style to ${CACHE_FILE}`);

  return JSON.parse(text);
}

// ═════════════════════════════════════════════════════════════════════════
// Build — fetch & deep-clone the base style, write style.json
// ═════════════════════════════════════════════════════════════════════════

async function build() {
  const basemap = await fetchBasemap();

  // Deep-clone the base style, declaring the root-level identity key first
  // so it is prepended in JSON output. (Assigning `style.name` to an
  // existing object would append the key last instead.) `name` is a root
  // property per the MapLibre style spec:
  // https://maplibre.org/maplibre-style-spec/root/
  // The published basemap ships its own name ("Basemap"), so the spread
  // would otherwise overwrite ours — re-set it after.
  const style = {
    name: STYLE_NAME,
    ...JSON.parse(JSON.stringify(basemap)),
  };
  style.name = STYLE_NAME;

  // Sprite sheet wiring — MapLibre accepts a sprite ARRAY of {id, url}
  // pairs (string arrays and relative URLs are rejected by maplibre-gl v5).
  // Each sheet loads independently under its id; icons are referenced as
  // "<id>:<name>", or bare "<name>" for the "default" sheet. The basemap
  // sprite stays "default" so its own layer references are untouched; the
  // outdoors-owned sheet (built by scripts/build-sprite.mjs into dev/public,
  // deployed to https://www.ogis.org/outdoors/) carries the five outdoor-poi
  // icons (trailhead, pass, dot, park, skiing) referenced as
  // "outdoors:<name>" — see OUTDOOR_SPRITE_ID above. One committed location
  // serves dev, the screenshot harness and GitHub Pages.
  // This must always apply — it is not feature-gated.
  style.sprite = [
    { id: "default", url: "https://www.ogis.org/basemap/sprite" },
    { id: OUTDOOR_SPRITE_ID, url: "https://www.ogis.org/outdoors/sprite" },
  ];

  applyModifications(style);

  writeFileSync(OUTDOOR_STYLE, `${JSON.stringify(style, null, 2)}\n`, "utf8");

  // Validate the built style against the MapLibre GL style spec so a
  // build can never emit an invalid style.json.
  try {
    validateStyle(OUTDOOR_STYLE);
  } catch (err) {
    console.error(`\n✗ style.json failed spec validation:\n${err.message}`);
    process.exit(1);
  }

  console.log(`✓ outdoor style written to ${OUTDOOR_STYLE}`);
  console.log(`  layers: ${style.layers.length}`);
  console.log(`  sources: ${Object.keys(style.sources).length}`);
}

// ═════════════════════════════════════════════════════════════════════════
// CLI — one-shot build
// ═════════════════════════════════════════════════════════════════════════

await build();
