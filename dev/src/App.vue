<script setup>
import { ref, shallowRef, watch, onMounted } from "vue";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import MaplibreCompare from "@maplibre/maplibre-gl-compare";
import "@maplibre/maplibre-gl-compare/dist/maplibre-gl-compare.css";

import outdoorStyleRaw from "../../style.json?raw";
import ProviderSelect from "./components/ProviderSelect.vue";
import { useProviderSelection } from "./composables/useProviderSelection";

// ── Constants ──
const API_KEYS_STORAGE = "outdoors_dev_apiKeys";

// ── Provider selection state (sections, selectedKey, persistence) ──
const { sections, allProviders, selectedKey, selectedEntry } =
  useProviderSelection();

// ── API key management ──
function getStoredApiKeys() {
  try {
    return JSON.parse(localStorage.getItem(API_KEYS_STORAGE) || "{}");
  } catch {
    return {};
  }
}

function setStoredApiKey(key, value) {
  const keys = getStoredApiKeys();
  keys[key] = value;
  localStorage.setItem(API_KEYS_STORAGE, JSON.stringify(keys));
}

/**
 * Walk all string values in an object tree and replace {apiKey} tokens.
 */
function replaceApiKeyTokens(obj, apiKey) {
  return JSON.parse(JSON.stringify(obj), (k, v) =>
    typeof v === "string" ? v.replace(/\{apiKey\}/g, apiKey) : v,
  );
}

/**
 * Ensure a provider has its API key available.
 * Returns a resolved copy with {apiKey} replaced, or null if cancelled.
 */
async function ensureApiKey(provider) {
  if (!provider.apiKey) return provider;

  const keys = getStoredApiKeys();
  let apiKey = keys[provider.key];

  if (!apiKey) {
    apiKey = window.prompt(`Enter API key for "${provider.label}":`);
    if (!apiKey) return null; // user cancelled
    setStoredApiKey(provider.key, apiKey);
  }

  return replaceApiKeyTokens(provider, apiKey);
}

// ── Cache for fetched remote style JSONs ──
const styleCache = shallowRef({});

// ── Map state ──
const compareEl = ref(null);
let leftMap = null;
let rightMap = null;

function applyLeftStyle(style) {
  if (leftMap) {
    leftMap.setStyle(style, { diff: false });
  }
}

function tileJsonToStyle(tj) {
  // Convert a TileJSON response into a minimal MapLibre style
  const sourceId = `remote-${tj.id || "source"}`;
  const sourceType = tj.format === "pbf" ? "vector" : tj.type || "vector";
  const layers = (tj.vector_layers || []).map((vl) => {
    const id = vl.id || "";
    let type = "line";
    if (
      /-area$/.test(id) ||
      /^(landcover|landuse|park|water|ocean|glacier|wetland|building|golf|pitch|protected-area|railway-platform|road-area)/.test(
        id,
      )
    ) {
      type = "fill";
    } else if (/-label$/.test(id)) {
      type = "symbol";
    } else if (/-(lowzoom|line)$/.test(id)) {
      type = "line";
    }
    const layer = {
      id,
      type,
      source: sourceId,
      "source-layer": id,
    };
    if (type === "symbol") {
      layer.layout = {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Regular"],
        "text-size": 10,
      };
      layer.paint = { "text-color": "#333" };
    }
    if (type === "fill") {
      layer.paint = { "fill-color": "#ccc", "fill-opacity": 0.3 };
    }
    if (type === "line") {
      layer.paint = { "line-color": "#888", "line-width": 1 };
    }
    return layer;
  });

  return {
    version: 8,
    name: tj.name || "Remote TileJSON",
    sources: {
      [sourceId]: {
        type: sourceType,
        tiles: tj.tiles,
        minzoom: tj.minzoom,
        maxzoom: tj.maxzoom,
        attribution: tj.attribution,
      },
    },
    layers,
  };
}

async function resolveStyle(entry) {
  if (entry?.style) return entry.style;
  if (entry?.styleUrl) {
    const cached = styleCache.value[entry.key];
    if (cached) return cached;
    try {
      const res = await fetch(entry.styleUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // Detect TileJSON vs MapLibre Style JSON
      const style = json.tilejson ? tileJsonToStyle(json) : json;
      styleCache.value[entry.key] = style;
      return style;
    } catch (e) {
      console.warn(`[App] Failed to fetch "${entry.label}":`, e);
      return null;
    }
  }
  return null;
}

// ── Apply style when selection changes ──
watch(selectedKey, async (key) => {
  if (!leftMap) return;
  const provider = allProviders.value.find((p) => p.key === key);
  if (!provider) return;

  const resolved = await ensureApiKey(provider);
  if (!resolved) return;

  const style = await resolveStyle(resolved);
  if (style) applyLeftStyle(style);
});

/**
 * Convert contour labels from metric ("m") to imperial ("ft") in the
 * built outdoor style. The style ships metric labels; the compare app
 * applies this so the right-hand map displays feet. Only touches the
 * `contour-labels` layer (hosted PBF contour mode).
 */
function applyImperialContours(style) {
  const labelLayer = style.layers?.find((l) => l.id === "contour-labels");
  if (!labelLayer?.layout) return;
  labelLayer.layout["text-field"] = [
    "concat",
    ["number-format", ["round", ["*", ["get", "ele"], 3.28084]], {}],
    "ft",
  ];
}

// ── Initialise maps ──
onMounted(async () => {
  const rightStyle = JSON.parse(outdoorStyleRaw);

  // Patch contour labels to imperial units BEFORE the map parses
  applyImperialContours(rightStyle);

  // Resolve initial left-map style (with API key prompt if needed)
  const entry = selectedEntry.value;
  const resolvedEntry = entry ? await ensureApiKey(entry) : null;
  const leftStyle = resolvedEntry ? await resolveStyle(resolvedEntry) : null;

  leftMap = new maplibregl.Map({
    container: "left",
    style: leftStyle,
    center: [9, 48],
    zoom: 3,
    hash: true,
  });

  rightMap = new maplibregl.Map({
    container: "right",
    style: rightStyle,
    center: [9, 48],
    zoom: 3,
  });

  new MaplibreCompare(leftMap, rightMap, compareEl.value, {});

  leftMap.once("idle", () => {
    rightMap.jumpTo({
      center: leftMap.getCenter(),
      zoom: leftMap.getZoom(),
    });
  });
});
</script>

<template>
  <div ref="compareEl" id="compare">
    <div id="left" class="map">
      <div class="style-selector">
        <ProviderSelect v-model="selectedKey" :sections="sections" />
      </div>
    </div>
    <div id="right" class="map"></div>
  </div>
</template>

<style>
@import "./styles/reset.css";
@import "./styles/style.css";
</style>
