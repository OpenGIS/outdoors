#!/usr/bin/env node

/**
 * Build the outdoors-owned MapLibre sprite sheet from build/icons/.
 *
 * Runs the native spreet tool (brew flother/taps/spreet — the same tool the
 * basemap repo uses via openmaptiles-tools docker) over the rendered SVG icons
 * in build/icons/, writing the standard 1x sheet plus the @2x retina sheet into
 * dev/public so Vite serves both at the dev server root, the screenshot
 * harness can reach them, and the production build copies them to dist/.
 *
 * Usage:
 *   node scripts/build-sprite.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paletteIconNames, writeIcons } from "./palette.mjs";
import { writeSpriteLock } from "./sprite-lock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const ICONS_DIR = resolve(PROJECT_ROOT, "build", "icons");
const OUT_DIR = resolve(PROJECT_ROOT, "dev", "public");

const SPRITE_JSON = resolve(OUT_DIR, "sprite.json");

try {
  execFileSync("spreet", ["--version"], { stdio: "ignore" });
} catch {
  console.error(
    "spreet not found — install with: brew install flother/taps/spreet",
  );
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

writeIcons();

execFileSync("spreet", [ICONS_DIR, resolve(OUT_DIR, "sprite")], {
  stdio: "inherit",
});
execFileSync("spreet", ["--retina", ICONS_DIR, resolve(OUT_DIR, "sprite@2x")], {
  stdio: "inherit",
});

const spriteIcons = Object.keys(JSON.parse(readFileSync(SPRITE_JSON, "utf8")));
const sorted = [...spriteIcons].sort();
const expected = paletteIconNames();
if (
  sorted.length !== expected.length ||
  sorted.some((name, i) => name !== expected[i])
) {
  console.error(
    `✗ sprite icon mismatch — expected [${expected.join(", ")}], got [${sorted.join(", ")}]`,
  );
  process.exit(1);
}

writeSpriteLock();

console.log(
  `✓ sprite built with ${spriteIcons.length} icons: ${spriteIcons.join(", ")}`,
);
