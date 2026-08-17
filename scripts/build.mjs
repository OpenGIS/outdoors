#!/usr/bin/env node

/**
 * Build the outdoor style from the Liberty base style (OpenFreeMap fork).
 *
 * Downloads the liberty style from GitHub (with local caching), applies
 * all outdoor-specific modifications, and writes to
 * style.json at the project root.
 *
 * The liberty style already has __TILEJSON_DOMAIN__ placeholders.
 * finalizeStyle() replaces them at build time so the runtime app
 * doesn't need to.
 *
 * Cache: the downloaded liberty style is cached in .cache/liberty.json.
 *
 * Approach (Slice 1 scaffold):
 *   This build builds on the Liberty base but replaces the visual layers
 *   (landcover, landuse, roads, buildings, POIs) with outdoor-first
 *   versions, while keeping Liberty's label/water/boundary/rail
 *   infrastructure.
 *
 *   Slice 1 wires up the feature toggles, colour & config constants, and
 *   the section functions. Sections that are not yet implemented are
 *   stubbed with a `// TBD: Slice N` comment; sections that already
 *   existed keep their current implementation.
 *
 * Feature toggles at the top enable/disable each section. Per-feature
 * config blocks follow in the same render order. All hosted overlay
 * sections — contours, POIs and routes — derive their tile URLs from a
 * single production endpoint, TILES_BASE_URL — which already points at
 * the production tile server (https://tile.ogis.app).
 *
 * Sections are ordered from bottom to top in the render stack:
 *  urban removal → terrain palette → road surface-aware → DEM (hillshade, terrain) →
 *  landcover (rock, farmland, subclass) → landuse (military/quarry, recreation) →
 *  park differentiation → water palette → road surface-aware → building outlines →
 *  aerialway → ferry → rail simplified → contours → POI section
 *  (peaks → park labels → replaced liberty pois) →
 *  low-zoom paths → outdoor routes → custom outdoor pois → mtb/bicycle → path styling
 *
 * All POI code — constants, the pois/catalogue.yml load, helpers and apply
 * functions — lives in ONE contiguous section near the bottom of this file
 * (see the POI SECTION block), driven by the catalogue. The non-POI sections
 * (paths, routes, mtb) render between the POI layers, so their build() calls
 * stay interleaved with the POI calls to preserve the exact layer stack.
 *
 * Dependencies:
 *   - OSM Liberty (OpenFreeMap fork): https://raw.githubusercontent.com/hyperknot/openfreemap-styles/main/styles/liberty/style.json
 *
 * Usage:
 *   node scripts/build.mjs           # one-shot build
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { validateStyle } from "./validate-style.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUTDOOR_STYLE = resolve(ROOT, "style.json");

// ═════════════════════════════════════════════════════════════════════════
// FEATURE TOGGLES (in rendering order, bottom→top)
// ═════════════════════════════════════════════════════════════════════════
// Flip these to enable/disable each feature section.

const REMOVE_URBAN_LAYERS = true;
const TERRAIN_PALETTE = true;
const DEM = true;
const DEM_HILLSHADE = true;
const DEM_TERRAIN = true;

const LANDCOVER_ROCK = true;
const LANDCOVER_FARMLAND = true;
const LANDCOVER_SUBCLASS = true;
const LANDUSE_MILITARY_QUARRY = true;
const LANDUSE_RECREATION = true;

const PARK_DIFFERENTIATION = true;
const WATER_PALETTE = true;
const ROAD_SURFACE_AWARE = true;
const BUILDING_OUTLINES = true;
const AERIALWAY = true;
const FERRY = true;
const RAIL_SIMPLIFIED = true;

const CONTOURS = true;

const PEAK_LABELS = true;
const PARK_LABELS = true;

const REPLACE_LIBERTY_POIS = true;

const LOW_ZOOM_PATHS = true;
const OUTDOOR_ROUTE = true;
const OUTDOOR_POI = true;
const MTB_SCALE = true;
const PATH_STYLING = true;

// ═════════════════════════════════════════════════════════════════════════
// LIBERTY BASE STYLE — source URL, local caching, and domain replacement
// ═════════════════════════════════════════════════════════════════════════
// The outdoor style builds on top of OSM Liberty via the OpenFreeMap fork.
// The liberty style is fetched from GitHub and cached locally — see
// fetchLiberty() below for the download-and-cache logic.
//
// The URL tracks the `main` branch. Cache invalidation uses the HTTP ETag
// from the response — a new version is auto-detected on the next build.

const LIBERTY_URL =
  "https://raw.githubusercontent.com/hyperknot/openfreemap-styles/refs/heads/main/styles/liberty/style.json";

const CACHE_DIR = resolve(__dirname, "..", ".cache");
const CACHE_FILE = resolve(CACHE_DIR, "liberty.json");
const CACHE_META_FILE = resolve(CACHE_DIR, "liberty-etag.txt");
const CACHE_PROCESSED_FILE = resolve(CACHE_DIR, "liberty-processed.json");

// Root style identity — written into the generated style.json as the
// `name` and `metadata` top-level properties (see the style spec's Root
// section). `metadata` must stay stable and free of volatile flag state.
const STYLE_NAME = "Outdoors";
const STYLE_METADATA = {};

const OFM_DOMAIN = "tiles.openfreemap.org";

// ═════════════════════════════════════════════════════════════════════════
// COLOURS — nested by feature, grouped in build/render order:
//   terrain base palette → contours → peaks → POIs → routes → MTB → paths
// Every colour literal in this file lives inside this object.
// ═════════════════════════════════════════════════════════════════════════

const COLOURS = {
  // Base terrain palette (applied by applyTerrainPalette)
  TERRAIN: {
    BACKGROUND: "hsl(47, 26%, 88%)",
    WATER: "hsl(205, 56%, 73%)",
    WATERWAY: "hsl(205, 56%, 73%)",
    GRASS: "hsl(82, 46%, 72%)",
    WOOD: "hsl(82, 46%, 72%)",
    PARK: "rgb(192, 216, 151)",
    SAND: "rgb(232, 214, 38)",
    ICE: "hsl(47, 22%, 94%)",
    RESIDENTIAL: "hsl(47, 13%, 86%)",
    BUILDINGS: "hsl(39, 41%, 86%)",
  },

  // Landcover — outdoor-first fills (applied by future slices)
  LANDCOVER: {
    ROCK: "hsl(40, 15%, 78%)", // pale taupe — bare rock, scree
    FARMLAND: "hsl(75, 35%, 88%)", // pale yellow-green — farmland
    HEATH: "hsl(60, 30%, 78%)", // muted yellow — heath/scrub
    TUNDRA: "hsl(50, 20%, 84%)", // pale warm grey — tundra
  },

  // Landuse — warning & amenity fills (applied by future slices)
  LANDUSE: {
    MILITARY: "rgba(200, 80, 80, 0.15)", // red tint — military areas
    QUARRY: "rgba(180, 150, 130, 0.2)", // brown tint — quarries
    PLAYGROUND: "hsl(90, 40%, 78%)", // light green — playgrounds
  },

  // Parks — national park vs nature reserve differentiation (future slice)
  PARK: {
    NATIONAL_PARK: "rgb(170, 210, 140)", // darker green
    NATURE_RESERVE: "rgb(192, 216, 151)", // medium green
    DEFAULT: "rgb(210, 225, 175)", // lighter green
    LABEL_TEXT: "#3d5c28", // dark green for park labels
  },

  // Roads — muted warm-taupe road palette (applied by applyRoadSurfaceAware)
  ROADS: {
    MAJOR: "rgb(228, 219, 201)", // lightest, most recessive — motorway/trunk/primary (+ motorway links)
    MEDIUM: "rgb(223, 211, 188)", // secondary/tertiary/links
    LOCAL: "rgb(255, 255, 255)", // darkest of the roads, clearly lighter than contour browns — minor/service/track/street
    CASING: "rgb(183, 168, 145)", // all non-path casing layers — darker than fills, keeps road outline crisp
    TRACK_CASING: "rgb(146, 118, 86)", // darker warm brown — track/service road outline (darker than CASING so low-zoom tracks read against land & contours)
  },

  // Buildings — stroke-only outlines (applied by future slice)
  BUILDING: {
    OUTLINE: "#333", // light warm grey outline stroke
    FILL: "rgba(0, 0, 0, 0.02)", // nearly transparent fill
  },

  // Aerialways — ski lifts, gondolas, cable cars (applied by future slice)
  AERIALWAY: {
    LINE: "hsl(330, 30%, 55%)", // muted magenta-pink
    CASING: "rgba(255, 255, 255, 0.8)", // white casing
  },

  // Ferries — shipway ferry routes (applied by future slice)
  FERRY: {
    LINE: "hsl(205, 45%, 55%)", // medium blue
  },

  // Contour lines & labels
  CONTOURS: {
    MINOR: "rgb(198, 170, 138)", // soft sand-brown — minor contour lines
    INDEX: "rgb(164, 130, 94)", // medium topo brown — index contour lines
    LABEL: "#5c4634", // dark umber — elevation labels
    HALO: "rgba(255, 255, 255, 0.5)", // semi-transparent white — label halo
  },

  // Mountain peak labels
  PEAKS: {
    TEXT: "#333333",
    HALO: "#ffffff",
    SADDLE_TEXT: "#555555",
    VOLCANO_COLOUR: "#d43838",
  },

  // Outdoor POI labels
  POI: { TEXT: "#333333", HALO: "#ffffff" },

  // Hiking route network tiers
  ROUTES: {
    IWN: "#b20303",
    NWN: "#152eec",
    RWN: "#ffa304",
    RWN_CASING: "#a76f0f",
    LWN: "#7d31c6",
    LWN_HALO: "#c19ae6",
    DEFAULT: "#b2b2b2",
  },

  // MTB scale difficulty overlay
  MTB: {
    GRADE_1: "blue",
    GRADE_2: "red",
    GRADE_3_PLUS: "black",
    BICYCLE_ACCESS: "#8c64bd",
  },

  // Paths & trails
  PATHS: { PATH: "#c05a2a" },
};

// ── Route network tier paint configs ──────────────────────────────────
// Shared by all outdoor route tiers.
// Each tier has colour, opacity, width, and minzoom.

const ROUTE_TIERS = {
  iwn: {
    color: COLOURS.ROUTES.IWN,
    opacity: 0.7,
    minzoom: 8,
    width: ["interpolate", ["linear"], ["zoom"], 8, 3, 10, 4, 12, 5],
  },
  nwn: {
    color: COLOURS.ROUTES.NWN,
    opacity: 0.7,
    minzoom: 8,
    width: ["interpolate", ["linear"], ["zoom"], 8, 2, 10, 3, 12, 4],
  },
  rwn: {
    color: COLOURS.ROUTES.RWN,
    opacity: 0.8,
    minzoom: 10,
    width: ["interpolate", ["linear"], ["zoom"], 10, 2, 12, 3],
    casing: {
      color: COLOURS.ROUTES.RWN_CASING,
      opacity: 0.35,
      width: ["interpolate", ["linear"], ["zoom"], 10, 5, 12, 7],
    },
  },
  lwn: {
    color: COLOURS.ROUTES.LWN,
    opacity: 0.8,
    minzoom: 12,
    width: 1.5,
    halo: {
      color: COLOURS.ROUTES.LWN_HALO,
      opacity: 0.4,
      width: 4,
      minzoom: 12,
    },
  },
};

const ROUTE_TIER_DEFAULT = {
  color: COLOURS.ROUTES.DEFAULT,
  opacity: 0.5,
  width: 1.0,
  minzoom: 12,
};

// ═════════════════════════════════════════════════════════════════════════
// PER-FEATURE CONFIG (in rendering order, bottom→top)
// ═════════════════════════════════════════════════════════════════════════
// Each feature's constants are grouped before its build logic below.
// All hosted overlay features (contours, routes & POIs) read their tile
// URLs from the single TILES_BASE_URL endpoint — see the self-hosted
// tiles block.

// ── Terrain palette ───────────────────────────────────────────────────
// Muted base-layer colours (see COLOURS.TERRAIN) applied by
// applyTerrainPalette(). Opacities are reference-derived values that
// soften the flat base fills so overlays read clearly on top.

const PALETTE_PARK_OPACITY = 0.53; // softened park fill (reference-derived)
const PALETTE_GRASS_OPACITY = 0.45; // softened grass fill (reference-derived)
const PALETTE_WOOD_OPACITY = 0.6; // softened wood fill (reference-derived)
const PALETTE_SAND_OPACITY = 0.3; // softened sand fill (reference-derived)
const PALETTE_RESIDENTIAL_OPACITY = 0.7; // softened residential fill (reference-derived)

// ── Roads ─────────────────────────────────────────────────────────────
// Surface-aware paved/unpaved road hierarchy (applied by
// applyRoadSurfaceAware). ROAD_TUNNEL_OPACITY fades tunnel fills so
// their dashes read clearly.

const ROAD_TUNNEL_OPACITY = 0.55; // line-opacity for tunnel fills (faded, dashes preserved)

// Paved/unpaved road hierarchy (applied by applyRoadSurfaceAware) —
// replaces the legacy Liberty road layers when enabled.
// Width stops for road surface fills. Each entry is [zoom, width_in_px].
// Convert to expression with: roadStopsToExpr(stops)
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

// Build v5-valid zoom-interpolate expression from stops.  v5 requires
// zoom-based expressions at the top level of a paint property — no nesting
// inside ["case"] or ["+"].  The callers: casing uses roadStopsToExpr(pad)
// to bake in casing padding; surfaceFill builds top-level zoom expressions
// with ["case", surface] at each stop value.
function roadStopsToExpr(stops) {
  return ["interpolate", ["exponential", 1.2], ["zoom"], ...stops.flat()];
}

// ── DEM (raster-dem source) ──────────────────────────────────────────
// The raster-dem source feeds the hillshade layer and 3D terrain.
// Mapterhorn (Terrarium-encoded WebP, 512px, maxzoom 17 — service max; z0-12 global, z13-17 regional only):

const DEM_SOURCE_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const DEM_SOURCE_ENCODING = "terrarium";
const DEM_SOURCE_TILESIZE = 512;
const DEM_SOURCE_ATTRIBUTION = `<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>`;
const DEM_SOURCE_MAXZOOM = 17;
// style.terrain.exaggeration — ratio by which the terrain is exaggerated relative to real world
const TERRAIN_EXAGGERATION = 1.5;
// hillshade-exaggeration — intensity of the hillshade (fades in z3 → z5)
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

// ── LANDCOVER_ROCK ───────────────────────────────────────────────────
// bare_rock & scree fills (applied by applyLandcoverRock).

const ROCK_MINZOOM = 10;
const ROCK_OPACITY = 0.6;

// ── LANDCOVER_FARMLAND ──────────────────────────────────────────────
// farmland, orchard, vineyard fills (applied by applyLandcoverFarmland).

const FARMLAND_MINZOOM = 8;
const FARMLAND_OPACITY = 0.7;

// ── LANDUSE ─────────────────────────────────────────────────────────
// military & quarry warning fills (applyMilitaryQuarry) and the
// playground fill (applyRecreation).

const MILITARY_QUARRY_MINZOOM = 8;
const MILITARY_QUARRY_OPACITY = 1;
const PLAYGROUND_MINZOOM = 14;

// ── PARK_DIFFERENTIATION ────────────────────────────────────────────
// national_park vs nature_reserve fills + park labels (applied by
// applyParkDifferentiation).

const PARK_MINZOOM = 6;
const PARK_OUTLINE_MINZOOM = 10;

// ── BUILDINGS ───────────────────────────────────────────────────────
// 2D stroke-only building outlines (applied by applyBuildingOutlines).

const BUILDING_MINZOOM = 13;
const BUILDING_OPACITY = 1;
const BUILDING_WIDTH = 1;

// ── AERIALWAY ───────────────────────────────────────────────────────
// Ski lifts, gondolas, cable cars (applied by applyAerialway).

const AERIALWAY_MINZOOM = 12;
const AERIALWAY_OPACITY = 0.7;
const AERIALWAY_WIDTH = 1.0;

// ── FERRY ───────────────────────────────────────────────────────────
// Shipway ferry routes (applied by applyFerry).

const FERRY_MINZOOM = 8;
const FERRY_OPACITY = 0.7;
const FERRY_WIDTH = 1.5;
const FERRY_DASHARRAY = [4, 3];

// ── Externally hosted outdoor vector tiles ──────────────────────────
// Single endpoint for every self-hosted overlay below (contours, routes,
// paths, POIs). Attribution blank to avoid double OSM in attr control
// (Liberty adds OSM).

const TILES_BASE_URL = "https://tile.ogis.app";
const TILES_ATTRIBUTION = "";

// ── Contours ─────────────────────────────────────────────────────────
// PBF vector contour tiles from the ogis.app hosted contour service
// (contour-mvt-server), generated server-side from the Mapterhorn DEM —
// the same tiles.mapterhorn.com endpoint used by DEM_SOURCE_URL.
// Gated by the CONTOURS toggle. See docs/5.dem.md for details.

const CONTOUR_LAYER_MAXZOOM = 20;

// Label expression — always metric at build time.
// The compare app (dev/src/App.vue) converts "m" → "ft" for imperial units.
const CONTOUR_LABEL_EXPR = [
  "concat",
  ["number-format", ["round", ["get", "ele"]], {}],
  "m",
];

// ogis.app hosted contour service (contour-mvt-server — serves z0–17). The
// server renders tiles from the Mapterhorn DEM — the same endpoint as
// DEM_SOURCE_URL — so the client and the tile server fetch the same
// Mapterhorn tile; the CDN sees it twice and serves the second request
// from cache. Derives from TILES_BASE_URL like the other hosted overlays.
const CONTOUR_PBF_TILE_URL = `${TILES_BASE_URL}/terrain/{z}/{x}/{y}.pbf`;
const CONTOUR_PBF_SOURCE_MINZOOM = 9;
const CONTOUR_PBF_SOURCE_MAXZOOM = 14;

// Contour line rendering — width (px) and opacity at the zoom-ramp stops
// (low = z9, mid = CONTOUR_MID_ZOOM, high = z14; see applyContours). Index =
// every 100 m (ele % 100 === 0) drawn bold; minor = intermediate contours,
// decimated to the CONTOUR_MINOR_EVERY cadence and drawn thin. Opacity uses
// the original 0.4→0.7 (index) / 0.35→0.5 (minor) ramps — emphasis comes
// from width and line count, not transparency.
const CONTOUR_MID_ZOOM = 13;
const CONTOUR_WIDTH_INDEX = { low: 0.75, mid: 1.1, high: 1.6 };
const CONTOUR_WIDTH_MINOR = { low: 0.4, mid: 0.45, high: 0.7 };
const CONTOUR_OPACITY_INDEX = { low: 0.4, mid: 0.64, high: 0.7 };
const CONTOUR_OPACITY_MINOR = { low: 0.35, mid: 0.47, high: 0.5 };
// Minor cadence — must divide the 100 m index interval evenly so minor lines
// sit symmetric between index lines (100 / 20 = 5). The condition uses offset
// 0 (ele % 20 === 0) so lines land on the server's 20 m grid at z10-12: all
// minors there, every 2nd at z13 (10 m), every 4th at z14 (5 m).
const CONTOUR_MINOR_EVERY = 20;

// ── Outdoor routes (hiking route relations) ──────────────────────────
// Vector tiles with hiking route relations from OSM — line geometry
// with network classification (iwn/nwn/rwn/lwn), ref, name, etc.
// Source-layer: 'outdoor_routes'. Self-hosted Planetiler tiles (z8–14).

const ROUTE_SOURCE_LAYER = "outdoor_routes";
const ROUTE_TILE_URL = `${TILES_BASE_URL}/routes/{z}/{x}/{y}.pbf`;
const ROUTE_SOURCE_MINZOOM = 8;
const ROUTE_SOURCE_MAXZOOM = 14;

// ── Low-zoom paths overlay ──────────────────────────────────────────
// Vector tiles with path/footway/track geometry from OSM — fills the
// z9–13 gap where the OpenMapTiles base tiles carry no path data
// (route-gated below z12, all paths at z12; tiers keep earlier zooms:
// iwn 9, nwn 10, rwn 11). Source-layer: 'outdoor_paths'.
// Self-hosted Planetiler tiles (z9–13). See docs/3.paths.md.

const PATHS_SOURCE_LAYER = "outdoor_paths";
const PATHS_TILE_URL = `${TILES_BASE_URL}/paths/{z}/{x}/{y}.pbf`;
const PATHS_SOURCE_MINZOOM = 9;
const PATHS_SOURCE_MAXZOOM = 13;
const PATHS_LAYER_MAXZOOM = 14; // exclusive — hands off to road_path_pedestrian at z14

// Path styling shared between the low-zoom overlay (z9–13) and the
// promoted base layer road_path_pedestrian (z14+) so the two render as
// one continuous visual family — no duplicated literals.
// Cap for the path family. BUTT (not round): with round caps + a
// zoom-interpolated line-width, MapLibre fails to apply line-dasharray —
// paths render as solid red lines instead of dashed. Butt caps render the
// dash correctly at every zoom; dash ends are square instead of rounded,
// which is barely visible at these widths (the Liberty base style uses the
// default butt cap). Constant-width dashed layers (e.g. ferry) are
// unaffected and keep round caps.
const PATH_LINE_CAP = "butt";
const PATH_LINE_JOIN = "round";
const PATH_DASHARRAY = [1, 0.7]; // matches the Liberty base road_path_pedestrian dash
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
]; // base layer width z14+ (previously hard-coded in the PROMOTE_PATHS section)
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
const PATH_BASE_MINZOOM = 14; // road_path_pedestrian renders from here; the overlay owns z9–13

// Path/footway ways render from z9 (route-gated tiers keep earlier zooms);
// track-class ways are handled separately below (PATHS_OVERLAY_TRACK_CLASSES).
const PATHS_OVERLAY_CLASSES = ["path", "footway"];

// Tracks are re-drawn from the overlay at z12–13 because OMT tiles carry
// only a subset of track geometry below z14; styled as local roads (paved
// look, no surface attribute).
const PATHS_OVERLAY_TRACK_CLASSES = ["track"];
const PATHS_TRACK_MINZOOM = 12; // below z12 nothing renders, matching the OMT local-road family's own start
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
]; // fill width; z13=2 matches OMT outdoor-local-fill at z14 (ROAD_LOCAL_STOPS gives 2 at z14) for a seamless handoff; final [14,2] stop keeps it flat right up to the exclusive maxzoom (avoids exponential extrapolation bulging)
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
]; // casing = fill + ~3px outline (mirrors the OMT local casing ROAD_LOCAL_STOPS+3 → 5 at z14)

// ═════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════

/**
 * Replace __TILEJSON_DOMAIN__ placeholders with the real tile domain.
 */
