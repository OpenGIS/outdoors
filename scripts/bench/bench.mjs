#!/usr/bin/env node

/**
 * Performance benchmark harness for the compare app (`dev/`).
 *
 * Starts a Vite dev server for the compare app on a free ephemeral port, then
 * drives a **headed** Google Chrome via Playwright at a forced device scale
 * factor and measures MapLibre on the real GPU. Two modes share the same
 * environment and JSON report:
 *
 * - `move` (default) — sustained draw performance: drives the camera with
 *   `easeTo` and samples `requestAnimationFrame` deltas plus render counts.
 * - `load` — time from navigation to fully rendered. Each round runs a **cold**
 *   load in a fresh browser context (empty HTTP cache) and then a **warm**
 *   reload in the same context (cached tiles). No camera movement: the shot's
 *   hash view loads as-is (both DEM toggles on, Esri / side-by-side).
 *
 * Usage:
 *   npm run bench
 *   npm run bench -- --shot bolzano-3d --variants full --rounds 1 --duration 3000
 *   npm run bench -- --mode load --shot bolzano-3d --rounds 1
 *   npm run bench -- --mode load --serve demo
 *
 * Flags:
 *   --mode       <move|load>  benchmark mode; default move
 *   --serve      <dev|demo>   serve the Vite dev app or the production
 *                             `demo/` bundle (via `vite preview`); load mode
 *                             only; default dev
 *   --shot       <id|all>     shot (scenario) to run; default all
 *   --variants   <csv|all>    move mode: variants to run; default all
 *   --rounds     <n>          interleaved rounds per shot; default 3
 *   --duration   <ms>         move mode: measured window per run; default 6000
 *   --cap        <ms>         load mode: hard cap per load; default 60000
 *   --warm       <n>          load mode: warm reloads per round; default 1
 *   --dpr        <n>          device pixel ratio (separate Chrome launch); default 2
 *   --screenshot <label>      capture-only mode: load each shot, fully settle,
 *                             write `.opencode/tmp/bench/quality-<shot>-<label>.png`
 *                             and exit (no interaction or measurement)
 *
 * The move method (map access, warm-up, sampling, camera drives) mirrors a prior
 * manual profiling pass, so numbers stay comparable with the recorded 1640x777
 * baseline. In load mode every timestamp is `performance.now()` — ms since the
 * document's navigation start. Raw per-run samples plus environment are written
 * to `.opencode/tmp/bench/<iso-timestamp>.json`; move fields are unchanged and a
 * `load` section is added.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const OUTPUT_DIR = resolve(PROJECT_ROOT, ".opencode", "tmp", "bench");

// Host and port range mirror scripts/screenshots/generate.mjs. Bind IPv4
// loopback and reach the server by 127.0.0.1 so we can never hit a session
// Vite server that listens on IPv6 loopback (::1).
const HOST = "127.0.0.1";
const PORT_MIN = 11001; // 11000 is reserved for a session dev server.
const PORT_MAX = 11999;

// The recorded 1640x777 CSS baseline. `--window-size` is expressed in
// device-independent pixels, so both DPR variants target the same CSS size;
// the window size is calibrated against the measured Chrome chrome.
const TARGET_VIEWPORT = { width: 1640, height: 777 };
const CHROME_HEIGHT_GUESS = 87;

const SETTLE_MS = 1500;
const WARMUP_MS = 2000;
// The idle sanity run is fixed at 3000 ms regardless of --duration.
const IDLE_DURATION_MS = 3000;
const IDLE_RENDER_TOLERANCE = 2;
const MAP_WAIT_TIMEOUT_MS = 120000;
const SERVER_READY_TIMEOUT_MS = 60000;
const PAN_METRES = 1500;

// ── Load mode ──
// Quiet = zero in-flight requests for this long AND neither map moving.
const QUIET_MS = 1000;
const DEFAULT_CAP_MS = 60000;
// Raw rAF gap samples kept per run; a 60 s cap at 60 fps is ~3600, so this
// bounds the JSON without losing a normal load's detail.
const MAX_FRAME_SAMPLES = 3000;
// Same-size raw request samples kept per run.
const MAX_REQUEST_SAMPLES = 2000;
// Slack over --cap allowed for the navigation itself to settle.
const LOAD_DEADLINE_PAD_MS = 15000;

// The default load-mode shot set: mid-zoom, dense high-zoom 3D and pitched
// relief — the views that carry the most tile work on a fresh visit.
const LOAD_SHOT_IDS = ["motorway", "bolzano-3d", "dolomites-3d"];

const SHOTS = {
  "bolzano-3d": { id: "bolzano-3d", hash: "16/46.4981/11.3548/0/60" },
  motorway: { id: "motorway", hash: "13.5/46.45/11.32" },
  dolomites: { id: "dolomites", hash: "13/45.81321/11.74098" },
  "dolomites-3d": {
    id: "dolomites-3d",
    hash: "13.03/45.81048/11.73434/-27.6/60",
  },
};

const VARIANTS = [
  "full",
  "no-left-dem",
  "no-right-terrain",
  "no-right-hillshade",
  "no-buildings",
  "no-symbols",
  "no-contours",
  "no-raster-ground",
  "no-overlays",
  "no-place-labels",
  "no-road-labels",
  "no-poi-labels",
  "no-path-labels",
  "no-contour-labels",
  "no-park-labels",
  "no-misc-labels",
  "lod-tight-a",
  "lod-tight-b",
  "left-only",
  "right-only",
];

/**
 * Every symbol layer in the built style assigned to exactly one family, so the
 * per-family cost can be isolated. Ids are grouped by meaning: settlements and
 * administrative names (place), road names/shields/direction marks (road),
 * point-of-interest labels including the outdoor overlays (poi), the outdoor
 * paths overlay labels (path — currently no symbol layers), elevation labels
 * (contour), park and protected-area names (park), and the remaining basemap
 * names such as water, house numbers, airports and peaks (misc).
 *
 * `no-path-labels` is intentionally present but empty because the built style
 * defines no symbol layers on the `outdoor-paths` source; the harness reports
 * the zero count rather than inventing a layer.
 */
const SYMBOL_GROUPS = {
  "no-place-labels": [
    "Country labels",
    "State labels",
    "City labels",
    "Capital city labels",
    "Town labels",
    "Village labels",
    "Other labels",
  ],
  "no-road-labels": [
    "Road labels",
    "Tertiary road shield",
    "Secondary road shield",
    "Primary road shield",
    "Trunk road shield",
    "Highway shield",
    "Oneway path",
    "Oneway",
    "Oneway opposite",
    "Ferry labels",
  ],
  "no-poi-labels": [
    "Shop",
    "Waste",
    "Mortuary",
    "Education",
    "Outdoor",
    "Sport",
    "Ferry",
    "Food",
    "Public",
    "Cultural",
    "Attraction",
    "Transport",
    "Health",
    "Campsite",
    "Accommodation",
    "Place of worship",
    "Bus stop",
    "Bus station",
    "Harbor",
    "Mall",
    "Train",
    "outdoor-amenities",
    "outdoor-poi",
  ],
  "no-path-labels": [],
  "no-contour-labels": ["contour-labels"],
  "no-park-labels": ["Local park", "National park labels", "Zoo"],
  "no-misc-labels": [
    "River labels",
    "Lakeline labels",
    "Water labels",
    "House number labels",
    "Major airport labels",
    "Airport labels",
    "Airport gate labels",
    "Volcano peak labels",
    "Mountain peak labels",
  ],
};

/**
 * `setSourceTileLodParams(maxZoomLevelsOnScreen, tileCountMaxMinRatio, sourceId)`
 * values to test against the MapLibre defaults (9.314, 3.0). Both parameters
 * lower than default request fewer, coarser tiles at high pitch. `lod-tight-a`
 * is a moderate step and now matches the app default (see `TERRAIN_LOD` in
 * `dev/src/terrainLod.js`); `lod-tight-b` is aggressive (near the (1,1) floor
 * that the covering-tiles tests show collapses to a couple of tiles).
 */
const LOD_SETTINGS = {
  "lod-tight-a": [6.0, 2.0],
  "lod-tight-b": [2.0, 1.0],
};

