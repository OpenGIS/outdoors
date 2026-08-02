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
 * Feature toggles at the top enable/disable each section. Per-feature
 * config blocks follow in the same render order. Both outdoor overlay
 * sections (POIs & routes) derive their tile URLs from a single
 * configurable endpoint, TILES_BASE_URL — change that one constant to
 * point at the production tile server.
 *
 * Sections are ordered from bottom to top in the render stack:
 *  satellite → terrain palette → road palette → DEM (hillshade, terrain) →
 *  contours → waymarked trails → mountain peak labels → promoted liberty pois →
 *  outdoor routes → outdoor pois → mtb/bicycle → path styling
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUTDOOR_STYLE = resolve(ROOT, "style.json");

// ═════════════════════════════════════════════════════════════════════════
// FEATURE TOGGLES (in rendering order, bottom→top)
// ═════════════════════════════════════════════════════════════════════════
// Flip these to enable/disable each feature section.

const SATELLITE = false; // ESRI World Satellite raster base layer
const DEM = true; // raster-dem source (Mapterhorn) — shared elevation source
const DEM_HILLSHADE = true; // 2D hillshade layer from the DEM source
const DEM_TERRAIN = false; // 3D terrain exaggeration from the DEM source
const TERRAIN_PALETTE = true; // Muted base-layer colour palette (MapTiler terrain reference)
const ROAD_PALETTE = true; // Muted warm-taupe road palette (outdoor-first: local roads & tracks most visible)
const CONTOURS_MODE = "pbf"; // Contour lines: "pbf" (ogis.app tiles) | "plugin" (GPU) | "disabled"
const WAYMARKED_ACTIVITIES = []; // Raster overlays, e.g. ['hiking', 'cycling']
const PEAK_LABELS = true; // Peak name + elevation labels (below promoted POIs)
const PROMOTE_LIBERTY_POI = true; // Promote selected base-map POIs to lower zoom
const OUTDOOR_ROUTE = true; // Hiking route overlay (self-hosted vector tiles)
const OUTDOOR_POI = true; // Outdoor POIs overlay (self-hosted vector tiles)
const MTB_SCALE = false; // MTB difficulty + bicycle access overlays
const PROMOTE_PATHS = true; // Paths/trails visible at all zoom levels

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

  // Roads — muted warm-taupe road palette (applied by applyRoadPalette)
  ROADS: {
    MAJOR: "rgb(228, 219, 201)", // lightest, most recessive — motorway/trunk/primary (+ motorway links)
    MEDIUM: "rgb(223, 211, 188)", // secondary/tertiary/links
    LOCAL: "rgb(217, 203, 176)", // darkest of the roads, clearly lighter than contour browns — minor/service/track/street
    CASING: "rgb(183, 168, 145)", // all non-path casing layers — darker than fills, keeps road outline crisp
  },

  // Contour lines & labels
  CONTOURS: {
    MINOR: "rgb(198, 170, 138)", // soft sand-brown — minor contour lines
    INDEX: "rgb(164, 130, 94)", // medium topo brown — index contour lines
    LABEL: "#5c4634", // dark umber — elevation labels
    HALO: "rgba(255, 255, 255, 0.5)", // semi-transparent white — label halo
  },

  // Mountain peak labels
  PEAKS: { TEXT: "#333333", HALO: "#ffffff" },

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
// Both outdoor overlay features (routes & POIs) read their tile URLs from
// the single TILES_BASE_URL endpoint — see the self-hosted tiles block.

// ── Satellite imagery ──────────────────────────────────────────────────
// ESRI World Satellite (ArcGIS Online) — CORS-permissive, no API key.

const SATELLITE_OPACITY = 0.3;
const SATELLITE_LANDCOVER_OPACITY = 1;
const SATELLITE_SOURCE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const SATELLITE_SOURCE_TILESIZE = 256;
const SATELLITE_SOURCE_MAXZOOM = 19;
const SATELLITE_SOURCE_ATTRIBUTION =
  "Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";

// ── DEM (raster-dem source) ──────────────────────────────────────────
// The raster-dem source feeds the hillshade layer and 3D terrain.
// Mapterhorn (Terrarium, 512px, maxzoom 15):
//   https://tiles.mapterhorn.com/{z}/{x}/{y}.webp

