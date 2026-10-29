#!/usr/bin/env node

/**
 * Check the screenshot set without rendering anything.
 *
 * Usage:
 *   node scripts/screenshots/check.mjs            # structural checks
 *   node scripts/screenshots/check.mjs --stale    # also check freshness
 *
 * Structural checks validate `shots.json`, the JPEGs in `screenshots/`,
 * and the image references in the README and docs. `--stale` additionally
 * compares each active image's mtime against the newest style/screenshot
 * input. Warnings never fail the check; structural problems do.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const SCREENSHOTS_DIR = resolve(PROJECT_ROOT, "screenshots");
const SHOTS_PATH = resolve(__dirname, "shots.json");

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const STALE_INPUTS = [
  "scripts/screenshots/shots.json",
  "scripts/screenshots/generate.mjs",
  "scripts/screenshots/harness.html",
  "scripts/build.mjs",
  "scripts/build-sprite.mjs",
  "style.json",
  "dev/public/sprite.json",
  "dev/public/sprite.png",
  "dev/public/sprite@2x.json",
  "dev/public/sprite@2x.png",
];
const REQUIRED_STALE_INPUT = "style.json";

const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function relativeToRoot(path) {
  return relative(PROJECT_ROOT, path).split("\\").join("/");
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function formatTime(mtimeMs) {
  return new Date(mtimeMs).toISOString();
}

function usage() {
  return [
    "Usage: node scripts/screenshots/check.mjs [--stale]",
    "",
    "Checks the screenshot set without rendering any images.",
    "",
    "Options:",
    "  --stale   also fail when an image is older than its style/build inputs",
    "  --help    show this help",
  ].join("\n");
}

function parseArgs(argv) {
  let stale = false;
  for (const arg of argv) {
    if (arg === "--stale") {
      stale = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}\n`);
      console.error(usage());
      process.exit(1);
    }
  }
  return { stale };
}

/* ------------------------------------------------------------------ */
/* Shots                                                               */
/* ------------------------------------------------------------------ */

function loadShots() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(SHOTS_PATH, "utf8"));
  } catch (error) {
    fail(`cannot read scripts/screenshots/shots.json: ${error.message}`);
    return [];
  }

  if (!parsed || !Array.isArray(parsed.shots) || parsed.shots.length === 0) {
    fail(
      'scripts/screenshots/shots.json must contain a non-empty "shots" array',
    );
    return [];
  }

  return parsed.shots;
}

/**
 * Validate every shot and return the ones whose id is safe to use as a
 * filename. Returning them independently of the other field failures lets
 * the image checks still run for an otherwise-valid shot.
 */
function validateShots(shots) {
  const ids = new Set();
  const usable = [];

  shots.forEach((shot, index) => {
    const position = `shot #${index + 1}`;
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) {
      fail(`${position} is not an object`);
      return;
    }

    const label =
      typeof shot.id === "string" && shot.id ? `"${shot.id}"` : position;
    let idOk = true;

    if (typeof shot.id !== "string" || !SAFE_ID.test(shot.id)) {
      fail(
        `${label}: id must match ${SAFE_ID} (lowercase letters, digits and hyphens, starting with a letter or digit)`,
      );
      idOk = false;
    } else if (ids.has(shot.id)) {
      fail(`duplicate shot id "${shot.id}"`);
      idOk = false;
    } else {
      ids.add(shot.id);
    }

    if (
      !Array.isArray(shot.center) ||
      shot.center.length !== 2 ||
      !shot.center.every(isFiniteNumber)
    ) {
      fail(`${label}: center must be two finite numbers`);
    }

    if (!isPositiveNumber(shot.zoom)) {
      fail(`${label}: zoom must be a positive number`);
    }

    if (!isPositiveInteger(shot.width)) {
      fail(`${label}: width must be a positive integer`);
    }

    if (!isPositiveInteger(shot.height)) {
      fail(`${label}: height must be a positive integer`);
    }

    if (shot.scale !== undefined && !isPositiveNumber(shot.scale)) {
      fail(`${label}: scale must be a positive number`);
    }

    for (const field of ["bearing", "pitch"]) {
      if (shot[field] !== undefined && !isFiniteNumber(shot[field])) {
        fail(`${label}: ${field} must be a finite number`);
      }
    }

    if (shot.maxCanvasSize !== undefined) {
      const numeric = isFiniteNumber(shot.maxCanvasSize);
      const pair =
        Array.isArray(shot.maxCanvasSize) &&
        shot.maxCanvasSize.length === 2 &&
        shot.maxCanvasSize.every(isFiniteNumber);
      if (!numeric && !pair) {
        fail(
          `${label}: maxCanvasSize must be a number or a pair of finite numbers`,
        );
      }
    }

    if (idOk) usable.push(shot);
  });

  return usable;
}