// DEM source ids, distinct per map: the left compare map adds its own
// `compare-dem`, while the right pane's style.json declares `demSource`.
const LEFT_DEM_SOURCE = "compare-dem";
const RIGHT_DEM_SOURCE = "demSource";

// Extra settle before a quality screenshot so terrain, hillshade and labels
// have finished painting. Longer than the measurement settle.
const QUALITY_SETTLE_MS = 4000;

const FLAG_KEYS = {
  "--mode": "mode",
  "--serve": "serve",
  "--shot": "shot",
  "--variants": "variants",
  "--rounds": "rounds",
  "--duration": "duration",
  "--cap": "cap",
  "--warm": "warm",
  "--dpr": "dpr",
  "--screenshot": "screenshot",
  "--help": "help",
};

// ── Process state for clean shutdown ──
let viteChild = null;
let browser = null;
let runCounter = 0;

const delay = (ms) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

// ── CLI ──

function usage() {
  return [
    "Usage: npm run bench [-- options]",
    "",
    "  --mode     <move|load>  benchmark mode (default move)",
    "  --serve    <dev|demo>   serve the Vite dev app or the production demo/",
    "                          bundle via vite preview (load mode only; default dev)",
    "  --shot     <id|all>     shot to run (default all; load mode defaults to",
    `                          ${LOAD_SHOT_IDS.join(", ")})`,
    "  --variants <csv|all>    move mode: variants to run (default all)",
    "  --rounds   <n>          interleaved rounds per shot (default 3)",
    "  --duration <ms>         move mode: measured window per run (default 6000)",
    "  --cap      <ms>         load mode: hard cap per load (default 60000)",
    "  --warm     <n>          load mode: warm reloads per round (default 1)",
    "  --dpr      <n>          device pixel ratio (default 2)",
    "  --screenshot <label>    capture-only screenshots (quality-<shot>-<label>.png)",
    "",
    `  shots:    ${Object.keys(SHOTS).join(", ")}`,
    `  variants: ${VARIANTS.join(", ")}`,
  ].join("\n");
}

/** Parse argv strictly: unknown flags and malformed values fail loudly. */
function parseArgs(argv) {
  const options = {
    mode: "move",
    shot: "all",
    variants: "all",
    rounds: 3,
    duration: 6000,
    cap: DEFAULT_CAP_MS,
    warm: 1,
    serve: "dev",
    dpr: 2,
    screenshot: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    let name = token;
    let value = null;
    const equals = token.indexOf("=");
    if (token.startsWith("--") && equals !== -1) {
      name = token.slice(0, equals);
      value = token.slice(equals + 1);
    }

    if (!name.startsWith("--")) {
      throw new Error(`unexpected argument "${token}"\n\n${usage()}`);
    }
    const key = FLAG_KEYS[name];
    if (!key) {
      throw new Error(`unknown flag "${name}"\n\n${usage()}`);
    }
    if (key === "help") {
      options.help = true;
      continue;
    }
    if (value === null) {
      value = argv[++i];
      if (value === undefined) {
        throw new Error(`flag "${name}" needs a value`);
      }
    }
    options[key] = value;
  }

  if (!["move", "load"].includes(options.mode)) {
    throw new Error(`flag "--mode" needs "move" or "load"`);
  }
  if (!["dev", "demo"].includes(options.serve)) {
    throw new Error(`flag "--serve" needs "dev" or "demo"`);
  }
  options.rounds = toInteger(options.rounds, "--rounds", { min: 1 });
  options.duration = toInteger(options.duration, "--duration", { min: 500 });
  options.cap = toInteger(options.cap, "--cap", { min: 5000 });
  options.warm = toInteger(options.warm, "--warm", { min: 0 });
  options.dpr = toNumber(options.dpr, "--dpr", { min: 0.1 });
  if (options.screenshot !== null && String(options.screenshot).trim() === "") {
    throw new Error('flag "--screenshot" needs a non-empty label');
  }

  return options;
}

function toInteger(value, flag, { min }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`flag "${flag}" needs an integer >= ${min}`);
  }
  return parsed;
}

function toNumber(value, flag, { min }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`flag "${flag}" needs a number >= ${min}`);
  }
  return parsed;
}

/** Resolve the requested shots, filtering out unknown ids. */
function resolveShots(shotOption, mode) {
  if (shotOption === "all") {
    const ids = mode === "load" ? LOAD_SHOT_IDS : Object.keys(SHOTS);
    return ids.map((id) => SHOTS[id]);
  }
  const shot = SHOTS[shotOption];
  if (!shot) {
    throw new Error(
      `unknown shot "${shotOption}" (known: ${Object.keys(SHOTS).join(", ")})`,
    );
  }
  return [shot];
}

/** Resolve the requested variants, filtering out unknown names. */
function resolveVariants(variantsOption) {
  if (variantsOption === "all") return [...VARIANTS];
  const requested = variantsOption.split(",").map((name) => name.trim());
  for (const name of requested) {
    if (!VARIANTS.includes(name)) {
      throw new Error(
        `unknown variant "${name}" (known: ${VARIANTS.join(", ")})`,
      );
    }
  }
  return requested;
}

// ── Vite dev server ──

/**
 * Find a free port by binding it briefly, then releasing it for Vite. The
 * reserved 11000 is skipped entirely so a session dev server can keep it.
 */
async function findFreePort() {
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    try {
      const server = createServer();
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, HOST, () => resolveListen());
      });
      await new Promise((resolveClose) => server.close(resolveClose));
      return port;
    } catch {
      // Port in use; try the next one.
    }
  }
  throw new Error(`no free port found in range ${PORT_MIN}-${PORT_MAX}`);
}

/** Start Vite for `dev/` on the given port; returns the child process. */
function spawnServer(args) {
  const child = spawn("npx", args, {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so Ctrl-C handling can tear down npx *and* vite.
    detached: true,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`[vite] ${text}`);
  });
  viteChild = child;
  return child;
}

function startVite(port) {
  return spawnServer([
    "vite",
    "--port",
    String(port),
    "--strictPort",
    "--host",
    HOST,
  ]);
}

/**
 * Serve the production `demo/` bundle (the deployable output of
 * `npm run demo:build`) on the given port via `vite preview`. The compare app
 * exposes `window.__outdoorsMaps` in every build, so load mode can reach the
 * maps even though the production Vue build strips `__vueParentComponent`.
 */
function startPreview(port) {
  return spawnServer([
    "vite",
    "preview",
    "--port",
    String(port),
    "--strictPort",
    "--host",
    HOST,
  ]);
}

async function waitForServer(url) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await delay(250);
  }
  throw new Error(`Vite did not become ready at ${url}`);
}

function killVite() {
  if (!viteChild) return;
  const pid = viteChild.pid;
  viteChild = null;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

// ── Chrome ──

async function launchChrome(dpr, size) {
  return chromium.launch({
    channel: "chrome",
    headless: false,
    args: [
      `--force-device-scale-factor=${dpr}`,
      `--window-size=${size.width},${size.height}`,
      "--window-position=0,0",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
}

/**
 * Probe the window's inner size, DPR, UA and WebGL renderer. `--window-size`
 * is in DIP, but the OS chrome height is unknown, so this measured offset is
 * used to correct the window so the page lands on the 1640x777 CSS target.
 */
function probeWindow() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") || canvas.getContext("webgl", {});
  let webgl = { renderer: null, vendor: null };
  if (gl) {
    const extension = gl.getExtension("WEBGL_debug_renderer_info");
    webgl = {
      renderer: extension
        ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      vendor: extension
        ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)
        : gl.getParameter(gl.VENDOR),
    };
  }
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    webgl,
  };
}

/** Seed compare-app state before the app mounts, and count in-flight fetches. */
function pageInitScript() {
  try {
    localStorage.setItem("outdoors_dev_selected", "esri-worldimagery");
    localStorage.setItem("outdoors_dev_viewMode", "side-by-side");
    // DEM toggles must default on for every navigation, so drop any value a
    // previous variant persisted.
    localStorage.removeItem("outdoors_dev_demHillshade");
    localStorage.removeItem("outdoors_dev_demTerrain");
  } catch {
    // localStorage unavailable (e.g. about:blank); harness pages are http.
  }

  const network = { active: 0 };
  window.__benchNet = network;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    network.active += 1;
    return originalFetch(...args).finally(() => {
      network.active -= 1;
    });
  };
}

