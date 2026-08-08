#!/usr/bin/env node

/**
 * Validate style.json against the MapLibre GL style spec.
 *
 * Usage:
 *   node scripts/validate-style.mjs
 *
 * Reads style.json from the project root, runs validateStyleMin from
 * @maplibre/maplibre-gl-style-spec, and lists every problem found (one
 * per line, prefixed with the layer id when one is extractable). Exits
 * 1 when the style is invalid, 0 with a short success line when clean.
 *
 * The exported validateStyle() is also called by scripts/build.mjs after
 * every build so invalid output fails the build.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STYLE_PATH = resolve(__dirname, "..", "style.json");

/**
 * Read the style at stylePath and validate it against the MapLibre GL
 * style spec. Returns the parsed style when valid; throws an Error whose
 * message lists every problem (one per line) when invalid.
 */
export function validateStyle(stylePath) {
  const style = JSON.parse(readFileSync(stylePath, "utf8"));
  const errors = validateStyleMin(style);
  if (errors.length === 0) return style;
  throw new Error(errors.map((error) => formatError(error, style)).join("\n"));
}

function formatError(error, style) {
  const layerId = extractLayerId(error.message, style);
  return layerId ? `- ${layerId}: ${error.message}` : `- ${error.message}`;
}

function extractLayerId(message, style) {
  const match = /layers\[(\d+)\]/.exec(message);
  if (!match || !style.layers) return null;
  const layer = style.layers[Number(match[1])];
  return layer && layer.id ? layer.id : null;
}

// ── CLI (only when run directly) ────────────────────────────────────────

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    const style = validateStyle(STYLE_PATH);
    console.log(`style.json: valid (${style.layers.length} layers)`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
