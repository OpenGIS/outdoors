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
 * config-driven outdoor-POI overlay. The basemap's own sources, glyphs and
 * sprite pass through untouched, since the published basemap is already
 * fully rewritten (glyphs & sprite point at www.ogis.org/basemap, tiles at
 * tiles.openfreemap.org/planet). Attribution is not passed through: the
 * build owns every attribution string — see the ATTRIBUTION config below.
 *
 * Later slices add the remaining outdoor mutations (paths, routes, POIs, …)
 * inside applyModifications().
 *
 * Cache: the downloaded basemap style is cached in .cache/basemap.json, with
 * the response ETag in .cache/basemap-etag.txt; the default sprite sheet is
 * cached the same way in .cache/basemap-sprite.json + -etag.txt. Cache
 * invalidation uses the HTTP ETag — see fetchBasemap() and fetchSpriteKeys().
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

// Default basemap sprite — fetched at build time so the basemap-POI icon
// expressions can identity-match the names the sheet actually contains,
// without a runtime ["image", …] probe (which raises styleimagemissing for
// names the sheet lacks). Same ETag-cache pattern as the style and
// scripts/check-poi-coverage.mjs.
const SPRITE_URL = "https://www.ogis.org/basemap/sprite.json";
const SPRITE_CACHE_FILE = resolve(CACHE_DIR, "basemap-sprite.json");
const SPRITE_CACHE_META_FILE = resolve(CACHE_DIR, "basemap-sprite-etag.txt");

// Root style identity — written into the generated style.json as the
// top-level `name` property (see the style spec's Root section). The
// published basemap carries its own name ("Basemap"); it is overridden here.
const STYLE_NAME = "Outdoors";

// ═════════════════════════════════════════════════════════════════════════
// ATTRIBUTION — single source of truth for every attribution string
// ═════════════════════════════════════════════════════════════════════════
// The build owns all attribution text; no other literal lives elsewhere.
// Entries are defined in rendered order: the basemap (OpenFreeMap/OSM) group
// first, Mapterhorn next, then MapLibre, Esri last. The pseudo-source
// attributions are still needed individually for licence compliance and for
// third-party style consumers (the style spec exposes them per source), but
// the per-map AttributionControl should show one seamless line: apps pass the
// composed `LINE` below as `customAttribution`. Because the line contains
// every source attribution verbatim, maplibre-gl v5's substring dedupe
// collapses each per-source entry into it, so the control renders exactly
// this one string — no `|` separators. No space separates an emoji from its
// label because the emoji glyph carries its own trailing advance, and a
// literal space on top would render as a doubled gap.
const ATTRIBUTION = {
  // Basemap vector tiles (OpenFreeMap / OpenMapTiles / OpenStreetMap).
  // Applied to the live `openmaptiles` source and to the basemap's
  // `attribution` pseudo-source (a licence requirement) so they cannot drift.
  BASEMAP:
    '❤️ <a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> ©️ <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> ❤️©️ <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  // Mapterhorn terrain raster-dem — see the DEM config section.
  MAPTERHORN: '©️ <a href="https://mapterhorn.com/attribution">Mapterhorn</a>',
  // MapLibre GL JS itself. Not attached to any source; the app's maps add it
  // via the control's `customAttribution`.
  MAPLIBRE: '❤️ <a href="https://maplibre.org/" target="_blank">MapLibre</a>',
  // Esri World Imagery raster ground — see the SATELLITE config section.
  ESRI: '©️ <a href="https://www.esri.com" target="_blank">Esri</a>',
};

