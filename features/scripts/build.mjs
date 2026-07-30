#!/usr/bin/env node

/**
 * Build outdoor feature vector tiles using Planetiler.
 *
 * Supports two build modes:
 *   - YAML schema (default): runs `generate-custom` with schema.yml
 *   - Java profile: runs a standalone Java profile class
 *
 * Usage:
 *   node scripts/build.mjs                     # default: pois (YAML)
 *   node scripts/build.mjs --feature=routes    # routes (Java profile)
 *   node scripts/build.mjs --feature=pois --bounds=10.48,45.27,11.78,46.18
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const JAR_DIR = resolve(ROOT, '.planetiler')
const JAR_PATH = resolve(JAR_DIR, 'planetiler.jar')

const PLANETILER_DOWNLOAD_URL =
  'https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar'

// Default bounds — Venetian Prealps, NE Italy (~50km around 45.723, 11.128)
const DEFAULT_BOUNDS = '10.48,45.27,11.78,46.18'
const DEFAULT_FEATURE = 'pois'

// Feature build mode: 'yaml' or 'java'
const FEATURE_MODES = {
  pois: 'yaml',
  routes: 'java',
}

// Map feature name to Java profile class file (in scripts/ directory)
const JAVA_PROFILES = {
  routes: 'HikingRouteOverlay.java',
}

function getArg(name, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`))
  return arg ? arg.split('=')[1] : fallback
}

function getFeature() {
  return getArg('feature', DEFAULT_FEATURE)
}

function getBounds() {
  return getArg('bounds', DEFAULT_BOUNDS)
}

function checkJava() {
  try {
    const out = execSync('java -version 2>&1', { encoding: 'utf8' })
    const match = out.match(/(\d+)\./)
    if (!match || parseInt(match[1]) < 21) {
      console.error('✗ JDK 21+ required. Found:')
      console.error(out.trim().split('\n')[0])
      process.exit(1)
    }
    console.log(`✓ ${out.trim().split('\n')[0]}`)
  } catch {
    console.error('✗ Java not found. Install JDK 21+: https://adoptium.net')
    process.exit(1)
  }
}

function downloadJar() {
  if (existsSync(JAR_PATH)) {
    console.log(`✓ Planetiler JAR already at ${JAR_PATH}`)
    return
  }

  console.log('↓ Downloading Planetiler JAR...')
  mkdirSync(JAR_DIR, { recursive: true })

  try {
    execSync(`curl -#L -o "${JAR_PATH}" "${PLANETILER_DOWNLOAD_URL}"`, {
      stdio: 'inherit',
      timeout: 120_000,
    })
    console.log('✓ Planetiler JAR downloaded')
  } catch (err) {
    console.error('✗ Failed to download Planetiler JAR:', err.message)
    process.exit(1)
  }
}

function buildYaml(feature, bounds) {
  const schemaPath = resolve(ROOT, feature, 'schema.yml')
  const outputPath = resolve(ROOT, feature, `outdoor_${feature}.pmtiles`)

  if (!existsSync(schemaPath)) {
    console.error(`✗ Schema not found at ${schemaPath}`)
    console.error(`  Valid YAML-based features: pois`)
    process.exit(1)
  }

  console.log(`  schema:  ${schemaPath}`)
  console.log(`  output:  ${outputPath}`)
  console.log(`  bounds:  ${bounds}`)
  console.log()

  const cmd = [
    `java -jar "${JAR_PATH}"`,
    'generate-custom',
    `--schema="${schemaPath}"`,
    `--output="${outputPath}"`,
    '--maxzoom=16',
    '--download',
    `--bounds=${bounds}`,
    '--quiet',
  ].join(' ')

  try {
    execSync(cmd, { stdio: 'inherit', timeout: 600_000 })
    console.log(`\n✓ Outdoor ${feature} tiles written to ${outputPath}`)
  } catch (err) {
    console.error(`\n✗ Planetiler build failed for ${feature}:`, err.message)
    process.exit(1)
  }
}

function buildJava(feature, bounds) {
  const javaFile = JAVA_PROFILES[feature]
  if (!javaFile) {
    console.error(`✗ No Java profile configured for feature: ${feature}`)
    process.exit(1)
  }

  const javaPath = resolve(__dirname, javaFile)
  if (!existsSync(javaPath)) {
    console.error(`✗ Java profile not found at ${javaPath}`)
    process.exit(1)
  }

  const area = getArg('area', 'italy')
  const outputPath = resolve(ROOT, feature, `outdoor_${feature}.pmtiles`)

  console.log(`  profile: ${javaFile}`)
  console.log(`  output:  ${outputPath}`)
  console.log(`  bounds:  ${bounds}`)
  console.log(`  area:    ${area}`)
  console.log()

  // Detect shared OSM data from previous YAML builds
  const sharedOsmPath = resolve(ROOT, 'data', 'sources', `geofabrik_${area}.osm.pbf`)
  const osmArg = existsSync(sharedOsmPath)
    ? `--osm_path="${sharedOsmPath}"`
    : `--download`

  // Run the Java profile as a single-file program (Java 22+ JEP 458)
  const cmd = [
    `java -cp "${JAR_PATH}"`,
    `"${javaPath}"`,
    `--area=${area}`,
    osmArg,
    `--bounds=${bounds}`,
    `--quiet`,
  ].join(' ')

  try {
    execSync(cmd, {
      stdio: 'inherit',
      timeout: 600_000,
      cwd: ROOT,  // Run from features/ so relative paths resolve
    })
    console.log(`\n✓ Outdoor ${feature} tiles written to ${outputPath}`)
  } catch (err) {
    console.error(`\n✗ Planetiler build failed for ${feature}:`, err.message)
    process.exit(1)
  }
}

function build() {
  const feature = getFeature()
  const bounds = getBounds()
  const mode = FEATURE_MODES[feature]

  if (!mode) {
    console.error(`✗ Unknown feature: ${feature}`)
    console.error(`  Valid features: ${Object.keys(FEATURE_MODES).join(', ')}`)
    process.exit(1)
  }

  console.log(`  feature: ${feature}`)
  console.log(`  mode:    ${mode}`)
  console.log()

  // Ensure the output directory exists
  const outputDir = resolve(ROOT, feature)
  mkdirSync(outputDir, { recursive: true })

  if (mode === 'yaml') {
    buildYaml(feature, bounds)
  } else if (mode === 'java') {
    buildJava(feature, bounds)
  }
}

const feature = getFeature()
console.log(`═══ Outdoor ${feature} Planetiler Build ═══`)
console.log()
checkJava()
downloadJar()
build()
