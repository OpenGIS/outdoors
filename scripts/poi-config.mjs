#!/usr/bin/env node

/**
 * Shared config for the outdoor-POI overlay (v2.0 refactor).
 *
 * The single source of truth for the hosted outdoor_pois tiles: which kinds
 * the overlay renders, which basemap sprite icon each uses, and at which
 * zoom the basemap's own POI layers take over. Imported by both
 * scripts/build.mjs (which builds the `outdoor-poi` symbol layer) and
 * scripts/generate-poi-schema.mjs (which regenerates pois/pois-schema.yml
 * for the planetiler profile), so the two can never drift.
 */

export const OUTDOOR_POI = {
  sourceId: "outdoor-poi",
  tileUrl: "https://tile.ogis.app/pois/{z}/{x}/{y}.pbf",
  sourceLayer: "outdoor_pois",
  sourceMinzoom: 12,
  sourceMaxzoom: 16,
  kinds: [
    // kind, icon (basemap sprite), handoffZoom (basemap layer takes over at
    // this zoom; null = basemap never renders it)
    { kind: "hut", icon: "alpinehut", handoffZoom: 17, showEle: true },
    { kind: "shelter", icon: "shelter", handoffZoom: null, showEle: true },
    { kind: "viewpoint", icon: "viewpoint", handoffZoom: 15, showEle: true },
    { kind: "campsite", icon: "camping", handoffZoom: 16, showEle: false },
    { kind: "picnic_site", icon: "picnic", handoffZoom: null, showEle: false },
    {
      kind: "drinking_water",
      icon: "drinking_water",
      handoffZoom: 18,
      showEle: false,
    },
    { kind: "trailhead", icon: "trailhead", handoffZoom: null, showEle: false },
    { kind: "pass", icon: "pass", handoffZoom: null, showEle: true },
    {
      kind: "ranger_station",
      icon: "wilderness_hut",
      handoffZoom: null,
      showEle: true,
    },
    { kind: "castle", icon: "castle", handoffZoom: 15, showEle: false },
    {
      kind: "information",
      icon: "office",
      handoffZoom: 16,
      showEle: false,
    },
    { kind: "parking", icon: "parking", handoffZoom: 17, showEle: false },
    { kind: "park", icon: "park", handoffZoom: 15, showEle: false },
    { kind: "toilets", icon: "toilets", handoffZoom: 18, showEle: false },
    { kind: "playground", icon: "playground", handoffZoom: 16, showEle: false },
    { kind: "ferry", icon: "ferry", handoffZoom: 15, showEle: false },
    {
      kind: "lighthouse",
      icon: "lighthouse",
      handoffZoom: null,
      showEle: false,
    },
    { kind: "skiing", icon: "skiing", handoffZoom: null, showEle: false },
  ],
};

// Planet-tile POIs rendered from the OpenMapTiles `poi` source-layer
// (planet tiles, no hosted extract). Icons come from the basemap's "default"
// sprite unless they live in the outdoors sheet (the "dot" fallback).
export const PLANET_POI = {
  sourceId: "openmaptiles", // the basemap's existing vector source
  sourceLayer: "poi",
  layerId: "outdoor-amenities",
  minzoom: 14,
  kinds: [
    { class: "doctors", icon: "doctors", showTitle: false },
    { class: "bank", icon: "bank", showTitle: false },
    { class: "bicycle_rental", icon: "rental_bicycle", showTitle: true },
  ],
};
