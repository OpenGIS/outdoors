<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import MaplibreCompare from "@maplibre/maplibre-gl-compare";
import "@maplibre/maplibre-gl-compare/dist/maplibre-gl-compare.css";

import outdoorStyleRaw from "../../style.json?raw";
import ProviderSelect from "./components/ProviderSelect.vue";
import { useProviderSelection } from "./composables/useProviderSelection";
import { useDemOverlay } from "./composables/useDemOverlay";

// ── Constants ──
const CONTOURS_TO_IMPERIAL = false;
const API_KEYS_STORAGE = "outdoors_dev_apiKeys";
const VIEW_MODE_STORAGE = "outdoors_dev_viewMode";

// ── Provider selection state (sections, selectedKey, persistence) ──
const { sections, allProviders, selectedKey, selectedEntry } =
  useProviderSelection();

// ── Left-map DEM overlays (hillshading, 3D terrain; both default on) ──
const { hillshade, terrain, attach: attachDemOverlay } = useDemOverlay();

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
    apiKey = window.prompt(
      `Enter API key for "${provider.label}":\n\nAPI keys are stored locally in your browser only.`,
    );
    if (!apiKey) return null; // user cancelled
    setStoredApiKey(provider.key, apiKey);
  }

  return replaceApiKeyTokens(provider, apiKey);
}

// ── Cache for fetched remote style JSONs ──
const styleCache = {};

// ── Map state ──
const compareEl = ref(null);
const viewMode = ref(localStorage.getItem(VIEW_MODE_STORAGE) || "overlay");
let leftMap = null;
let rightMap = null;
let compare = null;
let detachSync = null;

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
 * Recursively walk a MapLibre expression, converting elevation values from
 * metres to feet where they are rounded for display and swapping the "m"
 * suffix for "ft". The index-contours case expression is left intact so only
 * index contours get labelled.
 */
function toImperial(expr) {
  if (!Array.isArray(expr)) return expr === "m" ? "ft" : expr;
  if (
    expr.length === 2 &&
    expr[0] === "round" &&
    Array.isArray(expr[1]) &&
    expr[1][0] === "get" &&
    expr[1][1] === "ele"
  ) {
    return ["round", ["*", ["get", "ele"], 3.28084]];
  }
  return expr.map(toImperial);
}

/**
 * Convert contour labels from metric ("m") to imperial ("ft") in the
 * built outdoor style. The style ships metric labels; the compare app
 * applies this so the right-hand map displays feet. Only touches the
 * `contour-labels` layer (hosted PBF contour mode).
 */
function applyImperialContours(style) {
  const labelLayer = style.layers?.find((l) => l.id === "contour-labels");
  if (!labelLayer?.layout?.["text-field"]) return;
  labelLayer.layout["text-field"] = toImperial(labelLayer.layout["text-field"]);
}

// ── View mode (overlay swipe vs side-by-side) ──
function applyViewMode() {
  if (!leftMap || !rightMap || !compareEl.value) return;
  const el = compareEl.value;

  if (viewMode.value === "side-by-side") {
    if (compare) {
      compare.remove();
      compare = null;
    }
    if (detachSync) detachSync();
    el.classList.add("mode-side-by-side");
    alignRightToLeft();
    detachSync = createMoveSync(leftMap, rightMap);
    leftMap.resize();
    rightMap.resize();
  } else {
    if (detachSync) {
      detachSync();
      detachSync = null;
    }
    el.classList.remove("mode-side-by-side");
    if (!compare) {
      compare = new MaplibreCompare(leftMap, rightMap, el, {});
      alignRightToLeft();
    }
    leftMap.resize();
    rightMap.resize();
  }
}

function alignRightToLeft() {
  rightMap.jumpTo({
    center: leftMap.getCenter(),
    zoom: leftMap.getZoom(),
    bearing: leftMap.getBearing(),
    pitch: leftMap.getPitch(),
  });
}

/**
 * Bidirectional pan/zoom sync for side-by-side mode. Mirrors the
 * temporary-detach pattern of @mapbox/mapbox-gl-sync-move: listeners are
 * removed before jumping the other map, then restored, so movements cannot
 * cycle back and forth. Returns a detach function.
 */
function createMoveSync(master, clone) {
  const moveTo = (from, to) =>
    to.jumpTo({
      center: from.getCenter(),
      zoom: from.getZoom(),
      bearing: from.getBearing(),
      pitch: from.getPitch(),
    });

  const onMaster = () => {
    off();
    moveTo(master, clone);
    on();
  };
  const onClone = () => {
    off();
    moveTo(clone, master);
    on();
  };
  const on = () => {
    master.on("move", onMaster);
    clone.on("move", onClone);
  };
  const off = () => {
    master.off("move", onMaster);
    clone.off("move", onClone);
  };

  on();
  return off;
}

watch(viewMode, (mode) => {
  localStorage.setItem(VIEW_MODE_STORAGE, mode);
  applyViewMode();
});

// ── Initialise maps ──
onMounted(async () => {
  const rightStyle = JSON.parse(outdoorStyleRaw);

  // Dev-only: load the outdoors sprite from the locally built sheet (Vite
  // serves dev/public at the root) so icons under active development render
  // before deploy. maplibre-gl v5 rejects relative sprite URLs, so this is
  // absolute against the dev origin. Production keeps the remote sprite URL
  // in style.json.
  if (import.meta.env.DEV) {
    rightStyle.sprite = (rightStyle.sprite || []).map((sheet) =>
      sheet.id === "outdoors"
        ? { ...sheet, url: `${window.location.origin}/sprite` }
        : sheet,
    );
  }

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

  attachDemOverlay(leftMap);

  rightMap = new maplibregl.Map({
    container: "right",
    style: rightStyle,
    center: [9, 48],
    zoom: 3,
  });

  applyViewMode();

  leftMap.once("idle", alignRightToLeft);
});

onBeforeUnmount(() => {
  if (detachSync) {
    detachSync();
    detachSync = null;
  }
  compare?.remove();
  compare = null;
  leftMap?.remove();
  rightMap?.remove();
  leftMap = null;
  rightMap = null;
});
</script>

<template>
  <div ref="compareEl" id="compare">
    <div id="left" class="map">
      <div class="style-selector">
        <ProviderSelect v-model="selectedKey" :sections="sections" />
        <select
          v-model="viewMode"
          class="view-mode-select"
          aria-label="View mode"
        >
          <option value="overlay">Overlay</option>
          <option value="side-by-side">Side by side</option>
        </select>
        <label class="dem-toggle" title="Show hillshading on the left map">
          <input type="checkbox" v-model="hillshade" />
          Hillshading
        </label>
        <label
          class="dem-toggle"
          title="Enable 3D terrain on the left map at 1.2× vertical exaggeration"
        >
          <input type="checkbox" v-model="terrain" />
          3D terrain
        </label>
      </div>
    </div>
    <div id="right" class="map"></div>
  </div>
</template>

<style>
@import "./styles/reset.css";
@import "./styles/style.css";
</style>