function finalizeStyle(style) {
  const text = JSON.stringify(style);
  const modified = text.replace(/__TILEJSON_DOMAIN__/g, OFM_DOMAIN);
  return JSON.parse(modified);
}

/**
 * Liberty uses expression-style filters ("==", ["get","prop"], val) but v5
 * requires legacy filter syntax ("==", "prop", val).  Also converts
 * ["match",...] → ["in",...] / ["!in",...] and ["!",...] → ["!has",...].
 * Walk every layer recursively.
 */
function migrateLibertyFilters(style) {
  for (const layer of style.layers) {
    if (!layer.filter) continue;
    layer.filter = convertFilter(layer.filter);
  }
}

function convertFilter(node) {
  if (!Array.isArray(node)) return node;
  // Recursion first
  for (let i = 0; i < node.length; i++) {
    if (Array.isArray(node[i])) {
      node[i] = convertFilter(node[i]);
      // Remove boolean true values that replaced typeof checks
      if (node[i] === true) node.splice(i--, 1);
    }
  }
  const op = node[0];

  // ["has","prop"], ["!has","prop"] — fine
  if (op === "has" || op === "!has") return node;
  // ["in","prop",...], ["!in","prop",...] — already fine
  if (op === "in" || op === "!in") return node;
  // Combinators
  if (op === "all" || op === "any" || op === "none") return node;

  // ["match", ["geometry-type"], ["v1","v2",...], true, false] → drop
  // v5 doesn't accept "MultiPoint"/"MultiLineString" as $type values.
  // Source-layers already filter by geometry at tile level, so this is redundant.
  if (
    op === "match" &&
    Array.isArray(node[1]) &&
    node[1][0] === "geometry-type"
  ) {
    return true;
  }

  // ["match", input, ["v1","v2",...], true, false] → ["in", input, "v1","v2",...]
  if (op === "match") {
    let input = node[1];
    if (Array.isArray(input) && input[0] === "get") input = input[1];
    if (Array.isArray(input) && input[0] === "geometry-type") input = "$type";
    const values = node[2];
    const yesVal = node[3];
    const noVal = node[4];
    if (Array.isArray(values) && yesVal === true && noVal === false)
      return ["in", input, ...values];
    if (Array.isArray(values) && yesVal === false && noVal === true)
      return ["!in", input, ...values];
    return node;
  }

  // ["!", ["has","prop"]] → ["!has","prop"]
  if (op === "!") {
    const inner = node[1];
    if (Array.isArray(inner) && inner[0] === "has") return ["!has", inner[1]];
    return node;
  }

  // ["==", ["typeof","prop"], "number"] → remove (always true for OMT data)
  if (op === "==" && Array.isArray(node[1]) && node[1][0] === "typeof")
    return true;

  // ["geometry-type"] → "$type" in any filter position
  for (let i = 1; i < node.length; i++) {
    if (Array.isArray(node[i]) && node[i][0] === "geometry-type")
      node[i] = "$type";
  }

  // Comparison: ["==", ["get","prop"], val] → ["==", "prop", val]
  if (Array.isArray(node[1]) && node[1][0] === "get") node[1] = node[1][1];
  if (Array.isArray(node[2]) && node[2][0] === "get") node[2] = node[2][1];
  return node;
}