const DEM_SOURCE_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const DEM_SOURCE_ENCODING = "terrarium";
const DEM_SOURCE_TILESIZE = 512;
const DEM_SOURCE_MAXZOOM = 15;
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
// Muted warm-taupe road colours (see COLOURS.ROADS) applied by
// applyRoadPalette(). Tunnel fills stay faded so their dashes read
// clearly; track/service fills are thickened to suit outdoor use.

const ROAD_TUNNEL_OPACITY = 0.55; // line-opacity for tunnel fills (faded, dashes preserved)
const ROAD_TRACK_WIDTH = ["interpolate", ["exponential", 1.2], ["zoom"], 14, 0.5, 15, 1.5, 16, 3, 20, 9]; // line-width for service/track fills (appears ~1.5 zooms earlier than Liberty, thicker)

// ── Contours ─────────────────────────────────────────────────────────
// Mode selected by the CONTOURS_MODE feature toggle (see toggles above):
//   "plugin"   = maplibre-contour plugin (GPU-generated, client-side via Web Worker)
//   "pbf"      = PBF vector tiles from the ogis.app hosted contour service
//   "disabled" = no contour source or layers in the style

// Shared styling — used by both plugin and PBF modes
const CONTOUR_WIDTH_MINOR = [
  "interpolate",
  ["exponential", 1.2],
  ["zoom"],
  12,
  0.5,
  14,
  1.0,
];
const CONTOUR_WIDTH_INDEX = [
  "interpolate",
  ["exponential", 1.2],
  ["zoom"],
  12,
  0.7,
  14,
  1.1,
];
const CONTOUR_OPACITY_MINOR = [
  "interpolate",
  ["linear"],
  ["zoom"],
  12,
  0.4,
  14,
  0.5,
];
const CONTOUR_OPACITY_INDEX = [
  "interpolate",
  ["linear"],
  ["zoom"],
  12,
  0.55,
  14,
  0.7,
];
const CONTOUR_LAYER_MAXZOOM = 20;

// Label expression — always metric at build time.
// Runtime scripts/contours.js patches "m" → "ft" for imperial units.
const CONTOUR_LABEL_EXPR = [
  "concat",
  ["number-format", ["round", ["get", "ele"]], {}],
  "m",
];

// PBF mode — only used when CONTOURS_MODE = "pbf"
// ogis.app hosted contour service (contour-mvt-server — z9–14)
const CONTOUR_PBF_TILE_URL =
  "https://api.ogis.app/contours/terrain/{z}/{x}/{y}.pbf";
const CONTOUR_PBF_SOURCE_MINZOOM = 9;
const CONTOUR_PBF_SOURCE_MAXZOOM = 14;

// Plugin mode — only used when CONTOURS_MODE = "plugin"
// Thresholds define contour intervals: [minor_interval, major_interval]
// in metres at each zoom level.
const CONTOUR_PLUGIN_SOURCE_MINZOOM = 9;
const CONTOUR_PLUGIN_SOURCE_MAXZOOM = 20;
const CONTOUR_PLUGIN_THRESHOLDS = {
  9: [500, 2500],
  11: [200, 1000],
  12: [100, 500],
  14: [50, 200],
  15: [20, 100],
};
const CONTOUR_PLUGIN_EXTRA_OPTIONS = {
  contourLayer: "contours",
  elevationKey: "ele",
  levelKey: "level",
  extent: 4096,
  buffer: 1,
  overzoom: 1,
};
const CONTOUR_PLUGIN_PROTOCOL_ID = "dem"; // Must match DemSource.setupMaplibre() id at runtime

// ── Mountain peak labels ─────────────────────────────────────────────
// Peak name + elevation labels from the OpenMapTiles mountain_peak
// source-layer. Text only — no icon-image.

const PEAK_LABEL_MINZOOM = 7;
const PEAK_LABEL_TEXT_SIZE = 11;
const PEAK_LABEL_HALO_WIDTH = 1;
const PEAK_LABEL_HALO_BLUR = 1;