// The single rendered line: every fragment joined by one space. Written into
// the style metadata as `attributionLine` and used by apps/harness as the
// control's `customAttribution`.
ATTRIBUTION.LINE = [
  ATTRIBUTION.BASEMAP,
  ATTRIBUTION.MAPTERHORN,
  ATTRIBUTION.MAPLIBRE,
  ATTRIBUTION.ESRI,
].join(" ");

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
  // Esri World Imagery raster ground beneath all vector layers.
  SATELLITE_GROUND: true,
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

  // Roads (ROAD_SURFACE_AWARE) — a strict greyscale network: near-black
  // asphalt fills ascending in lightness by tier, casings that are lighter
  // than their fills, and light-grey unpaved variants with a slightly darker
  // edge.
  ROADS: {
    MAJOR: "rgb(26, 26, 26)", // asphalt — motorway/trunk/primary (+ links)
    MEDIUM: "rgb(36, 36, 36)", // asphalt — secondary/tertiary/links
    LOCAL: "rgb(48, 48, 48)", // asphalt — minor/service/track/raceway
    CASING_MAJOR: "rgb(94, 94, 94)", // casing — lighter than the major fill
    CASING_MEDIUM: "rgb(106, 106, 106)", // casing — lighter than the medium fill
    CASING_LOCAL: "rgb(120, 120, 120)", // casing — lighter than the local fill
    CASING_UNPAVED: "rgb(118, 118, 118)", // casing — darker edge for light-grey unpaved fills
    TRACK_CASING: "rgb(92, 92, 92)", // neutral grey — low-zoom track outline
    TRACK_FILL: "rgb(112, 112, 112)", // muted core inside the track casing; decoupled from LOCAL
    UNPAVED_MAJOR: "rgb(150, 150, 150)", // unpaved motorway/trunk/primary
    UNPAVED_MEDIUM: "rgb(153, 153, 153)", // unpaved secondary/tertiary
    UNPAVED_LOCAL: "rgb(156, 156, 156)", // unpaved minor/service/track
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

// SATELLITE — Esri World Imagery raster ground, inserted directly above the
// Background canvas floor so it sits beneath every vector layer. The URL
// template is z/y/x (row before column) — the Esri MapServer convention —
// not the more common z/x/y.
const SATELLITE_SOURCE_ID = "esri-satellite";
const SATELLITE_LAYER_ID = "satellite";
const SATELLITE_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const SATELLITE_TILE_SIZE = 256;
const SATELLITE_MAXZOOM = 20;

// IMAGERY GROUND — with the satellite raster sitting beneath the vector
// stack, every large opaque fill would hide the imagery it is drawn over, so
// these base-style landuse/landcover fills and the outline strokes that
// belong to them are stripped instead. Ids are the base style's layers at
// indices 1–47 plus 59–61, grouped by intent below. The water fills stay
// (they read as a translucent palette tint — see WATER_TINT_OPACITY).
const SAT_STRIP_LANDUSE_FILLS = [
  // 1–12: large landuse fills.
  "Residential",
  "Cemetery",
  "Military",
  "Railway",
  "Garage",
  "Dam",
  "Quarry",
  "Industrial",
  "Retail",
  "Commercial",
  "Education and Health",
  "Aeroway",
];

const SAT_STRIP_LANDCOVER_FILLS = [
  // 13–18: medium-scale landcover fills.
  "Wetland (medium scale)",
  "Sand (medium scale)",
  "Grass (medium scale)",
  "Rock (medium scale)",
  "Wood (medium scale)",
  "Farmland (medium scale)",
  // 19–44: detailed landcover/landuse fills, including the pattern fills.
  "Marsh",
  "Park",
  "Stadium",
  "Pitch",
  "Garden",
  "Garden pattern",
  "Wood",
  "Tidalflat",
  "Wetland and swamp",
  "Scree",
  "Sand",
  "Recreation ground",
  "Orchard and vineyard",
  "Meadow",
  "Mangrove",
  "Heath",
  "Forest",
  "Farmland",
  "Farm",
  "Scrub",
  "Dune",
  "Beach",
  "Bare rock",
  "Allotments",
  "Landcover patterns",
  "Grass",
  // 46: glacier fill.
  "Glacier",
];

const SAT_STRIP_OUTLINE_STROKES = [
  // 45, 47 & 60: the outline strokes drawn around the stripped fills.
  "Landcover outline",
  "Glacier outline",
  "Landuse outline",
];

const SAT_STRIP_OTHER = [
  // 59 & 61: misc pattern & themed-area layers.
  "Landuse pattern",
  "Theme park",
];

// fill-opacity applied to the base water fills so the imagery shows through
// the palette tint.
const WATER_TINT_OPACITY = 0.45;

// IMAGERY LEGIBILITY — final overrides applied by applyImageryLegibility() so
// the vector overlay stays readable on the satellite ground. The contour
// opacity ramp is scaled back at the z9–13 stops (minor lines a little more
// than index) so the lines recede over the dark, busy imagery; width, colour
// and the z14 stop are untouched. Small road/street labels sit directly over
// the imagery, so their halo is widened by a fixed bump (capped at a maximum;
// layers with no halo start from a base) and any missing halo colour is
// filled with white. Town/city/peak/water label layers read fine and are
// deliberately excluded, as are font sizes.
const CONTOUR_IMAGERY_OPACITY_SCALE = 0.625; // index contours (37.5% reduction)
const CONTOUR_IMAGERY_OPACITY_SCALE_MINOR = 0.6; // minor contours (40% reduction)

const IMAGERY_LABEL_LAYERS = [
  "Road labels",
  "Tertiary road shield",
  "Secondary road shield",
  "Primary road shield",
  "Trunk road shield",
  "Highway shield",
];
const IMAGERY_LABEL_HALO_BUMP = 0.5;
const IMAGERY_LABEL_HALO_MAX = 1.8;
const IMAGERY_LABEL_HALO_BASE = 1.5;
const IMAGERY_LABEL_HALO_COLOUR = "hsl(0, 0%, 100%)";

// Buildings are outline-only over the imagery. The base Building fill layer is
// removed outright rather than re-coloured: a fully transparent fill-color
// hides its fill-outline-color too (Chrome pixel-diff confirms the outline
// pass draws nothing), so a fill layer cannot render outline-only. It is
// replaced by a dedicated line layer over the same building source-layer —
// line layers honour line-color & line-width, so the footprint outline renders
// reliably over the satellite ground at a width we control. The line layer
// sits where the base Building fill sat, directly below the transportation
// lines; Taxiway is the immediate surviving predecessor in the stripped stack.
const BUILDING_OUTLINE_LAYER_ID = "building-outline";
const BUILDING_OUTLINE_SOURCE_LAYER = "building";
const BUILDING_OUTLINE_ANCHOR = "Taxiway";
const BUILDING_OUTLINE_MINZOOM = 13;
// line-width (px) and line-color at the zoom-ramp stops (low = z13, high =
// z16). The colours replicate the base Building fill-outline-color.
const BUILDING_OUTLINE_WIDTH = { low: 0.4, high: 0.6 };
const BUILDING_OUTLINE_COLOUR = {
  low: "hsl(26, 7%, 57%)",
  high: "hsl(26, 8%, 62%)",
};

// Buildings extrude from z15 so dense urban areas gain honest 3D massing over
// the satellite ground. The source-layer carries render_height &
// render_min_height on every feature (raw height/min_height are absent), so
// the extrusion is mapped from those directly — no invented heights. Features
// missing render_height fall back to 0 and render flat. OpenMapTiles tags
// footprint outlines that duplicate building:part geometry with hide_3d, so 3D
// renderers can skip them; the layer filters on that. A per-feature
// building:colour, where present, colours the massing, otherwise a muted
// height ramp applies. The extrusion is inserted immediately before the
// outline so the roof outline draws on top.
const BUILDING_3D_LAYER_ID = "building-3d";
const BUILDING_3D_SOURCE_LAYER = "building";
const BUILDING_3D_MINZOOM = 15;
const BUILDING_3D_HIDE_PROPERTY = "hide_3d";
const BUILDING_3D_COLOUR_PROPERTY = "colour";
// Muted warm-grey height ramp: the mid stop keeps the previous flat tone, and
// the tones subtly darken with height so tall massing reads without competing
// with the imagery. This is a calibration starting point — expect to tune the
// stops against the imagery.
const BUILDING_3D_COLOUR_RAMP = [
  [0, "rgb(150, 145, 138)"],
  [10, "rgb(140, 136, 130)"],
  [30, "rgb(122, 117, 111)"],
];
const BUILDING_3D_OPACITY = 0.85;

// Top-level light shared by the 3D extrusion and (where MapLibre derives its
// illumination from it) the hillshade. A warm, high-azimuth key light gives the
// massing a soft sunlit side. anchor viewport keeps the shading locked to the
// screen as the map rotates and pitches. Calibration starting point.
const STYLE_LIGHT = {
  anchor: "viewport",
  color: "rgb(255, 250, 242)",
  intensity: 0.6,
  position: [1.3, 300, 45],
};

// Remaining man-made surfaces recede over the imagery. The opaque urban area
// fills drop to a light translucent wash; the runway/taxiway tarmac is
// desaturated toward neutral grey and faded; the rail family is lightly
// muted so it still reads but stops competing with the ground. Nothing is
// removed — outdoor infrastructure (trails, POIs) stays prominent. Opacity
// is the main lever; colours are kept except the runway's blue cast.
const IMAGERY_URBAN_FILL_OPACITY = 0.4;
const IMAGERY_URBAN_FILL_LAYERS = ["Pier", "Bridge area", "Platform area"];

// The bright, wide pedestrian road linework is the single largest white
// contributor over the imagery: the lavender fill and its dark casing are
// pulled back to neutral, low-opacity greys so the satellite ground reads
// through. The pedestrian area fill is decoupled from the shared
// IMAGERY_URBAN_FILL_OPACITY above (Pier/Bridge/Platform keep it) and given a
// cooler, lighter, more transparent wash of its own.
const IMAGERY_PEDESTRIAN_ROAD_COLOUR = "rgb(128, 128, 128)";
const IMAGERY_PEDESTRIAN_ROAD_OPACITY = 0.3;
const IMAGERY_PEDESTRIAN_ROAD_OUTLINE_OPACITY = 0.3;
const IMAGERY_PEDESTRIAN_AREA_COLOUR = "hsl(0, 0%, 88%)";
const IMAGERY_PEDESTRIAN_AREA_OPACITY = 0.25;

// The white path casing under the orange path fills. Colour and width are
// untouched; only the opacity drops so it stops reading as white linework.
const IMAGERY_PATH_OUTLINE_OPACITY = 0.3;
const IMAGERY_PATH_OUTLINE_LAYERS = [
  "Footway path outline",
  "Bridleway path outline",
  "Cycleway path outline",
  "Steps path outline",
];

// Runway/taxiway tarmac — the base hsl(234, 25%, 76%) is a blue-cast grey
// that reads too strongly over the imagery; pulled toward neutral grey.
const IMAGERY_RUNWAY_COLOUR = "hsl(234, 8%, 74%)";
const IMAGERY_RUNWAY_OPACITY = 0.45;
const IMAGERY_RUNWAY_LAYERS = ["Runway", "Taxiway"];

// Rail family — the hatchings, tunnels and bridges are included so opacity
// does not jump where a rail line crosses one.
const IMAGERY_RAIL_OPACITY = 0.8;
const IMAGERY_RAIL_LAYERS = [
  "Major rail",
  "Minor rail",
  "Major rail hatching",
  "Minor rail hatching",
  "Major rail tunnel",
  "Major rail tunnel hatching",
  "Major rail bridge",
  "Major rail bridge hatching",
  "Subway line",
];

// DEM — Mapterhorn raster-dem source, hillshade layer & 3D terrain.
// Values ported from the pre-refactor build. The raster-dem source feeds
// both the hillshade layer and the terrain. Mapterhorn serves
// Terrarium-encoded WebP tiles at 512px, but its z16 coverage has gaps
// (e.g. around Bolzano) and the resulting 404s leave the terrain
// mis-sampled — at z16 pitched views the camera and ground come out
// malformed. Declaring the source at maxzoom 15 lets MapLibre overzoom the
// complete z15 tiles instead: no 404s, consistent terrain, and visually
// indistinguishable in stills. Separately, we declare the source at 256px,
// half the served size, so the terrain mesh and hillshade texture cost less
// to build: measured ~+23% fps at pitched high-zoom views, visually
// indistinguishable in stills. The source is added when either DEM toggle
// is enabled.
const DEM_SOURCE_ID = "demSource";
const DEM_SOURCE_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const DEM_SOURCE_ENCODING = "terrarium";
const DEM_SOURCE_TILESIZE = 256;
const DEM_SOURCE_MAXZOOM = 15;

// style.terrain.exaggeration — ratio by which the terrain is exaggerated
// relative to the real world.
const TERRAIN_EXAGGERATION = 1.2;

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
// tunnel fills so their dashes read clearly. Fill and casing widths come
// from the true-scale width engine further down (see ROAD WIDTH ENGINE).
const ROAD_TUNNEL_OPACITY = 0.55; // line-opacity for tunnel fills (faded, dashes preserved)

// The basemap's road fill layers, grouped by hierarchy tier. Each tier
// carries its paved/unpaved colours, plus the tier key used by the width
// engine to pick that tier's low-zoom floor. Links join their parent tier
// (they carry the same class + surface tags); the rail layers are left to
// the basemap, while the under-construction layers are recoloured into the
// same greyscale family (see ROAD_CONSTRUCTION_FILLS).
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
  },
  medium: {
    layers: ["Secondary road", "Tertiary road"],
    paved: COLOURS.ROADS.MEDIUM,
    unpaved: COLOURS.ROADS.UNPAVED_MEDIUM,
  },
  local: {
    layers: ["Minor road", "Service road", "Raceway road"],
    paved: COLOURS.ROADS.LOCAL,
    unpaved: COLOURS.ROADS.UNPAVED_LOCAL,
  },
};