/**
 * Create a core route line layer for a network tier.
 * Used by the outdoor route section.
 */
function createRouteLayer(
  sourceId,
  sourceLayer,
  network,
  tier,
  minzoomOverride,
) {
  return {
    id: `${sourceId}-${network}`,
    type: "line",
    source: sourceId,
    "source-layer": sourceLayer,
    minzoom: minzoomOverride
      ? Math.max(minzoomOverride, tier.minzoom || 0)
      : tier.minzoom,
    filter: ["==", ["get", "network"], network],
    paint: {
      "line-color": tier.color,
      "line-opacity": tier.opacity,
      "line-width": tier.width,
    },
  };
}

/**
 * Create a casing/halo background layer for a network tier.
 * Used by the outdoor route section.
 * Returns null if the tier has no casing or halo.
 */
function createRouteCasing(
  sourceId,
  sourceLayer,
  network,
  tier,
  minzoomOverride,
) {
  if (!tier.casing && !tier.halo) return null;
  const bg = tier.casing || tier.halo;
  return {
    id: `${sourceId}-${network}-${tier.casing ? "casing" : "halo"}`,
    type: "line",
    source: sourceId,
    "source-layer": sourceLayer,
    minzoom: minzoomOverride
      ? Math.max(minzoomOverride, bg.minzoom || tier.minzoom || 0)
      : bg.minzoom || tier.minzoom,
    filter: ["==", ["get", "network"], network],
    paint: {
      "line-color": bg.color,
      "line-opacity": bg.opacity,
      "line-width": bg.width,
    },
  };
}

/**
 * Build all route layers (casing + core + default) for a given source.
 * Returns an array of layer objects ready to push into the style.
 */
function createAllRouteLayers(
  sourceId,
  sourceLayer,
  tiers,
  defaultTier,
  minzoomOverride,
) {
  const layers = [];

  for (const [network, tier] of Object.entries(tiers)) {
    const casing = createRouteCasing(
      sourceId,
      sourceLayer,
      network,
      tier,
      minzoomOverride,
    );
    if (casing) layers.push(casing);
    layers.push(
      createRouteLayer(sourceId, sourceLayer, network, tier, minzoomOverride),
    );
  }

  layers.push({
    id: `${sourceId}-default`,
    type: "line",
    source: sourceId,
    "source-layer": sourceLayer,
    minzoom: minzoomOverride || defaultTier.minzoom,
    filter: ["!", ["has", "network"]],
    paint: {
      "line-color": defaultTier.color,
      "line-opacity": defaultTier.opacity,
      "line-width": defaultTier.width,
    },
  });

  return layers;
}

/**
 * Index of the first water/waterway layer in the layer stack.
 * Hillshade and contour layers are inserted just below this point so they
 * render above landcover/landuse but below all water features.
 * Returns -1 if no water layer is found.
 */
function waterStackIndex(style) {
  return style.layers.findIndex(
    (l) => l.id.startsWith("waterway") || l.id.startsWith("water"),
  );
}

// ═════════════════════════════════════════════════════════════════════════
// Section functions (in render order, bottom→top)
// ═════════════════════════════════════════════════════════════════════════
// Each section is gated on its feature toggle in build(). Stubbed sections
// carry a `// TBD: Slice N` comment and will be implemented in later slices.

/**
 * Remove urban-only clutter from the Liberty base: one-way arrows and
 * US road shields. Gated by REMOVE_URBAN_LAYERS.
 */
function applyUrbanRemoval(style) {
  const urbanIds = [
    "road_one_way_arrow",
    "road_one_way_arrow_opposite",
    "highway-shield-us-interstate",
    "road_shield_us",
  ];
  style.layers = style.layers.filter((l) => !urbanIds.includes(l.id));
}

/**
 * Override the Liberty base-layer colours with the muted terrain palette.
 * Skips any layer id that isn't found in the base style, so the build
 * stays robust if upstream renames or removes a layer.
 */
function applyTerrainPalette(style) {
  const set = (id, paintKey, value) => {
    const layer = style.layers.find((l) => l.id === id);
    if (!layer) return;
    layer.paint = layer.paint || {};
    layer.paint[paintKey] = value;
  };

  set("background", "background-color", COLOURS.TERRAIN.BACKGROUND);

  set("water", "fill-color", COLOURS.TERRAIN.WATER);

  set("waterway_tunnel", "line-color", COLOURS.TERRAIN.WATERWAY);
  set("waterway_river", "line-color", COLOURS.TERRAIN.WATERWAY);
  set("waterway_other", "line-color", COLOURS.TERRAIN.WATERWAY);

  set("landcover_grass", "fill-color", COLOURS.TERRAIN.GRASS);
  set("landcover_grass", "fill-opacity", PALETTE_GRASS_OPACITY);

  set("landcover_wood", "fill-color", COLOURS.TERRAIN.WOOD);
  set("landcover_wood", "fill-opacity", PALETTE_WOOD_OPACITY);

  set("park", "fill-color", COLOURS.TERRAIN.PARK);
  set("park", "fill-opacity", PALETTE_PARK_OPACITY);

  set("landcover_ice", "fill-color", COLOURS.TERRAIN.ICE);

  set("landcover_sand", "fill-color", COLOURS.TERRAIN.SAND);
  set("landcover_sand", "fill-opacity", PALETTE_SAND_OPACITY);

  set("landuse_residential", "fill-color", COLOURS.TERRAIN.RESIDENTIAL);
  set("landuse_residential", "fill-opacity", PALETTE_RESIDENTIAL_OPACITY);

  set("building", "fill-color", COLOURS.TERRAIN.BUILDINGS);

  set("building-3d", "fill-extrusion-color", COLOURS.TERRAIN.BUILDINGS);
}

/**
 * Add the shared raster-dem source. Gated by DEM.
 */
function applyDemSource(style) {
  style.sources.demSource = {
    type: "raster-dem",
    tiles: [DEM_SOURCE_URL],
    encoding: DEM_SOURCE_ENCODING,
    tileSize: DEM_SOURCE_TILESIZE,
    maxzoom: DEM_SOURCE_MAXZOOM,
    attribution: DEM_SOURCE_ATTRIBUTION,
  };
}

/**
 * Add the 2D hillshade layer above landcover/landuse, below water.
 * Gated by DEM && DEM_HILLSHADE.
 */
