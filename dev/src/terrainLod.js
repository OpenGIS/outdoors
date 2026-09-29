/**
 * Terrain level-of-detail tuning, shared by both compare maps.
 *
 * `setSourceTileLodParams(maxZoomLevelsOnScreen, tileCountMaxMinRatio)` caps
 * how many distinct zoom levels and how many tiles a raster-dem source loads
 * at high pitch, where the horizon is visible. MapLibre's defaults are
 * (9.314, 3.0). A moderate step down to (6, 2) was measured at +11% fps on
 * pitched views and is inert at pitch 0, so it costs nothing where it does
 * not apply. Lower values request fewer, coarser tiles.
 */
export const TERRAIN_LOD = {
  maxZoomLevelsOnScreen: 6,
  tileCountMaxMinRatio: 2,
};

/**
 * Apply the LOD override to a single raster-dem source. Guarded so older
 * MapLibre versions without `setSourceTileLodParams`, and absent sources,
 * degrade gracefully instead of throwing. Idempotent: safe to call repeatedly,
 * before or after the style has loaded.
 */
export function applyTerrainLod(map, sourceId) {
  if (typeof map?.setSourceTileLodParams !== "function") return;
  if (!map.getSource(sourceId)) return;
  map.setSourceTileLodParams(
    TERRAIN_LOD.maxZoomLevelsOnScreen,
    TERRAIN_LOD.tileCountMaxMinRatio,
    sourceId,
  );
}
