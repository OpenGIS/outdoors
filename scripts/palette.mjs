#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSpriteLock } from "./sprite-lock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PALETTE_FILE = resolve(ROOT, "palette.json");
const SRC_DIR = resolve(ROOT, "icons");
const OUT_DIR = resolve(ROOT, "build", "icons");

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SLOT_TOKEN = /^__([a-z]+)__$/;
const MAP_TOKEN = /^@map\.(.+)$/;
const ALLOWED_RAW_FILLS = new Set(["none", "white"]);
const ALLOWED_SLOTS = new Set(["primary", "detail", "outline"]);
const OUTLINE_SHAPES = "path|rect|circle|ellipse|polygon|polyline|line";

function fail(message) {
  throw new Error(message);
}

function listSvgNames(dir) {
  if (!existsSync(dir)) fail(`missing directory: ${dir}`);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".svg"))
    .map((file) => file.slice(0, -4))
    .sort();
}

function resolveRoleColour(palette, role, value) {
  if (typeof value !== "string")
    fail(
      `palette.json: icon role "${role}" must be a hex colour or map reference`,
    );

  const reference = MAP_TOKEN.exec(value);
  if (!reference) {
    if (!HEX.test(value))
      fail(
        `palette.json: icon role "${role}" is not a valid hex colour: ${value}`,
      );
    return value;
  }

  let node = palette.map;
  for (const key of reference[1].split(".")) {
    if (!node || typeof node !== "object" || !(key in node))
      fail(
        `palette.json: icon role "${role}" has unresolved map reference "${value}"`,
      );
    node = node[key];
  }
  if (typeof node !== "string" || !HEX.test(node))
    fail(
      `palette.json: icon role "${role}" map reference "${value}" does not resolve to a hex colour`,
    );
  return node;
}

function validateIconOutline(palette) {
  const outline = palette.iconOutline;
  if (!outline || typeof outline !== "object" || Array.isArray(outline))
    fail("palette.json: iconOutline must be an object");

  for (const key of Object.keys(outline)) {
    if (key !== "role" && key !== "width")
      fail(`palette.json: iconOutline has unknown key "${key}"`);
  }
  if (typeof outline.role !== "string" || !(outline.role in palette.iconRoles))
    fail(`palette.json: iconOutline references unknown role "${outline.role}"`);
  if (
    typeof outline.width !== "number" ||
    !Number.isFinite(outline.width) ||
    outline.width <= 0 ||
    outline.width > 2
  )
    fail(
      `palette.json: iconOutline width must be a positive number up to 2: ${outline.width}`,
    );
}

function loadPalette() {
  let palette;
  try {
    palette = JSON.parse(readFileSync(PALETTE_FILE, "utf8"));
  } catch (error) {
    fail(`cannot read palette.json: ${error.message}`);
  }

  if (palette.version !== 1)
    fail(`palette.json: unsupported version ${palette.version}`);
  if (!palette.map || typeof palette.map !== "object")
    fail("palette.json: missing map");
  if (!palette.iconRoles || typeof palette.iconRoles !== "object")
    fail("palette.json: missing iconRoles");
  if (!palette.icons || typeof palette.icons !== "object")
    fail("palette.json: missing icons");

  for (const [role, value] of Object.entries(palette.iconRoles)) {
    resolveRoleColour(palette, role, value);
  }
  if (palette.iconOutline !== undefined) validateIconOutline(palette);

  return palette;
}

function resolveRoleColours(palette) {
  const colours = new Map();
  for (const [role, value] of Object.entries(palette.iconRoles)) {
    colours.set(role, resolveRoleColour(palette, role, value));
  }
  return colours;
}

export function paletteIconNames() {
  return Object.keys(loadPalette().icons).sort();
}

function validateIconEntry(name, entry, palette) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    fail(`palette.json: icon "${name}" must be an object`);

  const slots = Object.keys(entry);
  if (!slots.includes("primary"))
    fail(`palette.json: icon "${name}" is missing primary`);
  for (const slot of slots) {
    if (!ALLOWED_SLOTS.has(slot))
      fail(`palette.json: icon "${name}" has unknown slot "${slot}"`);
    if (slot === "outline") {
      if (entry.outline !== true)
        fail(`palette.json: icon "${name}" outline must be true`);
      continue;
    }
    const role = entry[slot];
    if (typeof role !== "string")
      fail(`palette.json: icon "${name}" ${slot} must be a role id`);
    if (!(role in palette.iconRoles))
      fail(`palette.json: icon "${name}" references unknown role "${role}"`);
  }
  if (entry.outline === true && !palette.iconOutline)
    fail(
      `palette.json: icon "${name}" sets outline but iconOutline is missing`,
    );
}