// Road casing (`* outline`) layer ids by tier, each carrying its neutral grey
// casing colour. The basemap's vivid outline hues (red motorways, green
// secondaries, …) are replaced so only the asphalt fills colour the road
// network. Road, link, tunnel & bridge outlines are all casings; the path,
// rail & water outlines are left to the basemap.
const ROAD_CASING_LAYERS = {
  major: {
    colour: COLOURS.ROADS.CASING_MAJOR,
    layers: [
      "Highway road outline",
      "Trunk road outline",
      "Primary road outline",
      "Highway link outline",
      "Trunk road link outline",
      "Primary road link outline",
      "Highway tunnel outline",
      "Trunk tunnel outline",
      "Primary tunnel outline",
      "Highway link tunnel outline",
      "Highway bridge outline",
      "Trunk bridge outline",
      "Primary bridge outline",
      "Highway link bridge outline",
    ],
  },
  medium: {
    colour: COLOURS.ROADS.CASING_MEDIUM,
    layers: [
      "Secondary road outline",
      "Tertiary road outline",
      "Secondary road link outline",
      "Secondary tunnel outline",
      "Tertiary tunnel outline",
      "Secondary bridge outline",
      "Tertiary bridge outline",
    ],
  },
  local: {
    colour: COLOURS.ROADS.CASING_LOCAL,
    layers: [
      "Minor road outline",
      "Pedestrian road outline",
      "Service road link outline",
      "Service tunnel outline",
      "Street tunnel outline",
      "Link tunnel outline",
      "Service bridge outline",
      "Street bridge outline",
      "Link bridge outline",
    ],
  },
};

// Road bridge fill layers by tier — recoloured to the same asphalt palette (and
// unpaved case) as their non-bridge counterparts; widths stay as the basemap's.
const ROAD_BRIDGE_LAYERS = {
  major: [
    "Highway bridge",
    "Trunk bridge",
    "Primary bridge",
    "Highway link bridge",
  ],
  medium: ["Secondary bridge", "Tertiary bridge"],
  local: ["Minor bridge", "Service bridge", "Link bridge"],
};

// Road tunnel fill layers by tier — recoloured to the tier asphalt colour and
// faded by ROAD_TUNNEL_OPACITY so their dashes read. Path & rail tunnels are
// styled separately.
const ROAD_TUNNEL_LAYERS = {
  major: [
    "Highway tunnel",
    "Trunk tunnel",
    "Primary tunnel",
    "Highway link tunnel",
  ],
  medium: ["Secondary tunnel", "Tertiary tunnel"],
  local: ["Minor tunnel", "Service tunnel", "Link tunnel"],
};

// Basemap road-construction layers — recoloured into the same greyscale
// family as the roads they will become. The brown/olive/red fills take the
// unpaved light grey and their outlines take the darker unpaved casing;
// widths and dashes are left untouched. Ids missing from the base style are
// skipped by setPaint.
const ROAD_CONSTRUCTION_FILLS = [
  "Secondary road under construction",
  "Primary road under construction",
  "Trunk road under construction",
  "Highway road under construction",
  "Secondary bridge under construction",
  "Primary bridge under construction",
  "Trunk bridge under construction",
  "Highway bridge under construction",
  "Secondary tunnel under construction",
  "Primary tunnel under construction",
  "Trunk tunnel under construction",
  "Highway tunnel under construction",
];
const ROAD_CONSTRUCTION_OUTLINES = [
  "Trunk tunnel under construction outline",
  "Highway tunnel under construction outline",
];

// ROAD WIDTH ENGINE — real-world metres rendered at true Web Mercator scale.
//
// At zoom z a road's on-screen width is its real width in metres scaled by
// 2^z / ROAD_METRES_TO_PX_Z0 (256 px tiles), so a 12 m motorway and a 5 m
// lane keep honest relative widths instead of the old per-tier screen-px
// ramps. True scale is unusable at the ends of the range, so three factors
// ride on top:
//   • mid-zoom boost  — below ~z14 true-scale roads are sub-pixel; z12–14 are
//     scaled up so the network stays legible through the low-zoom hand-off;
//   • high-zoom taper — above z17 true scale passes 100 px per lane and reads
//     cartoonish; z18–20 take a fraction of true scale so growth stays gentle;
//   • low-zoom floor  — a per-tier cartographic minimum below z12, roughly
//     matching the previous low-zoom appearance, where true scale collapses.
// A fill is max(floor, boosted/tapered true scale). Casings are no longer
// independent ramps: each is the fill width plus a screen-constant shoulder
// on each side, so a narrow road reads stroke-dominant (a dark core in a
// light edge) while a motorway shows only a thin light edge.
const ROAD_WIDTH_REFERENCE_LATITUDE = 48; // shot set spans 43°–54°N, ±7%
const ROAD_METRES_TO_PX_Z0 =
  78271.5 * Math.cos((ROAD_WIDTH_REFERENCE_LATITUDE * Math.PI) / 180); // ≈ 52374 m per px at z0
const ROAD_UNPAVED_WIDTH_SCALE = 0.8; // gravel/earth lanes are narrower
const ROAD_UNPAVED_COND = ["==", ["get", "surface"], "unpaved"];