// ── Promoted liberty POIs ────────────────────────────────────────────
// Display selected base-map POIs at lower zooms (z12–14) rather than
// waiting for the regular poi layer at z15.

const PROMOTED_POI_MINZOOM = 12;
const PROMOTED_POI_MAXZOOM = 15;
const PROMOTED_POI_CLASSES = [
  "restaurant",
  "cafe",
  "fast_food",
  "pub",
  "bar",
  "grocery",
  "ice_cream",
  "toilets",
  "drinking_water",
  "information",
  "shelter",
  "picnic_site",
  "parking",
  "bus",
  "ferry",
  "fuel",
  "pharmacy",
  "hospital",
  "doctors",
  "bank",
  "atm",
  "post",
  "lodging",
  "campsite",
];

// ── Self-hosted outdoor vector tiles ────────────────────────────────
// One configurable endpoint serves BOTH the outdoor POI and route tiles
// (`/pois/...` and `/routes/...`).

const TILES_BASE_URL = "https://api.ogis.app/features";
const TILES_ATTRIBUTION = "© OpenStreetMap contributors";

// ── Outdoor routes (hiking route relations) ──────────────────────────
// Vector tiles with hiking route relations from OSM — line geometry
// with network classification (iwn/nwn/rwn/lwn), ref, name, etc.
// Source-layer: 'outdoor_routes'. Self-hosted Planetiler tiles (z8–14).

const ROUTE_SOURCE_LAYER = "outdoor_routes";
const ROUTE_TILE_URL = `${TILES_BASE_URL}/routes/{z}/{x}/{y}.pbf`;
const ROUTE_SOURCE_MINZOOM = 8;
const ROUTE_SOURCE_MAXZOOM = 14;

// ── Outdoor POI ──────────────────────────────────────────────────────
// Vector tiles with outdoor points of interest — huts, shelters, water,
// parking, viewpoints, mountain passes, campsites, etc.
// Source-layer: 'outdoor_pois'. Self-hosted Planetiler tiles (z12–18).

const POI_SOURCE_LAYER = "outdoor_pois";
const POI_TILE_URL = `${TILES_BASE_URL}/pois/{z}/{x}/{y}.pbf`;
const POI_SOURCE_MINZOOM = 12;
const POI_SOURCE_MAXZOOM = 18;

// POI style settings — icon + label rendering for the outdoor-poi layer
const POI_ICON_SIZE = 1;
const POI_ICON_OPACITY = 0.85;
const POI_TEXT_SIZE = 11;
const POI_TEXT_OFFSET = [0, 1.5];
const POI_TEXT_HALO_WIDTH = 1;
// Icon shown per `kind` value (Liberty sprite icon names); POI_ICON_DEFAULT
// is the fallback for unmapped kinds.
const POI_ICON_BY_KIND = {
  water: "drinking_water",
  hut: "lodging",
  shelter: "shelter",
  parking: "parking",
  viewpoint: "star_stroked",
  pass: "mountain",
  picnic_site: "picnic_site",
  information: "information",
  toilets: "toilets",
  ranger_station: "ranger_station",
  campsite: "campsite",
  playground: "playground",
  skiing: "skiing",
  ferry: "ferry",
  bicycle: "bicycle_rental",
  trailhead: "entrance",
  bus_stop: "bus",
  cable_car: "aerialway",
  halt: "railway",
  station: "railway",
  tram_stop: "railway_light",
  guest_house: "lodging",
  hotel: "lodging",
  pub: "bar",
  town: "town_hall",
  village: "town_hall",
  hamlet: "town_hall",
};
const POI_ICON_DEFAULT = "marker";

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
 * Build the full maplibre-contour plugin tile URL with encoded thresholds
 * and options baked into the query string. Produces URLs like:
 *   dem-contour://{z}/{x}/{y}?buffer=1&contourLayer=contours&...&thresholds=0*100*500~...
 */