/**
 * Launch Chrome at the target DPR, calibrate the window to the CSS target,
 * install the init script and return the ready-to-drive page.
 */
async function launchCalibrated(dpr) {
  const estimated = {
    width: TARGET_VIEWPORT.width,
    height: TARGET_VIEWPORT.height + CHROME_HEIGHT_GUESS,
  };

  let instance = await launchChrome(dpr, estimated);
  let context = await instance.newContext({ viewport: null });
  let page = await context.newPage();
  await page.goto("about:blank");
  let probe = await page.evaluate(probeWindow);
  const warnings = [];

  const offWidth = Math.abs(probe.innerWidth - TARGET_VIEWPORT.width) > 1;
  const offHeight = Math.abs(probe.innerHeight - TARGET_VIEWPORT.height) > 1;
  if (offWidth || offHeight) {
    const corrected = {
      width: TARGET_VIEWPORT.width + (probe.outerWidth - probe.innerWidth),
      height: TARGET_VIEWPORT.height + (probe.outerHeight - probe.innerHeight),
    };
    await instance.close();
    instance = await launchChrome(dpr, corrected);
    context = await instance.newContext({ viewport: null });
    page = await context.newPage();
    await page.goto("about:blank");
    probe = await page.evaluate(probeWindow);
    if (
      Math.abs(probe.innerWidth - TARGET_VIEWPORT.width) > 1 ||
      Math.abs(probe.innerHeight - TARGET_VIEWPORT.height) > 1
    ) {
      warnings.push(
        `viewport ${probe.innerWidth}x${probe.innerHeight} differs from target ` +
          `${TARGET_VIEWPORT.width}x${TARGET_VIEWPORT.height} (window may be screen-clamped)`,
      );
    }
  }

  await context.addInitScript(pageInitScript);
  browser = instance;
  return { browser: instance, context, page, probe, warnings };
}

// ── Page interaction ──

/**
 * Wait until both maps exist, are loaded and have no tiles in flight, then
 * let the page settle for `settle` ms before the next measurement.
 */
async function waitForStable(page, settle) {
  await page.waitForFunction(
    () => {
      const setup =
        document.querySelector("#compare")?.__vueParentComponent?.setupState;
      if (!setup?.leftMap || !setup?.rightMap) return false;
      const { leftMap, rightMap } = setup;
      return (
        leftMap.loaded() &&
        rightMap.loaded() &&
        leftMap.areTilesLoaded() &&
        rightMap.areTilesLoaded() &&
        (window.__benchNet?.active ?? 0) === 0
      );
    },
    undefined,
    { timeout: MAP_WAIT_TIMEOUT_MS },
  );
  if (settle > 0) await page.waitForTimeout(settle);
}

