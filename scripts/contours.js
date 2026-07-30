import mlcontour from 'maplibre-contour'
import maplibregl from 'maplibre-gl'

let _contourPluginRegistered = false

/**
 * Register the maplibre-contour plugin so it intercepts dem-contour://
 * tile requests and generates contour vector tiles from raw DEM data.
 *
 * Idempotent — subsequent calls are no-ops (the protocol handler only
 * needs to be registered once per page load).
 */
export function registerContourPlugin() {
  if (!_contourPluginRegistered) {
    const demSource = new mlcontour.DemSource({
      url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
      encoding: 'terrarium',
      maxzoom: 20,
      worker: true,
    })

    demSource.setupMaplibre(maplibregl)
    _contourPluginRegistered = true
  }
}

/**
 * Detect which contour mode a style uses by inspecting its
 * contour-source tile URL.
 *
 * @param {object} style  A MapLibre style object
 * @returns {'plugin'|'pbf'|null}
 */
export function detectContourMode(style) {
  const source = style?.sources?.['contour-source']
  if (!source?.tiles) return null
  const tileUrl = source.tiles[0]
  if (typeof tileUrl !== 'string') return null
  return tileUrl.startsWith('dem-contour://') ? 'plugin' : 'pbf'
}

/**
 * Apply imperial unit overrides to a built style object.
 *
 * For plugin mode: injects a multiplier query param into the contour
 * source URL (converting metres to feet inside the contour algorithm)
 * and changes the label suffix from 'm' to 'ft'.
 *
 * For PBF mode: rewrites the label expression to multiply ele by
 * 3.28084 and use 'ft'.
 *
 * @param {object} style  Style object to patch
 */
export function applyImperialUnits(style) {
  const mode = detectContourMode(style)
  if (!mode) return

  // ── Plugin mode: inject multiplier into tile URL ──
  if (mode === 'plugin') {
    const source = style.sources['contour-source']
    if (source.tiles) {
      source.tiles = source.tiles.map(t =>
        t.includes('?') ? `${t}&multiplier=3.28084` : `${t}?multiplier=3.28084`,
      )
    }
  }

  // ── Patch label suffix 'm' → 'ft' ──
  const labelLayer = style.layers?.find(l => l.id === 'contour-labels')
  if (labelLayer?.layout) {
    if (mode === 'plugin') {
      labelLayer.layout['text-field'] = [
        'concat',
        ['number-format', ['get', 'ele'], {}],
        'ft',
      ]
    } else {
      // PBF mode — multiply ele by 3.28084, then round
      labelLayer.layout['text-field'] = [
        'concat',
        ['number-format', ['round', ['*', ['get', 'ele'], 3.28084]], {}],
        'ft',
      ]
    }
  }
}

/**
 * One-shot setup: register the contour plugin (if the style uses it),
 * detect contour mode, and optionally apply imperial unit overrides.
 *
 * Must be called BEFORE the map parses the style — the plugin protocol
 * handler and URL patching need to be in place before style loading.
 *
 * @param {object} style  Style object to patch
 * @param {string} units  'metric' (default) or 'imperial'
 */
export function setupContours(style, units = 'metric') {
  const mode = detectContourMode(style)
  if (mode === 'plugin') {
    registerContourPlugin()
  }

  if (units === 'imperial') {
    applyImperialUnits(style)
  }
}
