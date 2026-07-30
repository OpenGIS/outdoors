<script setup>
import { ref, shallowRef, computed, watch, onMounted } from 'vue'
import { setupContours } from '../scripts/contours.js'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import MaplibreCompare from '@maplibre/maplibre-gl-compare'
import '@maplibre/maplibre-gl-compare/dist/maplibre-gl-compare.css'

import outdoorStyleRaw from '../style.json?raw'

// Comparison entries — add or remove entries to control the left-map dropdown.
// Each entry needs a unique `key`, a `label`, and a MapLibre style object.
const comparisonEntries = shallowRef([
  {
    key: 'opentopomap',
    label: 'OpenTopoMap',
    style: {
      version: 8,
      name: 'OpenTopoMap',
      sources: {
        opentopomap: {
          type: 'raster',
          tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution:
            '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> contributors (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
        },
      },
      layers: [
        {
          id: 'opentopomap-raster',
          type: 'raster',
          source: 'opentopomap',
          minzoom: 0,
          maxzoom: 18,
        },
      ],
    },
  },
  {
    key: 'thunderforestoutdoors',
    label: 'Thunderforest Outdoors',
    style: {
      version: 8,
      name: 'Thunderforest Outdoors',
      sources: {
        thunderforestoutdoors: {
          type: 'raster',
          tiles: [`https://api.thunderforest.com/outdoors/{z}/{x}/{y}@2x.png?apikey=${import.meta.env.VITE_THUNDERFOREST_API_KEY}`],
          tileSize: 256,
          attribution:
            '&copy; <a href="https://www.thunderforest.com">Thunderforest</a> | &copy; <a href="https://www.openstreetmap.org/copyright">OSM Contributors</a>',
        },
      },
      layers: [
        {
          id: 'thunderforestoutdoors-raster',
          type: 'raster',
          source: 'thunderforestoutdoors',
          minzoom: 0,
          maxzoom: 18,
        },
      ],
    },
  },
])

// Try to load cached Liberty style (downloaded by build script).
// The .cache/ dir is gitignored, so this is a no-op if not present.
// Using fetch() instead of dynamic import() because the Vue SFC compiler
// treats top-level import() inside a script setup block as a static import statement.
fetch('../.cache/liberty-processed.json')
  .then((r) => r.json())
  .then((style) => {
    comparisonEntries.value.unshift({
      key: 'liberty',
      label: 'Liberty',
      style,
    })
  })
  .catch(() => {
    // Liberty cache not available — skip entry
  })

const selectedKey = ref(comparisonEntries.value[0]?.key ?? '')
const selectedEntry = computed(() =>
  comparisonEntries.value.find((e) => e.key === selectedKey.value),
)

const compareEl = ref(null)
let leftMap = null
let rightMap = null

function applyLeftStyle(style) {
  if (leftMap) {
    leftMap.setStyle(style, { diff: false })
  }
}

watch(selectedKey, async (key) => {
  if (!leftMap) return
  const entry = comparisonEntries.value.find((e) => e.key === key)
  if (!entry?.style) return
  applyLeftStyle(entry.style)
})

onMounted(async () => {
  const rightStyle = JSON.parse(outdoorStyleRaw)

  // Register contour plugin & patch for imperial units BEFORE the map parses
  setupContours(rightStyle, 'imperial')

  const leftStyle = selectedEntry.value?.style

  leftMap = new maplibregl.Map({
    container: 'left',
    style: leftStyle,
    center: [9, 48],
    zoom: 3,
    hash: true,
  })

  rightMap = new maplibregl.Map({
    container: 'right',
    style: rightStyle,
    center: [9, 48],
    zoom: 3,
  })

  new MaplibreCompare(leftMap, rightMap, compareEl.value, {})

  leftMap.once('idle', () => {
    rightMap.jumpTo({
      center: leftMap.getCenter(),
      zoom: leftMap.getZoom(),
    })
  })
})
</script>

<template>
  <div ref="compareEl" id="compare">
    <div id="left" class="map">
      <div class="style-selector">
        <select v-model="selectedKey">
          <option
            v-for="entry in comparisonEntries"
            :key="entry.key"
            :value="entry.key"
          >
            {{ entry.label }}
          </option>
        </select>
      </div>
    </div>
    <div id="right" class="map"></div>
  </div>
</template>

<style>
@import './reset.css';
@import './style.css';
</style>