/** Apply a variant in the page and verify it took effect. */
async function applyVariant(page, variant) {
  const result = await page.evaluate(
    ({ name, groups, lodSettings, leftDem, rightDem }) => {
      const setup =
        document.querySelector("#compare")?.__vueParentComponent?.setupState;
      if (!setup) return { ok: false, detail: "compare app not mounted" };
      const { leftMap, rightMap } = setup;

      // Symbol family variants: hide (not remove) every layer in the group so
      // collision and placement stay on the same code path as the full run.
      if (Object.prototype.hasOwnProperty.call(groups, name)) {
        const ids = groups[name];
        let hidden = 0;
        for (const id of ids) {
          if (!rightMap.getLayer(id)) continue;
          rightMap.setLayoutProperty(id, "visibility", "none");
          if (rightMap.getLayoutProperty(id, "visibility") === "none") {
            hidden += 1;
          }
        }
        return {
          ok: hidden === ids.length,
          detail: `${hidden}/${ids.length} symbol layer(s) hidden`,
        };
      }

      // DEM level-of-detail variants: apply the same LOD to both maps' DEM
      // sources and confirm the source got a calculateTileZoom override.
      if (Object.prototype.hasOwnProperty.call(lodSettings, name)) {
        const [maxZoomLevelsOnScreen, tileCountMaxMinRatio] = lodSettings[name];
        const targets = [
          { map: leftMap, source: leftDem },
          { map: rightMap, source: rightDem },
        ];
        const applied = [];
        for (const target of targets) {
          if (!target.map.getSource(target.source)) {
            return { ok: false, detail: `missing source "${target.source}"` };
          }
          target.map.setSourceTileLodParams(
            maxZoomLevelsOnScreen,
            tileCountMaxMinRatio,
            target.source,
          );
          const source = target.map.getSource(target.source);
          applied.push(
            `${target.source}:${
              typeof source.calculateTileZoom === "function" ? "set" : "unset"
            }`,
          );
        }
        const ok = applied.every((entry) => entry.endsWith("set"));
        return {
          ok,
          detail: `z=${maxZoomLevelsOnScreen} ratio=${tileCountMaxMinRatio} (${applied.join(", ")})`,
        };
      }

      switch (name) {
        case "full":
          return { ok: true };
        case "no-left-dem": {
          const boxes = [
            ...document.querySelectorAll(".dem-toggle input[type=checkbox]"),
          ];
          for (const box of boxes) {
            box.checked = false;
            box.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return {
            ok: boxes.length === 2 && boxes.every((box) => !box.checked),
            detail: `${boxes.filter((box) => box.checked).length} checkbox(es) still checked`,
          };
        }
        case "no-right-terrain":
          rightMap.setTerrain(null);
          return { ok: rightMap.getTerrain() === null };
        case "no-right-hillshade":
          if (rightMap.getLayer("hillshade-layer")) {
            rightMap.removeLayer("hillshade-layer");
          }
          return { ok: !rightMap.getLayer("hillshade-layer") };
        case "no-buildings":
          if (rightMap.getLayer("building-3d")) {
            rightMap.removeLayer("building-3d");
          }
          return { ok: !rightMap.getLayer("building-3d") };
        case "no-symbols": {
          // Hide every symbol layer rather than removing it, so collision and
          // placement stay on the same code path as the full run.
          const ids = rightMap
            .getStyle()
            .layers.filter((layer) => layer.type === "symbol")
            .map((layer) => layer.id);
          for (const id of ids) {
            rightMap.setLayoutProperty(id, "visibility", "none");
          }
          const hidden = ids.filter(
            (id) => rightMap.getLayoutProperty(id, "visibility") === "none",
          ).length;
          return {
            ok: ids.length > 0 && hidden === ids.length,
            detail: `${hidden}/${ids.length} symbol layer(s) hidden`,
          };
        }
        case "no-contours": {
          const ids = ["contour-lines", "contour-labels"];
          for (const id of ids) {
            if (rightMap.getLayer(id)) rightMap.removeLayer(id);
          }
          const removed = ids.filter((id) => !rightMap.getLayer(id));
          return {
            ok: removed.length === ids.length,
            detail: `removed ${removed.join(", ")}`,
          };
        }
        case "no-raster-ground": {
          if (rightMap.getLayer("satellite")) rightMap.removeLayer("satellite");
          return { ok: !rightMap.getLayer("satellite") };
        }
        case "no-overlays": {
          const ids = rightMap
            .getStyle()
            .layers.map((layer) => layer.id)
            .filter(
              (id) =>
                id.startsWith("outdoor-poi") || id.startsWith("outdoor-paths"),
            );
          for (const id of ids) {
            if (rightMap.getLayer(id)) rightMap.removeLayer(id);
          }
          const remaining = ids.filter((id) => rightMap.getLayer(id));
          return {
            ok: ids.length > 0 && remaining.length === 0,
            detail: `removed ${ids.length} layer(s): ${ids.join(", ")}`,
          };
        }
        case "left-only":
        case "right-only": {
          const detach = setup.detachSync;
          if (typeof detach === "function") detach();
          return {
            ok: typeof detach === "function",
            detail: "side-by-side sync handle not exposed",
          };
        }
        default:
          return { ok: false, detail: `unhandled variant "${name}"` };
      }
    },
    {
      name: variant,
      groups: SYMBOL_GROUPS,
      lodSettings: LOD_SETTINGS,
      leftDem: LEFT_DEM_SOURCE,
      rightDem: RIGHT_DEM_SOURCE,
    },
  );

  if (!result.ok) {
    throw new Error(`variant "${variant}" not applied (${result.detail})`);
  }
  return result;
}

/**
 * Warm up, drive the camera and sample rAF deltas plus render counts. All the
 * timing lives in the page so it is not distorted by CDP round-trips.
 */
async function measure(page, { duration, mode, drive, warmup }) {
  return page.evaluate(
    async (config) => {
      const setup =
        document.querySelector("#compare")?.__vueParentComponent?.setupState;
      if (!setup) throw new Error("compare app not mounted");
      const { leftMap, rightMap } = setup;
      const driveMap = config.drive === "right" ? rightMap : leftMap;
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      // Warm up GPU / tile pipelines with unrecorded rotation. Skipped for
      // idle: moving first would leave DEM tiles in flight (the known z16
      // Mapterhorn 404s), so nothing would ever settle back to quiet.
      if (config.mode !== "idle") {
        driveMap.easeTo({
          bearing: driveMap.getBearing() + 180,
          duration: config.warmup,
          easing: (t) => t,
        });
        await sleep(config.warmup + 100);
      }

      let leftRenders = 0;
      let rightRenders = 0;
      const onLeftRender = () => {
        leftRenders += 1;
      };
      const onRightRender = () => {
        rightRenders += 1;
      };
      leftMap.on("render", onLeftRender);
      rightMap.on("render", onRightRender);

      if (config.mode === "rotate") {
        driveMap.easeTo({
          bearing: driveMap.getBearing() + 180,
          duration: config.duration,
          easing: (t) => t,
        });
      } else if (config.mode === "pan") {
        const centre = driveMap.getCenter();
        const deltaLng =
          config.panMetres / (111320 * Math.cos((centre.lat * Math.PI) / 180));
        driveMap.easeTo({
          center: [centre.lng + deltaLng, centre.lat],
          duration: config.duration,
          easing: (t) => t,
        });
      }
      // Idle: no camera drive; the caller already waited for a settled map.

      const deltas = [];
      await new Promise((resolve, reject) => {
        let start = null;
        let last = null;
        const tick = (now) => {
          if (document.visibilityState !== "visible") {
            reject(
              new Error(
                "page became hidden during measurement (rAF throttled); " +
                  "ensure the Chrome window stays visible",
              ),
            );
            return;
          }
          if (start === null) {
            start = now;
            last = now;
          } else {
            deltas.push(now - last);
            last = now;
          }
          if (now - start >= config.duration) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      leftMap.off("render", onLeftRender);
      rightMap.off("render", onRightRender);

      const canvasSize = (root) => {
        const canvas = root?.querySelector("canvas.maplibregl-canvas");
        if (!canvas) return null;
        return {
          width: canvas.width,
          height: canvas.height,
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
        };
      };

      return {
        deltas,
        leftRenders,
        rightRenders,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        canvas: {
          left: canvasSize(document.getElementById("left")),
          right: canvasSize(document.getElementById("right")),
        },
      };
    },
    {
      duration,
      mode,
      drive,
      warmup,
      panMetres: PAN_METRES,
    },
  );
}

// ── Load mode ──

/**
 * Page-side load tracker, installed via `context.addInitScript` before the app
 * boots. Every timestamp is `performance.now()` — ms since the document's
 * navigation start — so nothing depends on CDP round-trips. A tight rAF loop
 * records frame timestamps and first-crossing marks; the driver polls `peek()`
 * and calls `finish()` once the map is quiet or the cap is hit. `result()`
 * computes the frame-gap percentiles and returns the raw samples.
 *
 * Self-contained by design: Playwright serialises this function, so it must
 * not close over module scope. The first render is approximate — the listener
 * attaches when the maps become reachable, so one or two earliest frames may
 * precede it.
 */
function loadTracker(config) {
  const maxFrameSamples = config.maxFrameSamples ?? 3000;
  const tracker = {
    marks: {
      domContentLoaded: null,
      load: null,
      firstCanvas: null,
      mapsReachable: null,
      loaded: null,
      tilesLoaded: null,
      quiet: null,
      firstRender: null,
    },
    frames: [],
    leftRenders: 0,
    rightRenders: 0,
    isMoving: true,
    capped: false,
    finished: false,
    hiddenFrames: 0,
    visibility: "visible",
  };
  window.__benchLoad = tracker;

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        tracker.marks.domContentLoaded = performance.now();
      },
      { once: true },
    );
  } else {
    tracker.marks.domContentLoaded = performance.now();
  }
  window.addEventListener(
    "load",
    () => {
      tracker.marks.load = performance.now();
    },
    { once: true },
  );

  let attached = false;
  const onRender = () => {
    if (tracker.marks.firstRender === null) {
      tracker.marks.firstRender = performance.now();
    }
  };
  const onLeftRender = () => {
    tracker.leftRenders += 1;
    onRender();
  };
  const onRightRender = () => {
    tracker.rightRenders += 1;
    onRender();
  };

  const frame = (now) => {
    tracker.frames.push(now);
    if (document.visibilityState !== "visible") tracker.hiddenFrames += 1;

    if (
      tracker.marks.firstCanvas === null &&
      document.querySelector(".maplibregl-canvas")
    ) {
      tracker.marks.firstCanvas = now;
    }

    // Map access: the Vue setup state in dev, or the app's `window` hook in
    // production (where Vue strips `__vueParentComponent`).
    const setup =
      document.querySelector("#compare")?.__vueParentComponent?.setupState;
    const maps =
      setup?.leftMap && setup?.rightMap ? setup : window.__outdoorsMaps;
    if (maps?.leftMap && maps?.rightMap) {
      if (tracker.marks.mapsReachable === null) {
        tracker.marks.mapsReachable = now;
      }
      if (!attached) {
        maps.leftMap.on("render", onLeftRender);
        maps.rightMap.on("render", onRightRender);
        attached = true;
      }
      if (
        tracker.marks.loaded === null &&
        maps.leftMap.loaded() &&
        maps.rightMap.loaded()
      ) {
        tracker.marks.loaded = now;
      }
      if (
        tracker.marks.tilesLoaded === null &&
        tracker.marks.loaded !== null &&
        maps.leftMap.areTilesLoaded() &&
        maps.rightMap.areTilesLoaded()
      ) {
        tracker.marks.tilesLoaded = now;
      }
      tracker.isMoving = !!(
        maps.leftMap.isMoving() || maps.rightMap.isMoving()
      );
    }

    if (now >= config.capMs) {
      tracker.capped = true;
      tracker.finished = true;
      return;
    }
    if (!tracker.finished) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  tracker.peek = () => ({
    marks: { ...tracker.marks },
    frameCount: tracker.frames.length,
    lastFrame: tracker.frames.length
      ? tracker.frames[tracker.frames.length - 1]
      : null,
    leftRenders: tracker.leftRenders,
    rightRenders: tracker.rightRenders,
    isMoving: tracker.isMoving,
    capped: tracker.capped,
    finished: tracker.finished,
    hiddenFrames: tracker.hiddenFrames,
    visibility: tracker.visibility,
  });

  tracker.finish = (reason) => {
    tracker.finished = true;
    tracker.visibility = document.visibilityState;
    if (reason === "quiet" && tracker.marks.quiet === null) {
      tracker.marks.quiet = performance.now();
    }
    if (reason === "cap") tracker.capped = true;
    return tracker.result();
  };

  tracker.result = () => {
    tracker.visibility = document.visibilityState;
    const frames = tracker.frames;
    const gaps = [];
    for (let i = 1; i < frames.length; i++)
      gaps.push(frames[i] - frames[i - 1]);
    const sorted = [...gaps].sort((a, b) => a - b);
    const pick = (p) => {
      if (!sorted.length) return null;
      const rank = Math.ceil((p / 100) * sorted.length);
      return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
    };
    const sum = gaps.reduce((acc, value) => acc + value, 0);
    const meanGap = gaps.length ? sum / gaps.length : 0;

    const navigation = performance.getEntriesByType("navigation")[0];
    const domContentLoaded =
      tracker.marks.domContentLoaded ??
      (navigation ? navigation.domContentLoadedEventEnd : null);
    const windowLoad =
      tracker.marks.load ??
      (navigation && navigation.loadEventEnd ? navigation.loadEventEnd : null);

    // Resource Timing cross-check: main-thread resource bytes/end per host.
    // Worker-fetched tiles may or may not appear here; the driver's Playwright
    // request events are authoritative for request counts and bytes.
    const resourceHosts = {};
    for (const entry of performance.getEntriesByType("resource")) {
      let host;
      try {
        host = new URL(entry.name).host || "(inline)";
      } catch {
        continue;
      }
      const acc = resourceHosts[host] ?? {
        requests: 0,
        transferSize: 0,
        encodedBodySize: 0,
        lastResponseEnd: 0,
      };
      acc.requests += 1;
      acc.transferSize += entry.transferSize || 0;
      acc.encodedBodySize += entry.encodedBodySize || 0;
      acc.lastResponseEnd = Math.max(
        acc.lastResponseEnd,
        entry.responseEnd || 0,
      );
      resourceHosts[host] = acc;
    }

    return {
      marks: { ...tracker.marks, domContentLoaded, load: windowLoad },
      capped: tracker.capped,
      firstRenderApprox: true,
      renders: { left: tracker.leftRenders, right: tracker.rightRenders },
      frames: {
        count: frames.length,
        spanMs: frames.length ? frames[frames.length - 1] - frames[0] : 0,
        meanFps: meanGap > 0 ? 1000 / meanGap : 0,
        p50: pick(50),
        p95: pick(95),
        max: sorted.length ? sorted[sorted.length - 1] : null,
        gaps: gaps.slice(0, maxFrameSamples),
        gapsTruncated: gaps.length > maxFrameSamples,
      },
      resourceHosts,
      hiddenFrames: tracker.hiddenFrames,
      visibility: tracker.visibility,
    };
  };
}

/**
 * Driver-side per-window request accounting from Playwright's network events.
 * Counts in-flight requests (for the quiet test), requests and `content-length`
 * bytes per host, the last response end per host and 4xx/5xx counts. `begin()`
 * resets it so a cold load and its warm reloads can share one tracker.
 */
function createLoadNet() {
  const state = {
    active: 0,
    total: 0,
    bytesUnknown: 0,
    errors: 0,
    byHost: new Map(),
    samples: [],
    truncated: false,
    navStart: 0,
  };
  const pending = new Map();

  const hostOf = (url) => {
    try {
      return new URL(url).host || "(inline)";
    } catch {
      return "(invalid)";
    }
  };

  const statFor = (host) => {
    if (!state.byHost.has(host)) {
      state.byHost.set(host, {
        requests: 0,
        bytes: 0,
        bytesUnknown: 0,
        errors: 0,
        fourXx: 0,
        fiveXx: 0,
        statuses: {},
        lastResponseEnd: 0,
      });
    }
    return state.byHost.get(host);
  };

  const endTime = () => (state.navStart ? Date.now() - state.navStart : 0);

  return {
    get active() {
      return state.active;
    },
    begin(navStart) {
      state.active = 0;
      state.total = 0;
      state.bytesUnknown = 0;
      state.errors = 0;
      state.byHost = new Map();
      state.samples = [];
      state.truncated = false;
      state.navStart = navStart;
      pending.clear();
    },
    onRequest(request) {
      state.active += 1;
      state.total += 1;
      pending.set(request, { host: hostOf(request.url()), url: request.url() });
    },
    onResponse(response) {
      const entry = pending.get(response.request());
      if (!entry) return;
      entry.status = response.status();
      const raw = response.headers()["content-length"];
      const bytes = raw === undefined ? NaN : Number(raw);
      entry.bytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
    },
    onFinished(request) {
      const entry = pending.get(request) ?? {
        host: hostOf(request.url()),
        url: request.url(),
      };
      pending.delete(request);
      state.active = Math.max(0, state.active - 1);

      const stat = statFor(entry.host);
      stat.requests += 1;
      if (entry.bytes == null) {
        stat.bytesUnknown += 1;
        state.bytesUnknown += 1;
      } else {
        stat.bytes += entry.bytes;
      }
      const status = entry.status ?? 0;
      if (status) stat.statuses[status] = (stat.statuses[status] ?? 0) + 1;
      if (status >= 400 && status < 500) stat.fourXx += 1;
      if (status >= 500) stat.fiveXx += 1;
      if (status >= 400) state.errors += 1;
      stat.lastResponseEnd = Math.max(stat.lastResponseEnd, endTime());

      if (!state.truncated) {
        if (state.samples.length >= MAX_REQUEST_SAMPLES) {
          state.truncated = true;
        } else {
          state.samples.push({
            host: entry.host,
            url: entry.url,
            status,
            bytes: entry.bytes,
            responseEnd: endTime(),
          });
        }
      }
    },
    onFailed(request) {
      const entry = pending.get(request);
      pending.delete(request);
      state.active = Math.max(0, state.active - 1);
      const stat = statFor(entry ? entry.host : hostOf(request.url()));
      stat.requests += 1;
      stat.errors += 1;
      stat.lastResponseEnd = Math.max(stat.lastResponseEnd, endTime());
      state.errors += 1;
    },
    snapshot() {
      const byHost = {};
      for (const [host, stat] of state.byHost) {
        byHost[host] = { ...stat, statuses: { ...stat.statuses } };
      }
      return {
        totalRequests: state.total,
        bytesUnknown: state.bytesUnknown,
        errors: state.errors,
        byHost,
        samples: state.samples,
        truncated: state.truncated,
      };
    },
  };
}

/** Aggregate console/HTTP errors for one context and route network to `net`. */
function attachLoadHandlers(context, net, consoleCounts, httpCounts, failures) {
  context.on("request", (request) => net.onRequest(request));
  context.on("response", (response) => {
    net.onResponse(response);
    if (response.status() < 400) return;
    let host = "unknown";
    try {
      host = new URL(response.url()).host;
    } catch {
      // Non-standard URL; keep the fallback host.
    }
    const signature = `${response.status()} ${host}`;
    httpCounts.set(signature, (httpCounts.get(signature) ?? 0) + 1);
  });
  context.on("requestfinished", (request) => net.onFinished(request));
  context.on("requestfailed", (request) => net.onFailed(request));
  context.on("page", (page) => {
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const signature = consoleSignature(message.text());
      consoleCounts.set(signature, (consoleCounts.get(signature) ?? 0) + 1);
    });
    page.on("pageerror", (error) => {
      failures.push(`page error: ${String(error)}`);
    });
  });
}