function buildContourTileUrl(id, thresholds, extraOptions) {
  const thresholdStr = Object.entries(thresholds)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([zoom, values]) => [zoom, ...values].join("*"))
    .join("~");

  const allOpts = { ...extraOptions, thresholds: thresholdStr };

  const query = Object.keys(allOpts)
    .sort()
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(String(allOpts[k]))}`,
    )
    .join("&");

  return `${id}-contour://{z}/{x}/{y}?${query}`;
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
 * Override the Liberty base-layer road colours with the muted road
 * palette (see COLOURS.ROADS). Skips any layer id that isn't found in
 * the base style, so the build stays robust if upstream renames or
 * removes a layer. Tunnel fills are faded (dashes preserved); the
 * service/track fills are thickened for outdoor use.
 */
function applyRoadPalette(style) {
  const set = (id, paintKey, value) => {
    const layer = style.layers.find((l) => l.id === id);
    if (!layer) return;
    layer.paint = layer.paint || {};
    layer.paint[paintKey] = value;
  };

  // Fills → MAJOR (motorway/trunk/primary + motorway links)
  for (const id of [
    "road_motorway",
    "road_trunk_primary",
    "road_motorway_link",
    "bridge_motorway",
    "bridge_trunk_primary",
    "bridge_motorway_link",
    "tunnel_motorway",
    "tunnel_trunk_primary",
    "tunnel_motorway_link",
  ]) {
    set(id, "line-color", COLOURS.ROADS.MAJOR);
  }

  // Fills → MEDIUM (secondary/tertiary/links)
  for (const id of [
    "road_secondary_tertiary",
    "road_link",
    "bridge_secondary_tertiary",
    "bridge_link",
    "tunnel_secondary_tertiary",
    "tunnel_link",
  ]) {
    set(id, "line-color", COLOURS.ROADS.MEDIUM);
  }

  // Fills → LOCAL (minor/service/track/street)
  for (const id of [
    "road_minor",
    "road_service_track",
    "bridge_street",
    "bridge_service_track",
    "tunnel_minor",
    "tunnel_service_track",
  ]) {
    set(id, "line-color", COLOURS.ROADS.LOCAL);
  }

  // Casings → CASING (all non-path casing layers)
  for (const id of [
    "tunnel_motorway_link_casing",
    "tunnel_service_track_casing",
    "tunnel_link_casing",
    "tunnel_street_casing",
    "tunnel_secondary_tertiary_casing",
    "tunnel_trunk_primary_casing",
    "tunnel_motorway_casing",
    "road_motorway_link_casing",
    "road_service_track_casing",
    "road_link_casing",
    "road_minor_casing",
    "road_secondary_tertiary_casing",
    "road_trunk_primary_casing",
    "road_motorway_casing",
    "bridge_motorway_link_casing",
    "bridge_service_track_casing",
    "bridge_link_casing",
    "bridge_street_casing",
    "bridge_secondary_tertiary_casing",
    "bridge_trunk_primary_casing",
    "bridge_motorway_casing",
  ]) {
    set(id, "line-color", COLOURS.ROADS.CASING);
  }

  // Tunnel fills — faded, but their dash arrays are left untouched
  for (const id of [
    "tunnel_motorway",
    "tunnel_trunk_primary",
    "tunnel_motorway_link",
    "tunnel_secondary_tertiary",
    "tunnel_link",
    "tunnel_minor",
    "tunnel_service_track",
  ]) {
    set(id, "line-opacity", ROAD_TUNNEL_OPACITY);
  }

  // Service/track fills — thicker line-width (appears earlier than Liberty)
  for (const id of [
    "road_service_track",
    "tunnel_service_track",
    "bridge_service_track",
  ]) {
    set(id, "line-width", ROAD_TRACK_WIDTH);
  }
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

  const resolved = finalizeStyle(JSON.parse(text));
  writeFileSync(
    CACHE_PROCESSED_FILE,
    `${JSON.stringify(resolved, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `[build] cached resolved liberty style to ${CACHE_PROCESSED_FILE}`,
  );

  return JSON.parse(text);
}

// ═════════════════════════════════════════════════════════════════════════
// Build — read & deep-clone the base style, apply outdoor modifications
// ═════════════════════════════════════════════════════════════════════════
// Sections are ordered bottom→top in the render stack, matching the
// order of the feature toggles and per-feature config blocks above.

async function build() {
  const liberty = await fetchLiberty();

  // Always keep a fresh resolved copy in the cache
  const resolvedLiberty = finalizeStyle(liberty);
  writeFileSync(
    CACHE_PROCESSED_FILE,
    `${JSON.stringify(resolvedLiberty, null, 2)}\n`,
    "utf8",
  );

  const style = JSON.parse(JSON.stringify(liberty));

  // ═════════════════════════════════════════════════════════════════════
  // 1. Satellite imagery — ESRI World Satellite raster base layer
  // ═════════════════════════════════════════════════════════════════════
  // Adds a semi-transparent satellite raster overlay at the bottom of the
  // render stack (between the background / Natural Earth and everything
  // else). When enabled, landcover and water fill opacities are reduced
  // by SATELLITE_LANDCOVER_OPACITY to let the satellite show through.

  if (SATELLITE) {
    style.sources.satellite = {
      type: "raster",
      tiles: [SATELLITE_SOURCE_URL],
      tileSize: SATELLITE_SOURCE_TILESIZE,
      maxzoom: SATELLITE_SOURCE_MAXZOOM,
      attribution: SATELLITE_SOURCE_ATTRIBUTION,
    };

    const neIdx = style.layers.findIndex((l) => l.id === "natural_earth");
    const insertAt = neIdx !== -1 ? neIdx + 1 : 1;
    style.layers.splice(insertAt, 0, {
      id: "satellite",
      type: "raster",
      source: "satellite",
      paint: {
        "raster-opacity": SATELLITE_OPACITY,
      },
    });

    for (const layer of style.layers) {
      if (layer.source !== "openmaptiles") continue;

      const isLandWaterLayer =
        layer.id.startsWith("landcover_") ||
        layer.id.startsWith("landuse_") ||
        layer.id.startsWith("water") ||
        layer.id.startsWith("park") ||
        layer.id === "landcover_sand" ||
        layer.id.startsWith("aeroway_");

      if (!isLandWaterLayer) continue;

      if (layer.type === "fill") {
        const existing = layer.paint && layer.paint["fill-opacity"];
        layer.paint = layer.paint || {};
        layer.paint["fill-opacity"] =
          existing !== undefined
            ? ["*", existing, SATELLITE_LANDCOVER_OPACITY]
            : SATELLITE_LANDCOVER_OPACITY;
      } else if (layer.type === "line") {
        const existing = layer.paint && layer.paint["line-opacity"];
        layer.paint = layer.paint || {};
        layer.paint["line-opacity"] =
          existing !== undefined
            ? ["*", existing, SATELLITE_LANDCOVER_OPACITY]
            : SATELLITE_LANDCOVER_OPACITY;
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // 2. Base terrain palette
  // ═════════════════════════════════════════════════════════════════════
  // Overrides the Liberty base colours (background, water, landcover,
  // landuse, buildings) with the muted MapTiler terrain-reference palette
  // so overlays read clearly on top.

  if (TERRAIN_PALETTE) applyTerrainPalette(style);

  // ═════════════════════════════════════════════════════════════════════
  // 3. Road colour palette
  // ═════════════════════════════════════════════════════════════════════
  // Overrides the Liberty base road colours with the muted warm-taupe
  // palette (see COLOURS.ROADS) so local roads & tracks read clearly.

  if (ROAD_PALETTE) applyRoadPalette(style);

  // ═════════════════════════════════════════════════════════════════════
  // 4. DEM — raster-dem source, hillshade & terrain
  // ═════════════════════════════════════════════════════════════════════
  // One raster-dem source (demSource) feeds two granular features, both
  // gated on the DEM master toggle:
  //   DEM_HILLSHADE — a 2D hillshade layer (fades in from z3 to z5+),
  //                   rendered above landcover/landuse, below contours/water
  //   DEM_TERRAIN   — 3D terrain elevation (style.terrain.exaggeration)

  if (DEM) {
    style.sources.demSource = {
      type: "raster-dem",
      tiles: [DEM_SOURCE_URL],
      encoding: DEM_SOURCE_ENCODING,
      tileSize: DEM_SOURCE_TILESIZE,
      maxzoom: DEM_SOURCE_MAXZOOM,
    };

    if (DEM_HILLSHADE) {
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

    if (DEM_TERRAIN) {
      style.terrain = {
        source: "demSource",
        exaggeration: TERRAIN_EXAGGERATION,
      };
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // 5. Contours
  // ═════════════════════════════════════════════════════════════════════
  // Mode selected by CONTOURS_MODE:
  //
  // "plugin" — maplibre-contour plugin (GPU-generated, client-side).
  //   The plugin is registered at runtime by scripts/contours.js. It
  //   intercepts dem-contour:// tile requests and generates contour vector
  //   tiles from raw DEM data in a Web Worker.
  //
  // "pbf" — standard Mapbox Vector Tiles served as
  //   application/x-protobuf. No client-side contour generation.
  //
  // "disabled" — no contour source or layers are added to the style.

  if (CONTOURS_MODE === "plugin") {
    const url = buildContourTileUrl(
      CONTOUR_PLUGIN_PROTOCOL_ID,
      CONTOUR_PLUGIN_THRESHOLDS,
      CONTOUR_PLUGIN_EXTRA_OPTIONS,
    );

    style.sources["contour-source"] = {
      type: "vector",
      minzoom: CONTOUR_PLUGIN_SOURCE_MINZOOM,
      tiles: [url],
      maxzoom: CONTOUR_PLUGIN_SOURCE_MAXZOOM,
    };

    const contourLayers = [
      {
        id: "contour-lines",
        type: "line",
        source: "contour-source",
        "source-layer": "contours",
        minzoom: CONTOUR_PLUGIN_SOURCE_MINZOOM,
        maxzoom: CONTOUR_LAYER_MAXZOOM,
        filter: ["==", ["get", "level"], 0],
        paint: {
          "line-color": COLOURS.CONTOURS.MINOR,
          "line-opacity": CONTOUR_OPACITY_MINOR,
          "line-width": CONTOUR_WIDTH_MINOR,
        },
      },
      {
        id: "contour-lines-index",
        type: "line",
        source: "contour-source",
        "source-layer": "contours",
        minzoom: CONTOUR_PLUGIN_SOURCE_MINZOOM,
        maxzoom: CONTOUR_LAYER_MAXZOOM,
        filter: [">", ["get", "level"], 0],
        paint: {
          "line-color": COLOURS.CONTOURS.INDEX,
          "line-opacity": CONTOUR_OPACITY_INDEX,
          "line-width": CONTOUR_WIDTH_INDEX,
        },
      },
      {
        id: "contour-labels",
        type: "symbol",
        source: "contour-source",
        "source-layer": "contours",
        minzoom: CONTOUR_PLUGIN_SOURCE_MINZOOM,
        maxzoom: CONTOUR_LAYER_MAXZOOM,
        filter: [">", ["get", "level"], 0],
        layout: {
          "symbol-placement": "line",
          "symbol-avoid-edges": true,
          "text-rotation-alignment": "map",
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 14, 12],
          "text-field": CONTOUR_LABEL_EXPR,
          "text-font": ["Noto Sans Regular"],
          "text-padding": 10,
        },
        paint: {
          "text-color": COLOURS.CONTOURS.LABEL,
          "text-halo-color": COLOURS.CONTOURS.HALO,
          "text-halo-width": 1.25,
        },
      },
    ];

    const contourIdx = waterStackIndex(style);
    if (contourIdx !== -1) {
      style.layers.splice(contourIdx, 0, ...contourLayers);
    } else {
      style.layers.push(...contourLayers);
    }
  } else if (CONTOURS_MODE === "pbf") {
    style.sources["contour-source"] = {
      type: "vector",
      minzoom: CONTOUR_PBF_SOURCE_MINZOOM,
      tiles: [CONTOUR_PBF_TILE_URL],
      maxzoom: CONTOUR_PBF_SOURCE_MAXZOOM,
    };

    const contourLayers = [
      {
        id: "contour-lines",
        type: "line",
        source: "contour-source",
        "source-layer": "contours",
        minzoom: CONTOUR_PBF_SOURCE_MINZOOM,
        maxzoom: CONTOUR_LAYER_MAXZOOM,
        filter: [
          "all",
          ["!=", ["%", ["get", "ele"], 100], 0],
          [">", ["get", "ele"], 0],
        ],
        paint: {
          "line-color": COLOURS.CONTOURS.MINOR,
          "line-opacity": CONTOUR_OPACITY_MINOR,
          "line-width": CONTOUR_WIDTH_MINOR,
        },
      },
      {
        id: "contour-lines-index",
        type: "line",
        source: "contour-source",
        "source-layer": "contours",
        minzoom: CONTOUR_PBF_SOURCE_MINZOOM,
        maxzoom: CONTOUR_LAYER_MAXZOOM,
        filter: [
          "all",
          ["==", ["%", ["get", "ele"], 100], 0],
          [">", ["get", "ele"], 0],
        ],
        paint: {
          "line-color": COLOURS.CONTOURS.INDEX,
          "line-opacity": CONTOUR_OPACITY_INDEX,
          "line-width": CONTOUR_WIDTH_INDEX,
        },
      },
      {
        id: "contour-labels",
        type: "symbol",
        source: "contour-source",
        "source-layer": "contours",
        minzoom: CONTOUR_PBF_SOURCE_MINZOOM,
        maxzoom: CONTOUR_LAYER_MAXZOOM,
        filter: [
          "all",
          ["==", ["%", ["get", "ele"], 100], 0],
          [">", ["get", "ele"], 0],
        ],
        layout: {
          "symbol-placement": "line",
          "symbol-avoid-edges": true,
          "text-rotation-alignment": "map",
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 14, 12],
          "text-field": CONTOUR_LABEL_EXPR,
          "text-font": ["Noto Sans Regular"],
          "text-padding": 10,
        },
        paint: {
          "text-color": COLOURS.CONTOURS.LABEL,
          "text-halo-color": COLOURS.CONTOURS.HALO,
          "text-halo-width": 1.25,
        },
      },
    ];

    const contourIdx = waterStackIndex(style);
    if (contourIdx !== -1) {
      style.layers.splice(contourIdx, 0, ...contourLayers);
    } else {
      style.layers.push(...contourLayers);
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // 6. Waymarked Trails
  // ═════════════════════════════════════════════════════════════════════

  for (const activity of WAYMARKED_ACTIVITIES) {
    const sourceId = `waymarked-${activity}`;
    style.sources[sourceId] = {
      type: "raster",
      tiles: [`https://tile.waymarkedtrails.org/${activity}/{z}/{x}/{y}.png`],
      tileSize: 256,
      attribution: "© waymarkedtrails.org",
    };
    style.layers.push({
      id: `${sourceId}-layer`,
      type: "raster",
      source: sourceId,
      paint: { "raster-opacity": 0.7 },
    });
  }

  // ═════════════════════════════════════════════════════════════════════
  // 8. Mountain peak labels
  // ═════════════════════════════════════════════════════════════════════
  // Peak name + elevation labels from the OpenMapTiles `mountain_peak`
  // source-layer. Text only — no icon-image. Renders below the promoted
  // POIs so peaks stay below labels/icons.

  if (PEAK_LABELS) {
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

    const poiIdx = style.layers.findIndex((l) => l.id === "poi_r20");
    if (poiIdx !== -1) {
      style.layers.splice(poiIdx, 0, peakLayer);
    } else {
      style.layers.push(peakLayer);
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // 9. Promoted liberty POIs — outdoor-relevant POIs at lower zoom
  // ═════════════════════════════════════════════════════════════════════
  // Promotes selected POI classes from the OpenMapTiles `poi` source-layer
  // (toilets, restaurants, pubs, grocery stores, etc.) so they appear at
  // z12–14 instead of waiting for the regular poi_r1 layer at z15.

  if (PROMOTE_LIBERTY_POI) {
    const promotedLayer = {
      id: "poi-outdoor-promoted",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "poi",
      minzoom: PROMOTED_POI_MINZOOM,
      maxzoom: PROMOTED_POI_MAXZOOM,
      filter: [
        "all",
        ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false],
        ["match", ["get", "class"], PROMOTED_POI_CLASSES, true, false],
      ],
      layout: {
        "icon-image": [
          "match",
          ["get", "subclass"],
          ["florist", "furniture"],
          ["get", "subclass"],
          ["get", "class"],
        ],
        "icon-size": 1,
        "text-field": "",
      },
      paint: {
        "icon-opacity": 0.85,
      },
    };

    const poiIdx = style.layers.findIndex((l) => l.id === "poi_r20");
    if (poiIdx !== -1) {
      style.layers.splice(poiIdx, 0, promotedLayer);
    } else {
      style.layers.push(promotedLayer);
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // 10. Outdoor routes (hiking route relations)
  // ═════════════════════════════════════════════════════════════════════
  // Vector tiles with hiking route relations from OSM — line geometry
  // with network classification (iwn/nwn/rwn/lwn), ref, name, etc.
  // Source-layer: 'outdoor_routes'. Self-hosted Planetiler tiles (z8–14).

  if (OUTDOOR_ROUTE) {
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

    // Insert below the base-map POI layers (poi_r20 anchor) so route lines
    // render above roads/water but below POI icons & labels.
    const poiIdx = style.layers.findIndex((l) => l.id === "poi_r20");
    if (poiIdx !== -1) {
      style.layers.splice(poiIdx, 0, ...routeLayers);
    } else {
      style.layers.push(...routeLayers);
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // 11. Outdoor POIs (external vector tiles)
  // ═════════════════════════════════════════════════════════════════════
  // Vector tiles with outdoor points of interest — huts, shelters, water,
  // parking, viewpoints, mountain passes, campsites, etc.
  // Source-layer: 'outdoor_pois'. Self-hosted Planetiler tiles (z12–18).

  if (OUTDOOR_POI) {
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
        "icon-image": [
          "match",
          ["get", "kind"],
          ...Object.entries(POI_ICON_BY_KIND).flat(),
          POI_ICON_DEFAULT,
        ],
        "icon-size": POI_ICON_SIZE,
        "text-field": ["get", "name"],
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

    // Insert at the poi_r20 anchor — above outdoor-route lines (so icons &
    // labels stay readable) but below base-map POIs and place labels.
    const poiIdx = style.layers.findIndex((l) => l.id === "poi_r20");
    if (poiIdx !== -1) {
      style.layers.splice(poiIdx, 0, poiLayer);
    } else {
      style.layers.push(poiLayer);
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // 12. Activity overlays (MTB / bicycle)
  // ═════════════════════════════════════════════════════════════════════
  // Inserted before poi_r20 in the layer stack.

  if (MTB_SCALE) {
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

    const poiIdx = style.layers.findIndex((l) => l.id === "poi_r20");
    if (poiIdx !== -1) {
      style.layers.splice(poiIdx, 0, bicycleLayer, mtbLayer);
    } else {
      style.layers.push(bicycleLayer, mtbLayer);
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // 13. Path & trail styling
  // ═════════════════════════════════════════════════════════════════════

  if (PROMOTE_PATHS) {
    const pathLayer = style.layers.find((l) => l.id === "road_path_pedestrian");
    if (pathLayer) {
      pathLayer.minzoom = 0;
      pathLayer.maxzoom = 22;
      pathLayer.paint = pathLayer.paint || {};
      pathLayer.paint["line-color"] = COLOURS.PATHS.PATH;
      if (MTB_SCALE) {
        pathLayer.paint["line-opacity"] = ["case", ["has", "mtb_scale"], 0, 1];
      }
      pathLayer.paint["line-width"] = [
        "interpolate",
        ["exponential", 1.2],
        ["zoom"],
        12,
        1,
        14,
        2,
        20,
        8,
      ];
    }

    const nameLayer = style.layers.find((l) => l.id === "highway-name-path");
    if (nameLayer) {
      nameLayer.minzoom = 0;
      nameLayer.maxzoom = 22;
      nameLayer.paint = nameLayer.paint || {};
      nameLayer.paint["text-color"] = COLOURS.PATHS.PATH;
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // Write — substitute tile domain placeholders at build time so the
  // runtime app doesn't need to.
  // ═════════════════════════════════════════════════════════════════════

  const builtStyle = finalizeStyle(style);
  writeFileSync(
    OUTDOOR_STYLE,
    `${JSON.stringify(builtStyle, null, 2)}\n`,
    "utf8",
  );

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
