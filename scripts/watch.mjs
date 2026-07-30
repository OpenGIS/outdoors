#!/usr/bin/env node

/**
 * Watch scripts/build.mjs for changes and re-run the build automatically.
 *
 * Usage:
 *   node scripts/watch.mjs
 *
 * Designed to run alongside `vite` (e.g. via `concurrently`).
 * When build rewrites style.json, Vite's HMR picks it up.
 */

import { watchFile } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const buildScript = resolve(__dirname, "build.mjs");

// ── Debounce — macOS FSEvents can fire multiple times per save ──

let timeout = null;
const DEBOUNCE_MS = 200;

// ── Build-in-progress guard ──
// Prevents concurrent builds. (The old macOS kqueue read-trigger loop is
// now handled by using watchFile with mtime comparison above, so this
// guard only needs to handle the basic concurrent-spawn case.)

let isBuilding = false;

function runBuild() {
  if (timeout) clearTimeout(timeout);
  timeout = setTimeout(() => {
    timeout = null;
    if (isBuilding) return;
    isBuilding = true;
    const child = spawn("node", [buildScript], {
      stdio: "inherit",
      cwd: resolve(__dirname, ".."),
    });
    child.on("error", (err) => {
      console.error("[watch] build failed:", err.message);
      isBuilding = false;
    });
    child.on("exit", () => {
      isBuilding = false;
    });
  }, DEBOUNCE_MS);
}

// ── Watch ──
//
// Use stat polling (watchFile) because fs.watch on macOS uses kqueue and
// can fire on reads (access-time updates) not just writes. The spawned
// `node scripts/build.mjs` process reads the file, creating a re-trigger
// loop. watchFile checks mtime — only changes on writes, never on reads.

watchFile(buildScript, { interval: 300 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) {
    console.log("[watch] change: scripts/build.mjs");
    runBuild();
  }
});

console.log("[watch] watching scripts/build.mjs for changes…");