/* ------------------------------------------------------------------ */
/* JPEG                                                                */
/* ------------------------------------------------------------------ */

function readJpegSize(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    let marker = buffer[offset + 1];
    while (marker === 0xff && offset + 2 < buffer.length) {
      offset += 1;
      marker = buffer[offset + 1];
    }
    offset += 2;

    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }

    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;

    if (SOF_MARKERS.has(marker)) {
      if (length < 7) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }

    offset += length;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Docs references                                                     */
/* ------------------------------------------------------------------ */

function markdownFiles() {
  const files = [resolve(PROJECT_ROOT, "README.md")];
  const stack = [resolve(PROJECT_ROOT, "docs")];

  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(full);
      }
    }
  }

  return files.sort();
}

function cleanTarget(raw) {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }
  return target;
}

function resolveTarget(sourceFile, rawTarget) {
  const target = cleanTarget(rawTarget);
  if (!target || target.startsWith("#")) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return null;

  const pathPart = target.split(/[?#]/)[0];
  if (!pathPart) return null;

  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    // Keep the undecoded path when it is not valid percent-encoding.
  }

  if (decoded.startsWith("/")) {
    return resolve(PROJECT_ROOT, `.${decoded}`);
  }
  return resolve(dirname(sourceFile), decoded);
}

function collectReferences() {
  const references = [];

  for (const file of markdownFiles()) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      fail(`cannot read ${relativeToRoot(file)}: ${error.message}`);
      continue;
    }

    const markdown = /!\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g;
    for (const match of text.matchAll(markdown)) {
      const target = cleanTarget(match[1]);
      const resolved = resolveTarget(file, target);
      if (resolved) references.push({ source: file, target, resolved });
    }

    const html = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    for (const match of text.matchAll(html)) {
      const target = cleanTarget(match[1] ?? match[2] ?? match[3] ?? "");
      const resolved = resolveTarget(file, target);
      if (resolved) references.push({ source: file, target, resolved });
    }
  }

  return references;
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

function checkImages(shots) {
  let found = 0;
  let dimensionsOk = 0;

  for (const shot of shots) {
    const id = shot.id;
    const imagePath = resolve(SCREENSHOTS_DIR, `${id}.jpg`);
    const label = `screenshots/${id}.jpg`;

    let stats;
    try {
      stats = statSync(imagePath);
    } catch {
      fail(`${id}: missing image ${label}`);
      continue;
    }

    if (!stats.isFile()) {
      fail(`${id}: ${label} is not a file`);
      continue;
    }

    found += 1;

    if (stats.size === 0) {
      fail(`${id}: ${label} is empty`);
      continue;
    }

    let buffer;
    try {
      buffer = readFileSync(imagePath);
    } catch (error) {
      fail(`${id}: cannot read ${label}: ${error.message}`);
      continue;
    }

    if (
      buffer.length < 3 ||
      buffer[0] !== 0xff ||
      buffer[1] !== 0xd8 ||
      buffer[2] !== 0xff
    ) {
      fail(`${id}: ${label} is not a JPEG (bad magic bytes)`);
      continue;
    }

    const size = readJpegSize(buffer);
    if (!size) {
      fail(`${id}: cannot read JPEG dimensions from ${label}`);
      continue;
    }

    const scale = shot.scale ?? 2;
    const expectedWidth = Math.round(shot.width * scale);
    const expectedHeight = Math.round(shot.height * scale);
    if (size.width !== expectedWidth || size.height !== expectedHeight) {
      fail(
        `${id}: ${label} is ${size.width}x${size.height}, expected ${expectedWidth}x${expectedHeight}`,
      );
      continue;
    }

    dimensionsOk += 1;
  }

  return { found, dimensionsOk };
}

