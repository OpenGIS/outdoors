#!/usr/bin/env node

/**
 * Dev server for outdoor feature PMTiles.
 *
 * Auto-discovers feature directories (subdirectories containing
 * schema.yml) and serves each on /{feature}/{z}/{x}/{y}.pbf.
 *
 * Usage:
 *   node scripts/server.mjs          # port 11002
 *   node scripts/server.mjs --port 11003
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PMTiles } from 'pmtiles'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DEFAULT_PORT = 11002

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' }

function getPort() {
  const arg = process.argv.find(a => a.startsWith('--port='))
  return arg ? parseInt(arg.split('=')[1], 10) : DEFAULT_PORT
}

function writeHead(res, status, extra = {}) {
  res.writeHead(status, { ...CORS_HEADERS, ...extra })
}

function notFound(res, msg = 'Not found') {
  writeHead(res, 404, { 'Content-Type': 'text/plain' })
  res.end(msg + '\n')
}

/**
 * Discover feature directories — subdirectories of ROOT that contain
 * either a schema.yml or outdoor_<name>.pmtiles file (excluding
 * dotfiles, node_modules, data, scripts).
 */
function discoverFeatures() {
  const entries = readdirSync(ROOT, { withFileTypes: true })
  return entries
    .filter(e =>
      e.isDirectory() &&
      !e.name.startsWith('.') &&
      e.name !== 'node_modules' &&
      e.name !== 'data' &&
      e.name !== 'scripts'
    )
    .map(e => e.name)
    .filter(name =>
      existsSync(join(ROOT, name, 'schema.yml')) ||
      existsSync(join(ROOT, name, `outdoor_${name}.pmtiles`))
    )
}

/**
 * Load a PMTiles archive for a feature. Returns null if the file
 * doesn't exist or can't be opened (logs a warning).
 */
async function loadArchive(feature) {
  const pmtilesPath = resolve(ROOT, feature, `outdoor_${feature}.pmtiles`)

  if (!existsSync(pmtilesPath)) {
    console.warn(`  ⚠ ${feature}: no outdoor_${feature}.pmtiles found — build it first`)
    return null
  }

  try {
    const fileBuf = readFileSync(pmtilesPath)
    const source = {
      getKey: () => `${feature}.pmtiles`,
      getBytes: async (offset, length) => {
        const slice = fileBuf.subarray(offset, offset + length)
        return {
          data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
        }
      },
    }

    const archive = new PMTiles(source)
    const header = await archive.getHeader()

    console.log(`  ✓ ${feature}: loaded outdoor_${feature}.pmtiles`)
    console.log(`    center: ${header.centerLon.toFixed(4)}, ${header.centerLat.toFixed(4)}`)
    console.log(`    zoom:   ${header.minZoom} – ${header.maxZoom}`)

    return { feature, archive, header, pmtilesPath }
  } catch (err) {
    console.warn(`  ⚠ ${feature}: failed to open PMTiles archive — ${err.message}`)
    return null
  }
}

/**
 * Serve a tile from an archive.
 */
async function serveTile(res, archive, z, x, y) {
  try {
    const result = await archive.getZxy(z, x, y)
    if (!result || !result.data || result.data.byteLength === 0) {
      notFound(res, `No data for ${z}/${x}/${y}`)
      return
    }
    writeHead(res, 200, {
      'Content-Type': 'application/x-protobuf',
      'Cache-Control': 'public, max-age=86400',
    })
    res.end(Buffer.from(result.data))
    console.log(`  200 ${z}/${x}/${y}  ${result.data.byteLength}B`)
  } catch (err) {
    console.error(`  ERR ${z}/${x}/${y}: ${err.message}`)
    if (!res.headersSent) {
      writeHead(res, 500)
      res.end(err.message + '\n')
    }
  }
}

async function main() {
  const port = getPort()

  // ── Discover and load feature archives ──────────────────────────
  const features = discoverFeatures()

  if (features.length === 0) {
    console.error('✗ No feature directories with schema.yml found')
    console.error('  Run `npm run build` first to generate tiles.')
    process.exit(1)
  }

  console.log(`Found ${features.length} feature(s): ${features.join(', ')}`)
  console.log()

  const archives = (await Promise.all(features.map(loadArchive)))
    .filter(Boolean)

  if (archives.length === 0) {
    console.error('\n✗ No PMTiles archives could be loaded.')
    console.error('  Run `npm run build` first to generate tiles.')
    process.exit(1)
  }

  // Build route map: feature name → archive
  const routeMap = {}
  for (const entry of archives) {
    routeMap[entry.feature] = entry.archive
  }

  // ── HTTP server ─────────────────────────────────────────────────
  const server = createServer(async (req, res) => {
    // Health check
    if (req.url === '/health' || req.url === '/') {
      writeHead(res, 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        port,
        archives: archives.map(a => ({
          name: a.feature,
          path: `/${a.feature}/{z}/{x}/{y}.pbf`,
          center: [a.header.centerLon, a.header.centerLat],
          zoom: [a.header.minZoom, a.header.maxZoom],
        })),
      }))
      return
    }

    // Feature-specific tile: /{feature}/{z}/{x}/{y}.pbf
    const featureMatch = req.url.match(/^\/(\w+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/)
    if (featureMatch) {
      const [, feature, zStr, xStr, yStr] = featureMatch
      const archive = routeMap[feature]
      if (!archive) {
        notFound(res, `Unknown feature: ${feature}`)
        return
      }
      await serveTile(res, archive, parseInt(zStr), parseInt(xStr), parseInt(yStr))
      return
    }

    notFound(res, `Invalid tile URL: ${req.url}`)
  })

  server.listen(port, () => {
    console.log(`═══ Outdoor Feature Tile Server ═══`)
    console.log(`  URL:  http://localhost:${port}`)
    for (const a of archives) {
      console.log(`  Tile: http://localhost:${port}/${a.feature}/{z}/{x}/{y}.pbf`)
    }
    console.log(`  Ctrl+C to stop\n`)
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
