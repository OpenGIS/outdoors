#!/usr/bin/env node

/**
 * Generate named PNG screenshots of the project's MapLibre style.
 *
 * Usage:
 *   node scripts/screenshots/generate.mjs            # all shots
 *   node scripts/screenshots/generate.mjs --name <id> # one shot only
 *
 * Serves a small static harness page (plus style.json and the MapLibre
 * UMD bundle) over a local http server on a free port in 11000-11999,
 * then drives headless Chromium via Playwright: one fresh browser
 * context per shot (clean tile cache), waiting for the harness to
 * signal window.__shotReady before capturing the screenshot.
 *
 * Output PNGs land in screenshots/ at the project root at
 * width*scale x height*scale CSS pixels.
 */

import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const SCREENSHOTS_DIR = resolve(PROJECT_ROOT, "screenshots");
const PORT_RANGE = { min: 11000, max: 11999 };
// Bind IPv4 loopback only and reach the server by 127.0.0.1. Session Vite
// dev servers listen on IPv6 loopback (::1), and "localhost" resolves to
// ::1 first in Chromium on macOS, so navigating to "localhost" could hit
// the wrong process. 127.0.0.1 is unambiguous.
const HOST = "127.0.0.1";

const MIME_TYPES = {
  ".html": "text/html",
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};

/**
 * Find a free port in the ephemeral range by trying to bind each one in
 * turn; the first successful bind wins and the server is already
 * listening on it.
 */
async function startServer() {
  for (let port = PORT_RANGE.min; port <= PORT_RANGE.max; port++) {
    try {
      const server = createServer(handleRequest);
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, HOST, () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      return server;
    } catch {
      // Port in use; try the next one.
    }
  }
  throw new Error(
    `no free port found in range ${PORT_RANGE.min}-${PORT_RANGE.max}`,
  );
}

/**
 * Serve the harness page, style.json and the MapLibre UMD bundle. All
 * paths are resolved from this file's own location, never from the
 * current working directory.
 */
function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathToFile = {
    "/": resolve(__dirname, "harness.html"),
    "/style.json": resolve(PROJECT_ROOT, "style.json"),
    "/sprite.json": resolve(PROJECT_ROOT, "dev", "public", "sprite.json"),
    "/sprite.png": resolve(PROJECT_ROOT, "dev", "public", "sprite.png"),
    "/sprite@2x.json": resolve(PROJECT_ROOT, "dev", "public", "sprite@2x.json"),
    "/sprite@2x.png": resolve(PROJECT_ROOT, "dev", "public", "sprite@2x.png"),
    "/maplibre-gl.js": resolve(
      PROJECT_ROOT,
      "node_modules",
      "maplibre-gl",
      "dist",
      "maplibre-gl.js",
    ),
    "/maplibre-gl.css": resolve(
      PROJECT_ROOT,
      "node_modules",
      "maplibre-gl",
      "dist",
      "maplibre-gl.css",
    ),
  };

  const filePath = pathToFile[url.pathname];
  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  try {
    const body = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type":
        MIME_TYPES[extname(filePath)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

/**
 * Read shots.json, validate each shot, and return the (optionally
 * filtered) array.
 */
function loadShots(filterId) {
  const shots = JSON.parse(
    readFileSync(resolve(__dirname, "shots.json"), "utf8"),
  ).shots;

  if (!filterId) return shots;

  const matches = shots.filter((shot) => shot.id === filterId);
  if (matches.length === 0) {
    const ids = shots.map((shot) => shot.id).join(", ");
    throw new Error(`unknown shot id "${filterId}" (known ids: ${ids})`);
  }
  return matches;
}

/** Build the harness URL for one shot. */
function shotUrl(port, shot) {
  const params = new URLSearchParams({
    center: shot.center.join(","),
    zoom: String(shot.zoom),
    bearing: String(shot.bearing ?? 0),
    pitch: String(shot.pitch ?? 0),
  });
  return `http://${HOST}:${port}/?${params.toString()}`;
}

/**
 * Render one shot: fresh context (viewport + device scale), load the
 * harness, wait for the readiness flag, capture the PNG, and return any
 * console/page errors so the caller can warn without dropping the shot.
 */
async function captureShot(browser, port, shot) {
  const scale = shot.scale ?? 2;
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  try {
    await page.goto(shotUrl(port, shot), {
      waitUntil: "load",
      timeout: 120000,
    });
    // NB: options must be the third argument — Playwright treats a second
    // object as the function's arg, silently ignoring timeout.
    await page.waitForFunction(() => window.__shotReady === true, undefined, {
      // Outlives the harness's 20-minute idle fallback so that path still works.
      timeout: 1220000,
    });

    const outputPath = resolve(SCREENSHOTS_DIR, `${shot.id}.png`);
    await page.screenshot({
      path: outputPath,
      clip: { x: 0, y: 0, width: shot.width, height: shot.height },
      // Large shots (e.g. 10000x10000 CSS px at scale 2) take minutes to encode.
      timeout: 300000,
    });

    const mapErrors = await page.evaluate(() => window.__mapErrors ?? []);
    return { outputPath, consoleErrors, pageErrors, mapErrors };
  } finally {
    await context.close();
  }
}

/** CLI: extract the value following --name, or null. */
function parseNameFlag() {
  const index = process.argv.indexOf("--name");
  return index !== -1 ? process.argv[index + 1] : null;
}

async function main() {
  const filterId = parseNameFlag();
  const shots = loadShots(filterId);
  const isFiltered = filterId !== null;

  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const server = await startServer();
  const port = server.address().port;
  console.log(`Screenshot server on http://${HOST}:${port}`);
  console.log(
    `Generating ${shots.length} shot${shots.length === 1 ? "" : "s"}`,
  );

  const browser = await chromium.launch();
  const failures = [];
  const warnings = [];
  let generated = 0;

  try {
    for (const shot of shots) {
      const banner = `  - ${shot.id}`;
      console.log(banner);
      try {
        const result = await captureShot(browser, port, shot);
        generated += 1;

        const problems = [
          ...result.pageErrors,
          ...result.mapErrors,
          ...result.consoleErrors,
        ];
        if (problems.length > 0) {
          warnings.push(
            `[${shot.id}] console/page errors:\n    ${problems.join("\n    ")}`,
          );
        }
      } catch (error) {
        failures.push(`[${shot.id}] ${error.message}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`Generated ${generated} shots -> ${SCREENSHOTS_DIR}`);

  for (const warning of warnings) console.warn(`\n${warning}`);
  for (const failure of failures) console.error(`\nFAILED: ${failure}`);

  if (failures.length > 0) process.exitCode = 1;
  if (isFiltered) process.exitCode = 0;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
