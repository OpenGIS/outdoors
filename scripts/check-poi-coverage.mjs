#!/usr/bin/env node

/**
 * Slim coverage check for the outdoor-POI overlay (v2.0 refactor).
 *
 * Usage:
 *   node scripts/check-poi-coverage.mjs
 *
 * Three checks, all against the built style.json, the shared OUTDOOR_POI
 * config and the generated pois/pois-schema.yml:
 *
 *   [1] Sprite validation — every literal icon-image value used by the
 *       symbol layers of style.json must resolve against the sprite sheet it
 *       names. A value is split at its FIRST ":" into sheet id + name: the
 *       sheet id must be one of the style's sprite ids ("default" or
 *       "outdoors") and the name must exist in that sheet's json. Bare values
 *       (no ":") are "default" sheet references and must exist in the basemap
 *       sprite (fetched + ETag-cached from
 *       https://www.ogis.org/basemap/sprite.json, mirroring fetchBasemap in
 *       scripts/build.mjs) — never the union. The outdoors sheet is the local
 *       dev/public/sprite.json (built by scripts/build-sprite.mjs — run
 *       `npm run sprite:build` first). Token-template icon names
 *       ("{subclass}", "{class}") and dynamic expressions are resolved at
 *       render time, so they are skipped.
 *       Plus an orphan check: every icon key in dev/public/sprite.json must be
 *       referenced somewhere in style.json with the "outdoors:" prefix, so the
 *       outdoors sheet can never silently grow an icon that OUTDOOR_SPRITE_ICONS
 *       in scripts/build.mjs forgets.
 *   [2] Kind coverage — the outdoor-poi layer exists, references the
 *       outdoor-poi source, and every kind in OUTDOOR_POI.kinds appears in
 *       its filter.
 *   [3] Schema sync — the kind set in pois/pois-schema.yml matches
 *       OUTDOOR_POI.kinds.
 *   [4] Planet layer — the PLANET_POI layer (outdoor-amenities) exists in
 *       style.json with the correct source/source-layer/minzoom, its filter
 *       contains every PLANET_POI class, and every PLANET_POI icon resolves
 *       in its named sheet (covered by check [1] automatically).
 *
 * Exit code:
 *   0 — all checks pass
 *   1 — any check fails
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { OUTDOOR_POI, PLANET_POI } from "./poi-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CACHE_DIR = resolve(ROOT, ".cache");
const STYLE_FILE = resolve(ROOT, "style.json");
const SCHEMA_FILE = resolve(ROOT, "pois", "pois-schema.yml");

const SPRITE_URL = "https://www.ogis.org/basemap/sprite.json";
const SPRITE_CACHE = resolve(CACHE_DIR, "basemap-sprite.json");
const SPRITE_ETAG = resolve(CACHE_DIR, "basemap-sprite-etag.txt");

// The outdoors-owned sprite sheet, committed to dev/public by
// scripts/build-sprite.mjs (`npm run sprite:build`). It loads as its own
// sprite id ("outdoors") under style.sprite — see scripts/build.mjs — so
// its icons must be referenced as "outdoors:<name>". This check resolves
// each prefixed value against the named sheet, never the union.
const LOCAL_SPRITE = resolve(ROOT, "dev", "public", "sprite.json");

const OUTDOOR_SPRITE_ID = "outdoors";

// ─────────────────────────────────────────────────────────────────────
// Fetch with ETag conditional GET + cache (mirrors fetchBasemap in
// scripts/build.mjs).
// ─────────────────────────────────────────────────────────────────────

async function fetchWithCache(url, cachePath, etagPath, label) {
  const headers = {};
  const cachedEtag = existsSync(etagPath)
    ? readFileSync(etagPath, "utf8").trim()
    : null;
  if (cachedEtag) headers["If-None-Match"] = cachedEtag;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    if (existsSync(cachePath)) {
      console.warn(
        `[check] network error, using cached ${label}: ${err.message}`,
      );
      return { source: "cached", text: readFileSync(cachePath, "utf8") };
    }
    throw new Error(
      `Failed to fetch ${url} (no cache available): ${err.message}`,
    );
  }

  if (res.status === 304 && existsSync(cachePath)) {
    return { source: "cached", text: readFileSync(cachePath, "utf8") };
  }

  if (!res.ok) {
    if (existsSync(cachePath)) {
      console.warn(
        `[check] server returned ${res.status}, using cached ${label}`,
      );
      return { source: "cached", text: readFileSync(cachePath, "utf8") };
    }
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  const etag = res.headers.get("etag") || "";

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, text, "utf8");
  writeFileSync(etagPath, etag, "utf8");

  return { source: "fetched", text };
}

// ─────────────────────────────────────────────────────────────────────
// Sprite icon names — literal icon-image values from a layer layout.
// Plain strings, the VALUE positions of a match expression (never the
// keys), and the values of a legacy `{ stops: [...] }` function. Token
// templates ("{subclass}") and empty strings are skipped — they are
// resolved at render time. Other expressions (coalesce, image, step,
// get) are dynamic — skipped.
// ─────────────────────────────────────────────────────────────────────

function collectSpriteIconNames(img) {
  const names = new Set();
  if (typeof img === "string") {
    if (!/^{[^}]+}$/.test(img) && img.trim()) names.add(img);
    return names;
  }
  if (Array.isArray(img)) {
    if (img[0] === "match") {
      const tail = img.slice(2);
      for (let i = 1; i < tail.length; i += 2) {
        if (typeof tail[i] === "string" && tail[i].trim()) names.add(tail[i]);
      }
      if (tail.length % 2 === 1 && typeof tail[tail.length - 1] === "string") {
        names.add(tail[tail.length - 1]);
      }
    }
    return names;
  }
  if (img && typeof img === "object" && Array.isArray(img.stops)) {
    for (const [, value] of img.stops) {
      if (typeof value === "string" && value.trim()) names.add(value);
    }
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────
// Kind coverage — the kind literals of the outdoor-poi filter, from
// ["==", ["get", "kind"], <kind>] clauses at any nesting depth.
// ─────────────────────────────────────────────────────────────────────

function extractKindLiterals(filter) {
  const kinds = new Set();
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (
      node[0] === "==" &&
      Array.isArray(node[1]) &&
      node[1][0] === "get" &&
      node[1][1] === "kind" &&
      typeof node[2] === "string"
    ) {
      kinds.add(node[2]);
    }
    for (const child of node.slice(1)) walk(child);
  };
  walk(filter);
  return kinds;
}

// ─────────────────────────────────────────────────────────────────────
// Planet layer — the class literals of a ["in", ["get", "class"],
// ["literal", [...]]] filter.
// ─────────────────────────────────────────────────────────────────────

function extractClassLiterals(filter) {
  if (
    Array.isArray(filter) &&
    filter[0] === "in" &&
    Array.isArray(filter[1]) &&
    filter[1][0] === "get" &&
    filter[1][1] === "class" &&
    Array.isArray(filter[2]) &&
    filter[2][0] === "literal" &&
    Array.isArray(filter[2][1])
  ) {
    return new Set(filter[2][1]);
  }
  return new Set();
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

console.log("══════════════════════════════════════════════════════════════");
console.log(" Outdoor POI coverage check");
console.log("══════════════════════════════════════════════════════════════");
console.log();

const failures = [];

// ---- [1] Sprite validation ----------------------------------------------

console.log(
  "[1] Sprite validation — literal icon-image values vs the sheet they name",
);
const spriteData = await fetchWithCache(
  SPRITE_URL,
  SPRITE_CACHE,
  SPRITE_ETAG,
  "sprite",
);
const defaultSpriteKeys = new Set(Object.keys(JSON.parse(spriteData.text)));

if (!existsSync(LOCAL_SPRITE)) {
  console.error(
    `✗ ${LOCAL_SPRITE} not found — run \`npm run sprite:build\` first`,
  );
  process.exit(1);
}
const outdoorSpriteKeys = new Set(
  Object.keys(JSON.parse(readFileSync(LOCAL_SPRITE, "utf8"))),
);

// Per-sheet icon keys — "default" resolves against the fetched basemap
// sprite, the outdoors sheet against dev/public/sprite.json. MapLibre keys
// images from a non-default sheet as "<id>:<name>"; bare names only resolve
// against the default sheet. A prefixed value is split at its FIRST ":".
const sheetKeys = new Map([
  ["default", defaultSpriteKeys],
  [OUTDOOR_SPRITE_ID, outdoorSpriteKeys],
]);

const style = JSON.parse(readFileSync(STYLE_FILE, "utf8"));
const iconUsage = new Map();
for (const layer of style.layers) {
  if (layer.type !== "symbol") continue;
  const img = layer.layout?.["icon-image"];
  if (img === undefined) continue;
  for (const name of collectSpriteIconNames(img)) {
    if (!iconUsage.has(name)) iconUsage.set(name, new Set());
    iconUsage.get(name).add(layer.id);
  }
}

const spriteMissing = [];
for (const [fullName, layers] of iconUsage) {
  const idx = fullName.indexOf(":");
  const sheet = idx === -1 ? "default" : fullName.slice(0, idx);
  const name = idx === -1 ? fullName : fullName.slice(idx + 1);
  if (!sheetKeys.has(sheet)) {
    spriteMissing.push({
      name: fullName,
      layers: [...layers].sort(),
      note: `unknown sprite id "${sheet}" (valid: ${[...sheetKeys.keys()].join(", ")})`,
    });
    continue;
  }
  if (sheetKeys.get(sheet).has(name)) continue;
  spriteMissing.push({ name: fullName, layers: [...layers].sort() });
}

console.log(
  `  sprite: ${SPRITE_URL} (${spriteData.source}, ${defaultSpriteKeys.size} icons)`,
);
console.log(
  `  outdoors sprite: ${LOCAL_SPRITE} (${outdoorSpriteKeys.size} icons)`,
);
console.log(`  literal icon-image values scanned: ${iconUsage.size}`);
if (spriteMissing.length === 0) {
  console.log("  all icons present in their named sheet");
} else {
  for (const m of spriteMissing) {
    console.log(
      `  MISSING "${m.name}"${m.note ? ` (${m.note})` : ""} — used by: ${m.layers.join(", ")}`,
    );
    failures.push(
      `sprite icon "${m.name}"${m.note ? ` (${m.note})` : ""} (used by ${m.layers.join(", ")})`,
    );
  }
}
console.log();

// ---- [1b] Outdoors-sheet orphan check ------------------------------------

console.log(
  `[1b] Outdoors-sheet orphan check — every outdoors icon referenced as "${OUTDOOR_SPRITE_ID}:<name>"`,
);
const referencedOutdoor = new Set();
for (const fullName of iconUsage.keys()) {
  const idx = fullName.indexOf(":");
  if (idx !== -1 && fullName.slice(0, idx) === OUTDOOR_SPRITE_ID) {
    referencedOutdoor.add(fullName.slice(idx + 1));
  }
}
const orphanIcons = [...outdoorSpriteKeys].filter(
  (name) => !referencedOutdoor.has(name),
);
if (orphanIcons.length === 0) {
  console.log("  every outdoors icon is referenced in style.json");
} else {
  console.log(
    `  FAIL orphans in outdoors sheet: ${orphanIcons.join(", ")} — add them to OUTDOOR_SPRITE_ICONS in scripts/build.mjs`,
  );
  for (const name of orphanIcons) {
    failures.push(
      `outdoors sprite icon "${name}" not referenced with "${OUTDOOR_SPRITE_ID}:" prefix — OUTDOOR_SPRITE_ICONS missing it`,
    );
  }
}
console.log();

// ---- [2] Kind coverage ---------------------------------------------------

console.log("[2] Kind coverage — outdoor-poi layer vs OUTDOOR_POI.kinds");
const poiLayer = style.layers.find((l) => l.id === "outdoor-poi");
if (!poiLayer) {
  failures.push("outdoor-poi layer missing from style.json");
  console.log("  FAIL outdoor-poi layer missing from style.json");
} else {
  const sourceOk =
    poiLayer.source === OUTDOOR_POI.sourceId &&
    poiLayer["source-layer"] === OUTDOOR_POI.sourceLayer;
  const kindLiterals = extractKindLiterals(poiLayer.filter);
  const missingKinds = OUTDOOR_POI.kinds.filter(
    (k) => !kindLiterals.has(k.kind),
  );
  console.log(
    `  layer present, source reference ${sourceOk ? "ok" : "MISMATCH"}` +
      ` (${poiLayer.source}/${poiLayer["source-layer"]})`,
  );
  console.log(`  kinds in filter: ${[...kindLiterals].join(", ")}`);
  if (!sourceOk) {
    failures.push("outdoor-poi layer source/source-layer mismatch");
  }
  if (missingKinds.length > 0) {
    console.log(
      `  FAIL kinds missing from filter: ${missingKinds.map((k) => k.kind).join(", ")}`,
    );
    for (const k of missingKinds) {
      failures.push(`kind "${k.kind}" missing from outdoor-poi filter`);
    }
  } else {
    console.log("  all kinds present in filter");
  }
}
console.log();

// ---- [3] Schema sync -----------------------------------------------------

console.log("[3] Schema sync — pois-schema.yml kind set vs OUTDOOR_POI.kinds");
const schemaDoc = YAML.parse(readFileSync(SCHEMA_FILE, "utf8"));
const poiFeatures =
  schemaDoc.layers.find((l) => l.id === "outdoor_pois")?.features ?? [];
const schemaKinds = new Set(
  poiFeatures
    .map((f) => f.attributes?.find((a) => a.key === "kind")?.value)
    .filter(Boolean),
);
const configKinds = new Set(OUTDOOR_POI.kinds.map((k) => k.kind));
const missingFromSchema = [...configKinds].filter((k) => !schemaKinds.has(k));
const extraInSchema = [...schemaKinds].filter((k) => !configKinds.has(k));
console.log(`  schema kinds: ${[...schemaKinds].join(", ")}`);
if (missingFromSchema.length === 0 && extraInSchema.length === 0) {
  console.log("  kind sets match");
} else {
  if (missingFromSchema.length > 0) {
    console.log(
      `  FAIL kinds missing from schema: ${missingFromSchema.join(", ")}`,
    );
    for (const k of missingFromSchema)
      failures.push(`kind "${k}" missing from pois-schema.yml`);
  }
  if (extraInSchema.length > 0) {
    console.log(
      `  FAIL kinds in schema but not config: ${extraInSchema.join(", ")}`,
    );
    for (const k of extraInSchema)
      failures.push(`kind "${k}" in pois-schema.yml but not OUTDOOR_POI.kinds`);
  }
}
console.log();

// ---- [4] Planet layer -----------------------------------------------------

console.log("[4] Planet layer — outdoor-amenities vs PLANET_POI config");
const planetLayer = style.layers.find((l) => l.id === PLANET_POI.layerId);
if (!planetLayer) {
  failures.push(`${PLANET_POI.layerId} layer missing from style.json`);
  console.log(`  FAIL ${PLANET_POI.layerId} layer missing from style.json`);
} else {
  const sourceOk =
    planetLayer.source === PLANET_POI.sourceId &&
    planetLayer["source-layer"] === PLANET_POI.sourceLayer;
  const minzoomOk = planetLayer.minzoom === PLANET_POI.minzoom;
  const classLiterals = extractClassLiterals(planetLayer.filter);
  const missingClasses = PLANET_POI.kinds.filter(
    (k) => !classLiterals.has(k.class),
  );
  console.log(
    `  layer present, source reference ${sourceOk ? "ok" : "MISMATCH"}` +
      ` (${planetLayer.source}/${planetLayer["source-layer"]}),` +
      ` minzoom ${planetLayer.minzoom} ${minzoomOk ? "ok" : "MISMATCH"}`,
  );
  console.log(`  classes in filter: ${[...classLiterals].join(", ")}`);
  if (!sourceOk) {
    failures.push(`${PLANET_POI.layerId} layer source/source-layer mismatch`);
  }
  if (!minzoomOk) {
    failures.push(
      `${PLANET_POI.layerId} layer minzoom mismatch (expected ${PLANET_POI.minzoom})`,
    );
  }
  if (missingClasses.length > 0) {
    console.log(
      `  FAIL classes missing from filter: ${missingClasses.map((k) => k.class).join(", ")}`,
    );
    for (const k of missingClasses) {
      failures.push(
        `class "${k.class}" missing from ${PLANET_POI.layerId} filter`,
      );
    }
  } else {
    console.log("  all classes present in filter");
  }
}
console.log();

// ---- Summary + exit code -------------------------------------------------

if (failures.length === 0) {
  console.log(
    "✓ all checks pass — sprite icons present, all kinds covered, schema in sync, planet layer ok",
  );
  process.exitCode = 0;
} else {
  console.log(
    `✗ ${failures.length} failure${failures.length === 1 ? "" : "s"}:`,
  );
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