/**
 * Navigate once, then poll the page-side tracker until quiet (zero in-flight
 * requests for `quietMs` with both maps stationary) or the page-side cap. The
 * driver owns the in-flight count, so the quiet decision cannot be fooled by
 * worker-fetched tiles that `window.fetch` cannot see.
 */
async function measureLoad(page, { url, reload, capMs, quietMs, net }) {
  const navStart = Date.now();
  net.begin(navStart);
  const navOptions = {
    waitUntil: "commit",
    timeout: capMs + LOAD_DEADLINE_PAD_MS,
  };
  if (reload) await page.reload(navOptions);
  else await page.goto(url, navOptions);

  await page.waitForFunction(() => !!window.__benchLoad, null, {
    timeout: LOAD_DEADLINE_PAD_MS,
  });

  let reason = "cap";
  let quietSince = null;
  const deadline = navStart + capMs + LOAD_DEADLINE_PAD_MS;
  while (Date.now() < deadline) {
    const peek = await page.evaluate(() => window.__benchLoad.peek());
    if (peek.capped || peek.finished) {
      reason = "cap";
      break;
    }
    const mapReady =
      peek.marks.mapsReachable !== null && peek.marks.loaded !== null;
    if (mapReady && !peek.isMoving && net.active === 0) {
      if (quietSince === null) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietMs) {
        reason = "quiet";
        break;
      }
    } else {
      quietSince = null;
    }
    await delay(100);
  }

  const result = await page.evaluate(
    (finishReason) => window.__benchLoad.finish(finishReason),
    reason,
  );
  result.requests = net.snapshot();
  return result;
}

