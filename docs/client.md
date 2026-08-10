---
git_hash: "6f56e70659dcfa2102f35d7ee09b8f5bede73d7b"
modified: "2026-08-10"
---

# Client-side rendering

> `style.json` is a data document, not an application — it must be rendered by a client mapping library.

## 1. Overview

[`style.json`](../style.json) is a data document, not an application: it must be rendered by a client mapping library. It follows the [MapLibre Style Specification](https://maplibre.org/maplibre-style-spec/) and works with any compatible renderer — MapLibre GL JS, MapLibre Native, Mapbox GL JS, and others. The build emits a single self-contained file that any of these libraries can load directly; the client does the fetching, parsing, and drawing.

## 2. Renderer compatibility

The style declares its sources and layers per the MapLibre Style Specification, so any conformant renderer displays it identically — no renderer-specific code, plugins, or runtime registration are needed. The only renderer-specific assumptions the style makes are documented where they occur (see [Rendering behaviours](#4-rendering-behaviours)).

## 3. Spec conformance

Every build validates the assembled `style.json` against the MapLibre Style Specification before exiting; a violation fails the build, so an invalid style can never be emitted. See the **Validate** step of [The Style Build](build.md#the-pipeline) and the [Validation Gate](style.md#validation-gate).

## 4. Rendering behaviours

Client-side behaviours the style relies on:

- **Vector tile sources** — the client fetches and draws vector tile sources like any other MapLibre vector source. The contour overlay is fully declarative in the style: the client only fetches and renders the PBF tiles, with no client-side contour generation (see [Contours](contours.md)).
- **Symbol collision** — MapLibre resolves symbol collisions from the top of the layer stack down: the highest label layer places first and wins the space. This matters where label stacking is tuned at build time — the contour labels get a build-time repositioning pass so they sit above the POI labels (see [Label placement in the symbol stack](contours.md#label-placement-in-the-symbol-stack)).
- **Terrain** — a raster DEM source powers two client-rendered effects: a 2D hillshade layer that fades in across the low zooms, and 3D terrain relief via the style's `terrain` property. See [Terrain source & relief](style.md#2-terrain-source--relief--dem-dem_hillshade-dem_terrain) in [Style Structure](style.md) for the layer details.

## 5. Units — metric vs imperial

The style ships **metric-only**: elevation labels use metres (`m`) — contour labels and all peak labels. There is no feet variant in the style.

Unit switching is a **client-side concern**: the client rewrites a label's `text-field` expression at runtime, before the map parses the style. The dev compare app demonstrates both shapes of patch below.

### Contours — a node swap

`applyImperialContours()` in [`dev/src/App.vue`](../dev/src/App.vue) replaces the `contour-labels` layer's `text-field` with a `concat`/`number-format`/`round` expression that multiplies `ele` by 3.28084 and appends `"ft"`:

```js
[
  "concat",
  ["number-format", ["round", ["*", ["get", "ele"], 3.28084]], {}],
  "ft",
];
```

The style's metric contour expression — `CONTOUR_LABEL_EXPR` in [`scripts/build.mjs`](../scripts/build.mjs) — is already a full expression, so the imperial patch is a node swap: the replacement expression slots in where the metric one was. The patch is gated by the `CONTOURS_TO_IMPERIAL` boolean constant in the app.

### Peak heights — a whole-string replacement

The four peak label layers — `mountain-peak`, `mountain-peak-secondary`, `mountain-saddle`, `mountain-volcano`, built by `applyPeakLabels()` in [`scripts/build.mjs`](../scripts/build.mjs) — use **legacy token strings** rather than expressions, e.g. `"{name:latin} {name:nonlatin}\n{ele} m\n▲"` (saddles end `\n—`; secondary and volcano end after the unit). Token syntax (`{ele}`) cannot be used inside an expression, so an imperial patch cannot swap a child node — it must replace the **entire `text-field` string** with a full `concat` expression, rebuilding the name fields as `["get", ...]` expressions. A worked `applyImperialPeaks()`-style patch, per layer:

```js
// mountain-peak — ends with the triangle glyph
[
  "concat",
  ["get", "name:latin"],
  " ",
  ["get", "name:nonlatin"],
  "\n",
  ["number-format", ["round", ["*", ["get", "ele"], 3.28084]], {}],
  "ft\n",
  "▲",
];
```

```js
// mountain-peak-secondary and mountain-volcano — end after the unit
[
  "concat",
  ["get", "name:latin"],
  " ",
  ["get", "name:nonlatin"],
  "\n",
  ["number-format", ["round", ["*", ["get", "ele"], 3.28084]], {}],
  "ft",
];
```

```js
// mountain-saddle — ends with the dash glyph
[
  "concat",
  ["get", "name:latin"],
  " ",
  ["get", "name:nonlatin"],
  "\n",
  ["number-format", ["round", ["*", ["get", "ele"], 3.28084]], {}],
  "ft\n",
  "—",
];
```

The differences from the contour patch: four layers instead of one; whole-string replacement rather than a node swap; a per-layer trailing glyph (`▲`, `—`, or none); and the name fields converted from tokens to `["get", ...]` expressions. There is also a rounding asymmetry: the metric peak labels render the raw `ele` value unrounded, while the imperial pattern rounds — a visible inconsistency to decide on.

## 6. Repository consumers

The style's client consumers in this repository:

- **Dev compare app** — [`dev/src/App.vue`](../dev/src/App.vue) (Vue + Vite) renders the built `style.json` side-by-side against reference providers using `maplibre-gl` and `@maplibre/maplibre-gl-compare`; it is also where the imperial patches above live.
- **Demo build** — [`demo/`](../demo) is the built compare app deployed to GitHub Pages by [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) — the public viewer of the style.

## 7. Usage example

Loading the style in MapLibre GL JS is a matter of pointing a `Map` at it:

```js
import maplibregl from "maplibre-gl";

const map = new maplibregl.Map({
  container: "map", // a named <div> in your page
  style: "style.json",
});
```

Options like `center` and `zoom` are up to the consumer; no API keys are required for the style's own hosted sources.

## 8. Related

- [Style Structure](style.md) — the full layer stack, bottom to top
- [Contours](contours.md) — the server-generated contour overlay
- [The Style Build](build.md) — how `style.json` is produced
- [Project README](../README.md)