// Layer-id keyword → real width in metres. First match wins, so the order is
// significant: "service" is tested before "link" (so "Service road link
// outline" reads as a service road) and "link" before the class keywords (so
// every major/medium link layer — motorway slip roads and ramps — takes the
// ramp width, not its parent class's mainline width). Casing ids ("… outline")
// resolve against their base layer. Across the current layer families every
// id resolves: motorway 12, trunk 9.5, primary 8, secondary 7.5, tertiary 6.5,
// raceway 6, minor 5, service 4, links/ramps 5.5, the bare Link/Street bridge
// & tunnel family 4 (see ROAD_WIDTH_OVERRIDES), and the outdoor-paths-track
// overlay 3.5. "Pedestrian road outline" is exempt and keeps its basemap width.
const ROAD_TRACK_WIDTH_METRES = 3.5; // hosted low-zoom track overlay
const ROAD_WIDTH_KEYWORDS = [
  ["outdoor-paths-track", ROAD_TRACK_WIDTH_METRES],
  ["service", 4], // before "link": a service-road link stays a service road
  ["link", 5.5], // ramps & link roads — before the class keywords
  ["highway", 12], // motorway
  ["trunk", 9.5],
  ["primary", 8],
  ["secondary", 7.5],
  ["tertiary", 6.5],
  ["minor", 5],
  ["raceway", 6],
];

// Basemap "Link"/"Street" bridge & tunnel ids the keyword table cannot place
// consistently: they carry no class keyword, and "Street … outline" has no
// base layer below it. Pinned to the service width so a fill and its casing
// can never disagree.
const ROAD_WIDTH_OVERRIDES = {
  "Link bridge": 4,
  "Link tunnel": 4,
  "Service bridge outline": 4,
  "Street bridge outline": 4,
  "Link bridge outline": 4,
  "Service tunnel outline": 4,
  "Street tunnel outline": 4,
  "Link tunnel outline": 4,
};

// Per-tier low-zoom floor in px — a fill never renders thinner than its tier
// minimum below the true-scale regime.
const ROAD_FLOOR_STOPS = {
  major: [
    [5, 0.7],
    [9, 1.1],
    [12, 1.3],
  ],
  medium: [
    [7, 0.4],
    [9, 0.7],
    [12, 0.85],
  ],
  local: [
    [10, 0.45],
    [12, 0.6],
  ],
};

// f(z): mid-zoom boost (z12–14) and high-zoom taper (z18–20); true scale
// (×1.0) through the z15–17 mid-band.
const ROAD_WIDTH_FACTOR = {
  12: 1.5,
  13: 1.3,
  14: 1.15,
  15: 1,
  16: 1,
  17: 1,
  18: 0.8,
  19: 0.62,
  20: 0.5,
};
const ROAD_WIDTH_MIN_ZOOM = 12;
const ROAD_WIDTH_MAX_ZOOM = 20;

// Casing shoulder in px per side, deliberately screen-constant so the light
// edge keeps its weight as the fill grows. [[zoom, px], …].
const ROAD_CASING_SHOULDER_STOPS = [
  [5, 0.25],
  [9, 0.35],
  [12, 0.5],
  [15, 0.7],
  [17, 1],
  [20, 1.4],
];

// Numeric value of a zoom stop list at an arbitrary zoom, using the same
// exponential interpolation MapLibre applies between stops.
function stopValueAt(stops, exponent, z) {
  const first = stops[0];
  if (z <= first[0]) return first[1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [z0, v0] = stops[i];
    const [z1, v1] = stops[i + 1];
    if (z >= z0 && z <= z1) {
      const t = (exponent ** (z - z0) - 1) / (exponent ** (z1 - z0) - 1);
      return v0 + (v1 - v0) * t;
    }
  }
  return stops[stops.length - 1][1];
}

function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// Resolve a road layer id to its real width in metres. Casing ids ("… outline")
// resolve against their base layer; overrides win before the keyword scan.
function roadWidthMetres(id) {
  if (Object.prototype.hasOwnProperty.call(ROAD_WIDTH_OVERRIDES, id)) {
    return ROAD_WIDTH_OVERRIDES[id];
  }
  const base = id.endsWith(" outline") ? id.slice(0, -" outline".length) : id;
  const lower = base.toLowerCase();
  for (const [keyword, metres] of ROAD_WIDTH_KEYWORDS) {
    if (lower.includes(keyword)) return metres;
  }
  throw new Error(`No road width keyword matched layer id "${id}"`);
}

// Boosted/tapered true scale in px at an integer zoom; 0 outside the engine's
// z12–20 range so the tier floor governs below z12.
function roadTrueScalePx(metres, z) {
  if (z < ROAD_WIDTH_MIN_ZOOM || z > ROAD_WIDTH_MAX_ZOOM) return 0;
  return (metres * 2 ** z * ROAD_WIDTH_FACTOR[z]) / ROAD_METRES_TO_PX_Z0;
}

function roadFloorPx(tier, z) {
  return stopValueAt(ROAD_FLOOR_STOPS[tier], 1.4, z);
}

function roadShoulderPx(z) {
  return stopValueAt(ROAD_CASING_SHOULDER_STOPS, 1.2, z);
}

// Merge [zoom, value] stop lists (or bare zoom numbers) into one sorted list.
function roadZoomStops(...stopSets) {
  const zooms = new Set();
  for (const stops of stopSets) {
    for (const stop of stops) {
      zooms.add(Array.isArray(stop) ? stop[0] : stop);
    }
  }
  return [...zooms].sort((a, b) => a - b);
}

// Every integer zoom the true-scale engine defines.
function roadIntegerStops() {
  const stops = [];
  for (let z = ROAD_WIDTH_MIN_ZOOM; z <= ROAD_WIDTH_MAX_ZOOM; z++)
    stops.push(z);
  return stops;
}

// Fill width: max(tier floor, boosted/tapered true scale), with unpaved ways
// taking ROAD_UNPAVED_WIDTH_SCALE of the metric branch. The floor is a shared
// cartographic minimum and does not scale with surface. The style spec allows
// only one zoom-based subexpression per width, so the max envelope is resolved
// numerically at each stop rather than nested as a ["max", …] of two zoom
// interpolates (which fails validation).
function roadWidthExpr(metres, tier) {
  const zooms = roadZoomStops(ROAD_FLOOR_STOPS[tier], roadIntegerStops());
  const expr = ["interpolate", ["exponential", 2], ["zoom"]];
  for (const z of zooms) {
    const floor = roadFloorPx(tier, z);
    const trueScale = roadTrueScalePx(metres, z);
    expr.push(z, [
      "case",
      ROAD_UNPAVED_COND,
      roundTo(Math.max(floor, trueScale * ROAD_UNPAVED_WIDTH_SCALE), 3),
      roundTo(Math.max(floor, trueScale), 3),
    ]);
  }
  return expr;
}