/**
 * One throwaway load before the measured runs, so the Vite dev server's
 * module-transform cache (and the OS file cache) is warm; otherwise the first
 * cold shot carries dev-server transform cost. Failures are non-fatal.
 */
async function warmUpLoad(instance, baseUrl, shot) {
  const context = await instance.newContext({ viewport: null });
  await context.addInitScript(pageInitScript);
  const page = await context.newPage();
  try {
    const nonce = ++runCounter;
    await page.goto(`${baseUrl}/?bench=${nonce}#${shot.hash}`, {
      waitUntil: "load",
      timeout: MAP_WAIT_TIMEOUT_MS,
    });
  } catch {
    // Measured runs will surface any real problem.
  } finally {
    await context.close();
  }
}

// ── Statistics ──

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function summariseDeltas(deltas) {
  if (deltas.length === 0) {
    return {
      frames: 0,
      meanFps: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      over25: 0,
      over33: 0,
      over50: 0,
      p50Vsync: 0,
    };
  }
  const sorted = [...deltas].sort((a, b) => a - b);
  const total = deltas.reduce((sum, value) => sum + value, 0);
  const meanDelta = total / deltas.length;
  const p50 = percentile(sorted, 50);
  const over = (threshold) =>
    (deltas.filter((delta) => delta > threshold).length / deltas.length) * 100;
  return {
    frames: deltas.length,
    meanFps: 1000 / meanDelta,
    p50,
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    over25: over(25),
    over33: over(33),
    over50: over(50),
    p50Vsync: p50 / 16.67,
  };
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Build one summary row per (shot, variant, mode) across all rounds. */
function aggregate(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.shot}|${run.variant}|${run.mode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }

  const rows = [];
  for (const [key, group] of groups) {
    const [shot, variant, mode] = key.split("|");
    rows.push({
      shot,
      variant,
      mode,
      runs: group.length,
      medianFps: median(group.map((run) => run.stats.meanFps)),
      p50: median(group.map((run) => run.stats.p50)),
      p95: median(group.map((run) => run.stats.p95)),
      over33: median(group.map((run) => run.stats.over33)),
      leftRenders: median(group.map((run) => run.renders.left)),
      rightRenders: median(group.map((run) => run.renders.right)),
    });
  }
  return rows;
}

