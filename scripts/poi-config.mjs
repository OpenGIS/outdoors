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
    // this zoom; null = basemap never renders it), priority (symbol-sort-key
    // weight; lower = placed first = wins collisions, mirroring the basemap's
    // rank-as-sort-key convention — see the sort-key derivation in build.mjs).
    // Priority ladder (outdoor identity < core amenities < comfort < general
    // POIs < urban amenities):
    //   10  hut, pass, trailhead, ranger_station
    //   20  shelter, viewpoint, campsite
    //   30  drinking_water, picnic_site
    //   40  castle, ferry, lighthouse, park, playground, skiing, toilets
    //   50  information, parking
    {
      kind: "hut",
      icon: "alpinehut",
      handoffZoom: 17,
      showEle: true,
      priority: 10,
    },
    {
      kind: "shelter",
      icon: "shelter",
      handoffZoom: null,
      showEle: true,
      priority: 20,
    },
    {
      kind: "viewpoint",
      icon: "viewpoint",
      handoffZoom: 15,
      showEle: true,
      priority: 20,
    },
    {
      kind: "campsite",
      icon: "camping",
      handoffZoom: 16,
      showEle: false,
      priority: 20,
    },
    {
      kind: "picnic_site",
      icon: "picnic",
      handoffZoom: null,
      showEle: false,
      priority: 30,
    },
    {
      kind: "drinking_water",
      icon: "drinking_water",
      handoffZoom: 18,
      showEle: false,
      priority: 30,
    },
    {
      kind: "trailhead",
      icon: "trailhead",
      handoffZoom: null,
      showEle: false,
      priority: 10,
    },
    {
      kind: "pass",
      icon: "pass",
      handoffZoom: null,
      showEle: true,
      priority: 10,
    },
    {
      kind: "ranger_station",
      icon: "wilderness_hut",
      handoffZoom: null,
      showEle: true,
      priority: 10,
    },
    {
      kind: "castle",
      icon: "castle",
      handoffZoom: 15,
      showEle: false,
      priority: 40,
    },
    {
      kind: "information",
      icon: "office",
      handoffZoom: 16,
      showEle: false,
      priority: 50,
    },
    {
      kind: "parking",
      icon: "parking",
      handoffZoom: 17,
      showEle: false,
      priority: 50,
    },
    {
      kind: "park",
      icon: "park",
      handoffZoom: 15,
      showEle: false,
      priority: 40,
    },
    {
      kind: "toilets",
      icon: "toilets",
      handoffZoom: 18,
      showEle: false,
      priority: 40,
    },
    {
      kind: "playground",
      icon: "playground",
      handoffZoom: 16,
      showEle: false,
      priority: 40,
    },
    {
      kind: "ferry",
      icon: "ferry",
      handoffZoom: 15,
      showEle: false,
      priority: 40,
    },
    {
      kind: "lighthouse",
      icon: "lighthouse",
      handoffZoom: null,
      showEle: false,
      priority: 40,
    },
    {
      kind: "skiing",
      icon: "skiing",
      handoffZoom: null,
      showEle: false,
      priority: 40,
    },
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
    // priority = symbol-sort-key weight for the outdoor-amenities layer. These
    // sit at 1000, NOT the outdoor ladder's urban tier (50): the basemap's own
    // POI layers sort by feature rank (20–2000, lower = placed first), so a
    // fixed 50 would let doctors/bank/bicycle_rental outrank nearly every
    // basemap POI. 1000 keeps basemap POIs first, our amenities winning only
    // against the least-important ranks (≥1000). See build.mjs.
    { class: "doctors", icon: "doctors", showTitle: false, priority: 1000 },
    { class: "bank", icon: "bank", showTitle: false, priority: 1000 },
    {
      class: "bicycle_rental",
      icon: "rental_bicycle",
      showTitle: true,
      priority: 1000,
    },
  ],
};