function validateSource(name, svg, entry) {
  const declared = new Set(
    Object.keys(entry).filter((slot) => slot !== "outline"),
  );
  const fills = [...svg.matchAll(/fill="([^"]*)"/g)].map((match) => match[1]);

  for (const value of fills) {
    if (ALLOWED_RAW_FILLS.has(value)) continue;
    const token = SLOT_TOKEN.exec(value);
    if (token) {
      if (!declared.has(token[1]))
        fail(`icons/${name}.svg: uses undeclared slot "__${token[1]}__"`);
      continue;
    }
    fail(`icons/${name}.svg: raw colour fill is not allowed: "${value}"`);
  }

  for (const slot of declared) {
    const needle = `fill="__${slot}__"`;
    if (!svg.includes(needle))
      fail(`icons/${name}.svg: missing declared slot "${slot}"`);
  }
}

function addOutline(svg, colour, width) {
  const pattern = new RegExp(
    `(<(?:${OUTLINE_SHAPES})\\b[^>]*\\bfill="__primary__"[^>]*?)(\\s*\\/?>)`,
    "g",
  );
  const stroke = ` stroke="${colour}" stroke-width="${width}" stroke-linejoin="round" paint-order="stroke fill"`;
  return svg.replace(pattern, (match, start, end) => `${start}${stroke}${end}`);
}

function renderIcon(name, svg, entry, palette, colours) {
  let output = svg;
  if (entry.outline === true) {
    output = addOutline(
      output,
      colours.get(palette.iconOutline.role),
      palette.iconOutline.width,
    );
  }
  for (const [slot, role] of Object.entries(entry)) {
    if (slot === "outline") continue;
    output = output.split(`__${slot}__`).join(colours.get(role));
  }
  if (output.includes("__"))
    fail(`icons/${name}.svg: unresolved slot token remains`);
  return output;
}

export function buildIcons() {
  const palette = loadPalette();
  const colours = resolveRoleColours(palette);
  const sourceNames = listSvgNames(SRC_DIR);
  const paletteNames = Object.keys(palette.icons).sort();

  for (const name of sourceNames) {
    if (!(name in palette.icons))
      fail(`icons/${name}.svg has no palette.json entry`);
  }
  for (const name of paletteNames) {
    if (!sourceNames.includes(name))
      fail(`palette.json icon "${name}" has no icons/${name}.svg`);
  }

  const usedRoles = new Set();
  const rendered = new Map();
  for (const name of sourceNames) {
    const entry = palette.icons[name];
    validateIconEntry(name, entry, palette);
    if (entry.primary) usedRoles.add(entry.primary);
    if (entry.detail) usedRoles.add(entry.detail);
    const source = readFileSync(join(SRC_DIR, `${name}.svg`), "utf8");
    validateSource(name, source, entry);
    rendered.set(name, renderIcon(name, source, entry, palette, colours));
  }

  if (palette.iconOutline) usedRoles.add(palette.iconOutline.role);
  for (const role of Object.keys(palette.iconRoles)) {
    if (!usedRoles.has(role))
      fail(`palette.json: icon role "${role}" is never used by an icon`);
  }

  return rendered;
}

export function writeIcons() {
  const rendered = buildIcons();
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, svg] of rendered) {
    writeFileSync(join(OUT_DIR, `${name}.svg`), svg);
  }
  return rendered.size;
}

export function checkIcons() {
  buildIcons();
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length) {
    console.error(`usage: node scripts/palette.mjs [--check]`);
    process.exit(1);
  }

  try {
    if (check) {
      checkIcons();
      const mismatches = checkSpriteLock();
      if (mismatches.length) {
        for (const mismatch of mismatches) console.error(`✗ ${mismatch}`);
        process.exit(1);
      }
      console.log("✓ palette.json + icons/ are consistent");
      return;
    }

    const count = writeIcons();
    console.log(
      `✓ rendered ${count} icons from palette.json + icons/ into build/icons`,
    );
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
