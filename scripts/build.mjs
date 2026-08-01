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
 * config blocks follow in the same render order. Data source URL
 * selectors (e.g. ROUTE_SOURCE = "trailsplits" | "local") swap
 * providers without changing any section logic.
 *
 * Sections are ordered from bottom to top in the render stack:
 *   satellite → terrain → contours → waymarked trails →
 *   trailsplits hiking network → promoted liberty pois →
 *   outdoor pois → outdoor routes → mtb/bicycle → path styling
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
const TERRAIN = false; // 3D terrain hillshading (raster DEM)
const WAYMARKED_ACTIVITIES = []; // Raster overlays, e.g. ['hiking', 'cycling']
const TRAILSPLITS_HIKING_TRAILS = false; // TrailSplits hiking network overlay (vector tiles)
const PROMOTE_LIBERTY_POI = true; // Promote selected base-map POIs to lower zoom
const OUTDOOR_POI = false; // Outdoor POIs overlay (vector tiles)
const OUTDOOR_ROUTE = false; // Hiking route overlay (vector tiles)
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
// COLOURS
// ═════════════════════════════════════════════════════════════════════════

const COLOURS = {
  // Paths & trails
  PATH: "#c05a2a",

  // MTB scale difficulty overlay
  MTB_GRADE_1: "blue",
  MTB_GRADE_2: "red",
  MTB_GRADE_3_PLUS: "black",

  // Bicycle access overlay
  BICYCLE_ACCESS: "#8c64bd",

  // Contour lines & labels
  CONTOUR_MINOR: "rgb(190, 186, 180)",
  CONTOUR_INDEX: "rgb(180, 175, 170)",
  CONTOUR_LABEL: "#4a4a4a",
  CONTOUR_HALO: "rgba(255, 255, 255, 0.85)",

  // Hiking route network tiers
  ROUTE_IWN: "#b20303",
  ROUTE_NWN: "#152eec",
  ROUTE_RWN: "#ffa304",
  ROUTE_RWN_CASING: "#a76f0f",
  ROUTE_LWN: "#7d31c6",
  ROUTE_LWN_HALO: "#c19ae6",
  ROUTE_DEFAULT: "#b2b2b2",
};

// ── Route network tier paint configs ──────────────────────────────────
// Shared by both outdoor-route-* and trailsplits-hiking-* sections.
// Each tier has colour, opacity, width, and minzoom.

const ROUTE_TIERS = {
  iwn: {
    color: COLOURS.ROUTE_IWN,
    opacity: 0.7,
    minzoom: 8,
    width: ["interpolate", ["linear"], ["zoom"], 8, 3, 10, 4, 12, 5],
  },
  nwn: {
    color: COLOURS.ROUTE_NWN,
    opacity: 0.7,
    minzoom: 8,
    width: ["interpolate", ["linear"], ["zoom"], 8, 2, 10, 3, 12, 4],
  },
  rwn: {
    color: COLOURS.ROUTE_RWN,
    opacity: 0.8,
    minzoom: 10,
    width: ["interpolate", ["linear"], ["zoom"], 10, 2, 12, 3],
    casing: {
      color: COLOURS.ROUTE_RWN_CASING,
      opacity: 0.35,
      width: ["interpolate", ["linear"], ["zoom"], 10, 5, 12, 7],
    },
  },
  lwn: {
    color: COLOURS.ROUTE_LWN,
    opacity: 0.8,
    minzoom: 12,
    width: 1.5,
    halo: {
      color: COLOURS.ROUTE_LWN_HALO,
      opacity: 0.4,
      width: 4,
      minzoom: 12,
    },
  },
};

const ROUTE_TIER_DEFAULT = {
  color: COLOURS.ROUTE_DEFAULT,
  opacity: 0.5,
  width: 1.0,
  minzoom: 12,
};

// ═════════════════════════════════════════════════════════════════════════
// PER-FEATURE CONFIG (in rendering order, bottom→top)
// ═════════════════════════════════════════════════════════════════════════
// Each feature's constants are grouped before its build logic below.
// Data source selectors like POI_SOURCE accept "local" (self-hosted) or
// "trailsplits" (free API, no key required).

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

// ── Terrain DEM (raster-elevation) ────────────────────────────────────
// Mapterhorn (Terrarium, 512px, maxzoom 15):
//   https://tiles.mapterhorn.com/{z}/{x}/{y}.webp

