<script setup>
import { ref, watch, onMounted } from "vue";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import MaplibreCompare from "@maplibre/maplibre-gl-compare";
import "@maplibre/maplibre-gl-compare/dist/maplibre-gl-compare.css";

import outdoorStyleRaw from "../../style.json?raw";
import ProviderSelect from "./components/ProviderSelect.vue";
import { useProviderSelection } from "./composables/useProviderSelection";

// ── Constants ──
const CONTOURS_TO_IMPERIAL = false;
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
const styleCache = {};

// ── Map state ──
const compareEl = ref(null);
let leftMap = null;
let rightMap = null;

async function resolveStyle(entry) {
  if (entry?.style) return entry.style;
  if (entry?.styleUrl) {
    const cached = styleCache[entry.key];
    if (cached) return cached;
    try {
      const res = await fetch(entry.styleUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const style = json;
      styleCache[entry.key] = style;
      return style;
    } catch (e) {
      console.warn(`[App] Failed to fetch "${entry.label}":`, e);
      return null;
    }
  }
}

async function resolveProviderStyle(key) {
  const provider = allProviders.value.find((p) => p.key === key);
  if (!provider) return null;
  const resolved = await ensureApiKey(provider);
  if (!resolved) return null;
  return resolveStyle(resolved);
}

// ── Apply style when selection changes ──
watch(selectedKey, async (key) => {
  if (!leftMap) return;
  const style = await resolveProviderStyle(key);
  if (style) leftMap.setStyle(style, { diff: false });
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
  if (CONTOURS_TO_IMPERIAL) {
    applyImperialContours(rightStyle);
  }

  // Resolve initial left-map style (with API key prompt if needed)
  const entry = selectedEntry.value;
  const leftStyle = entry ? await resolveProviderStyle(entry.key) : null;

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