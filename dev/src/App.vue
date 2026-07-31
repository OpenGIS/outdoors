<script setup>
import { ref, shallowRef, computed, watch, onMounted } from "vue";
import { setupContours } from "../../scripts/contours.js";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import MaplibreCompare from "@maplibre/maplibre-gl-compare";
import "@maplibre/maplibre-gl-compare/dist/maplibre-gl-compare.css";

import outdoorStyleRaw from "../../style.json?raw";
import rawProviders from "./providers.json";
import ProviderSelect from "./components/ProviderSelect.vue";

// ── Constants ──
const API_KEYS_STORAGE = "outdoors_dev_apiKeys";
const SELECTED_STORAGE = "outdoors_dev_selected";

// ── Provider configuration from JSON ──
const providerConfig = ref(rawProviders);

// ── Build sections from available providers ──
const sections = computed(() => {
  const result = [];

  // Merge remote vectors and rasters, group by category
  const allRemote = [];
  for (const p of providerConfig.value.remoteVector || []) {
    allRemote.push({ ...p });
  }
  for (const p of providerConfig.value.remoteRaster || []) {
    allRemote.push({ ...p });
  }

  // Group by category
  const grouped = {};
  for (const p of allRemote) {
    const cat = p.category || "Other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(p);
  }

  // Sort categories alphabetically, then providers by label
  const sortedCats = Object.keys(grouped).sort((a, b) =>
    a.localeCompare(b),
  );
  for (const cat of sortedCats) {
    grouped[cat].sort((a, b) => a.label.localeCompare(b.label));
    result.push({ label: cat, providers: grouped[cat] });
  }

  return result;
});

// ── Flat list for quick provider lookup ──
const allProviders = computed(() =>
  sections.value.flatMap((s) => s.providers),
);

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

// ── Selected provider ──
const selectedKey = ref(localStorage.getItem(SELECTED_STORAGE) || "");

// Validate / initialise selection when providers become available
watch(
  allProviders,
  (providers) => {
    if (!providers.length || selectedKey.value) return;
    const saved = localStorage.getItem(SELECTED_STORAGE);
    if (saved && providers.find((p) => p.key === saved)) {
      selectedKey.value = saved;
    } else {
      // Default to first provider that doesn't require an API key
      // (e.g. OpenTopoMap) to avoid key prompts on page load.
      const noKeyProvider = providers.find((p) => !p.apiKey);
      selectedKey.value = noKeyProvider?.key ?? providers[0].key;
    }
  },
  { immediate: true },
);

// Persist selection
watch(selectedKey, (key) => {
  if (key) localStorage.setItem(SELECTED_STORAGE, key);
});

const selectedEntry = computed(() =>
  allProviders.value.find((p) => p.key === selectedKey.value),
);

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

// ── Initialise maps ──
onMounted(async () => {
  const rightStyle = JSON.parse(outdoorStyleRaw);

  // Register contour plugin & patch for imperial units BEFORE the map parses
  setupContours(rightStyle, "imperial");

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