const TERRAIN_SOURCE_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const TERRAIN_SOURCE_ENCODING = "terrarium";
const TERRAIN_SOURCE_TILESIZE = 512;
const TERRAIN_SOURCE_MAXZOOM = 15;

// ── Contours ─────────────────────────────────────────────────────────
// Mode: true = maplibre-contour plugin (GPU-generated, client-side via Web Worker)
//       false = PBF vector tiles (server-generated, standard MVT)

const CONTOURS_USE_PLUGIN = false;

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

// PBF mode — only used when CONTOURS_USE_PLUGIN = false
// "local" = self-hosted contour-mvt-server (goes to z14)
// "ogis" = ogis.app hosted contour service (same contour-mvt-server — z14)
const CONTOUR_PBF_SOURCE = "ogis";
const CONTOUR_PBF_TILE_URL =
  CONTOUR_PBF_SOURCE === "local"
    ? "http://localhost:11001/contours/terrain/{z}/{x}/{y}.pbf"
    : "https://api.ogis.app/contours/terrain/{z}/{x}/{y}.pbf";
const CONTOUR_PBF_SOURCE_MINZOOM = 9;
const CONTOUR_PBF_SOURCE_MAXZOOM = 14;

// Plugin mode — only used when CONTOURS_USE_PLUGIN = true
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

// ── TrailSplits hiking network ───────────────────────────────────────
// Vector tile overlay from the free TrailSplits API (no key required).
// Reference: https://trailsplits.com/api

const TRAILSPLITS_HIKING_URL =
  "https://api.trailsplits.com/tiles/v1/hiking-network/current/{z}/{x}/{y}.pbf";
const TRAILSPLITS_HIKING_MINZOOM = 8;

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

// ── Outdoor POI ──────────────────────────────────────────────────────
// Vector tiles with outdoor points of interest — huts, shelters, water,
// parking, viewpoints, mountain passes, campsites, etc.
// Source-layer: 'outdoor_pois'.
// "local" = self-hosted Planetiler tiles (z8–16, wider zoom range)
// "trailsplits" = TrailSplits API (free, no key — z12–14)

const POI_SOURCE = "trailsplits";
const POI_LOCAL_URL = "http://localhost:11002/pois/{z}/{x}/{y}.pbf";
const POI_REMOTE_URL =
  "https://api.trailsplits.com/tiles/v1/outdoor-pois/current/{z}/{x}/{y}.pbf";
const POI_TILE_URL = POI_SOURCE === "local" ? POI_LOCAL_URL : POI_REMOTE_URL;
const POI_SOURCE_MINZOOM = 12;
const POI_SOURCE_MAXZOOM = POI_SOURCE === "local" ? 18 : 14;

// ── Outdoor routes (hiking route relations) ──────────────────────────
// Vector tiles with hiking route relations from OSM — line geometry
// with network classification (iwn/nwn/rwn/lwn), ref, name, etc.
// Source-layer: 'outdoor_routes' (local) or 'hiking_network' (TrailSplits).
// "local" = self-hosted Planetiler tiles (z8–14, wider zoom range)
// "trailsplits" = TrailSplits API (free, no key — z8–12)

const ROUTE_SOURCE = "trailsplits";
const ROUTE_LOCAL_URL = "http://localhost:11002/routes/{z}/{x}/{y}.pbf";
const ROUTE_REMOTE_URL =
  "https://api.trailsplits.com/tiles/v1/hiking-network/current/{z}/{x}/{y}.pbf";
const ROUTE_TILE_URL =
  ROUTE_SOURCE === "local" ? ROUTE_LOCAL_URL : ROUTE_REMOTE_URL;
