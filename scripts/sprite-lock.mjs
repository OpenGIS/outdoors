#!/usr/bin/env node

/**
 * Committed freshness lock for the generated sprite sheets.
 *
 * Hashes the sprite sources (palette.json and icons/*.svg) and the rendered
 * sprite files in dev/public, writing the result to sprite.lock.json. CI can
 * then run the palette check without spreet and still detect a source change
 * that has not been followed by a sprite rebuild.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const PALETTE_FILE = resolve(PROJECT_ROOT, "palette.json");
const ICONS_DIR = resolve(PROJECT_ROOT, "icons");
const SPRITE_DIR = resolve(PROJECT_ROOT, "dev", "public");
const LOCK_FILE = resolve(PROJECT_ROOT, "sprite.lock.json");

const LOCK_VERSION = 1;
const ALGORITHM = "sha256";
const SPRITE_FILES = [
  "sprite.json",
  "sprite.png",
  "sprite@2x.json",
  "sprite@2x.png",
];
const REBUILD = "run `npm run sprite:build`";

function sha256(data) {
  return createHash(ALGORITHM).update(data).digest("hex");
}

function hashFile(file) {
  return sha256(readFileSync(file));
}

export function computeSourceHashes() {
  const palette = hashFile(PALETTE_FILE);
  const iconHashes = readdirSync(ICONS_DIR)
    .filter((file) => file.endsWith(".svg"))
    .sort()
    .map((file) => `${file}:${hashFile(join(ICONS_DIR, file))}\n`)
    .join("");
  return { palette, icons: sha256(iconHashes) };
}

export function computeSpriteHashes() {
  const hashes = {};
  for (const file of SPRITE_FILES) {
    hashes[file] = hashFile(join(SPRITE_DIR, file));
  }
  return hashes;
}

export function writeSpriteLock() {
  const lock = {
    version: LOCK_VERSION,
    algorithm: ALGORITHM,
    sources: computeSourceHashes(),
    sprites: computeSpriteHashes(),
  };
  writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

export function checkSpriteLock() {
  if (!existsSync(LOCK_FILE)) {
    return [`sprite.lock.json is missing — ${REBUILD} to generate it`];
  }

  let lock;
  try {
    lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
  } catch (error) {
    return [`sprite.lock.json cannot be read: ${error.message}`];
  }

  if (lock.version !== LOCK_VERSION) {
    return [
      `sprite.lock.json has unsupported version ${lock.version}; ${REBUILD}`,
    ];
  }
  if (lock.algorithm !== ALGORITHM) {
    return [
      `sprite.lock.json has unsupported algorithm ${lock.algorithm}; ${REBUILD}`,
    ];
  }

  const mismatches = [];

  const sources = computeSourceHashes();
  for (const [key, value] of Object.entries(sources)) {
    if (lock.sources?.[key] !== value) {
      mismatches.push(
        `sources.${key} is stale — ${key === "palette" ? "palette.json" : "icons/"} has changed since the last sprite build; ${REBUILD}`,
      );
    }
  }

  for (const file of SPRITE_FILES) {
    const path = join(SPRITE_DIR, file);
    if (!existsSync(path) || hashFile(path) !== lock.sprites?.[file]) {
      mismatches.push(
        `sprites.${file} is stale — dev/public/${file} has changed or is missing since the last sprite build; ${REBUILD}`,
      );
    }
  }

  return mismatches;
}
