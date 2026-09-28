import { ref, watch } from "vue";

const HILLSHADE_STORAGE = "outdoors_dev_demHillshade";
const TERRAIN_STORAGE = "outdoors_dev_demTerrain";

// Deliberately distinct from the right pane's `demSource` id so a provider
// style that happens to use the same source id cannot collide with ours.
const DEM_SOURCE_ID = "compare-dem";
const HILLSHADE_LAYER_ID = "compare-hillshade";
const TERRAIN_EXAGGERATION = 1.2;

const DEM_SOURCE = {
  type: "raster-dem",
  tiles: ["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"],
  encoding: "terrarium",
  tileSize: 512,
  maxzoom: 17,
  attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
};

// Mirrors the right pane's hillshade for parity.
const HILLSHADE_PAINT = {
  "hillshade-exaggeration": [
    "interpolate",
    ["linear"],
    ["zoom"],
    3,
    0,
    5,
    0.2,
    12,
    0.2,
  ],
};

/**
 * Read a boolean toggle. Absent values default to enabled, so both DEM
 * overlays are on for a first-time visitor.
 */
function readEnabled(key) {
  const stored = localStorage.getItem(key);
  return stored === null ? true : stored !== "false";
}

function persist(key, value) {
  localStorage.setItem(key, String(value));
}

/**
 * DEM overlays for the left-hand compare map: hillshading and 3D terrain
 * backed by a dedicated `compare-dem` raster-dem source. Both toggles default
 * on and persist independently; the source is only removed once both are off,
 * because terrain still needs it while enabled.
 *
 * Returns:
 * - hillshade: writable ref bound via v-model
 * - terrain: writable ref bound via v-model
 * - attach: binds the state to a MapLibre map instance, re-applying after
 *   every style load
 */
export function useDemOverlay() {
  const hillshade = ref(readEnabled(HILLSHADE_STORAGE));
  const terrain = ref(readEnabled(TERRAIN_STORAGE));

  let map = null;
  let ready = false;

  function ensureSource() {
    if (!map || map.getSource(DEM_SOURCE_ID)) return;
    map.addSource(DEM_SOURCE_ID, {
      ...DEM_SOURCE,
      tiles: [...DEM_SOURCE.tiles],
    });
  }

  /**
   * Id of the provider's first symbol layer, so the hillshade can sit above
   * base raster/polygons but below labels. Undefined pushes to the top.
   */
  function firstSymbolLayerId() {
    const layers = map.getStyle()?.layers ?? [];
    return layers.find((layer) => layer.type === "symbol")?.id;
  }

  function removeSourceIfUnused() {
    if (!map || hillshade.value || terrain.value) return;
    if (!map.getSource(DEM_SOURCE_ID)) return;
    map.setTerrain(null);
    map.removeSource(DEM_SOURCE_ID);
  }

  function applyHillshade() {
    if (!map || !ready) return;

    if (hillshade.value) {
      ensureSource();
      if (map.getLayer(HILLSHADE_LAYER_ID)) return;
      map.addLayer(
        {
          id: HILLSHADE_LAYER_ID,
          type: "hillshade",
          source: DEM_SOURCE_ID,
          paint: HILLSHADE_PAINT,
        },
        firstSymbolLayerId(),
      );
    } else {
      if (map.getLayer(HILLSHADE_LAYER_ID)) {
        map.removeLayer(HILLSHADE_LAYER_ID);
      }
      removeSourceIfUnused();
    }
  }

  function applyTerrain() {
    if (!map || !ready) return;

    if (terrain.value) {
      ensureSource();
      map.setTerrain({
        source: DEM_SOURCE_ID,
        exaggeration: TERRAIN_EXAGGERATION,
      });
    } else {
      map.setTerrain(null);
      removeSourceIfUnused();
    }
  }

  function applyAll() {
    applyHillshade();
    applyTerrain();
  }

  /**
   * Bind to a MapLibre map instance. The overlays are re-applied after every
   * `style.load`, so a full provider style replacement (setStyle with
   * diff: false) restores the source, hillshade layer and terrain. Skipping
   * until the first style load keeps `ready` gated against adding to an
   * unloaded style.
   */
  function attach(instance) {
    map = instance;
    map.on("style.load", () => {
      ready = true;
      applyAll();
    });
  }

  watch(hillshade, (value) => {
    persist(HILLSHADE_STORAGE, value);
    applyHillshade();
  });

  watch(terrain, (value) => {
    persist(TERRAIN_STORAGE, value);
    applyTerrain();
  });

  return { hillshade, terrain, attach };
}