const ROUTE_SOURCE_MINZOOM = 8;
const ROUTE_SOURCE_MAXZOOM = ROUTE_SOURCE === "local" ? 14 : 12;

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
 * Shared by outdoor-route and trailsplits-hiking sections.
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
 * Shared by outdoor-route and trailsplits-hiking sections.
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
  // 2. Terrain & hillshade
  // ═════════════════════════════════════════════════════════════════════

  if (TERRAIN) {
    style.sources.terrainSource = {
      type: "raster-dem",
      tiles: [TERRAIN_SOURCE_URL],
      encoding: TERRAIN_SOURCE_ENCODING,
      tileSize: TERRAIN_SOURCE_TILESIZE,
      maxzoom: TERRAIN_SOURCE_MAXZOOM,
    };
    style.terrain = { source: "terrainSource", exaggeration: 1.5 };
    style.layers.push({
      id: "hillshade-layer",
      type: "hillshade",
      source: "terrainSource",
      paint: { "hillshade-exaggeration": 0.2 },
    });
  }

  // ═════════════════════════════════════════════════════════════════════
  // 3. Contours
  // ═════════════════════════════════════════════════════════════════════
  // Two modes selected by CONTOURS_USE_PLUGIN:
  //
  // Plugin mode (true) — maplibre-contour plugin (GPU-generated, client-side).
  //   The plugin is registered at runtime by scripts/contours.js. It
  //   intercepts dem-contour:// tile requests and generates contour vector
  //   tiles from raw DEM data in a Web Worker.
  //
  // PBF mode (false) — standard Mapbox Vector Tiles served as
  //   application/x-protobuf. No client-side contour generation.

  if (CONTOURS_USE_PLUGIN) {
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

    style.layers.push(
      {
        id: "contour-lines",
        type: "line",
        source: "contour-source",
        "source-layer": "contours",
        minzoom: CONTOUR_PLUGIN_SOURCE_MINZOOM,
        maxzoom: CONTOUR_LAYER_MAXZOOM,
        filter: ["==", ["get", "level"], 0],
        paint: {
          "line-color": COLOURS.CONTOUR_MINOR,
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
          "line-color": COLOURS.CONTOUR_INDEX,
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
          "text-padding": 0,
        },
        paint: {
          "text-color": COLOURS.CONTOUR_LABEL,
          "text-halo-color": COLOURS.CONTOUR_HALO,
          "text-halo-width": 1.25,
        },
      },
    );
  }

  if (!CONTOURS_USE_PLUGIN) {
    style.sources["contour-source"] = {
      type: "vector",
      minzoom: CONTOUR_PBF_SOURCE_MINZOOM,
      tiles: [CONTOUR_PBF_TILE_URL],
      maxzoom: CONTOUR_PBF_SOURCE_MAXZOOM,
    };

    style.layers.push(
      {
        id: "contour-lines",
        type: "line",
        source: "contour-source",
        "source-layer": "contours",
        minzoom: CONTOUR_PBF_SOURCE_MINZOOM,
        maxzoom: CONTOUR_LAYER_MAXZOOM,
        filter: ["!=", ["%", ["get", "ele"], 100], 0],
        paint: {
          "line-color": COLOURS.CONTOUR_MINOR,
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
        filter: ["==", ["%", ["get", "ele"], 100], 0],
        paint: {
          "line-color": COLOURS.CONTOUR_INDEX,
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
        filter: ["==", ["%", ["get", "ele"], 100], 0],
        layout: {
          "symbol-placement": "line",
          "symbol-avoid-edges": true,
          "text-rotation-alignment": "map",
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 14, 12],
          "text-field": CONTOUR_LABEL_EXPR,
          "text-font": ["Noto Sans Regular"],
          "text-padding": 0,
        },
        paint: {
          "text-color": COLOURS.CONTOUR_LABEL,
          "text-halo-color": COLOURS.CONTOUR_HALO,
          "text-halo-width": 1.25,
        },
      },
    );
  }

  // ═════════════════════════════════════════════════════════════════════
  // 4. Waymarked Trails
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
  // 5. TrailSplits hiking network
  // ═════════════════════════════════════════════════════════════════════

  if (TRAILSPLITS_HIKING_TRAILS) {
    style.sources["trailsplits-hiking"] = {
      type: "vector",
      tiles: [TRAILSPLITS_HIKING_URL],
      minzoom: 8,
      maxzoom: 12,
      attribution: "© TrailSplits",
    };

    const tsLayers = createAllRouteLayers(
      "trailsplits-hiking",
      "hiking_network",
      ROUTE_TIERS,
      ROUTE_TIER_DEFAULT,
      TRAILSPLITS_HIKING_MINZOOM,
    );

    style.layers.push(...tsLayers);
  }

  // ═════════════════════════════════════════════════════════════════════
  // 6. Promoted liberty POIs — outdoor-relevant POIs at lower zoom
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
  // 7. Outdoor POIs (external vector tiles)
  // ═════════════════════════════════════════════════════════════════════
  // Vector tiles with outdoor points of interest — huts, shelters, water,
  // parking, viewpoints, mountain passes, campsites, etc.
  // Source-layer: 'outdoor_pois'.

  if (OUTDOOR_POI) {
    style.sources["outdoor-poi"] = {
      type: "vector",
      tiles: [POI_TILE_URL],
      minzoom: POI_SOURCE_MINZOOM,
      maxzoom: POI_SOURCE_MAXZOOM,
      attribution:
        POI_SOURCE === "local"
          ? "© OpenStreetMap contributors"
          : "© TrailSplits",
    };

    style.layers.push({
      id: "outdoor-poi",
      type: "symbol",
      source: "outdoor-poi",
      "source-layer": "outdoor_pois",
      layout: {
        "icon-image": [
          "match",
          ["get", "kind"],
          "water",
          "drinking_water",
          "hut",
          "lodging",
          "shelter",
          "shelter",
          "parking",
          "parking",
          "viewpoint",
          "star_stroked",
          "pass",
          "mountain",
          "picnic_site",
          "picnic_site",
          "information",
          "information",
          "toilets",
          "toilets",
          "ranger_station",
          "ranger_station",
          "campsite",
          "campsite",
          "playground",
          "playground",
          "skiing",
          "skiing",
          "ferry",
          "ferry",
          "bicycle",
          "bicycle_rental",
          "trailhead",
          "entrance",
          "bus_stop",
          "bus",
          "cable_car",
          "aerialway",
          "halt",
          "railway",
          "station",
          "railway",
          "tram_stop",
          "railway_light",
          "guest_house",
          "lodging",
          "hotel",
          "lodging",
          "pub",
          "bar",
          "town",
          "town_hall",
          "village",
          "town_hall",
          "hamlet",
          "town_hall",
          "marker",
        ],
        "icon-size": 1,
        "text-field": ["get", "name"],
        "text-size": 11,
        "text-font": ["Noto Sans Regular"],
        "text-offset": [0, 1.5],
        "text-anchor": "top",
      },
      paint: {
        "text-color": "#333333",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1,
        "icon-opacity": 0.85,
      },
    });
  }

  // ═════════════════════════════════════════════════════════════════════
  // 8. Outdoor routes (hiking route relations)
  // ═════════════════════════════════════════════════════════════════════
  // Vector tiles with hiking route relations from OSM — line geometry
  // with network classification (iwn/nwn/rwn/lwn), ref, name, etc.

  if (OUTDOOR_ROUTE) {
    const routeSourceLayer =
      ROUTE_SOURCE === "local" ? "outdoor_routes" : "hiking_network";

    style.sources["outdoor-route"] = {
      type: "vector",
      tiles: [ROUTE_TILE_URL],
      minzoom: ROUTE_SOURCE_MINZOOM,
      maxzoom: ROUTE_SOURCE_MAXZOOM,
      attribution:
        ROUTE_SOURCE === "local"
          ? "© OpenStreetMap contributors"
          : "© TrailSplits",
    };

    const routeLayers = createAllRouteLayers(
      "outdoor-route",
      routeSourceLayer,
      ROUTE_TIERS,
      ROUTE_TIER_DEFAULT,
    );

    style.layers.push(...routeLayers);
  }

  // ═════════════════════════════════════════════════════════════════════
  // 9. Activity overlays (MTB / bicycle)
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
          COLOURS.MTB_GRADE_1,
          "2",
          COLOURS.MTB_GRADE_2,
          COLOURS.MTB_GRADE_3_PLUS,
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
        "line-color": COLOURS.BICYCLE_ACCESS,
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
  // 10. Path & trail styling
  // ═════════════════════════════════════════════════════════════════════

  if (PROMOTE_PATHS) {
    const pathLayer = style.layers.find((l) => l.id === "road_path_pedestrian");
    if (pathLayer) {
      pathLayer.minzoom = 0;
      pathLayer.maxzoom = 22;
      pathLayer.paint = pathLayer.paint || {};
      pathLayer.paint["line-color"] = COLOURS.PATH;
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
      nameLayer.paint["text-color"] = COLOURS.PATH;
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