// Casing width: the fill plus a shoulder sliver on each side, resolved on the
// union of the fill and shoulder stops.
function roadCasingWidthExpr(metres, tier) {
  const zooms = roadZoomStops(
    ROAD_FLOOR_STOPS[tier],
    ROAD_CASING_SHOULDER_STOPS,
    roadIntegerStops(),
  );
  const expr = ["interpolate", ["exponential", 2], ["zoom"]];
  for (const z of zooms) {
    const floor = roadFloorPx(tier, z);
    const trueScale = roadTrueScalePx(metres, z);
    const shoulder = 2 * roadShoulderPx(z);
    expr.push(z, [
      "case",
      ROAD_UNPAVED_COND,
      roundTo(
        Math.max(floor, trueScale * ROAD_UNPAVED_WIDTH_SCALE) + shoulder,
        3,
      ),
      roundTo(Math.max(floor, trueScale) + shoulder, 3),
    ]);
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
// Track fill & casing widths come from the road width engine (3.5 m, local
// floor) so the overlay tracks match the basemap's local-road rendering.

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
const OUTDOOR_SPRITE_ICONS = [
  // Outdoor-POI overlay (poi-config.mjs).
  "trailhead",
  "pass",
  "dot",
  "park",
  "skiing",
  // Curated basemap-POI glyphs — see BASEMAP_POI_ICON_REMAP below. Every entry
  // MUST exist as an SVG in icons/ and in EXPECTED_ICONS in
  // scripts/build-sprite.mjs, and be referenced somewhere below, or the
  // coverage check's orphan assertion fails.
  "soccer",
  "basketball",
  "tennis",
  "volleyball",
  "baseball",
  "bowls",
  "swimming_pool",
  "running",
  "skateboard",
  "garden",
  "stadium",
  "sports_centre",
  "route_marker",
  "trail_blaze",
  "ruins",
];
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

// Basemap-POI icon remap — the basemap's own POI symbol layers (Shop, Waste,
// Outdoor, Sport, Food, Public, Cultural, Transport, Health, Accommodation,
// Place of worship, Bus station, Zoo) use dynamic icon templates such as
// "{subclass}". At urban zooms many resolved names are absent from the
// basemap sprite sheet, producing runtime `styleimagemissing` warnings and no
// icon.
//
// applyBasemapPoiIcons() replaces each template with a single match:
//
//   ["match", ["get", "<key>"],
//      ...curated OSM value → icon pairs,  // bespoke glyphs win
//      ...identity pairs,                  // every default-sheet name → itself
//      "outdoors:dot"]
//
// Every output therefore names an icon that is loaded: curated pairs map to
// bespoke outdoors glyphs or near-miss default-sheet literals, identity pairs
// (built from the fetched default sprite's keys, minus the curated inputs)
// map a value to the identically named sprite icon, and the fallback is the
// neutral outdoors generic. No ["image", …] probe is used — MapLibre fires
// styleimagemissing for any probe whose name is absent, so matching against
// the real key list is the only zero-warning approach. Only
// BASEMAP_POI_ICON_REMAP is hand-maintained; the identity pairs are derived.
const BASEMAP_POI_ICON_REMAP = {
  // Recreation & sport — curated outdoors glyphs. Visually similar variants
  // share one glyph (e.g. table_tennis with tennis, beachvolleyball with
  // volleyball, softball with baseball, bmx with skateboard, fistball with
  // sports_centre).
  soccer: outdoorIcon("soccer"),
  "soccer;basketball": outdoorIcon("soccer"), // literal compound subclass
  basketball: outdoorIcon("basketball"),
  tennis: outdoorIcon("tennis"),
  table_tennis: outdoorIcon("tennis"),
  volleyball: outdoorIcon("volleyball"),
  beachvolleyball: outdoorIcon("volleyball"),
  baseball: outdoorIcon("baseball"),
  softball: outdoorIcon("baseball"),
  bowls: outdoorIcon("bowls"),
  multi: outdoorIcon("sports_centre"),
  gaelic_games: outdoorIcon("sports_centre"),
  fistball: outdoorIcon("sports_centre"),
  pitch: outdoorIcon("sports_centre"),
  skateboard: outdoorIcon("skateboard"),
  bmx: outdoorIcon("skateboard"),
  running: outdoorIcon("running"),
  swimming_pool: outdoorIcon("swimming_pool"),
  sports_centre: outdoorIcon("sports_centre"),
  stadium: outdoorIcon("stadium"),
  // Nature & outdoor heritage.
  garden: outdoorIcon("garden"),
  route_marker: outdoorIcon("route_marker"),
  trail_blaze: outdoorIcon("trail_blaze"),
  ruins: outdoorIcon("ruins"),
  // Near-miss literals that DO exist in the basemap sheet.
  fire_station: "firestation",
  wine: "alcohol",
  beer: "biergarten",
  art_gallery: "gallery",
  post: "post_office",
  information: "board",
  lodging: "bed",
  bus: "bus_station",
  stele: "monument",
  // Non-outdoor names with no good match — the neutral generic.
  chess: outdoorIcon("dot"),
  dormitory: outdoorIcon("dot"),
  zoo: outdoorIcon("dot"),
};

/**
 * Flatten the curated label→icon pairs for the basemap-POI icon matches.
 * Only values the basemap sprite is known to lack (or that warrant a bespoke
 * outdoors glyph) belong in BASEMAP_POI_ICON_REMAP; every other default-sheet
 * name is handled by an identity pair — see basemapPoiIdentityNames().
 */
const BASEMAP_POI_ICON_MATCH_PAIRS = Object.entries(
  BASEMAP_POI_ICON_REMAP,
).flat();

/**
 * The default-sprite names that get an identity pair (name → same name) in
 * every basemap-POI icon match: every fetched key except the curated inputs,
 * which keep precedence. Derived at build time — no hand-maintained list.
 */
function basemapPoiIdentityNames(spriteKeys) {
  const curatedInputs = new Set(Object.keys(BASEMAP_POI_ICON_REMAP));
  return spriteKeys.filter((name) => !curatedInputs.has(name));
}

/**
 * The icon-image expression that replaces a basemap "{class}" / "{subclass}"
 * template. See BASEMAP_POI_ICON_REMAP for the technique: a single match over
 * the source key whose curated pairs take precedence, followed by identity
 * pairs for every remaining default-sprite name, landing on `fallback` (the
 * neutral "outdoors:dot" generic by default). Every possible output therefore
 * exists in a loaded sheet, so no resolved value can raise styleimagemissing.
 */
function basemapPoiIconExpression(
  sourceKey,
  spriteKeys = [],
  fallback = outdoorIcon("dot"),
) {
  return [
    "match",
    ["get", sourceKey],
    ...BASEMAP_POI_ICON_MATCH_PAIRS,
    ...basemapPoiIdentityNames(spriteKeys).flatMap((name) => [name, name]),
    fallback,
  ];
}

// Elevation in the label — showEle kinds carry ele from the tiles, rendered
// as "{name} {ele}m" like the peak labels. number-format(round(ele))
// mirrors the contour-label approach (to-string would print raw decimals).
const POI_ELE_KINDS = OUTDOOR_POI.kinds
  .filter((k) => k.showEle)
  .map((k) => k.kind);

// Symbol-sort-key — a match over kind → priority, mirroring the basemap's
// rank-as-sort-key convention: its POI layers (Zoo, Attraction, Campsite,
// Accommodation, Waste, Ferry) use ["to-number",["get","rank"]] with feature
// rank 20–2000, lower = placed first = wins collisions. Our priorities use
// the same convention — 10 (outdoor identity) beats 50 (parking, information)
// when icons collide. Derived from OUTDOOR_POI.kinds so it can never drift
// from the config. The 50 fallback covers any unmatched kind, so unknown
// kinds lose; it never fires because the filter only admits configured kinds.
const POI_SORT_KEY_MATCH = [
  "match",
  ["get", "kind"],
  ...OUTDOOR_POI.kinds.flatMap((k) => [k.kind, k.priority]),
  50,
];
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

// Symbol-sort-key for the planet amenities — derived from PLANET_POI.kinds
// like the outdoor-poi key, but at 1000 rather than the urban tier (50): the
// basemap's POI layers sort by feature rank 20–2000 (lower = placed first),
// so a 50 would let doctors/bank/bicycle_rental outrank nearly every basemap
// POI they collide with. 1000 keeps basemap POIs first — our amenities win
// only against the least-important ranks (≥1000). See the priority comment in
// poi-config.mjs.
const PLANET_POI_SORT_KEY_MATCH = [
  "match",
  ["get", "class"],
  ...PLANET_POI.kinds.flatMap((k) => [k.class, k.priority]),
  1000,
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
 * Override a layout property on a layer, matched by exact id. Layers missing
 * from the base style are skipped silently so the build stays robust against
 * upstream renames.
 */
function setLayout(style, id, layoutKey, value) {
  const layer = style.layers.find((l) => l.id === id);
  if (!layer) return;
  layer.layout = layer.layout || {};
  layer.layout[layoutKey] = value;
}

/**
 * Remove layers from the style, matched by exact id. Ids missing from the
 * base style are skipped silently so the build stays robust against upstream
 * renames. Returns the number of layers actually removed.
 */
function removeLayers(style, ids) {
  const strip = new Set(ids);
  const before = style.layers.length;
  style.layers = style.layers.filter((l) => !strip.has(l.id));
  return before - style.layers.length;
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
 * line layer and the contour elevation labels. The satellite-ground slice
 * adds the Esri World Imagery raster beneath all vector layers. Each is gated
 * by its FEATURES toggle. Later slices add the remaining outdoor sections
 * (paths, routes, POIs, …) here, mutating `style` in place and returning it.
 */
function applyModifications(style, spriteKeys = []) {
  // Ground raster first, so it sits beneath every vector layer.
  if (FEATURES.SATELLITE_GROUND) applySatelliteGround(style);
  // Then clear the opaque fills that would hide it, before the palettes run.
  if (FEATURES.SATELLITE_GROUND) applyImageryGround(style);
  if (FEATURES.TERRAIN_PALETTE) applyTerrainPalette(style);
  if (FEATURES.WATER_PALETTE) applyWaterPalette(style);
  if (FEATURES.PARK_DIFFERENTIATION) applyParkDifferentiation(style);
  if (FEATURES.DEM_HILLSHADE || FEATURES.DEM_TERRAIN) applyDemSource(style);
  if (FEATURES.DEM_HILLSHADE) applyDemHillshade(style);
  if (FEATURES.DEM_TERRAIN) applyDemTerrain(style);
  if (FEATURES.CONTOURS) applyContours(style);
  if (FEATURES.CONTOURS) applyContourLabels(style);
  // Always: swap the basemap's dynamic POI icon templates for expressions
  // that can never resolve to a name the sprite lacks. Independent of the
  // outdoor overlay, like the always-on sprite wiring in build().
  applyBasemapPoiIcons(style, spriteKeys);
  if (FEATURES.OUTDOOR_POI) applyOutdoorPoi(style);
  if (FEATURES.ROAD_SURFACE_AWARE) applyRoadSurfaceAware(style);
  if (FEATURES.LOW_ZOOM_PATHS) applyLowZoomPaths(style);
  if (FEATURES.PATH_STYLING) applyPathStyling(style);
  // Last, so its overrides beat the contour & road/path styling above.
  if (FEATURES.SATELLITE_GROUND) applyImageryLegibility(style);
  return style;
}

/**
 * Add the Esri World Imagery raster source and a ground layer directly above
 * the Background canvas floor, so satellite imagery sits beneath every vector
 * layer. Uses the default raster opacity — no paint overrides. Gated by
 * SATELLITE_GROUND.
 */
function applySatelliteGround(style) {
  if (!style.sources[SATELLITE_SOURCE_ID]) {
    style.sources[SATELLITE_SOURCE_ID] = {
      type: "raster",
      tiles: [SATELLITE_TILE_URL],
      tileSize: SATELLITE_TILE_SIZE,
      maxzoom: SATELLITE_MAXZOOM,
      attribution: ATTRIBUTION.ESRI,
    };
  }

  const layer = {
    id: SATELLITE_LAYER_ID,
    type: "raster",
    source: SATELLITE_SOURCE_ID,
    minzoom: 0,
  };
  insertAfter(style, layer, "Background");
}

/**
 * Let the satellite ground read through: strip the large-area opaque
 * landuse/landcover fills and their outline strokes (see the SAT_STRIP_*
 * config), and make the water fills translucent. Layer ids are matched
 * exactly and missing layers are skipped silently. Gated by SATELLITE_GROUND;
 * a no-op when it is off.
 */
function applyImageryGround(style) {
  const removed = removeLayers(style, [
    ...SAT_STRIP_LANDUSE_FILLS,
    ...SAT_STRIP_LANDCOVER_FILLS,
    ...SAT_STRIP_OUTLINE_STROKES,
    ...SAT_STRIP_OTHER,
  ]);
  console.log(`[build] imagery ground: removed ${removed} opaque layers`);

  // Translucent water so the imagery shows through the palette tint. The
  // intermittent fill's own fill-opacity is overridden in the process.
  setPaint(style, "Water", "fill-opacity", WATER_TINT_OPACITY);
  setPaint(style, "Water intermittent", "fill-opacity", WATER_TINT_OPACITY);
}

/**
 * Final legibility pass over the satellite ground: recede the contour lines
 * at z9–13, widen the halo on the small road/street label layers, tone down
 * the remaining man-made surfaces (translucent urban fills, faded pedestrian
 * road/area linework and path casings, desaturated & faded runway/taxiway
 * tarmac, lightly muted rails — see the IMAGERY_* and BUILDING_* config),
 * replace the base Building fill with the outline line
 * layer and add the 3D building extrusion. Runs last in
 * applyModifications() — after the contours and the road/path styling — so
 * its setPaint overrides win. Gated by SATELLITE_GROUND; a no-op when it is
 * off.
 */
function applyImageryLegibility(style) {
  // Scale the contour opacity ramp's low (z9) and mid (z13) stops; the z14
  // stop, the widths, the colours and contour labels are left as built. The
  // expression keeps the same zoom stops and the same contourCase() cadence.
  setPaint(style, "contour-lines", "line-opacity", [
    "interpolate",
    ["linear"],
    ["zoom"],
    CONTOUR_SOURCE_MINZOOM,
    contourCase(
      CONTOUR_OPACITY_INDEX.low * CONTOUR_IMAGERY_OPACITY_SCALE,
      CONTOUR_OPACITY_MINOR.low * CONTOUR_IMAGERY_OPACITY_SCALE_MINOR,
    ),
    CONTOUR_MID_ZOOM,
    contourCase(
      CONTOUR_OPACITY_INDEX.mid * CONTOUR_IMAGERY_OPACITY_SCALE,
      CONTOUR_OPACITY_MINOR.mid * CONTOUR_IMAGERY_OPACITY_SCALE_MINOR,
    ),
    CONTOUR_SOURCE_MAXZOOM,
    contourCase(CONTOUR_OPACITY_INDEX.high, CONTOUR_OPACITY_MINOR.high),
  ]);

  // Buildings outline-only: drop the base fill, then add the dedicated line
  // layer in its slot below the transportation lines. The fill is removed
  // rather than made transparent because a transparent fill hides its own
  // fill-outline-color (see the BUILDING_OUTLINE_* config).
  removeLayers(style, ["Building"]);
  const buildingOutline = {
    id: BUILDING_OUTLINE_LAYER_ID,
    type: "line",
    source: "openmaptiles",
    "source-layer": BUILDING_OUTLINE_SOURCE_LAYER,
    minzoom: BUILDING_OUTLINE_MINZOOM,
    paint: {
      "line-color": [
        "interpolate",
        ["linear"],
        ["zoom"],
        BUILDING_OUTLINE_MINZOOM,
        BUILDING_OUTLINE_COLOUR.low,
        16,
        BUILDING_OUTLINE_COLOUR.high,
      ],
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        BUILDING_OUTLINE_MINZOOM,
        BUILDING_OUTLINE_WIDTH.low,
        16,
        BUILDING_OUTLINE_WIDTH.high,
      ],
      "line-opacity": 1,
    },
  };
  if (!insertAfter(style, buildingOutline, BUILDING_OUTLINE_ANCHOR)) {
    console.warn(
      `[build] building outline: anchor "${BUILDING_OUTLINE_ANCHOR}" not found`,
    );
  }

  // Set the top-level light once so the 3D massing is shaded consistently;
  // MapLibre may also derive hillshade illumination from it. See STYLE_LIGHT.
  style.light = STYLE_LIGHT;

  // 3D massing sits immediately beneath the outline so the roof outline draws
  // on top of the extrusion. Heights come straight from the source-layer; no
  // invented heights, and features without one render flat.
  const building3d = {
    id: BUILDING_3D_LAYER_ID,
    type: "fill-extrusion",
    source: "openmaptiles",
    "source-layer": BUILDING_3D_SOURCE_LAYER,
    minzoom: BUILDING_3D_MINZOOM,
    // hide_3d footprints duplicate building:part geometry; a missing property
    // yields null ≠ true, so ordinary footprints are kept.
    filter: ["!=", ["get", BUILDING_3D_HIDE_PROPERTY], true],
    paint: {
      "fill-extrusion-color": [
        "case",
        ["has", BUILDING_3D_COLOUR_PROPERTY],
        ["get", BUILDING_3D_COLOUR_PROPERTY],
        [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "render_height"], 0],
          ...BUILDING_3D_COLOUR_RAMP.flat(),
        ],
      ],
      "fill-extrusion-height": ["get", "render_height"],
      "fill-extrusion-base": ["get", "render_min_height"],
      "fill-extrusion-opacity": BUILDING_3D_OPACITY,
    },
  };
  if (!insertBefore(style, building3d, BUILDING_OUTLINE_LAYER_ID)) {
    console.warn(
      `[build] building 3d: anchor "${BUILDING_OUTLINE_LAYER_ID}" not found`,
    );
  }

  for (const id of IMAGERY_LABEL_LAYERS) {
    const layer = style.layers.find((l) => l.id === id);
    if (!layer) continue;
    layer.paint = layer.paint || {};
    const halo = layer.paint["text-halo-width"];
    layer.paint["text-halo-width"] =
      typeof halo === "number"
        ? Math.min(IMAGERY_LABEL_HALO_MAX, halo + IMAGERY_LABEL_HALO_BUMP)
        : IMAGERY_LABEL_HALO_BASE;
    // Only fill in a halo colour where the basemap omits one; otherwise the
    // layer's own colour is left untouched.
    if (!layer.paint["text-halo-color"]) {
      layer.paint["text-halo-color"] = IMAGERY_LABEL_HALO_COLOUR;
    }
  }

  // Remaining man-made surfaces sit lightly over the satellite ground:
  // translucent urban area fills, the faded pedestrian road/area linework and
  // path casings, desaturated & faded runway/taxiway tarmac and lightly muted
  // rails. Nothing is removed; outdoor infrastructure (trails, POIs) is
  // untouched.
  for (const id of IMAGERY_URBAN_FILL_LAYERS) {
    setPaint(style, id, "fill-opacity", IMAGERY_URBAN_FILL_OPACITY);
  }
  setPaint(
    style,
    "Pedestrian area",
    "fill-color",
    IMAGERY_PEDESTRIAN_AREA_COLOUR,
  );
  setPaint(
    style,
    "Pedestrian area",
    "fill-opacity",
    IMAGERY_PEDESTRIAN_AREA_OPACITY,
  );
  setPaint(
    style,
    "Pedestrian road",
    "line-color",
    IMAGERY_PEDESTRIAN_ROAD_COLOUR,
  );
  setPaint(
    style,
    "Pedestrian road",
    "line-opacity",
    IMAGERY_PEDESTRIAN_ROAD_OPACITY,
  );
  setPaint(
    style,
    "Pedestrian road outline",
    "line-opacity",
    IMAGERY_PEDESTRIAN_ROAD_OUTLINE_OPACITY,
  );
  for (const id of IMAGERY_PATH_OUTLINE_LAYERS) {
    setPaint(style, id, "line-opacity", IMAGERY_PATH_OUTLINE_OPACITY);
  }
  for (const id of IMAGERY_RUNWAY_LAYERS) {
    setPaint(style, id, "line-color", IMAGERY_RUNWAY_COLOUR);
    setPaint(style, id, "line-opacity", IMAGERY_RUNWAY_OPACITY);
  }
  for (const id of IMAGERY_RAIL_LAYERS) {
    setPaint(style, id, "line-opacity", IMAGERY_RAIL_OPACITY);
  }
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
    attribution: ATTRIBUTION.MAPTERHORN,
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
 * surface tag. Each tier's fill layers get a surface-aware line-colour and a
 * true-scale line-width from the road width engine, with a solid
 * line-dasharray pinned so no basemap dash value can leak through. The
 * basemap's vivid casing outlines, bridge fills and tunnel fills are brought
 * into the same greyscale palette — casings become neutral greys lighter than
 * their fills (or the darker unpaved edge on unpaved ways) and take the fill
 * width plus a shoulder sliver on each side, bridges mirror their tier fills
 * and tunnels keep their dashes faded by ROAD_TUNNEL_OPACITY. The
 * under-construction fills and outlines are recoloured into that same
 * greyscale family (widths & dashes unchanged). Rail & path rendering is left
 * alone. Gated by ROAD_SURFACE_AWARE.
 */
function applyRoadSurfaceAware(style) {
  const unpaved = ROAD_UNPAVED_COND;

  for (const [tier, config] of Object.entries(ROAD_TIERS)) {
    for (const id of config.layers) {
      const layer = style.layers.find((l) => l.id === id);
      if (!layer) continue;
      layer.paint = layer.paint || {};
      layer.paint["line-color"] = [
        "case",
        unpaved,
        config.unpaved,
        config.paved,
      ];
      layer.paint["line-width"] = roadWidthExpr(roadWidthMetres(id), tier);
      // Unpaved ways no longer dash: pin a constant solid dasharray so no
      // basemap dash value can leak through.
      layer.paint["line-dasharray"] = ["literal", [1]];
      layer.layout = layer.layout || {};
      // BUTT cap retained from the dashed rendering so line ends stay flush.
      layer.layout["line-cap"] = "butt";
      layer.layout["line-join"] = "round";
    }
  }

  // Casings — neutral grey line-colour, with unpaved ways taking the slightly
  // darker edge, and the fill width plus a shoulder sliver on each side so the
  // light edge frames the asphalt core. Pedestrian outline is exempt and keeps
  // its basemap width.
  for (const [tier, { colour, layers }] of Object.entries(ROAD_CASING_LAYERS)) {
    for (const id of layers) {
      setPaint(style, id, "line-color", [
        "case",
        unpaved,
        COLOURS.ROADS.CASING_UNPAVED,
        colour,
      ]);
      if (id === "Pedestrian road outline") continue;
      setPaint(
        style,
        id,
        "line-width",
        roadCasingWidthExpr(roadWidthMetres(id), tier),
      );
    }
  }

  // Bridge fills — the same greyscale palette & unpaved case as the road
  // fills, with the engine's true-scale widths.
  for (const [tier, ids] of Object.entries(ROAD_BRIDGE_LAYERS)) {
    for (const id of ids) {
      setPaint(style, id, "line-color", [
        "case",
        unpaved,
        ROAD_TIERS[tier].unpaved,
        ROAD_TIERS[tier].paved,
      ]);
      setPaint(
        style,
        id,
        "line-width",
        roadWidthExpr(roadWidthMetres(id), tier),
      );
    }
  }

  // Tunnel fills — tier asphalt colour, faded so the dashes read, with the
  // engine's true-scale widths.
  for (const [tier, ids] of Object.entries(ROAD_TUNNEL_LAYERS)) {
    for (const id of ids) {
      setPaint(style, id, "line-color", ROAD_TIERS[tier].paved);
      setPaint(style, id, "line-opacity", ROAD_TUNNEL_OPACITY);
      setPaint(
        style,
        id,
        "line-width",
        roadWidthExpr(roadWidthMetres(id), tier),
      );
    }
  }

  // Under-construction roads — the basemap's brown/olive/red fills and their
  // outlines are brought into the greyscale family; widths & dashes stay.
  for (const id of ROAD_CONSTRUCTION_FILLS) {
    setPaint(style, id, "line-color", COLOURS.ROADS.UNPAVED_MAJOR);
  }
  for (const id of ROAD_CONSTRUCTION_OUTLINES) {
    setPaint(style, id, "line-color", COLOURS.ROADS.CASING_UNPAVED);
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
      "line-width": roadCasingWidthExpr(ROAD_TRACK_WIDTH_METRES, "local"),
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
      "line-color": COLOURS.ROADS.TRACK_FILL,
      "line-width": roadWidthExpr(ROAD_TRACK_WIDTH_METRES, "local"),
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

// Matches a bare "{class}" / "{subclass}" token-template icon name in the
// basemap's POI layers. These are resolved at render time by substring
// substitution, so a name the sprite lacks raises styleimagemissing.
const TOKEN_ICON_RE = /^\{([a-z_]+)\}$/;

/**
 * Rewrite the basemap's dynamic POI icon-image templates so every name they
 * can resolve to is guaranteed to live in a loaded sprite. Scans every layer
 * for a "{class}" / "{subclass}" token (Waste, Outdoor, Sport, Food, Public,
 * Cultural, Transport, Health, Accommodation, Place of worship, Bus station,
 * Zoo, …) and replaces it with a match — see basemapPoiIconExpression().
 * The Shop layer ships its own coalesce but ends in a dead ["image", "dot"]
 * fallback ("dot" is not in the basemap sheet), so it is rewritten too,
 * keeping its subclass → class precedence. Also neutralises legacy {stops}
 * icon functions whose high-zoom stop is whitespace (City labels' " "), which
 * would otherwise raise the same warning — empty string is the one icon value
 * maplibre-gl treats as "no image" silently. Always applied (not
 * feature-gated), matching the always-on sprite wiring in build(). `spriteKeys`
 * are the fetched default-sheet names that seed the identity pairs. Returns the
 * number of layers rewritten.
 */
function applyBasemapPoiIcons(style, spriteKeys = []) {
  const rewrites = [];

  for (const layer of style.layers) {
    const img = layer.layout?.["icon-image"];
    const match = typeof img === "string" ? TOKEN_ICON_RE.exec(img) : null;
    if (match) {
      setLayout(
        style,
        layer.id,
        "icon-image",
        basemapPoiIconExpression(match[1], spriteKeys),
      );
      rewrites.push(layer.id);
    }
  }

  // Shop: keep its subclass → class precedence, then land on a live icon.
  if (style.layers.some((l) => l.id === "Shop")) {
    setLayout(
      style,
      "Shop",
      "icon-image",
      basemapPoiIconExpression(
        "subclass",
        spriteKeys,
        basemapPoiIconExpression("class", spriteKeys),
      ),
    );
    rewrites.push("Shop");
  }

  // Legacy {stops} icon functions — blank out whitespace stops so they render
  // no image without a warning ("" resolves to null in maplibre-gl).
  for (const layer of style.layers) {
    const img = layer.layout?.["icon-image"];
    if (!img || typeof img !== "object" || !Array.isArray(img.stops)) continue;
    let changed = false;
    for (const stop of img.stops) {
      if (typeof stop[1] === "string" && !stop[1].trim()) {
        stop[1] = "";
        changed = true;
      }
    }
    if (changed) rewrites.push(layer.id);
  }

  console.log(
    `[build] basemap POI icons: rewrote ${rewrites.length} dynamic icon-image expression(s)` +
      ` (${Object.keys(BASEMAP_POI_ICON_REMAP).length} curated pairs +` +
      ` ${basemapPoiIdentityNames(spriteKeys).length} identity names)`,
  );
  return rewrites.length;
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
      "symbol-sort-key": POI_SORT_KEY_MATCH,
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
      "symbol-sort-key": PLANET_POI_SORT_KEY_MATCH,
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

/**
 * Fetch the default basemap sprite sheet's icon keys, with the same
 * ETag-cache pattern as fetchBasemap(). Used only to derive the identity pairs
 * of the basemap-POI icon matches — a missing sheet is non-fatal, because the
 * curated pairs plus the fallback are still zero-warning on their own.
 */
async function fetchSpriteKeys() {
  const headers = {};
  const cachedEtag = existsSync(SPRITE_CACHE_META_FILE)
    ? readFileSync(SPRITE_CACHE_META_FILE, "utf8").trim()
    : null;

  if (cachedEtag) {
    headers["If-None-Match"] = cachedEtag;
  }

  const cachedKeys = () =>
    Object.keys(JSON.parse(readFileSync(SPRITE_CACHE_FILE, "utf8")));

  let res;
  try {
    res = await fetch(SPRITE_URL, { headers });
  } catch (err) {
    if (existsSync(SPRITE_CACHE_FILE)) {
      console.warn(
        `[build] network error, using cached basemap sprite: ${err.message}`,
      );
      return cachedKeys();
    }
    console.warn(
      `[build] no basemap sprite available (network error, no cache) —` +
        ` proceeding without identity icon pairs`,
    );
    return [];
  }

  if (res.status === 304 && existsSync(SPRITE_CACHE_FILE)) {
    return cachedKeys();
  }

  if (!res.ok) {
    if (existsSync(SPRITE_CACHE_FILE)) {
      console.warn(
        `[build] server returned ${res.status}, using cached basemap sprite`,
      );
      return cachedKeys();
    }
    console.warn(
      `[build] no basemap sprite available (HTTP ${res.status}, no cache) —` +
        ` proceeding without identity icon pairs`,
    );
    return [];
  }

  const text = await res.text();
  const etag = res.headers.get("etag") || "";

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(SPRITE_CACHE_FILE, text, "utf8");
  writeFileSync(SPRITE_CACHE_META_FILE, etag, "utf8");

  return Object.keys(JSON.parse(text));
}

// ═════════════════════════════════════════════════════════════════════════
// Build — fetch & deep-clone the base style, write style.json
// ═════════════════════════════════════════════════════════════════════════

async function build() {
  const basemap = await fetchBasemap();
  const spriteKeys = await fetchSpriteKeys();

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

  // Attribution — the build owns all attribution text (see the ATTRIBUTION
  // config). The basemap string goes on the live `openmaptiles` source, where
  // maplibre v5 actually reads it (a style-level attribution overrides the
  // source's TileJSON), and on the basemap's `attribution` pseudo-source,
  // which references no layer but must stay for licence compliance. Both are
  // synchronised from the same string; guards skip a renamed/removed source.
  if (style.sources.openmaptiles) {
    style.sources.openmaptiles.attribution = ATTRIBUTION.BASEMAP;
  }
  if (style.sources.attribution) {
    style.sources.attribution.attribution = ATTRIBUTION.BASEMAP;
  }

  // Publish the composed single-line attribution as style metadata for apps
  // and the screenshot harness to pass to the control's `customAttribution`.
  // Merge rather than clobber so any upstream basemap metadata survives.
  style.metadata = {
    ...style.metadata,
    attributionLine: ATTRIBUTION.LINE,
  };

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

  applyModifications(style, spriteKeys);

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