/** Median of the finite numbers in `values`, or null when there are none. */
function medianOf(values) {
  const numbers = values.filter(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

const sumHost = (byHost, field) =>
  Object.values(byHost).reduce((acc, stat) => acc + (stat[field] || 0), 0);
const maxHost = (byHost, field) =>
  Object.values(byHost).reduce(
    (acc, stat) => Math.max(acc, stat[field] || 0),
    0,
  );

/** Build one summary row per (shot, kind) across all rounds, with per-host sums. */
function aggregateLoad(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.shot}|${run.kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }

  const rows = [];
  for (const [key, group] of groups) {
    const [shot, kind] = key.split("|");

    const byHost = {};
    for (const run of group) {
      for (const [host, stat] of Object.entries(run.requests.byHost)) {
        const acc = (byHost[host] ??= {
          requests: 0,
          bytes: 0,
          errors: 0,
          fourXx: 0,
          fiveXx: 0,
          lastResponseEnd: 0,
        });
        acc.requests += stat.requests;
        acc.bytes += stat.bytes;
        acc.errors += stat.errors;
        acc.fourXx += stat.fourXx;
        acc.fiveXx += stat.fiveXx;
        acc.lastResponseEnd = Math.max(
          acc.lastResponseEnd,
          stat.lastResponseEnd,
        );
      }
    }

    rows.push({
      shot,
      kind,
      runs: group.length,
      cappedRuns: group.filter((run) => run.capped).length,
      tFirstCanvas: medianOf(group.map((run) => run.marks.firstCanvas)),
      tLoaded: medianOf(group.map((run) => run.marks.loaded)),
      tTiles: medianOf(group.map((run) => run.marks.tilesLoaded)),
      tQuiet: medianOf(group.map((run) => run.marks.quiet)),
      totalMs: medianOf(
        group.map((run) => run.marks.quiet ?? run.frames.spanMs),
      ),
      meanFps: medianOf(group.map((run) => run.frames.meanFps)),
      p50: medianOf(group.map((run) => run.frames.p50)),
      p95: medianOf(group.map((run) => run.frames.p95)),
      max: medianOf(group.map((run) => run.frames.max)),
      leftRenders: medianOf(group.map((run) => run.renders.left)),
      rightRenders: medianOf(group.map((run) => run.renders.right)),
      requests: medianOf(group.map((run) => run.requests.totalRequests)),
      requestsByHost: byHost,
      bytes: medianOf(
        group.map((run) => sumHost(run.requests.byHost, "bytes")),
      ),
      lastResponseEnd: medianOf(
        group.map((run) => maxHost(run.requests.byHost, "lastResponseEnd")),
      ),
      fourXx: medianOf(
        group.map((run) => sumHost(run.requests.byHost, "fourXx")),
      ),
      fiveXx: medianOf(
        group.map((run) => sumHost(run.requests.byHost, "fiveXx")),
      ),
    });
  }

  return rows.sort(
    (a, b) => a.shot.localeCompare(b.shot) || a.kind.localeCompare(b.kind),
  );
}

// ── Reporting ──

function formatCell(value, width) {
  return String(value).padEnd(width);
}

const fmtMs = (value) =>
  value == null || !Number.isFinite(value) ? "—" : value.toFixed(0);

const fmtFps = (value) =>
  value == null || !Number.isFinite(value) ? "—" : value.toFixed(1);

const fmtBytes = (value) =>
  value == null || !Number.isFinite(value) ? "—" : (value / 1024).toFixed(0);

/** Print the per-shot load medians plus a per-host request/bytes breakdown. */
function printLoadSummary(rows) {
  const headers = [
    "shot",
    "kind",
    "canvas",
    "loaded",
    "tiles",
    "quiet",
    "total",
    "fps",
    "p50",
    "p95",
    "max",
    "L-rend",
    "R-rend",
    "req",
    "kB",
    "lastEnd",
    "4xx",
  ];
  const table = [
    headers,
    ...rows.map((row) => [
      row.shot,
      row.kind,
      fmtMs(row.tFirstCanvas),
      fmtMs(row.tLoaded),
      fmtMs(row.tTiles),
      fmtMs(row.tQuiet),
      fmtMs(row.totalMs),
      fmtFps(row.meanFps),
      fmtMs(row.p50),
      fmtMs(row.p95),
      fmtMs(row.max),
      row.leftRenders ?? "—",
      row.rightRenders ?? "—",
      row.requests ?? "—",
      fmtBytes(row.bytes),
      fmtMs(row.lastResponseEnd),
      row.fourXx ?? "—",
    ]),
  ];

  const widths = headers.map((_, column) =>
    Math.max(...table.map((cells) => String(cells[column]).length)),
  );
  const lines = table.map((cells) =>
    cells.map((cell, column) => formatCell(cell, widths[column])).join("  "),
  );
  const divider = widths.map((width) => "-".repeat(width)).join("  ");

  console.log("\nLoad medians (ms since navigation start):");
  console.log(lines[0]);
  console.log(divider);
  for (const line of lines.slice(1)) console.log(line);
  console.log(
    "\ncanvas/loaded/tiles/quiet/total = median ms; lastEnd = median latest " +
      "per-host response end; kB = median total content-length bytes; 4xx = " +
      "median 4xx count per run.",
  );

  for (const row of rows) {
    const hosts = Object.entries(row.requestsByHost).sort(
      (a, b) => b[1].bytes - a[1].bytes,
    );
    if (hosts.length === 0) continue;
    console.log(
      `\n${row.shot} ${row.kind} — per host (requests summed over ` +
        `${row.runs} run(s), lastEnd is max):`,
    );
    for (const [host, stat] of hosts) {
      console.log(
        `  ${host}  req ${stat.requests}  ${(stat.bytes / 1024).toFixed(0)} kB` +
          (stat.bytesUnknown ? ` (+${stat.bytesUnknown} unknown)` : "") +
          `  lastEnd ${stat.lastResponseEnd.toFixed(0)} ms` +
          `  4xx ${stat.fourXx}  5xx ${stat.fiveXx}`,
      );
    }
  }
}

function printSummary(rows) {
  const fullFps = new Map();
  for (const row of rows) {
    if (row.mode === "rotate" && row.variant === "full") {
      fullFps.set(row.shot, row.medianFps);
    }
  }

  const withRatio = rows.map((row) => {
    const baseline = fullFps.get(row.shot);
    const ratio =
      baseline && baseline > 0 ? (row.medianFps / baseline).toFixed(2) : "-";
    return { ...row, ratio: row.mode === "rotate" ? `${ratio}x` : "-" };
  });

  const headers = [
    "shot",
    "variant",
    "mode",
    "FPS",
    "p50 ms",
    "p95 ms",
    "%>33ms",
    "L-rend",
    "R-rend",
    "xfull",
  ];
  const table = [
    headers,
    ...withRatio.map((row) => [
      row.shot,
      row.variant,
      row.mode,
      row.medianFps.toFixed(1),
      row.p50.toFixed(1),
      row.p95.toFixed(1),
      row.over33.toFixed(0),
      String(row.leftRenders),
      String(row.rightRenders),
      row.ratio,
    ]),
  ];

  const widths = headers.map((_, column) =>
    Math.max(...table.map((cells) => String(cells[column]).length)),
  );
  const lines = table.map((cells) =>
    cells.map((cell, column) => formatCell(cell, widths[column])).join("  "),
  );
  const divider = widths.map((width) => "-".repeat(width)).join("  ");

  console.log("\n" + lines[0]);
  console.log(divider);
  for (const line of lines.slice(1)) console.log(line);
  console.log(
    `\nFPS = median of per-run mean FPS; p50/p95 = median frame ms; ` +
      `L-rend/R-rend = median render events per run.`,
  );
}

/** Collapse a console message into a stable signature for counting. */
function consoleSignature(message) {
  return message.length > 140 ? `${message.slice(0, 140)}…` : message;
}

function printConsoleSummary(consoleCounts, httpCounts) {
  const consoleTotal = [...consoleCounts.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  const httpTotal = [...httpCounts.values()].reduce(
    (sum, count) => sum + count,
    0,
  );

  console.log(
    `\nConsole errors: ${consoleTotal} across ${consoleCounts.size} signature(s)`,
  );
  for (const [signature, count] of topEntries(consoleCounts, 8)) {
    console.log(`  ${count} x ${signature}`);
  }

  console.log(`\nHTTP responses >= 400: ${httpTotal}`);
  for (const [signature, count] of topEntries(httpCounts, 8)) {
    console.log(`  ${count} x ${signature}`);
  }
}

function topEntries(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// ── Main ──

async function executeRun(
  page,
  baseUrl,
  { shot, variant, mode, round, config },
) {
  const nonce = ++runCounter;
  const url = `${baseUrl}/?bench=${nonce}#${shot.hash}`;

  await page.goto(url, { waitUntil: "load", timeout: MAP_WAIT_TIMEOUT_MS });
  // Wait for the first stable load before mutating any style state.
  await waitForStable(page, 0);
  const applied = await applyVariant(page, variant);
  // Re-settle after the variant's style changes.
  await waitForStable(page, SETTLE_MS);
  // Occlusion throttles requestAnimationFrame, so make sure the window is
  // frontmost before measuring.
  await page.bringToFront();

  const drive = variant === "right-only" ? "right" : "left";
  const result = await measure(page, {
    duration: mode === "idle" ? IDLE_DURATION_MS : config.duration,
    mode,
    drive,
    warmup: WARMUP_MS,
  });

  const stats = summariseDeltas(result.deltas);
  const idleSane =
    mode !== "idle" ||
    result.leftRenders + result.rightRenders <= IDLE_RENDER_TOLERANCE;

  return {
    shot: shot.id,
    variant,
    mode,
    round,
    drive,
    variantDetail: applied.detail ?? null,
    stats,
    // Raw per-frame samples (ms) so runs can be re-analysed downstream.
    deltas: result.deltas,
    renders: { left: result.leftRenders, right: result.rightRenders },
    inner: { width: result.innerWidth, height: result.innerHeight },
    devicePixelRatio: result.devicePixelRatio,
    canvas: result.canvas,
    idleSane,
  };
}

/**
 * Capture-only mode: load each shot, wait for a full load plus a longer settle
 * so terrain, hillshade and labels finish painting, then write a full-page PNG
 * per shot to `.opencode/tmp/bench/quality-<shot>-<label>.png`. Used for
 * visual quality comparisons (e.g. 512 vs 256 DEM tiles) without measuring.
 */
async function runScreenshots(options, shots) {
  const port = await findFreePort();
  const baseUrl = `http://${HOST}:${port}`;
  console.log(`Starting Vite on ${baseUrl}`);
  startVite(port);
  await waitForServer(baseUrl);

  const launched = await launchCalibrated(options.dpr);
  const { page, probe, warnings } = launched;
  for (const warning of warnings) console.warn(`WARNING: ${warning}`);

  console.log(
    `Capturing ${shots.length} quality screenshot(s) at DPR ${options.dpr}`,
  );
  const outputs = [];
  for (const shot of shots) {
    const nonce = ++runCounter;
    const url = `${baseUrl}/?bench=${nonce}#${shot.hash}`;
    await page.goto(url, { waitUntil: "load", timeout: MAP_WAIT_TIMEOUT_MS });
    await waitForStable(page, 0);
    // Occlusion throttles rAF, so make sure the window is frontmost before
    // the extra settle and capture.
    await page.bringToFront();
    await page.waitForTimeout(QUALITY_SETTLE_MS);
    const filePath = resolve(
      OUTPUT_DIR,
      `quality-${shot.id}-${options.screenshot}.png`,
    );
    await page.screenshot({ path: filePath, fullPage: true });
    outputs.push(filePath);
    console.log(`  ${shot.id} -> ${filePath}`);
  }

  console.log(
    `\nWebGL renderer: ${probe.webgl?.renderer ?? "unknown"}\n` +
      `Wrote ${outputs.length} screenshot(s).`,
  );
  return 0;
}

async function run(options) {
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const shots = resolveShots(options.shot, options.mode);
  mkdirSync(OUTPUT_DIR, { recursive: true });

  if (options.screenshot !== null) {
    return runScreenshots(options, shots);
  }
  if (options.serve === "demo" && options.mode !== "load") {
    throw new Error(
      'flag "--serve demo" is only supported with "--mode load" ' +
        "(the variant ablation and screenshots read the Vue setup state)",
    );
  }
  if (options.mode === "load") {
    return runLoad(options, shots);
  }
  return runMove(options, shots, resolveVariants(options.variants));
}

/** Move mode: the original camera-drive draw benchmark. */
async function runMove(options, shots, variants) {
  const port = await findFreePort();
  const baseUrl = `http://${HOST}:${port}`;
  console.log(`Starting Vite on ${baseUrl}`);
  startVite(port);
  await waitForServer(baseUrl);

  const launched = await launchCalibrated(options.dpr);
  const { page, probe, warnings: launchWarnings } = launched;

  const consoleCounts = new Map();
  const httpCounts = new Map();
  const failures = [];
  const runs = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const signature = consoleSignature(message.text());
    consoleCounts.set(signature, (consoleCounts.get(signature) ?? 0) + 1);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    let host = "unknown";
    try {
      host = new URL(response.url()).host;
    } catch {
      // Non-standard URL; keep the fallback host.
    }
    const signature = `${response.status()} ${host}`;
    httpCounts.set(signature, (httpCounts.get(signature) ?? 0) + 1);
  });
  page.on("pageerror", (error) => {
    failures.push(`page error: ${String(error)}`);
  });

  const config = {
    dpr: options.dpr,
    rounds: options.rounds,
    duration: options.duration,
    shots: shots.map((shot) => shot.id),
    variants,
    targetViewport: TARGET_VIEWPORT,
    warmupMs: WARMUP_MS,
    settleMs: SETTLE_MS,
  };

  console.log(
    `Benchmarking ${shots.length} shot(s) x ${variants.length} variant(s) ` +
      `x ${options.rounds} round(s) at DPR ${options.dpr}`,
  );
  if (launchWarnings.length) {
    for (const warning of launchWarnings) console.warn(`WARNING: ${warning}`);
  }

  const startedAt = Date.now();
  for (const shot of shots) {
    // Interleave rounds so drift spreads across variants.
    for (let round = 1; round <= options.rounds; round++) {
      for (const variant of variants) {
        process.stdout.write(`  ${shot.id} r${round} ${variant} rotate ... `);
        try {
          const run = await executeRun(page, baseUrl, {
            shot,
            variant,
            mode: "rotate",
            round,
            config,
          });
          runs.push(run);
          console.log(
            `${run.stats.meanFps.toFixed(1)} fps ` +
              `(p50 ${run.stats.p50.toFixed(1)} ms)`,
          );
        } catch (error) {
          console.log("FAILED");
          if (/hidden during measurement/.test(error.message)) throw error;
          failures.push(`[${shot.id} ${variant} r${round}] ${error.message}`);
        }
      }
    }

    // Extra interaction modes for the full configuration only.
    if (variants.includes("full")) {
      for (const mode of ["pan", "idle"]) {
        process.stdout.write(`  ${shot.id} ${mode} (full) ... `);
        try {
          const run = await executeRun(page, baseUrl, {
            shot,
            variant: "full",
            mode,
            round: null,
            config,
          });
          runs.push(run);
          console.log(
            `${run.stats.meanFps.toFixed(1)} fps ` +
              `(p50 ${run.stats.p50.toFixed(1)} ms, ` +
              `renders ${run.renders.left}/${run.renders.right})`,
          );
          if (!run.idleSane) {
            failures.push(
              `[${shot.id} idle] expected ~0 renders but saw ` +
                `${run.renders.left}/${run.renders.right}`,
            );
          }
        } catch (error) {
          console.log("FAILED");
          failures.push(`[${shot.id} ${mode}] ${error.message}`);
        }
      }
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = aggregate(runs);

  console.log(`\nCompleted ${runs.length} run(s) in ${elapsed}s`);
  printSummary(summary);
  printConsoleSummary(consoleCounts, httpCounts);

  const timestamp = new Date().toISOString();
  const outputPath = resolve(
    OUTPUT_DIR,
    `${timestamp.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        timestamp,
        config,
        environment: probe,
        runs,
        summary,
        consoleErrors: Object.fromEntries(consoleCounts),
        httpErrors: Object.fromEntries(httpCounts),
        failures,
      },
      null,
      2,
    ),
  );
  console.log(`\nResults written to ${outputPath}`);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAILED: ${failure}`);
    return 1;
  }
  return 0;
}

/**
 * Load mode: measure time from navigation to fully rendered. Per round, a cold
 * load in a fresh browser context (empty HTTP cache) followed by warm reloads
 * in the same context (cached tiles). No camera movement — each shot loads at
 * its hash view with both DEM toggles on, Esri and side-by-side preset.
 */
async function runLoad(options, shots) {
  const port = await findFreePort();
  const baseUrl = `http://${HOST}:${port}`;
  const serverLabel =
    options.serve === "demo" ? "demo bundle (vite preview)" : "Vite dev server";
  console.log(`Starting ${serverLabel} on ${baseUrl}`);
  if (options.serve === "demo") startPreview(port);
  else startVite(port);
  await waitForServer(baseUrl);

  const launched = await launchCalibrated(options.dpr);
  const { browser: instance, probe, warnings: launchWarnings } = launched;
  for (const warning of launchWarnings) console.warn(`WARNING: ${warning}`);

  const consoleCounts = new Map();
  const httpCounts = new Map();
  const failures = [];
  const runs = [];

  // Warm the dev server's module-transform cache with one throwaway load so the
  // first measured shot does not carry transform cost.
  console.log("Warming up (discarded) ...");
  await warmUpLoad(instance, baseUrl, shots[0]);

  const warmLabel = options.warm > 0 ? ` + ${options.warm} warm reload(s)` : "";
  console.log(
    `Load-benchmarking ${shots.length} shot(s) x ${options.rounds} round(s) ` +
      `(cold${warmLabel}) at DPR ${options.dpr}, cap ${options.cap} ms`,
  );

  const startedAt = Date.now();
  for (const shot of shots) {
    for (let round = 1; round <= options.rounds; round++) {
      const context = await instance.newContext({ viewport: null });
      await context.addInitScript(pageInitScript);
      await context.addInitScript(loadTracker, {
        capMs: options.cap,
        maxFrameSamples: MAX_FRAME_SAMPLES,
      });
      const net = createLoadNet();
      attachLoadHandlers(context, net, consoleCounts, httpCounts, failures);
      const page = await context.newPage();
      await page.bringToFront();

      const sequence = [
        { kind: "cold", reload: false },
        ...Array.from({ length: options.warm }, () => ({
          kind: "warm",
          reload: true,
        })),
      ];

      for (const step of sequence) {
        const nonce = ++runCounter;
        const url = `${baseUrl}/?bench=${nonce}#${shot.hash}`;
        process.stdout.write(`  ${shot.id} r${round} ${step.kind} ... `);
        try {
          const result = await measureLoad(page, {
            url,
            reload: step.reload,
            capMs: options.cap,
            quietMs: QUIET_MS,
            net,
          });
          const record = {
            shot: shot.id,
            round,
            kind: step.kind,
            capped: result.capped,
            marks: result.marks,
            firstRenderApprox: result.firstRenderApprox,
            renders: result.renders,
            frames: result.frames,
            resourceHosts: result.resourceHosts,
            hiddenFrames: result.hiddenFrames,
            visibility: result.visibility,
            requests: result.requests,
          };
          runs.push(record);
          console.log(
            `quiet ${fmtMs(record.marks.quiet)} ms ` +
              `(canvas ${fmtMs(record.marks.firstCanvas)}, ` +
              `loaded ${fmtMs(record.marks.loaded)}, ` +
              `tiles ${fmtMs(record.marks.tilesLoaded)}) ` +
              `${fmtFps(record.frames.meanFps)} fps` +
              (record.capped ? " [CAPPED]" : ""),
          );
        } catch (error) {
          console.log("FAILED");
          failures.push(`[${shot.id} ${step.kind} r${round}] ${error.message}`);
        }
      }

      await context.close();
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const loadSummary = aggregateLoad(runs);

  console.log(`\nCompleted ${runs.length} load(s) in ${elapsed}s`);
  printLoadSummary(loadSummary);
  printConsoleSummary(consoleCounts, httpCounts);

  const timestamp = new Date().toISOString();
  const outputPath = resolve(
    OUTPUT_DIR,
    `${timestamp.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        timestamp,
        config: {
          mode: "load",
          serve: options.serve,
          capMs: options.cap,
          quietMs: QUIET_MS,
          warmReloads: options.warm,
          rounds: options.rounds,
          dpr: options.dpr,
          shots: shots.map((shot) => shot.id),
          targetViewport: TARGET_VIEWPORT,
        },
        environment: probe,
        // Move-mode fields stay present and empty so the file shape is stable.
        runs: [],
        summary: [],
        consoleErrors: Object.fromEntries(consoleCounts),
        httpErrors: Object.fromEntries(httpCounts),
        failures,
        load: { runs, summary: loadSummary },
      },
      null,
      2,
    ),
  );
  console.log(`\nResults written to ${outputPath}`);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAILED: ${failure}`);
    return 1;
  }
  return 0;
}

async function cleanup() {
  killVite();
  if (browser) {
    const instance = browser;
    browser = null;
    try {
      await instance.close();
    } catch {
      // Browser may already be closed.
    }
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const onSignal = async (signal) => {
    console.error(`\nReceived ${signal}; shutting down.`);
    await cleanup();
    process.exit(130);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  let exitCode = 0;
  try {
    exitCode = await run(options);
  } catch (error) {
    console.error(`\nBenchmark failed: ${error.message}`);
    exitCode = 1;
  } finally {
    await cleanup();
  }
  process.exitCode = exitCode;
}

main();
