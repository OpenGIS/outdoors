/**
 * Parse a MapLibre `location.hash` camera fragment.
 *
 * Format: `#zoom/lat/lng[/bearing[/pitch]]`. Numbers are parsed with
 * `parseFloat` to mirror MapLibre's own hash semantics; bearing and pitch are
 * optional and default to 0 when absent. Malformed input — fewer than three or
 * more than five parts, or a non-finite zoom/lat/lng — returns `null` so the
 * caller can fall back to its existing defaults unchanged.
 */
export function parseHashCamera(hash) {
  if (typeof hash !== "string" || hash.length < 2 || hash[0] !== "#") {
    return null;
  }
  const parts = hash.slice(1).split("/");
  if (parts.length < 3 || parts.length > 5) return null;
  const [zoom, lat, lng, bearing, pitch] = parts.map((part) =>
    parseFloat(part),
  );
  if (![zoom, lat, lng].every(Number.isFinite)) return null;
  return {
    zoom,
    center: { lat, lng },
    bearing: Number.isFinite(bearing) ? bearing : 0,
    pitch: Number.isFinite(pitch) ? pitch : 0,
  };
}
