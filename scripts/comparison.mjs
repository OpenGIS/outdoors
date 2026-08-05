#!/usr/bin/env node

/**
 * One-off script: generate a comparison style that is Liberty base +
 * our colour/style modifications ONLY — no extra data sources (no
 * DEM, contours, POIs, routes, paths overlay).
 *
 * This is NOT part of the regular build. It's a tool for comparing
 * the outdoor colour palette against the base Liberty theme to
 * understand how much the style has been reshaped.
 *
 * Output: .opencode/tmp/comparison-style.json
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Re-use the same colours and helper functions from build.mjs
// (copied here to keep this script self-contained)

const COLOURS = {
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
  ROADS: {
    MAJOR: "rgb(228, 219, 201)",
    MEDIUM: "rgb(223, 211, 188)",
    LOCAL: "rgb(255, 255, 255)",
    CASING: "rgb(183, 168, 145)",
    TRACK_CASING: "rgb(146, 118, 86)",
  },
  PATHS: { PATH: "#c05a2a" },
};

const PALETTE_PARK_OPACITY = 0.53;
const PALETTE_GRASS_OPACITY = 0.45;
const PALETTE_WOOD_OPACITY = 0.6;
const PALETTE_SAND_OPACITY = 0.3;
const PALETTE_RESIDENTIAL_OPACITY = 0.7;
const ROAD_TUNNEL_OPACITY = 0.55;
const ROAD_TRACK_LABEL_MINZOOM = 13;

const ROAD_TRACK_WIDTH = [
  "interpolate", ["exponential", 1.2], ["zoom"],
  12, 1, 13, 1.5, 14, 2, 15, 3, 16, 4, 20, 9.5,
];

const ROAD_TRACK_CASING_WIDTH = [
  "interpolate", ["exponential", 1.2], ["zoom"],
  12, 2, 13, 3, 14, 4, 15, 5.5, 16, 7, 20, 12.5,
];

const PATH_DASHARRAY = [1, 0.7];
const PATH_WIDTH = [
  "interpolate", ["exponential", 1.2], ["zoom"],
  12, 1, 14, 2, 20, 8,
];
const PATH_BASE_MINZOOM = 14;

function set(style, id, paintKey, value) {
  const layer = style.layers.find((l) => l.id === id);
  if (!layer) return;
  layer.paint = layer.paint || {};
  layer.paint[paintKey] = value;
}

function applyTerrainPalette(style) {
  set(style, "background", "background-color", COLOURS.TERRAIN.BACKGROUND);
  set(style, "water", "fill-color", COLOURS.TERRAIN.WATER);
  set(style, "waterway_tunnel", "line-color", COLOURS.TERRAIN.WATERWAY);
  set(style, "waterway_river", "line-color", COLOURS.TERRAIN.WATERWAY);
  set(style, "waterway_other", "line-color", COLOURS.TERRAIN.WATERWAY);
  set(style, "landcover_grass", "fill-color", COLOURS.TERRAIN.GRASS);
  set(style, "landcover_grass", "fill-opacity", PALETTE_GRASS_OPACITY);
  set(style, "landcover_wood", "fill-color", COLOURS.TERRAIN.WOOD);
  set(style, "landcover_wood", "fill-opacity", PALETTE_WOOD_OPACITY);
  set(style, "park", "fill-color", COLOURS.TERRAIN.PARK);
  set(style, "park", "fill-opacity", PALETTE_PARK_OPACITY);
  set(style, "landcover_ice", "fill-color", COLOURS.TERRAIN.ICE);
  set(style, "landcover_sand", "fill-color", COLOURS.TERRAIN.SAND);
  set(style, "landcover_sand", "fill-opacity", PALETTE_SAND_OPACITY);
  set(style, "landuse_residential", "fill-color", COLOURS.TERRAIN.RESIDENTIAL);
  set(style, "landuse_residential", "fill-opacity", PALETTE_RESIDENTIAL_OPACITY);
  set(style, "building", "fill-color", COLOURS.TERRAIN.BUILDINGS);
  set(style, "building-3d", "fill-extrusion-color", COLOURS.TERRAIN.BUILDINGS);
}

function applyRoadPalette(style) {
  // Fills → MAJOR
  for (const id of [
    "road_motorway", "road_trunk_primary", "road_motorway_link",
    "bridge_motorway", "bridge_trunk_primary", "bridge_motorway_link",
    "tunnel_motorway", "tunnel_trunk_primary", "tunnel_motorway_link",
  ]) set(style, id, "line-color", COLOURS.ROADS.MAJOR);

  // Fills → MEDIUM
  for (const id of [
    "road_secondary_tertiary", "road_link",
    "bridge_secondary_tertiary", "bridge_link",
    "tunnel_secondary_tertiary", "tunnel_link",
  ]) set(style, id, "line-color", COLOURS.ROADS.MEDIUM);

  // Fills → LOCAL
  for (const id of [
    "road_minor", "road_service_track",
    "bridge_street", "bridge_service_track",
    "tunnel_minor", "tunnel_service_track",
  ]) set(style, id, "line-color", COLOURS.ROADS.LOCAL);

  // Casings → CASING
  for (const id of [
    "tunnel_motorway_link_casing", "tunnel_service_track_casing",
    "tunnel_link_casing", "tunnel_street_casing",
    "tunnel_secondary_tertiary_casing", "tunnel_trunk_primary_casing",
    "tunnel_motorway_casing", "road_motorway_link_casing",
    "road_service_track_casing", "road_link_casing",
    "road_minor_casing", "road_secondary_tertiary_casing",
    "road_trunk_primary_casing", "road_motorway_casing",
    "bridge_motorway_link_casing", "bridge_service_track_casing",
    "bridge_link_casing", "bridge_street_casing",
    "bridge_secondary_tertiary_casing", "bridge_trunk_primary_casing",
    "bridge_motorway_casing",
  ]) set(style, id, "line-color", COLOURS.ROADS.CASING);

  // Track/service casings → TRACK_CASING
  for (const id of [
    "road_service_track_casing", "bridge_service_track_casing",
    "tunnel_service_track_casing",
  ]) {
    set(style, id, "line-color", COLOURS.ROADS.TRACK_CASING);
    set(style, id, "line-width", ROAD_TRACK_CASING_WIDTH);
  }

  // Tunnel fills → faded
  for (const id of [
    "tunnel_motorway", "tunnel_trunk_primary", "tunnel_motorway_link",
    "tunnel_secondary_tertiary", "tunnel_link",
    "tunnel_minor", "tunnel_service_track",
  ]) set(style, id, "line-opacity", ROAD_TUNNEL_OPACITY);

  // Service/track fills → thicker
  for (const id of [
    "road_service_track", "tunnel_service_track", "bridge_service_track",
  ]) set(style, id, "line-width", ROAD_TRACK_WIDTH);

  // Track labels → promoted
  const trackNameLayer = style.layers.find((l) => l.id === "highway-name-minor");
  if (trackNameLayer) trackNameLayer.minzoom = ROAD_TRACK_LABEL_MINZOOM;
}

function applyPathStyling(style) {
  const pathLayer = style.layers.find((l) => l.id === "road_path_pedestrian");
  if (pathLayer) {
    pathLayer.minzoom = PATH_BASE_MINZOOM;
    pathLayer.maxzoom = 22;
    pathLayer.paint = pathLayer.paint || {};
    pathLayer.paint["line-color"] = COLOURS.PATHS.PATH;
    pathLayer.paint["line-dasharray"] = PATH_DASHARRAY;
    pathLayer.paint["line-width"] = PATH_WIDTH;
    pathLayer.layout = pathLayer.layout || {};
    pathLayer.layout["line-cap"] = "round";
    pathLayer.layout["line-join"] = "round";
  }

  const nameLayer = style.layers.find((l) => l.id === "highway-name-path");
  if (nameLayer) {
    nameLayer.minzoom = 0;
    nameLayer.maxzoom = 22;
    nameLayer.paint = nameLayer.paint || {};
    nameLayer.paint["text-color"] = COLOURS.PATHS.PATH;
  }
}

// ── Main ──────────────────────────────────────────────────────────────

const libertySrc = readFileSync(
  resolve(ROOT, ".cache/liberty-processed.json"),
  "utf8",
);
const style = JSON.parse(libertySrc);

// Apply ONLY colour/palette modifications — no new sources, no new layers
applyTerrainPalette(style);
applyRoadPalette(style);
applyPathStyling(style);

// Remove Liberty's terrain if present (it doesn't have one, but just in case)
delete style.terrain;

const outDir = resolve(ROOT, ".opencode/tmp");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, "comparison-style.json");
writeFileSync(outPath, `${JSON.stringify(style, null, 2)}\n`, "utf8");

const baseLayers = JSON.parse(libertySrc).layers.length;
console.log(`✓ Comparison style written to ${outPath}`);
console.log(`  Layers: ${style.layers.length} (all from Liberty — zero additions)`);
console.log(`  Sources: ${Object.keys(style.sources).length} (Liberty base only)`);
console.log(`  Modifications: colour palette only — no DEM, contours, POIs, routes, paths overlay`);
console.log(`  Terrain: removed`);