function applyDemHillshade(style) {
  const hillshadeIdx = waterStackIndex(style);
  const hillshadeLayer = {
    id: "hillshade-layer",
    type: "hillshade",
    source: "demSource",
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
 * Add 3D terrain exaggeration from the DEM source.
 * Gated by DEM && DEM_TERRAIN.
 */
function applyDemTerrain(style) {
  style.terrain = {
    source: "demSource",
    exaggeration: TERRAIN_EXAGGERATION,
  };
}

/**
 * bare_rock & scree fills from the OpenMapTiles landcover source-layer.
 * Gated by LANDCOVER_ROCK.
 */
function applyLandcoverRock(style) {
  const layer = {
    id: "landcover-rock",
    type: "fill",
    source: "openmaptiles",
    "source-layer": "landcover",
    minzoom: ROCK_MINZOOM,
    filter: ["==", "class", "rock"],
    paint: {
      "fill-color": COLOURS.LANDCOVER.ROCK,
      "fill-opacity": ROCK_OPACITY,
      "fill-antialias": false,
    },
  };

  const landcoverIdx = style.layers.findIndex((l) =>
    l.id.startsWith("landcover_"),
  );
  if (landcoverIdx !== -1) {
    style.layers.splice(landcoverIdx, 0, layer);
  } else {
    const waterIdx = style.layers.findIndex((l) => l.id.startsWith("water"));
    if (waterIdx !== -1) {
      style.layers.splice(waterIdx, 0, layer);
    } else {
      style.layers.push(layer);
    }
  }
}

/**
 * farmland, orchard & vineyard fills from the OpenMapTiles landcover
 * source-layer. Gated by LANDCOVER_FARMLAND.
 */
function applyLandcoverFarmland(style) {
  const layer = {
    id: "landcover-farmland",
    type: "fill",
    source: "openmaptiles",
    "source-layer": "landcover",
    minzoom: FARMLAND_MINZOOM,
    filter: ["==", "class", "farmland"],
    paint: {
      "fill-color": COLOURS.LANDCOVER.FARMLAND,
      "fill-opacity": FARMLAND_OPACITY,
      "fill-antialias": false,
    },
  };

  const landcoverIdx = style.layers.findIndex((l) =>
    l.id.startsWith("landcover_"),
  );
  if (landcoverIdx !== -1) {
    style.layers.splice(landcoverIdx, 0, layer);
  } else {
    const waterIdx = style.layers.findIndex((l) => l.id.startsWith("water"));
    if (waterIdx !== -1) {
      style.layers.splice(waterIdx, 0, layer);
    } else {
      style.layers.push(layer);
    }
  }
}

/**
 * Grass subclass differentiation (heath, scrub, tundra) within the
 * landcover_grass layer. Gated by LANDCOVER_SUBCLASS.
 */
function applyLandcoverSubclass(style) {
  const grass = style.layers.find((l) => l.id === "landcover_grass");
  if (!grass) return;
  grass.paint = grass.paint || {};
  grass.paint["fill-color"] = [
    "match",
    ["get", "subclass"],
    ["heath", "scrub", "tundra"],
    COLOURS.LANDCOVER.HEATH,
    COLOURS.TERRAIN.GRASS,
  ];
}

/**
 * Military & quarry warning fills from the OpenMapTiles landuse
 * source-layer. Gated by LANDUSE_MILITARY_QUARRY.
 */
function applyMilitaryQuarry(style) {
  const militaryLayer = {
    id: "landuse-military",
    type: "fill",
    source: "openmaptiles",
    "source-layer": "landuse",
    minzoom: MILITARY_QUARRY_MINZOOM,
    filter: ["==", "class", "military"],
    paint: {
      "fill-color": COLOURS.LANDUSE.MILITARY,
      "fill-opacity": MILITARY_QUARRY_OPACITY,
      "fill-antialias": false,
    },
  };

  const quarryLayer = {
    id: "landuse-quarry",
    type: "fill",
    source: "openmaptiles",
    "source-layer": "landuse",
    minzoom: MILITARY_QUARRY_MINZOOM,
    filter: ["==", "class", "quarry"],
    paint: {
      "fill-color": COLOURS.LANDUSE.QUARRY,
      "fill-opacity": MILITARY_QUARRY_OPACITY,
      "fill-antialias": false,
    },
  };

  const landuseIdx = style.layers.findIndex((l) => l.id.startsWith("landuse_"));
  if (landuseIdx !== -1) {
    style.layers.splice(landuseIdx + 1, 0, militaryLayer, quarryLayer);
  } else {
    const waterIdx = style.layers.findIndex((l) => l.id.startsWith("water"));
    if (waterIdx !== -1) {
      style.layers.splice(waterIdx, 0, militaryLayer, quarryLayer);
    } else {
      style.layers.push(militaryLayer, quarryLayer);
    }
  }
}

/**
 * Playground fill from the OpenMapTiles landuse source-layer.
 * Gated by LANDUSE_RECREATION.
 */
function applyRecreation(style) {
  const layer = {
    id: "landuse-playground",
    type: "fill",
    source: "openmaptiles",
    "source-layer": "landuse",
    minzoom: PLAYGROUND_MINZOOM,
    filter: ["==", "class", "playground"],
    paint: {
      "fill-color": COLOURS.LANDUSE.PLAYGROUND,
      "fill-opacity": 0.5,
      "fill-antialias": false,
    },
  };

  let anchor = -1;
  for (const id of ["landuse-military", "landuse-quarry"]) {
    const idx = style.layers.findIndex((l) => l.id === id);
    if (idx !== -1) anchor = Math.max(anchor, idx);
  }
  if (anchor === -1) {
    style.layers.forEach((l, i) => {
      if (l.id.startsWith("landuse_")) anchor = i;
    });
  }

  if (anchor !== -1) {
    style.layers.splice(anchor + 1, 0, layer);
  } else {
    const waterIdx = style.layers.findIndex((l) => l.id.startsWith("water"));
    if (waterIdx !== -1) {
      style.layers.splice(waterIdx, 0, layer);
    } else {
      style.layers.push(layer);
    }
  }
}

/**
 * national_park vs nature_reserve fills + park labels.
 * Gated by PARK_DIFFERENTIATION.
 */
function applyParkDifferentiation(style) {
  const parkLayers = [
    {
      id: "park-national-park",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "park",
      minzoom: PARK_MINZOOM,
      filter: ["==", "class", "national_park"],
      paint: {
        "fill-color": COLOURS.PARK.NATIONAL_PARK,
        "fill-opacity": 0.4,
        "fill-antialias": false,
      },
    },
    {
      id: "park-nature-reserve",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "park",
      minzoom: PARK_MINZOOM,
      filter: ["any", ["==", "class", "nature_reserve"]],
      paint: {
        "fill-color": COLOURS.PARK.NATURE_RESERVE,
        "fill-opacity": 0.4,
        "fill-antialias": false,
      },
    },
    {
      id: "park-other",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "park",
      minzoom: PARK_MINZOOM,
      filter: [
        "all",
        ["!=", "class", "national_park"],
        ["!=", "class", "nature_reserve"],
      ],
      paint: {
        "fill-color": COLOURS.PARK.DEFAULT,
        "fill-opacity": 0.3,
        "fill-antialias": false,
      },
    },
    {
      id: "park-outline",
      type: "line",
      source: "openmaptiles",
      "source-layer": "park",
      minzoom: PARK_OUTLINE_MINZOOM,
      paint: {
        "line-color": COLOURS.PARK.DEFAULT,
        "line-opacity": 0.3,
        "line-dasharray": [1, 1.5],
      },
    },
  ];

  style.layers = style.layers.filter(
    (l) => l.id !== "park" && l.id !== "park_outline",
  );

  const waterIdx = waterStackIndex(style);
  if (waterIdx !== -1) {
    style.layers.splice(waterIdx, 0, ...parkLayers);
  } else {
    style.layers.push(...parkLayers);
  }
}

/**
 * Water colour override + swimming_pool differentiation.
 * Gated by WATER_PALETTE.
 */
function applyWaterPalette(style) {
  const waterLayer = style.layers.find((l) => l.id === "water");
  if (waterLayer) {
    // TERRAIN_PALETTE already sets the water colour; still set it here so
    // WATER_PALETTE alone produces the correct water colour.
    waterLayer.paint = waterLayer.paint || {};
    waterLayer.paint["fill-color"] = COLOURS.TERRAIN.WATER;

    // Exclude swimming_pool polygons from the main water fill.
    // Liberty's water filter uses expression syntax (["get","brunnel"])
    // which v5 rejects in filters — convert to legacy form.
    waterLayer.filter = [
      "all",
      ["!=", "brunnel", "tunnel"],
      ["!=", "class", "swimming_pool"],
    ];
  }

  const poolLayer = {
    id: "water-swimming-pool",
    type: "fill",
    source: "openmaptiles",
    "source-layer": "water",
    filter: ["==", "class", "swimming_pool"],
    minzoom: 14,
    paint: {
      "fill-color": "hsl(200, 45%, 75%)", // lighter, more artificial blue
      "fill-opacity": 0.5,
    },
  };

  const waterIdx = style.layers.findIndex((l) => l.id === "water");
  if (waterIdx !== -1) {
    style.layers.splice(waterIdx + 1, 0, poolLayer);
  } else {
    style.layers.push(poolLayer);
  }
}

/**
 * Paved/unpaved road hierarchy — replaces the legacy Liberty road layers
 * when enabled. Gated by ROAD_SURFACE_AWARE.
 */
function applyRoadSurfaceAware(style) {
  const libertyRoadIds = [
    // Road fills (7)
    "road_motorway",
    "road_trunk_primary",
    "road_secondary_tertiary",
    "road_minor",
    "road_service_track",
    "road_link",
    "road_motorway_link",
    // Road casings (7)
    "road_motorway_casing",
    "road_trunk_primary_casing",
    "road_secondary_tertiary_casing",
    "road_minor_casing",
    "road_service_track_casing",
    "road_link_casing",
    "road_motorway_link_casing",
    // Bridge fills (8)
    "bridge_motorway",
    "bridge_trunk_primary",
    "bridge_secondary_tertiary",
    "bridge_street",
    "bridge_link",
    "bridge_motorway_link",
    "bridge_service_track",
    "bridge_path_pedestrian",
    // Bridge casings (8)
    "bridge_motorway_casing",
    "bridge_trunk_primary_casing",
    "bridge_secondary_tertiary_casing",
    "bridge_street_casing",
    "bridge_link_casing",
    "bridge_motorway_link_casing",
    "bridge_service_track_casing",
    "bridge_path_pedestrian_casing",
    // Tunnel fills (8)
    "tunnel_motorway",
    "tunnel_trunk_primary",
    "tunnel_secondary_tertiary",
    "tunnel_minor",
    "tunnel_link",
    "tunnel_motorway_link",
    "tunnel_service_track",
    "tunnel_path_pedestrian",
    // Tunnel casings (7)
    "tunnel_motorway_casing",
    "tunnel_trunk_primary_casing",
    "tunnel_secondary_tertiary_casing",
    "tunnel_street_casing",
    "tunnel_link_casing",
    "tunnel_motorway_link_casing",
    "tunnel_service_track_casing",
    // Road area (1)
    "road_area_pattern",
  ];

  style.layers = style.layers.filter((l) => !libertyRoadIds.includes(l.id));

  const roadClasses = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "minor",
    "service",
    "track",
  ];
  const pathClasses = ["path", "pedestrian"];
  const surfaceClasses = (classes) => [
    "all",
    ["in", "class", ...classes],
    ["!=", "brunnel", "bridge"],
    ["!=", "brunnel", "tunnel"],
  ];
  const brunnelFilter = (classes, brunnel) => [
    "all",
    ["in", "class", ...classes],
    ["==", "brunnel", brunnel],
  ];

  // Build a v5-valid line-width expression where zoom is the top-level
  // interpolate and surface-awareness lives at each stop value.  Unpaved
  // width ramps at different zooms than paved — merge the two stop sets:
  //   ["interpolate", …, ["zoom"],
  //    z0, ["case", ["==","surface","unpaved"], u0, p0],
  //    z1, ["case", ["==","surface","unpaved"], u1, p1], …]
  function surfaceWidthExpr(pavedStops) {
    const unpaved = ROAD_UNPAVED_STOPS;
    // Collect all zoom levels from both stop arrays
    const zooms = new Set(pavedStops.map(([z]) => z));
    unpaved.forEach(([z]) => zooms.add(z));
    const sorted = [...zooms].sort((a, b) => a - b);
    // At each zoom, compute the paved/unpaved value via linear interpolation
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

  const surfaceFill = (
    id,
    classes,
    minzoom,
    pavedColor,
    pavedStops,
    unpavedColor,
  ) => ({
    id,
    type: "line",
    source: "openmaptiles",
    "source-layer": "transportation",
    minzoom,
    filter: surfaceClasses(classes),
    paint: {
      "line-color": [
        "case",
        ["==", ["get", "surface"], "unpaved"],
        unpavedColor,
        pavedColor,
      ],
      "line-width": surfaceWidthExpr(pavedStops),
      "line-dasharray": [
        "case",
        ["==", ["get", "surface"], "unpaved"],
        ROAD_UNPAVED_DASHARRAY,
        ["literal", [1]],
      ],
    },
    // BUTT cap: with round caps + an interpolated width, MapLibre fails to
    // apply line-dasharray — unpaved roads would render solid instead of
    // dashed (same quirk as the path family, see PATH_LINE_CAP).
    layout: { "line-cap": "butt", "line-join": "round" },
  });

  const casing = (id, classes, color, width, minzoom) => ({
    id,
    type: "line",
    source: "openmaptiles",
    "source-layer": "transportation",
    // A casing must never render without its fill: during a zoom transition
    // the next zoom's tiles render overzoomed before the camera crosses the
    // fill's minzoom, which would flash roads as solid casing colour. Gate
    // casing and fill together at the same minzoom (see the local casing call).
    ...(minzoom !== undefined ? { minzoom } : {}),
    filter: surfaceClasses(classes),
    paint: {
      "line-color": color,
      "line-width": width,
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });

  const brunnelCasing = (id, classes, brunnel, width) => ({
    id,
    type: "line",
    source: "openmaptiles",
    "source-layer": "transportation",
    filter: brunnelFilter(classes, brunnel),
    paint: {
      "line-color": COLOURS.ROADS.CASING,
      "line-width": width,
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });

  const brunnelFill = (
    id,
    classes,
    brunnel,
    minzoom,
    color,
    width,
    opacity,
  ) => ({
    id,
    type: "line",
    source: "openmaptiles",
    "source-layer": "transportation",
    minzoom,
    filter: brunnelFilter(classes, brunnel),
    paint: {
      "line-color": color,
      "line-width": width,
      ...(opacity ? { "line-opacity": opacity } : {}),
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });

  const newLayers = [
    {
      id: "outdoor-road-area",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["==", "$type", "Polygon"],
      paint: {
        "fill-color": COLOURS.ROADS.CASING,
        "fill-opacity": 0.3,
      },
    },

    // Tunnels (below casings — hidden under the road surface)
    brunnelCasing("outdoor-tunnel-casing", roadClasses, "tunnel", [
      "interpolate",
      ["exponential", 1.2],
      ["zoom"],
      5,
      4,
      12,
      8,
      20,
      18,
    ]),
    brunnelFill(
      "outdoor-tunnel-fill",
      roadClasses,
      "tunnel",
      undefined,
      COLOURS.ROADS.LOCAL,
      ["interpolate", ["exponential", 1.2], ["zoom"], 5, 2, 12, 5, 20, 14],
      ROAD_TUNNEL_OPACITY,
    ),
    brunnelCasing("outdoor-tunnel-path-casing", pathClasses, "tunnel", [
      "interpolate",
      ["exponential", 1.2],
      ["zoom"],
      14,
      4,
      20,
      10,
    ]),
    brunnelFill(
      "outdoor-tunnel-path-fill",
      pathClasses,
      "tunnel",
      14,
      COLOURS.PATHS.PATH,
      ["interpolate", ["exponential", 1.2], ["zoom"], 14, 2, 20, 8],
      ROAD_TUNNEL_OPACITY,
    ),

    // Surface road casings
    casing(
      "outdoor-major-casing",
      ["motorway", "trunk", "primary"],
      COLOURS.ROADS.CASING,
      roadStopsToExpr(ROAD_MAJOR_STOPS.map(([z, w]) => [z, w + 2])),
    ),
    casing(
      "outdoor-medium-casing",
      ["secondary", "tertiary"],
      COLOURS.ROADS.CASING,
      roadStopsToExpr(ROAD_MEDIUM_STOPS.map(([z, w]) => [z, w + 1.5])),
      8, // same minzoom as outdoor-medium-fill — casing must not render without its fill
    ),
    casing(
      "outdoor-local-casing",
      ["minor", "service", "track"],
      COLOURS.ROADS.TRACK_CASING,
      roadStopsToExpr(ROAD_LOCAL_STOPS.map(([z, w]) => [z, w + 3])),
      12, // same minzoom as outdoor-local-fill — casing must not render without its fill
    ),

    // Surface road fills
    surfaceFill(
      "outdoor-major-fill",
      ["motorway", "trunk", "primary"],
      5,
      COLOURS.ROADS.MAJOR,
      ROAD_MAJOR_STOPS,
      "rgb(210, 200, 180)",
    ),
    surfaceFill(
      "outdoor-medium-fill",
      ["secondary", "tertiary"],
      8,
      COLOURS.ROADS.MEDIUM,
      ROAD_MEDIUM_STOPS,
      "rgb(210, 197, 175)",
    ),
    surfaceFill(
      "outdoor-local-fill",
      ["minor", "service", "track"],
      12,
      COLOURS.ROADS.LOCAL,
      ROAD_LOCAL_STOPS,
      "rgb(237, 230, 218)",
    ),

    // Bridge casings
    brunnelCasing("outdoor-bridge-casing", roadClasses, "bridge", [
      "interpolate",
      ["exponential", 1.2],
      ["zoom"],
      5,
      4,
      12,
      8,
      20,
      18,
    ]),
    brunnelFill(
      "outdoor-bridge-fill",
      roadClasses,
      "bridge",
      undefined,
      COLOURS.ROADS.LOCAL,
      ["interpolate", ["exponential", 1.2], ["zoom"], 5, 2, 12, 5, 20, 14],
    ),
    brunnelCasing("outdoor-bridge-path-casing", pathClasses, "bridge", [
      "interpolate",
      ["exponential", 1.2],
      ["zoom"],
      14,
      4,
      20,
      10,
    ]),
    brunnelFill(
      "outdoor-bridge-path-fill",
      pathClasses,
      "bridge",
      14,
      COLOURS.PATHS.PATH,
      ["interpolate", ["exponential", 1.2], ["zoom"], 14, 2, 20, 8],
    ),
  ];

  let anchorIdx = style.layers.findIndex((l) => l.id === "road_major_rail");
  if (anchorIdx === -1) {
    anchorIdx = style.layers.findIndex((l) => l.id === "boundary_3");
  }

  if (anchorIdx !== -1) {
    style.layers.splice(anchorIdx, 0, ...newLayers);
  } else {
    style.layers.push(...newLayers);
  }
}

/**
 * 2D stroke-only building outlines — replaces the building and
 * building-3d layers. Gated by BUILDING_OUTLINES.
 */
function applyBuildingOutlines(style) {
  style.layers = style.layers.filter(
    (l) => l.id !== "building" && l.id !== "building-3d",
  );

  const outlineLayer = {
    id: "building-outline",
    type: "line",
    source: "openmaptiles",
    "source-layer": "building",
    minzoom: BUILDING_MINZOOM,
    paint: {
      "line-color": COLOURS.BUILDING.OUTLINE,
      "line-opacity": BUILDING_OPACITY,
      "line-width": BUILDING_WIDTH,
    },
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
  };

  const boundaryIdx = style.layers.findIndex((l) => l.id === "boundary_3");
  if (boundaryIdx !== -1) {
    style.layers.splice(boundaryIdx, 0, outlineLayer);
  } else {
    style.layers.push(outlineLayer);
  }
}

/**
 * Ski lifts, gondolas, cable cars from the OpenMapTiles aeroway/aerialway
 * source-layer. Gated by AERIALWAY.
 */
function applyAerialway(style) {
  const layer = {
    id: "aerialway",
    type: "line",
    source: "openmaptiles",
    "source-layer": "transportation",
    minzoom: AERIALWAY_MINZOOM,
    filter: ["==", "class", "aerialway"],
    paint: {
      "line-color": COLOURS.AERIALWAY.LINE,
      "line-opacity": AERIALWAY_OPACITY,
      "line-width": AERIALWAY_WIDTH,
    },
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
  };

  const railIdx = style.layers.findIndex((l) => l.id === "road_major_rail");
  if (railIdx !== -1) {
    style.layers.splice(railIdx + 1, 0, layer);
  } else {
    const boundaryIdx = style.layers.findIndex((l) => l.id === "boundary_3");
    if (boundaryIdx !== -1) {
      style.layers.splice(boundaryIdx, 0, layer);
    } else {
      style.layers.push(layer);
    }
  }
}

/**
 * Shipway ferry routes from the OpenMapTiles shipway source-layer.
 * Gated by FERRY.
 */
function applyFerry(style) {
  const layer = {
    id: "ferry",
    type: "line",
    source: "openmaptiles",
    "source-layer": "transportation",
    minzoom: FERRY_MINZOOM,
    filter: ["==", "class", "ferry"],
    paint: {
      "line-color": COLOURS.FERRY.LINE,
      "line-opacity": FERRY_OPACITY,
      "line-width": FERRY_WIDTH,
      "line-dasharray": FERRY_DASHARRAY,
    },
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
  };

  let anchor = style.layers.findIndex((l) => l.id === "aerialway");
  if (anchor === -1) {
    anchor = style.layers.findIndex((l) => l.id === "road_major_rail");
  }
  if (anchor !== -1) {
    style.layers.splice(anchor + 1, 0, layer);
  } else {
    const boundaryIdx = style.layers.findIndex((l) => l.id === "boundary_3");
    if (boundaryIdx !== -1) {
      style.layers.splice(boundaryIdx, 0, layer);
    } else {
      style.layers.push(layer);
    }
  }
}

/**
 * Strip the bridge/tunnel rail variants, keeping only the base rail
 * layers. Gated by RAIL_SIMPLIFIED.
 */
function applyRailSimplified(style) {
  style.layers = style.layers.filter((l) => {
    return !(
      l.id.startsWith("bridge_major_rail") ||
      l.id.startsWith("bridge_transit_rail") ||
      l.id.startsWith("tunnel_major_rail") ||
      l.id.startsWith("tunnel_transit_rail")
    );
  });
}

/**
 * PBF vector contour tiles from the ogis.app hosted contour service
 * (contour-mvt-server), served as standard Mapbox Vector Tiles — no
 * client-side contour generation. See docs/5.dem.md.
 *
 * Tier conditions used by the paint `case` expressions:
 * - contourIndexCond — index contours, every 100 m of elevation
 *   (ele % 100 === 0). Drawn bold.
 * - contourMinorCond — minor contours, drawn on a 20 m elevation cadence
 *   (CONTOUR_MINOR_EVERY, offset 0 so lines land on the server's 20 m grid).
 *   20 divides the 100 m index interval evenly (100 / 20 = 5), so minors sit
 *   symmetric at 20/40/60/80 m between every index pair. A cadence that does
 *   not divide 100 m (e.g. 40 m → 100 / 40 = 2.5) leaves minors ragged and
 *   asymmetric against the index grid.
 * - contourCase() — three-branch case per zoom stop: index style, minor
 *   style, or hidden (opacity 0 / width 0). The hidden branch is what
 *   decimates: features off the cadence are painted invisible rather than
 *   filtered, because v5 filter syntax cannot express modulo.
 */
const contourIndexCond = ["==", ["%", ["get", "ele"], 100], 0];
const contourMinorCond = ["==", ["%", ["get", "ele"], CONTOUR_MINOR_EVERY], 0];
// case(index → idxValue, minor → minorValue, hidden → 0)
const contourCase = (idxValue, minorValue) => [
  "case",
  contourIndexCond,
  idxValue,
  contourMinorCond,
  minorValue,
  0,
];

function applyContours(style) {
  style.sources["contour-source"] = {
    type: "vector",
    minzoom: CONTOUR_PBF_SOURCE_MINZOOM,
    tiles: [CONTOUR_PBF_TILE_URL],
    maxzoom: CONTOUR_PBF_SOURCE_MAXZOOM,
  };

  const contourLinesLayer = {
    // Single contour line layer — v5 filter syntax doesn't support ["%",...]
    // expressions, so merge minor + index into one layer with expression-based paint.
    id: "contour-lines",
    type: "line",
    source: "contour-source",
    "source-layer": "contours",
    minzoom: CONTOUR_PBF_SOURCE_MINZOOM,
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
      // v5 requires zoom at the top level — case at each stop, not interpolate inside case.
      "line-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        CONTOUR_PBF_SOURCE_MINZOOM,
        contourCase(CONTOUR_OPACITY_INDEX.low, CONTOUR_OPACITY_MINOR.low),
        CONTOUR_MID_ZOOM,
        contourCase(CONTOUR_OPACITY_INDEX.mid, CONTOUR_OPACITY_MINOR.mid),
        14,
        contourCase(CONTOUR_OPACITY_INDEX.high, CONTOUR_OPACITY_MINOR.high),
      ],
      "line-width": [
        "interpolate",
        ["exponential", 1.2],
        ["zoom"],
        CONTOUR_PBF_SOURCE_MINZOOM,
        contourCase(CONTOUR_WIDTH_INDEX.low, CONTOUR_WIDTH_MINOR.low),
        CONTOUR_MID_ZOOM,
        contourCase(CONTOUR_WIDTH_INDEX.mid, CONTOUR_WIDTH_MINOR.mid),
        14,
        contourCase(CONTOUR_WIDTH_INDEX.high, CONTOUR_WIDTH_MINOR.high),
      ],
    },
  };

  const contourIdx = waterStackIndex(style);
  if (contourIdx !== -1) {
    style.layers.splice(contourIdx, 0, contourLinesLayer);
  } else {
    style.layers.push(contourLinesLayer);
  }
}

/**
 * Contour elevation labels — index (100 m) labels placed along the contour
 * lines. The layer is inserted below the POI stack and then repositioned by
 * reorderContourLabelStack() so contour labels beat POI labels but still
 * yield to peaks and park labels. Gated by CONTOURS.
 */
function applyContourLabels(style) {
  const layer = {
    id: "contour-labels",
    type: "symbol",
    source: "contour-source",
    "source-layer": "contours",
    minzoom: CONTOUR_PBF_SOURCE_MINZOOM,
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

  // Insert below the POI stack; reorderContourLabelStack() repositions the
  // layer above the POI tiers in build().
  const poiIdx = style.layers.findIndex((l) => l.id === poiAnchorId);
  if (poiIdx !== -1) {
    style.layers.splice(poiIdx, 0, layer);
  } else {
    style.layers.push(layer);
  }
}

/**
 * Reposition the contour-label / peak / park-label block directly above the
 * base-map POI tiers (outdoor-poi-z2) so contour labels beat POI labels but
 * still yield to peaks and park labels — peaks and park labels render on top
 * of the outdoor section. The label functions insert below the POI stack (see
 * applyContourLabels), so this post-pass re-inserts the block at its final
 * position after the outdoor steps, preserving the layers' relative order
 * (bottom→top: contour-labels, peaks, park-label). No-op when the anchor layer
 * or any moved layer is absent (feature toggle off).
 */
function reorderContourLabelStack(style) {
  const movedIds = [
    "contour-labels",
    "mountain-peak",
    "mountain-peak-secondary",
    "mountain-saddle",
    "mountain-volcano",
    "park-label",
  ];

  const anchorIdx = style.layers.findIndex((l) => l.id === "outdoor-poi-z2");
  if (anchorIdx === -1) return;

  const moved = movedIds
    .map((id) => style.layers.find((l) => l.id === id))
    .filter(Boolean);
  if (!moved.length) return;

  style.layers = style.layers.filter((l) => !moved.includes(l));
  const insertAt = style.layers.findIndex((l) => l.id === "outdoor-poi-z2") + 1;
  style.layers.splice(insertAt, 0, ...moved);
}

/**
 * Low-zoom paths overlay. Vector tiles with path/footway/track geometry
 * from OSM — fills the z9–13 gap where the OpenMapTiles base tiles carry
 * no path data (route-gated below z12, all paths at z12; tiers keep
 * earlier zooms: iwn 9, nwn 10, rwn 11). Source-layer: 'outdoor_paths'.
 * Self-hosted Planetiler tiles (z9–13). Renders below the outdoor route
 * lines so routes stay on top of paths. See docs/3.paths.md.
 */
function applyLowZoomPaths(style) {
  style.sources["outdoor-paths"] = {
    type: "vector",
    tiles: [PATHS_TILE_URL],
    minzoom: PATHS_SOURCE_MINZOOM,
    maxzoom: PATHS_SOURCE_MAXZOOM,
    attribution: TILES_ATTRIBUTION,
  };

  const pathsLayer = {
    id: "outdoor-paths",
    type: "line",
    source: "outdoor-paths",
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

  // Track-class ways — re-drawn from the overlay at z12–13 styled as local
  // roads (paved look, no surface attribute), because OMT tiles carry only
  // a subset of track geometry below z14. Casing renders lowest, then the
  // fill, with the paths layer above.
  const trackCasingLayer = {
    id: "outdoor-paths-track-casing",
    type: "line",
    source: "outdoor-paths",
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
    source: "outdoor-paths",
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

  // Insert at the POI anchor — below the outdoor route lines so routes
  // stay on top of paths.
  const poiIdx = style.layers.findIndex((l) => l.id === poiAnchorId);
  if (poiIdx !== -1) {
    style.layers.splice(
      poiIdx,
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
 * Outdoor routes (hiking route relations). Vector tiles with hiking route
 * relations from OSM — line geometry with network classification
 * (iwn/nwn/rwn/lwn), ref, name, etc. Source-layer: 'outdoor_routes'.
 * Self-hosted Planetiler tiles (z8–14).
 */
function applyOutdoorRoute(style) {
  style.sources["outdoor-route"] = {
    type: "vector",
    tiles: [ROUTE_TILE_URL],
    minzoom: ROUTE_SOURCE_MINZOOM,
    maxzoom: ROUTE_SOURCE_MAXZOOM,
    attribution: TILES_ATTRIBUTION,
  };

  const routeLayers = createAllRouteLayers(
    "outdoor-route",
    ROUTE_SOURCE_LAYER,
    ROUTE_TIERS,
    ROUTE_TIER_DEFAULT,
  );

  // Insert below the base-map POI layers (POI anchor) so route lines
  // render above roads/water but below POI icons & labels.
  const poiIdx = style.layers.findIndex((l) => l.id === poiAnchorId);
  if (poiIdx !== -1) {
    style.layers.splice(poiIdx, 0, ...routeLayers);
  } else {
    style.layers.push(...routeLayers);
  }
}

/**
 * MTB difficulty + bicycle access overlays from the OpenMapTiles
 * transportation source-layer. Inserted before the POI block in the layer
 * stack.
 */
function applyMtbScale(style) {
  const mtbLayer = {
    id: "mtb_scale-casing",
    type: "line",
    metadata: { "mapbox:group": "1444849345966.4436" },
    source: "openmaptiles",
    "source-layer": "transportation",
    minzoom: 0,
    maxzoom: 22,
    filter: [
      "all",
      ["==", "$type", "LineString"],
      ["!=", "brunnel", "tunnel"],
      ["has", "mtb_scale"],
    ],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": [
        "match",
        ["get", "mtb_scale"],
        "1",
        COLOURS.MTB.GRADE_1,
        "2",
        COLOURS.MTB.GRADE_2,
        COLOURS.MTB.GRADE_3_PLUS,
      ],
      "line-opacity": 0.8,
      "line-width": {
        base: 1.2,
        stops: [
          [12, 0.5],
          [16, 3],
        ],
      },
    },
  };

  const bicycleLayer = {
    id: "bicycle-access",
    type: "line",
    source: "openmaptiles",
    "source-layer": "transportation",
    minzoom: 0,
    maxzoom: 22,
    filter: [
      "all",
      ["==", "$type", "LineString"],
      ["!=", "brunnel", "tunnel"],
      ["has", "bicycle"],
      ["in", "class", "track"],
    ],
    paint: {
      "line-color": COLOURS.MTB.BICYCLE_ACCESS,
      "line-opacity": 0.7,
      "line-width": 2,
    },
  };

  const poiIdx = style.layers.findIndex((l) => l.id === poiAnchorId);
  if (poiIdx !== -1) {
    style.layers.splice(poiIdx, 0, bicycleLayer, mtbLayer);
  } else {
    style.layers.push(bicycleLayer, mtbLayer);
  }
}

/**
 * Restyle the base-layer road_path_pedestrian + highway-name-path layers
 * so paths form one continuous visual family with the low-zoom overlay.
 * Gated by PATH_STYLING.
 */
function applyPathStyling(style) {
  const pathLayer = style.layers.find((l) => l.id === "road_path_pedestrian");
  if (pathLayer) {
    pathLayer.minzoom = PATH_BASE_MINZOOM; // the LOW_ZOOM_PATHS overlay owns z9–13
    pathLayer.maxzoom = 22;
    pathLayer.paint = pathLayer.paint || {};
    pathLayer.paint["line-color"] = COLOURS.PATHS.PATH;
    pathLayer.paint["line-dasharray"] = PATH_DASHARRAY;
    if (MTB_SCALE) {
      pathLayer.paint["line-opacity"] = ["case", ["has", "mtb_scale"], 0, 1];
    }
    pathLayer.paint["line-width"] = PATH_WIDTH;
    pathLayer.layout = pathLayer.layout || {};
    pathLayer.layout["line-cap"] = PATH_LINE_CAP;
    pathLayer.layout["line-join"] = PATH_LINE_JOIN;
  }

  const nameLayer = style.layers.find((l) => l.id === "highway-name-path");
  if (nameLayer) {
    nameLayer.minzoom = 0;
    nameLayer.maxzoom = 22;
    nameLayer.paint = nameLayer.paint || {};
    nameLayer.paint["text-color"] = COLOURS.PATHS.PATH;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// POI SECTION — peak labels, park labels & point-of-interest layers
// ═════════════════════════════════════════════════════════════════════════
// All POI code lives here in one contiguous block: the catalogue load, the
// derived class/icon lists, the style constants, the helpers and the apply
// functions. The section reads in render order — bottom→top of the final
// layer stack:
//
//   mountain-peak (+ secondary/saddle/volcano)   — OMT mountain_peak
//   park-label                                   — OMT park
//   outdoor-poi (custom tiles)                   — outdoor_pois
//   outdoor-poi-z1 (z12+)                        — OMT poi
//   outdoor-poi-z2 (z14+)                        — OMT poi
//   poi_transit (railway/airport only)           — OMT poi
//
// Peaks and park-label are NOT catalogue-driven and are kept byte-identical
// to their previous behaviour. Everything else is driven by
// pois/catalogue.yml — the single source of truth for which POIs render, at
// what zoom, with which icon, and whether they carry a name label. The
// non-POI sections (low-zoom paths, outdoor routes, MTB scale) render
// between outdoor-poi and outdoor-poi-z1 in the final stack, so their
// calls in build() stay interleaved with the POI calls — see build() step 15.

// ── Catalogue load ──────────────────────────────────────────────────────
// pois/catalogue.yml is parsed once at build start. A missing or malformed
// file (or one without a non-empty `pois` array) fails the build loudly.

const CATALOGUE_FILE = resolve(ROOT, "pois", "catalogue.yml");

let catalogue;
try {
  catalogue = YAML.parse(readFileSync(CATALOGUE_FILE, "utf8"));
} catch (err) {
  throw new Error(
    `[poi] failed to parse POI catalogue ${CATALOGUE_FILE}: ${err.message}`,
  );
}
if (
  !catalogue ||
  !Array.isArray(catalogue.pois) ||
  catalogue.pois.length === 0
) {
  throw new Error(
    `[poi] POI catalogue ${CATALOGUE_FILE} has no non-empty 'pois' array`,
  );
}

// ── Derived class & icon lists ──────────────────────────────────────────
// ofm entries render from the OpenMapTiles `poi` source-layer; custom
// entries render from the self-hosted outdoor_pois tiles (POI_TILE_URL).

const OFM_ENTRIES = catalogue.pois.filter((e) => e.source === "ofm");
const CUSTOM_ENTRIES = catalogue.pois.filter((e) => e.source === "custom");

// Zoom tiers from the catalogue: tier 1 → outdoor-poi-z1 (z12+), tier 2 →
// outdoor-poi-z2 (z14+).
const TIER1_ENTRIES = OFM_ENTRIES.filter((e) => e.tier === 1);
const TIER2_ENTRIES = OFM_ENTRIES.filter((e) => e.tier === 2);
const tier1Classes = TIER1_ENTRIES.map((e) => e.class);
const tier2Classes = TIER2_ENTRIES.map((e) => e.class);

// ── POI constants ───────────────────────────────────────────────────────
// Peak name + elevation labels (applyPeakLabels). Text only — no icon.
// Rank-1 tier plus the rank 2–3, saddle & volcano tiers.

const PEAK_LABEL_MINZOOM = 7;
const PEAK_LABEL_TEXT_SIZE = 11;
const PEAK_LABEL_HALO_WIDTH = 1;
const PEAK_LABEL_HALO_BLUR = 1;

// Extended peak tiers
const PEAK_RANK23_MINZOOM = 10;
const SADDLE_MINZOOM = 10;
const VOLCANO_MINZOOM = 6;
const PEAK_RANK1_SIZE = 12;
const PEAK_RANK23_SIZE = 10;
const SADDLE_SIZE = 9;

// Park-label zoom/rank — shared with the park differentiation fills but
// only consumed by the park-label layer in this section.
const PARK_LABEL_MINZOOM = 8;
const PARK_LABEL_MAX_RANK = 3;

// Self-hosted outdoor POI tiles (outdoor-poi layer) — served from the
// shared TILES_BASE_URL endpoint (see the self-hosted tiles block above).
const POI_SOURCE_LAYER = "outdoor_pois";
const POI_TILE_URL = `${TILES_BASE_URL}/pois/{z}/{x}/{y}.pbf`;
const POI_SOURCE_MINZOOM = 12;
const POI_SOURCE_MAXZOOM = 16;

// Icon + label rendering for the POI layers. POI_ICON_DEFAULT is the
// fallback class/kind → icon (unreachable in practice — layer filters only
// allowlist catalogue classes/kinds).
const POI_ICON_SIZE = 1;
const POI_ICON_OPACITY = 0.85;
const POI_TEXT_SIZE = 11;
const POI_TEXT_OFFSET = [0, 1.5];
const POI_TEXT_HALO_WIDTH = 1;
const POI_ICON_DEFAULT = "marker";

// ── POI helpers ─────────────────────────────────────────────────────────

/**
 * icon-image match for a group of catalogue entries: class/kind → sprite
 * icon with POI_ICON_DEFAULT as the fallback.
 */
function poiIconMatch(entries, field) {
  return [
    "match",
    ["get", field],
    ...entries.flatMap((e) => [e[field], e.icon]),
    POI_ICON_DEFAULT,
  ];
}

/**
 * text-field from a group's show_title flags: all true → the name field,
 * none true → "" (icon-only), mixed → a per-entry case expression.
 */
function poiTextField(entries, field) {
  if (entries.every((e) => e.show_title)) return ["get", "name"];
  if (!entries.some((e) => e.show_title)) return "";
  return [
    "case",
    ...entries.flatMap((e) => [
      ["==", ["get", field], e[field]],
      e.show_title ? ["get", "name"] : "",
    ]),
    "",
  ];
}

/**
 * Density cap for entries carrying a rank_max field (park). Returns null
 * when no entry has one, so the filter keeps its plain shape.
 *
 * Emits legacy filter syntax directly (bare string property keys, !in /
 * all / any) so it passes through convertFilter() unchanged.
 */
function rankCapCondition(entries) {
  const capped = entries.filter((e) => e.rank_max);
  if (capped.length === 0) return null;
  if (capped.length === 1) {
    const entry = capped[0];
    return [
      "any",
      ["!=", "class", entry.class],
      ["<=", "rank", entry.rank_max],
    ];
  }
  const caps = capped.map((e) => [
    "all",
    ["==", "class", e.class],
    ["<=", "rank", e.rank_max],
  ]);
  return ["any", ["!in", "class", ...capped.map((e) => e.class)], ...caps];
}

/**
 * POI anchor layer id used by sections that insert layers relative to the
 * base-map POI stack. Defaults to Liberty's `poi_r20`; applyReplacePois
 * swaps it to the first replacement layer (outdoor-poi-z1) when it removes
 * poi_r20, so the interleaved non-POI sections keep stacking correctly.
 */
let poiAnchorId = "poi_r20";

// ── Apply functions (in render order, bottom→top) ───────────────────────

/**
 * Peak name + elevation labels from the OpenMapTiles `mountain_peak`
 * source-layer. Text only — no icon-image. Renders below the outdoor
 * POI layers so peaks stay below labels/icons. Gated by PEAK_LABELS.
 */
function applyPeakLabels(style) {
  const peakLayer = {
    id: "mountain-peak",
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "mountain_peak",
    minzoom: PEAK_LABEL_MINZOOM,
    filter: ["all", ["==", "$type", "Point"], ["==", "rank", 1]],
    layout: {
      "text-field": "{name:latin} {name:nonlatin}\n{ele} m\n▲",
      "text-font": ["Noto Sans Regular"],
      "text-anchor": "bottom",
      "text-offset": [0, 0.5],
      "text-max-width": 8,
      "text-size": PEAK_LABEL_TEXT_SIZE,
    },
    paint: {
      "text-color": COLOURS.PEAKS.TEXT,
      "text-halo-color": COLOURS.PEAKS.HALO,
      "text-halo-width": PEAK_LABEL_HALO_WIDTH,
      "text-halo-blur": PEAK_LABEL_HALO_BLUR,
    },
  };

  // Secondary peaks (rank 2–3), saddles, and volcanoes extend the rank-1
  // tier — inserted after mountain-peak so they render in the same block.
  const secondaryLayer = {
    id: "mountain-peak-secondary",
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "mountain_peak",
    minzoom: PEAK_RANK23_MINZOOM,
    filter: [
      "all",
      ["==", "$type", "Point"],
      [">=", "rank", 2],
      ["<=", "rank", 3],
    ],
    layout: {
      "text-field": "{name:latin} {name:nonlatin}\n{ele} m",
      "text-font": ["Noto Sans Regular"],
      "text-anchor": "bottom",
      "text-offset": [0, 0.4],
      "text-max-width": 8,
      "text-size": PEAK_RANK23_SIZE,
    },
    paint: {
      "text-color": COLOURS.PEAKS.TEXT,
      "text-halo-color": COLOURS.PEAKS.HALO,
      "text-halo-width": 0.8,
      "text-halo-blur": 1,
    },
  };

  const saddleLayer = {
    id: "mountain-saddle",
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "mountain_peak",
    minzoom: SADDLE_MINZOOM,
    filter: ["all", ["==", "$type", "Point"], ["==", "class", "saddle"]],
    layout: {
      "text-field": "{name:latin} {name:nonlatin}\n{ele} m\n—",
      "text-font": ["Noto Sans Regular"],
      "text-anchor": "bottom",
      "text-offset": [0, 0.4],
      "text-max-width": 8,
      "text-size": SADDLE_SIZE,
    },
    paint: {
      "text-color": COLOURS.PEAKS.SADDLE_TEXT,
      "text-halo-color": COLOURS.PEAKS.HALO,
      "text-halo-width": 0.8,
      "text-halo-blur": 1,
    },
  };

  const volcanoLayer = {
    id: "mountain-volcano",
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "mountain_peak",
    minzoom: VOLCANO_MINZOOM,
    filter: ["all", ["==", "$type", "Point"], ["==", "class", "volcano"]],
    layout: {
      "text-field": "{name:latin} {name:nonlatin}\n{ele} m",
      "text-font": ["Noto Sans Regular"],
      "text-anchor": "bottom",
      "text-offset": [0, 0.4],
      "text-max-width": 8,
      "text-size": PEAK_RANK1_SIZE,
    },
    paint: {
      "text-color": COLOURS.PEAKS.VOLCANO_COLOUR,
      "text-halo-color": COLOURS.PEAKS.HALO,
      "text-halo-width": 1,
      "text-halo-blur": 1,
    },
  };

  const peakLayers = [peakLayer, secondaryLayer, saddleLayer, volcanoLayer];

  const poiIdx = style.layers.findIndex((l) => l.id === poiAnchorId);
  if (poiIdx !== -1) {
    style.layers.splice(poiIdx, 0, ...peakLayers);
  } else {
    style.layers.push(...peakLayers);
  }
}

/**
 * Protected-area point labels (national park / nature reserve markers).
 * Gated by PARK_LABELS.
 */
function applyParkLabels(style) {
  const layer = {
    id: "park-label",
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "park",
    minzoom: PARK_LABEL_MINZOOM,
    filter: [
      "all",
      ["==", "$type", "Point"],
      ["<=", "rank", PARK_LABEL_MAX_RANK],
    ],
    layout: {
      "text-field": "{name:latin} {name:nonlatin}",
      "text-font": ["Noto Sans Regular"],
      "text-anchor": "top",
      "text-offset": [0, 0.5],
      "text-max-width": 8,
      "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 12, 13],
      "icon-image": "park",
      "icon-size": 0.6,
      "icon-optional": true,
    },
    paint: {
      "text-color": COLOURS.PARK.LABEL_TEXT,
      "text-halo-color": "rgba(255, 255, 255, 0.8)",
      "text-halo-width": 1,
      "text-halo-blur": 1,
    },
  };

  // Insert before the POI stack so park labels render below POI icons and
  // labels but above place labels.
  const poiIdx = style.layers.findIndex((l) => l.id === poiAnchorId);
  if (poiIdx !== -1) {
    style.layers.splice(poiIdx, 0, layer);
  } else {
    style.layers.push(layer);
  }
}

/**
 * Outdoor POIs from the self-hosted outdoor_pois tiles (huts, shelters,
 * water, parking, viewpoints, passes, campsites, etc.). The icon-image
 * match and text-field both come from the catalogue's custom entries.
 * Gated by OUTDOOR_POI.
 */
function applyOutdoorPoi(style) {
  style.sources["outdoor-poi"] = {
    type: "vector",
    tiles: [POI_TILE_URL],
    minzoom: POI_SOURCE_MINZOOM,
    maxzoom: POI_SOURCE_MAXZOOM,
    attribution: TILES_ATTRIBUTION,
  };

  const poiLayer = {
    id: "outdoor-poi",
    type: "symbol",
    source: "outdoor-poi",
    "source-layer": POI_SOURCE_LAYER,
    layout: {
      "icon-image": poiIconMatch(CUSTOM_ENTRIES, "kind"),
      "icon-size": POI_ICON_SIZE,
      "text-field": poiTextField(CUSTOM_ENTRIES, "kind"),
      "text-size": POI_TEXT_SIZE,
      "text-font": ["Noto Sans Regular"],
      "text-offset": POI_TEXT_OFFSET,
      "text-anchor": "top",
    },
    paint: {
      "text-color": COLOURS.POI.TEXT,
      "text-halo-color": COLOURS.POI.HALO,
      "text-halo-width": POI_TEXT_HALO_WIDTH,
      "icon-opacity": POI_ICON_OPACITY,
    },
  };

  // Insert at the POI anchor — above outdoor-route lines (so icons &
  // labels stay readable) but below base-map POIs and place labels.
  const poiIdx = style.layers.findIndex((l) => l.id === poiAnchorId);
  if (poiIdx !== -1) {
    style.layers.splice(poiIdx, 0, poiLayer);
  } else {
    style.layers.push(poiLayer);
  }
}

/**
 * Outdoor-filtered base-map POI tiers replacing the Liberty poi_r1/r7/r20
 * layers. Class allowlists, icon-image and the rank caps (park, bus, post)
 * all derive from the catalogue; poi_transit is re-filtered to rail &
 * airport only. Gated by REPLACE_LIBERTY_POIS.
 */
function applyReplacePois(style) {
  const z1Filter = [
    "all",
    ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false],
    ["match", ["get", "class"], tier1Classes, true, false],
  ];
  const rankCap = rankCapCondition(TIER1_ENTRIES);
  if (rankCap) z1Filter.push(rankCap);

  const z2Filter = [
    "all",
    ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false],
    ["match", ["get", "class"], tier2Classes, true, false],
  ];
  const rankCapZ2 = rankCapCondition(TIER2_ENTRIES);
  if (rankCapZ2) z2Filter.push(rankCapZ2);

  const z1Layer = {
    id: "outdoor-poi-z1",
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "poi",
    minzoom: 12,
    filter: z1Filter,
    layout: {
      "icon-image": poiIconMatch(TIER1_ENTRIES, "class"),
      "icon-size": POI_ICON_SIZE,
      "text-field": poiTextField(TIER1_ENTRIES, "class"),
      "text-font": ["Noto Sans Regular"],
      "text-size": 10,
      "text-offset": POI_TEXT_OFFSET,
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "icon-opacity": POI_ICON_OPACITY,
      "text-color": COLOURS.POI.TEXT,
      "text-halo-color": COLOURS.POI.HALO,
      "text-halo-width": POI_TEXT_HALO_WIDTH,
    },
  };

  const z2Layer = {
    id: "outdoor-poi-z2",
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "poi",
    minzoom: 14,
    filter: z2Filter,
    layout: {
      "icon-image": poiIconMatch(TIER2_ENTRIES, "class"),
      "icon-size": POI_ICON_SIZE,
      "text-field": poiTextField(TIER2_ENTRIES, "class"),
      "text-font": ["Noto Sans Regular"],
      "text-size": 10,
      "text-offset": POI_TEXT_OFFSET,
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "icon-opacity": 0.8,
      "text-color": COLOURS.POI.TEXT,
      "text-halo-color": COLOURS.POI.HALO,
      "text-halo-width": POI_TEXT_HALO_WIDTH,
    },
  };

  // Capture where poi_r20 sat before removing the old layers, so the new
  // tiers replace the old POI block's position in the stack.
  const removedPoiIds = ["poi_r1", "poi_r7", "poi_r20"];
  const poiAnchorIdx = style.layers.findIndex((l) => l.id === "poi_r20");
  let insertAt = -1;
  if (poiAnchorIdx !== -1) {
    const removedBefore = style.layers
      .slice(0, poiAnchorIdx)
      .filter((l) => removedPoiIds.includes(l.id)).length;
    insertAt = poiAnchorIdx - removedBefore;
  }

  style.layers = style.layers.filter((l) => !removedPoiIds.includes(l.id));

  // Simplify poi_transit — drop the bus class, keep rail & airport only.
  const transitLayer = style.layers.find((l) => l.id === "poi_transit");
  if (transitLayer) {
    transitLayer.filter = ["all", ["in", "class", "railway", "airport"]];
  }

  const newPoiLayers = [z1Layer, z2Layer];
  if (insertAt !== -1) {
    style.layers.splice(insertAt, 0, ...newPoiLayers);
  } else {
    const labelCityIdx = style.layers.findIndex((l) => l.id === "label_city");
    if (labelCityIdx !== -1) {
      style.layers.splice(labelCityIdx, 0, ...newPoiLayers);
    } else {
      style.layers.push(...newPoiLayers);
    }
  }

  // Re-anchor later sections (routes, paths, MTB, etc.) to the first
  // replacement layer now that poi_r20 is gone.
  poiAnchorId = z1Layer.id;
}

// ═════════════════════════════════════════════════════════════════════════
// Liberty fetch — download from GitHub with local cache
// ═════════════════════════════════════════════════════════════════════════

/**
 * Fetch the liberty base style — from local cache if up-to-date,
 * otherwise from GitHub.
 *
 * Cache invalidation uses the HTTP ETag from GitHub's raw content
 * response. On each build:
 *   1. Send a conditional GET with `If-None-Match` set to the cached ETag.
 *   2. If the server returns 304 (Not Modified), the cache is fresh.
 *   3. If it returns 200, the file changed — download and re-cache.
 *   4. If the network is unavailable, fall back to cache with a warning.
 *
 * This means the style auto-updates when upstream changes, works
 * offline (when cached), and requires no manual version management.
 */
async function fetchLiberty() {
  const headers = {};
  const cachedEtag = existsSync(CACHE_META_FILE)
    ? readFileSync(CACHE_META_FILE, "utf8").trim()
    : null;

  if (cachedEtag) {
    headers["If-None-Match"] = cachedEtag;
  }

  let res;
  try {
    res = await fetch(LIBERTY_URL, { headers });
  } catch (err) {
    if (existsSync(CACHE_FILE)) {
      console.warn(
        `[build] network error, using cached liberty style: ${err.message}`,
      );
      return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    }
    throw new Error(
      `Failed to fetch liberty style (no cache available): ${err.message}`,
    );
  }

  if (res.status === 304 && existsSync(CACHE_FILE)) {
    console.log("[build] liberty style unchanged (304), using cache");
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  }

  if (!res.ok) {
    if (existsSync(CACHE_FILE)) {
      console.warn(
        `[build] server returned ${res.status}, using cached liberty style`,
      );
      return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    }
    throw new Error(
      `Failed to fetch liberty style: ${res.status} ${res.statusText}`,
    );
  }

  console.log("[build] liberty style updated, fetching from GitHub");
  const text = await res.text();
  const etag = res.headers.get("etag") || "";

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, text, "utf8");
  writeFileSync(CACHE_META_FILE, etag, "utf8");
  console.log(`[build] cached liberty style to ${CACHE_FILE}`);

  return JSON.parse(text);
}

// ═════════════════════════════════════════════════════════════════════════
// Build — read & deep-clone the base style, apply outdoor modifications
// ═════════════════════════════════════════════════════════════════════════
// Sections are ordered bottom→top in the render stack, matching the
// order of the feature toggles and per-feature config blocks above.
// Each section only runs when its toggle is enabled.

async function build() {
  const liberty = await fetchLiberty();

  // Always keep a fresh resolved copy in the cache
  const resolvedLiberty = finalizeStyle(liberty);
  writeFileSync(
    CACHE_PROCESSED_FILE,
    `${JSON.stringify(resolvedLiberty, null, 2)}\n`,
    "utf8",
  );

  // Deep-clone the base style, declaring the root-level identity keys
  // first so they are prepended in JSON output. (Assigning `style.name`
  // to an existing object would append the key last instead.) `name` and
  // `metadata` are root properties per the MapLibre style spec:
  // https://maplibre.org/maplibre-style-spec/root/
  // Liberty currently ships neither key, so the spread never overwrites.
  const style = {
    name: STYLE_NAME,
    metadata: STYLE_METADATA,
    ...JSON.parse(JSON.stringify(liberty)),
  };

  // 1. Urban removal — one-way arrows + US shields
  if (REMOVE_URBAN_LAYERS) applyUrbanRemoval(style);

  // 2. Base terrain palette
  if (TERRAIN_PALETTE) applyTerrainPalette(style);

  // 3. DEM — raster-dem source, hillshade & terrain (all gated on DEM)
  if (DEM) {
    applyDemSource(style);
    if (DEM_HILLSHADE) applyDemHillshade(style);
    if (DEM_TERRAIN) applyDemTerrain(style);
  }

  // 4. Landcover — rock, farmland, grass subclass
  if (LANDCOVER_ROCK) applyLandcoverRock(style);
  if (LANDCOVER_FARMLAND) applyLandcoverFarmland(style);
  if (LANDCOVER_SUBCLASS) applyLandcoverSubclass(style);

  // 5. Landuse — military/quarry warning fills + recreation
  if (LANDUSE_MILITARY_QUARRY) applyMilitaryQuarry(style);
  if (LANDUSE_RECREATION) applyRecreation(style);

  // 6. Park differentiation — national_park vs nature_reserve + labels
  if (PARK_DIFFERENTIATION) applyParkDifferentiation(style);

  // 7. Water palette — water colour + swimming_pool differentiation
  if (WATER_PALETTE) applyWaterPalette(style);

  // 8. Road surface-aware hierarchy (replaces Liberty road layers)
  if (ROAD_SURFACE_AWARE) applyRoadSurfaceAware(style);

  // 9. Building outlines — 2D stroke-only (replaces building + building-3d)
  if (BUILDING_OUTLINES) applyBuildingOutlines(style);

  // 10. Aerialways — ski lifts, gondolas, cable cars
  if (AERIALWAY) applyAerialway(style);

  // 11. Ferries — shipway ferry routes
  if (FERRY) applyFerry(style);

  // 12. Rail simplified — strip bridge/tunnel rail variants
  if (RAIL_SIMPLIFIED) applyRailSimplified(style);

  // 13. Contours — hosted PBF contour vector tiles + labels
  if (CONTOURS) applyContours(style);

  // 14. POI section (see the POI SECTION block above) — the label functions
  //     below insert below the POI stack: peaks, park-label and contour-labels
  //     run before applyReplacePois (they need the Liberty poi_r20 anchor),
  //     and applyReplacePois runs before the non-POI sections below so
  //     outdoor-poi-z1/z2 anchor at the top of the POI stack.
  //     reorderContourLabelStack (step 22) then repositions the
  //     contour/peak/park block above the POI tiers. Custom outdoor-poi
  //     (applyOutdoorPoi) stays with the non-POI sections below — it must sit
  //     above routes but below MTB to preserve the layer stack.
  if (PEAK_LABELS) applyPeakLabels(style);

  // 15. Park labels — protected-area point labels
  if (PARK_LABELS) applyParkLabels(style);

  // 15b. Contour labels — inserted below the POI stack here; step 22 moves it
  //      above the POI tiers so contour labels beat POIs but lose to peaks
  //      and park labels.
  if (CONTOURS) applyContourLabels(style);

  // 16. Replaced liberty POIs — catalogue-driven outdoor-filtered tiers
  if (REPLACE_LIBERTY_POIS) applyReplacePois(style);

  // 17. Low-zoom paths overlay (z9–13) — non-POI; sits below the route
  //     layers and the custom outdoor-poi layer in the stack.
  if (LOW_ZOOM_PATHS) applyLowZoomPaths(style);

  // 18. Outdoor routes (hiking route relations) — non-POI; sits between the
  //     paths overlay and the custom outdoor-poi layer.
  if (OUTDOOR_ROUTE) applyOutdoorRoute(style);

  // 19. Custom outdoor POIs (external vector tiles) — part of the POI
  //     section; called here (above routes, below MTB) to preserve the stack.
  if (OUTDOOR_POI) applyOutdoorPoi(style);

  // 20. MTB scale + bicycle access — non-POI; sits between the custom
  //     outdoor-poi layer and outdoor-poi-z1/z2.
  if (MTB_SCALE) applyMtbScale(style);

  // 21. Path & trail styling
  if (PATH_STYLING) applyPathStyling(style);

  // 22. Label-stack fix-up — reposition contour-labels / peaks / park-label
  //     directly above the POI tiers (see reorderContourLabelStack).
  reorderContourLabelStack(style);

  // ═════════════════════════════════════════════════════════════════════
  // Write — substitute tile domain placeholders at build time so the
  // runtime app doesn't need to.
  // ═════════════════════════════════════════════════════════════════════

  migrateLibertyFilters(style);
  const builtStyle = finalizeStyle(style);
  writeFileSync(
    OUTDOOR_STYLE,
    `${JSON.stringify(builtStyle, null, 2)}\n`,
    "utf8",
  );

  // Validate the built style against the MapLibre GL style spec so a
  // build can never emit an invalid style.json.
  try {
    validateStyle(OUTDOOR_STYLE);
  } catch (err) {
    console.error(`\n✗ style.json failed spec validation:\n${err.message}`);
    process.exit(1);
  }

  console.log(`✓ outdoor style written to ${OUTDOOR_STYLE}`);
  console.log(
    `  layers: ${style.layers.length} (was ${liberty.layers.length})`,
  );
  console.log(
    `  sources: ${Object.keys(style.sources).length} (was ${Object.keys(liberty.sources).length})`,
  );
}

// ═════════════════════════════════════════════════════════════════════════
// CLI — one-shot build
// ═════════════════════════════════════════════════════════════════════════

await build();