function checkReferences() {
  const references = collectReferences().filter((reference) =>
    isInside(SCREENSHOTS_DIR, reference.resolved),
  );

  for (const reference of references) {
    let stats;
    try {
      stats = statSync(reference.resolved);
    } catch {
      fail(
        `missing screenshot reference "${reference.target}" in ${relativeToRoot(reference.source)}`,
      );
      continue;
    }
    if (!stats.isFile()) {
      fail(
        `screenshot reference "${reference.target}" in ${relativeToRoot(reference.source)} is not a file`,
      );
    }
  }

  return references;
}

function checkOrphans(shots, references) {
  const activeIds = new Set(shots.map((shot) => shot.id));
  const referenced = new Set(references.map((reference) => reference.resolved));

  let entries;
  try {
    entries = readdirSync(SCREENSHOTS_DIR, { withFileTypes: true });
  } catch (error) {
    fail(`cannot read screenshots/: ${error.message}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !/\.jpe?g$/i.test(entry.name)) continue;
    const id = entry.name.replace(/\.jpe?g$/i, "");
    if (activeIds.has(id)) continue;

    const full = resolve(SCREENSHOTS_DIR, entry.name);
    if (referenced.has(full)) {
      warn(
        `inactive screenshot "${entry.name}" is still referenced by the README or docs`,
      );
    } else {
      warn(
        `orphan screenshot "${entry.name}" is not in shots.json or referenced by the docs`,
      );
    }
  }

  for (const shot of shots) {
    const imagePath = resolve(SCREENSHOTS_DIR, `${shot.id}.jpg`);
    if (!referenced.has(imagePath)) {
      warn(`active shot "${shot.id}" is not referenced by the README or docs`);
    }
  }
}

function checkStale(shots) {
  let newest = null;

  for (const relPath of STALE_INPUTS) {
    const absolute = resolve(PROJECT_ROOT, relPath);
    if (relPath === REQUIRED_STALE_INPUT && !statExists(absolute)) {
      fail(`${REQUIRED_STALE_INPUT} is missing — run \`npm run build\` first`);
      continue;
    }

    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;

    if (!newest || stats.mtimeMs > newest.mtimeMs) {
      newest = { path: relPath, mtimeMs: stats.mtimeMs };
    }
  }

  if (!newest) return;

  const stale = [];
  for (const shot of shots) {
    const imagePath = resolve(SCREENSHOTS_DIR, `${shot.id}.jpg`);
    let stats;
    try {
      stats = statSync(imagePath);
    } catch {
      continue;
    }

    if (stats.mtimeMs < newest.mtimeMs) {
      stale.push(
        `screenshots/${shot.id}.jpg (${formatTime(
          stats.mtimeMs,
        )}) is older than ${newest.path} (${formatTime(newest.mtimeMs)})`,
      );
    }
  }

  return { newest, stale };
}

function statExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function report({ staleMode, shotCount, images, referenceCount, staleResult }) {
  const lines = [
    staleMode
      ? "Screenshot check (structural + freshness)"
      : "Screenshot check (structural)",
    `  Active shots: ${shotCount}`,
    `  Images found: ${images.found} of ${shotCount}`,
    `  Dimensions OK: ${images.dimensionsOk} of ${images.found}`,
    `  Docs references: ${referenceCount} checked`,
  ];

  if (warnings.length > 0) {
    lines.push(`  Warnings (${warnings.length}):`);
    for (const warning of warnings) lines.push(`    - ${warning}`);
  }

  if (staleResult && staleResult.stale.length > 0) {
    lines.push(`  Stale images (${staleResult.stale.length}):`);
    for (const item of staleResult.stale) lines.push(`    - ${item}`);
  }

  if (failures.length > 0) {
    lines.push(`  Failures (${failures.length}):`);
    for (const failure of failures) lines.push(`    - ${failure}`);
  }

  const failureCount =
    failures.length + (staleResult ? staleResult.stale.length : 0);

  lines.push("");
  lines.push(
    failureCount === 0
      ? "✓ screenshot check passed"
      : `✗ screenshot check failed (${failureCount} failures)`,
  );

  console.log(lines.join("\n"));
  if (failureCount > 0) process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function main() {
  const { stale } = parseArgs(process.argv.slice(2));

  const shots = loadShots();
  const activeShots = validateShots(shots);

  const images = checkImages(activeShots);
  const references = checkReferences();
  checkOrphans(activeShots, references);

  const staleResult = stale ? checkStale(activeShots) : null;

  report({
    staleMode: stale,
    shotCount: shots.length,
    images,
    referenceCount: references.length,
    staleResult,
  });
}

main();
