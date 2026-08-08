#!/usr/bin/env node

/**
 * Schema-based gap analysis for the POI catalogue.
 *
 * Usage:
 *   node scripts/check-poi-coverage.mjs
 *
 * Cross-checks pois/catalogue.yml (the single source of truth for the
 * outdoor POIs) against two upstreams:
 *
 *   [1] Upstream sync — catalogue vs the OpenMapTiles `poi` layer schema.
 *       Downloads layers/poi/{mapping.yaml,poi.sql,poi.yaml,class.sql}
 *       from openmaptiles/openmaptiles master with an ETag conditional
 *       GET + local cache (mirrors fetchLiberty in scripts/build.mjs).
 *       Reports which ofm entries use a `class` value the OMT poi layer
 *       can never emit ("dead entries"), and which custom entries map to
 *       OSM tags OMT already ingests (candidates for promotion from OMT
 *       data instead of the hosted outdoor_pois tiles).
 *
 *   [2] Catalogue ofm entries vs the OMT class universe — dead ofm
 *       entries that can never be emitted by the poi layer.
 *
 *   [3] Custom entries vs the OMT subclass universe — candidates for
 *       promotion from OMT data instead of the hosted outdoor_pois tiles.
 *
 *   [4] Style coverage — catalogue vs the built style.json at the
 *       project root. Reports ofm classes the style has no poi layer
 *       filter for (zero-coverage = regression bug), which custom kinds
 *       appear in the outdoor-poi icon-image match, and icon-image kinds
 *       with no catalogue entry ("dead icon mappings").
 *
 *   [5] Sprite icon validation — every icon-image used by the symbol
 *       layers of style.json must exist in the style's sprite sheet
 *       (fetched + ETag-cached from the style's "sprite" URL).
 *
 *   [6] Gap report (advisory) — ofm entries whose desired data zoom
 *       (tier 1 → z12, tier 2 → z14) is below the OMT poi
 *       data floor (z14) need a custom extract to render at that zoom;
 *       reports whether a custom entry covers each, with an OSM-tag
 *       suggestion for uncovered ones. Informational — does not affect
 *       the exit code.
 *
 *   [7] Rank caps — catalogue rank_max validation vs the built style.
 *       Every rank_max must be an integer in 1..1000 on an ofm entry
 *       (custom entries come from hosted tiles with no OMT rank) and must
 *       appear as a `rank <= N` cap inside the correct tier layer's filter
 *       (outdoor-poi-z1 for tier 1, outdoor-poi-z2 for tier 2); no cap may
 *       exist without a catalogue entry. Failures exit 1.
 *
 * Exit code:
 *   0 — every ofm entry is covered by the style AND no ofm entry is dead
 *       AND every icon-image exists in the sprite AND all rank caps are
 *       valid and present in the built style
 *   1 — any dead ofm entry, any zero-coverage entry, any
 *       sprite-missing icon, or any rank-cap failure
 *
 * Class-universe interpretation (documented against current master,
 * Feb 2025+): poi.sql no longer contains an inline
 * `UPDATE ... SET class = CASE WHEN subclass IN (...) THEN '...' ...`.
 * Class is computed by the `poi_class()` SQL function in class.sql, whose
 * WHEN/THEN clauses are generated from `fields.class.values` in poi.yaml
 * (the `%%FIELD_MAPPING: class %%` placeholder). The function's ELSE
 * branch falls through to `subclass`:
 *
 *     CASE
 *       WHEN mapping_key = 'amenity' AND subclass = 'university' THEN 'college'
 *       %%FIELD_MAPPING: class %%
 *       ELSE subclass
 *     END
 *
 * So the class universe is built as:
 *   - every THEN class literal from poi.yaml fields.class.values, plus
 *   - every subclass value (from mapping.yaml def_poi_mapping_*) that is
 *     NOT mentioned in any WHEN clause (ELSE falls through to subclass).
 *
 * The script still detects the legacy inline `SET class = CASE` form if
 * upstream ever reverts to it, and dedupes the osm_poi_point /
 * osm_poi_polygon update blocks when both exist.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CACHE_DIR = resolve(ROOT, ".cache");
const CATALOGUE_FILE = resolve(ROOT, "pois", "catalogue.yml");
const STYLE_FILE = resolve(ROOT, "style.json");

const OMT_POI_BASE =
  "https://raw.githubusercontent.com/openmaptiles/openmaptiles/master/layers/poi";

const UPSTREAM_FILES = [
  { name: "mapping.yaml", cache: "openmaptiles-poi-mapping.yaml", etag: "openmaptiles-poi-mapping.etag" },
  { name: "poi.sql", cache: "openmaptiles-poi-poi.sql", etag: "openmaptiles-poi-poi.sql.etag" },
  // class.sql + poi.yaml are fetched because current master computes the
  // poi class in the poi_class() function (class.sql) whose mapping lives
  // in poi.yaml fields.class.values, not inline in poi.sql.
  { name: "class.sql", cache: "openmaptiles-poi-class.sql", etag: "openmaptiles-poi-class.sql.etag" },
  { name: "poi.yaml", cache: "openmaptiles-poi-poi.yaml", etag: "openmaptiles-poi-poi.yaml.etag" },
];

const REMAP_NOTE = (from, to) =>
  `OMT maps this subclass to class '${to}' (not '${from}')`;
const NOT_SUBCLASS_NOTE = (cls) =>
  `not a value the OMT poi layer emits as class '${cls}'`;

// ─────────────────────────────────────────────────────────────────────
// Fetch with ETag conditional GET + cache (mirrors fetchLiberty in
// scripts/build.mjs). Returns { source: "fetched"|"cached", text, sha }.
// ─────────────────────────────────────────────────────────────────────

// raw.githubusercontent.com ETag is a quoted content hash (git blob sha),
// sometimes with a weak-validator W/ prefix. The raw form is stored so it
// round-trips verbatim in If-None-Match; the W/ and quotes are only
// stripped for display.
function displaySha(rawEtag) {
  return (rawEtag || "").replace(/^W\//i, "").replace(/^"|"$/g, "");
}

async function fetchWithCache(url, cacheName, etagName, label) {
  const cachePath = resolve(CACHE_DIR, cacheName);
  const etagPath = resolve(CACHE_DIR, etagName);

  const headers = {};
  const cachedEtag = existsSync(etagPath)
    ? readFileSync(etagPath, "utf8").trim()
    : null;
  if (cachedEtag) headers["If-None-Match"] = cachedEtag;

  const cachedSha = cachedEtag ? displaySha(cachedEtag) : null;
  const labelName = label ?? cacheName;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    if (existsSync(cachePath)) {
      console.warn(
        `[check] network error, using cached ${labelName}: ${err.message}`,
      );
      return { source: "cached", text: readFileSync(cachePath, "utf8"), sha: cachedSha };
    }
    throw new Error(
      `Failed to fetch ${url} (no cache available): ${err.message}`,
    );
  }

  if (res.status === 304 && existsSync(cachePath)) {
    return { source: "cached", text: readFileSync(cachePath, "utf8"), sha: cachedSha };
  }

  if (!res.ok) {
    if (existsSync(cachePath)) {
      console.warn(
        `[check] server returned ${res.status}, using cached ${labelName}`,
      );
      return { source: "cached", text: readFileSync(cachePath, "utf8"), sha: cachedSha };
    }
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  const etag = res.headers.get("etag") || "";

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, text, "utf8");
  writeFileSync(etagPath, etag, "utf8");

  return { source: "fetched", text, sha: displaySha(etag) };
}

async function fetchUpstream(file) {
  return fetchWithCache(
    `${OMT_POI_BASE}/${file.name}`,
    file.cache,
    file.etag,
    file.name,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Subclass universe — union of every def_poi_mapping_* tag-value list in
// mapping.yaml (skip def_poi_fields and the def_poi_mapping aggregate).
// ─────────────────────────────────────────────────────────────────────

function parseSubclassUniverse(mappingText) {
  const doc = YAML.parse(mappingText);
  const subclasses = new Set();
  for (const [key, value] of Object.entries(doc)) {
    if (key === "def_poi_mapping" || key === "def_poi_fields") continue;
    if (!key.startsWith("def_poi_mapping_")) continue;
    for (const v of value ?? []) subclasses.add(v);
  }
  return subclasses;
}

// ─────────────────────────────────────────────────────────────────────
// Class universe — THEN class literals plus, when the ELSE branch falls
// through to `subclass`, every subclass not mentioned in any WHEN clause.
// ─────────────────────────────────────────────────────────────────────

function collectSubclasses(value, out) {
  if (typeof value === "string") {
    out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectSubclasses(v, out);
  } else if (value && typeof value === "object") {
    if (value.__AND__) collectSubclasses(value.__AND__, out);
    if (value.subclass) collectSubclasses(value.subclass, out);
  }
}

function buildClassUniverse({ poiSql, classSql, poiYaml, subclassUniverse }) {
  const legacy = extractLegacyClassBlocks(poiSql);

  if (legacy) {
    // Legacy inline `SET class = CASE ... END` (point + polygon updates,
    // deduped via Sets).
    const thenClasses = new Set();
    const mentionedSubclasses = new Set();
    let elseFallsThrough = false;
    for (const body of legacy.bodies) {
      for (const m of body.matchAll(/THEN\s+'([^']+)'/gi)) {
        thenClasses.add(m[1]);
      }
      for (const m of body.matchAll(/subclass\s+IN\s*\(([^)]*)\)/gi)) {
        for (const v of m[1].matchAll(/'([^']+)'/g)) mentionedSubclasses.add(v[1]);
      }
      if (/\bELSE\s+subclass\b/i.test(body)) elseFallsThrough = true;
    }
    const universe = new Set(thenClasses);
    if (elseFallsThrough) {
      for (const sc of subclassUniverse) {
        if (!mentionedSubclasses.has(sc)) universe.add(sc);
      }
    }
    return {
      universe,
      thenClasses,
      mentionedSubclasses,
      elseFallsThrough,
      interpretation: `legacy inline SET class = CASE in poi.sql (${legacy.bodies.length} block(s)); ELSE ${
        elseFallsThrough ? "falls through to subclass" : "is a literal"
      }`,
    };
  }

  // Modern: poi_class() function in class.sql, mapping in poi.yaml
  // (fields are nested under layer: layer.fields.class.values).
  const classYaml = YAML.parse(poiYaml);
  const classValues = classYaml?.layer?.fields?.class?.values;
  if (!classValues || typeof classValues !== "object") {
    throw new Error(
      "Could not find fields.class.values in poi.yaml — upstream poi.yaml structure changed",
    );
  }
  const thenClasses = new Set(Object.keys(classValues));
  const mentionedSubclasses = new Set();
  for (const value of Object.values(classValues)) {
    collectSubclasses(value, mentionedSubclasses);
  }
  const elseFallsThrough = /\bELSE\s+subclass\b/i.test(classSql ?? "");

  const universe = new Set(thenClasses);
  if (elseFallsThrough) {
    for (const sc of subclassUniverse) {
      if (!mentionedSubclasses.has(sc)) universe.add(sc);
    }
  }
  return {
    universe,
    thenClasses,
    mentionedSubclasses,
    elseFallsThrough,
    interpretation: `poi_class() function (class.sql) + poi.yaml fields.class.values; ELSE ${
      elseFallsThrough ? "falls through to subclass" : "is a literal"
    }`,
  };
}

function extractLegacyClassBlocks(sqlText) {
  const bodies = [];
  const startRe = /class\s*=\s*CASE/gi;
  let m;
  while ((m = startRe.exec(sqlText)) !== null) {
    const body = scanCaseBody(sqlText, m.index + m[0].toUpperCase().indexOf("CASE"));
    if (body) bodies.push(body);
  }
  return bodies.length ? { bodies } : null;
}

function scanCaseBody(sqlText, caseIdx) {
  let depth = 0;
  const kwRe = /\b(CASE|END|WHEN|THEN|ELSE)\b/gi;
  kwRe.lastIndex = caseIdx;
  let firstCase = null;
  let m;
  while ((m = kwRe.exec(sqlText)) !== null) {
    if (m[1].toUpperCase() === "CASE") {
      depth += 1;
      if (firstCase === null) firstCase = m.index;
    } else if (m[1].toUpperCase() === "END") {
      depth -= 1;
      if (depth === 0) return sqlText.slice(firstCase + 4, m.index);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Style coverage — extract class allowlists from layer filters.
// Handles both shapes:
//   ["all", ..., ["in", "class", "a", "b"], ...]
//   ["all", ..., ["match", ["get", "class"], [...], true, false], ...]
// ─────────────────────────────────────────────────────────────────────

function extractClassAllowlist(filter) {
  const out = new Set();
  walk(filter);
  function walk(node) {
    if (!Array.isArray(node)) return;
    const [op, ...rest] = node;
    if (op === "in") {
      const [field, ...vals] = rest;
      if (field === "class" || field === "subclass") {
        for (const v of vals) if (typeof v === "string") out.add(v);
      }
    } else if (op === "match") {
      const [getExpr, ...tail] = rest;
      if (isGetClass(getExpr)) {
        for (let i = 0; i < tail.length; i += 2) {
          const v = tail[i];
          if (typeof v === "string") out.add(v);
          else if (Array.isArray(v)) {
            for (const s of v) if (typeof s === "string") out.add(s);
          }
        }
      }
    } else if (op === "all" || op === "any" || op === "none") {
      for (const child of rest) walk(child);
    }
  }
  return out;
}

function isGetClass(e) {
  return Array.isArray(e) && e[0] === "get" && (e[1] === "class" || e[1] === "subclass");
}

// subclass → class map from poi.yaml layer.fields.class.values (for remap notes).
function parseClassRemap(poiYamlText) {
  const doc = YAML.parse(poiYamlText);
  const values = doc?.layer?.fields?.class?.values ?? {};
  const remap = new Map();
  for (const [cls, value] of Object.entries(values)) {
    const mentioned = new Set();
    collectSubclasses(value, mentioned);
    for (const sc of mentioned) {
      if (sc !== cls) remap.set(sc, cls);
    }
  }
  return remap;
}

// ["match", ["get", "kind"], k1, v1, k2, v2, ..., fallback] → [[k1,v1], ...]
function extractMatchPairs(expr) {
  if (!Array.isArray(expr) || expr[0] !== "match") return [];
  const tail = expr.slice(2);
  const pairs = [];
  for (let i = 0; i + 1 < tail.length; i += 2) {
    pairs.push([tail[i], tail[i + 1]]);
  }
  return pairs;
}

// ─────────────────────────────────────────────────────────────────────
// Sprite icon validation — icon-image icon names from a layer layout
// value: plain strings, and the VALUE positions of a match expression
// (v1..vn + default, never the keys). Non-match expressions (e.g.
// ["to-string", ...], ["step", ...], ["get", ...]) are dynamic — skipped.
// ─────────────────────────────────────────────────────────────────────

function collectSpriteIconNames(img) {
  const names = new Set();
  if (typeof img === "string") {
    names.add(img);
    return names;
  }
  if (Array.isArray(img) && img[0] === "match") {
    const tail = img.slice(2);
    for (let i = 1; i < tail.length; i += 2) {
      if (typeof tail[i] === "string") names.add(tail[i]);
    }
    if (tail.length % 2 === 1 && typeof tail[tail.length - 1] === "string") {
      names.add(tail[tail.length - 1]);
    }
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────
// Gap report — ofm entries that need a custom extract to render below
// the OMT poi data floor (z14). Desired data zoom: tier 1 → z12; plain
// tier 2 only needs z14.
// ─────────────────────────────────────────────────────────────────────

function desiredDataZoom(entry) {
  if (entry.tier === 1) return 12;
  return 14;
}

// custom kind → ofm class equivalences where the kind name differs from
// the OMT class it covers (water is the kind for OMT class drinking_water,
// ferry is the kind for OMT class ferry_terminal).
const EQUIVALENT_CUSTOM_KIND = { water: "drinking_water", ferry: "ferry_terminal" };

function findCustomCoverage(entry, customEntries) {
  const direct = customEntries.find((e) => e.kind === entry.class);
  if (direct) return { kind: direct.kind, minZoom: direct.min_zoom };
  const equivalent = customEntries.find(
    (e) => EQUIVALENT_CUSTOM_KIND[e.kind] === entry.class,
  );
  if (equivalent) return { kind: equivalent.kind, minZoom: equivalent.min_zoom };
  return null;
}

// subclass → OSM tag from mapping.yaml's def_poi_mapping_* lists.
function buildSubclassTagMap(mappingText) {
  const doc = YAML.parse(mappingText);
  const map = new Map();
  for (const [key, values] of Object.entries(doc)) {
    if (key === "def_poi_mapping" || key === "def_poi_fields") continue;
    if (!key.startsWith("def_poi_mapping_")) continue;
    const tag = key.slice("def_poi_mapping_".length);
    for (const v of values ?? []) map.set(v, tag);
  }
  return map;
}

function parseClassValues(poiYamlText) {
  return YAML.parse(poiYamlText)?.layer?.fields?.class?.values ?? {};
}

// Inverse-lookup OSM tag suggestion for an uncovered class: the class
// itself if it is a mapping value (park → leisure: park), else the first
// of its THEN-class subclasses that is (beer → amenity: pub).
function suggestOsmTag(entry, subclassTagMap, classValues) {
  if (subclassTagMap.has(entry.class)) {
    return `${subclassTagMap.get(entry.class)}: ${entry.class}`;
  }
  const subclasses = classValues?.[entry.class];
  if (subclasses) {
    const mentioned = new Set();
    collectSubclasses(subclasses, mentioned);
    for (const sc of mentioned) {
      if (subclassTagMap.has(sc)) return `${subclassTagMap.get(sc)}: ${sc}`;
    }
  }
  return null;
}

function formatZoom(minzoom, maxzoom) {
  const min = minzoom ?? 0;
  const max = maxzoom ?? 22;
  return min === max ? `${min}` : `${min}–${max}`;
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  console.log(
    "  " +
      headers.map((h, i) => h.padEnd(widths[i])).join("  ") +
      "\n  " +
      widths.map((w) => "-".repeat(w)).join("  "),
  );
  for (const row of rows) {
    console.log("  " + row.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  "));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

const sources = {};
for (const file of UPSTREAM_FILES) {
  sources[file.name] = await fetchUpstream(file);
}

const mapping = YAML.parse(sources["mapping.yaml"].text);
const subclassUniverse = parseSubclassUniverse(sources["mapping.yaml"].text);

const classInfo = buildClassUniverse({
  poiSql: sources["poi.sql"].text,
  classSql: sources["class.sql"].text,
  poiYaml: sources["poi.yaml"].text,
  subclassUniverse,
});

const catalogue = YAML.parse(readFileSync(CATALOGUE_FILE, "utf8"));
const pois = catalogue.pois;
const ofmEntries = pois.filter((p) => p.source === "ofm");
const customEntries = pois.filter((p) => p.source === "custom");

const style = JSON.parse(readFileSync(STYLE_FILE, "utf8"));

// ---- [1] Upstream schema -------------------------------------------------

console.log("══════════════════════════════════════════════════════════════");
console.log(" POI catalogue coverage check");
console.log("══════════════════════════════════════════════════════════════");
console.log();
console.log("[1] Upstream schema — openmaptiles/openmaptiles master layers/poi");
for (const file of UPSTREAM_FILES) {
  const s = sources[file.name];
  const sha = s.sha ? ` (upstream schema sha ${s.sha})` : "";
  console.log(`  ${file.name.padEnd(13)} ${s.source.padEnd(8)}${sha}`);
}
console.log(
  `  subclass universe: ${subclassUniverse.size} tag values (def_poi_mapping_*)`,
);
console.log(`  class computation: ${classInfo.interpretation}`);
console.log(
  `  class universe: ${classInfo.universe.size} values ` +
    `(${classInfo.thenClasses.size} THEN classes + ` +
    `${classInfo.universe.size - classInfo.thenClasses.size} fall-through subclasses)`,
);
console.log();

// ---- [2] Catalogue ofm entries vs OMT class universe ---------------------

const classRemapTo = parseClassRemap(sources["poi.yaml"].text);

console.log("[2] Catalogue ofm entries vs OMT class universe");
const ofmRows = [];
const deadOfm = [];
for (const entry of ofmEntries) {
  const inOmt = classInfo.universe.has(entry.class);
  let note = "";
  if (!inOmt) {
    const remap = classRemapTo.get(entry.class);
    if (remap) {
      note = REMAP_NOTE(entry.class, remap);
    } else if (classInfo.mentionedSubclasses.has(entry.class)) {
      note = `OMT maps this subclass to a different class`;
    } else {
      note = NOT_SUBCLASS_NOTE(entry.class);
    }
    deadOfm.push({ entry, note });
  }
  ofmRows.push([entry.id, entry.class, inOmt ? "yes" : "no", note]);
}
printTable(["id", "class", "in OMT?", "note"], ofmRows);
console.log(
  `  dead ofm entries (${deadOfm.length}): ${deadOfm.map((d) => d.entry.id).join(", ")}`,
);
console.log();

// ---- [3] Custom entries vs OMT subclass universe -------------------------

console.log(
  "[3] Custom entries that could be promoted from OMT data instead of hosted",
);
const customVsOmt = [];
const customOnly = [];
const omtEquivalent = [];
for (const entry of customEntries) {
  const values = Object.values(entry.include_when ?? {}).flat();
  const equivalent = values.some((v) => subclassUniverse.has(v));
  const matching = values.filter((v) => subclassUniverse.has(v));
  const missing = values.filter((v) => !subclassUniverse.has(v));
  const note = equivalent
    ? `in OMT: ${matching.join(", ")}`
    : `not in OMT: ${missing.join(", ")}`;
  (equivalent ? omtEquivalent : customOnly).push(entry.id);
  customVsOmt.push([entry.id, entry.kind, equivalent ? "yes" : "no", note]);
}
printTable(["id", "kind", "OMT-equivalent?", "note"], customVsOmt);
console.log(`  custom-only (${customOnly.length}): ${customOnly.join(", ")}`);
console.log(`  OMT-equivalent (${omtEquivalent.length}): ${omtEquivalent.join(", ")}`);
console.log();

// ---- [4] Style coverage — ofm classes ------------------------------------

const poiLayers = style.layers.filter((l) => l["source-layer"] === "poi");
const coverage = new Map();
for (const layer of poiLayers) {
  const allowlist = extractClassAllowlist(layer.filter);
  for (const cls of allowlist) {
    if (!coverage.has(cls)) coverage.set(cls, []);
    coverage.get(cls).push({
      id: layer.id,
      minzoom: layer.minzoom,
      maxzoom: layer.maxzoom,
    });
  }
}

console.log("[4] Style coverage — ofm classes (layers on source-layer poi)");
const coverageRows = [];
const zeroCoverage = [];
for (const entry of ofmEntries) {
  const hits = coverage.get(entry.class) ?? [];
  if (hits.length === 0) {
    zeroCoverage.push(entry.id);
    coverageRows.push([
      entry.class,
      "NO",
      "zero coverage — regression bug",
    ]);
  } else {
    const layers = hits
      .map((h) => `${h.id} (${formatZoom(h.minzoom, h.maxzoom)})`)
      .join(", ");
    coverageRows.push([entry.class, "yes", layers]);
  }
}
printTable(["class", "covered?", "layers (zoom)"], coverageRows);
console.log(
  `  zero-coverage (${zeroCoverage.length}): ${zeroCoverage.join(", ") || "none"}`,
);
console.log();

// ---- [5] Sprite icon validation ------------------------------------------

console.log("[5] Sprite icon validation");
const spriteUrl = Array.isArray(style.sprite) ? style.sprite[0] : style.sprite;
const spriteMissing = [];
if (!spriteUrl) {
  console.log("  no sprite URL in style.json — cannot validate icons");
} else {
  const spriteData = await fetchWithCache(
    `${spriteUrl}.json`,
    "openfreemap-sprite.json",
    "openfreemap-sprite.etag",
    "sprite",
  );
  const spriteKeys = new Set(Object.keys(JSON.parse(spriteData.text)));
  const iconUsage = new Map();
  for (const layer of style.layers) {
    if (layer.type !== "symbol") continue;
    const img = layer.layout?.["icon-image"];
    if (img === undefined) continue;
    for (const name of collectSpriteIconNames(img)) {
      if (!iconUsage.has(name)) iconUsage.set(name, new Set());
      iconUsage.get(name).add(layer.id);
    }
  }
  for (const [name, layers] of iconUsage) {
    if (!spriteKeys.has(name)) {
      spriteMissing.push({ name, layers: [...layers].sort() });
    }
  }
  console.log(
    `  sprite: ${spriteUrl}.json (${spriteData.source}, ${spriteKeys.size} icons)`,
  );
  if (spriteMissing.length === 0) {
    console.log("  all icons present in sprite");
  } else {
    for (const m of spriteMissing) {
      console.log(`  MISSING "${m.name}" — used by: ${m.layers.join(", ")}`);
    }
  }
  console.log(
    `  missing from sprite (${spriteMissing.length}): ${spriteMissing.map((m) => m.name).join(", ") || "none"}`,
  );
}
console.log();

// ---- [6] Gap report — ofm entries needing custom extracts ----------------

console.log(
  "[6] Gap report — ofm entries whose desired data zoom is below the OMT poi data floor (z14)",
);
const subclassTagMap = buildSubclassTagMap(sources["mapping.yaml"].text);
const classValues = parseClassValues(sources["poi.yaml"].text);
const gapRows = [];
const gapUncovered = [];
for (const entry of ofmEntries) {
  const desired = desiredDataZoom(entry);
  if (desired >= 14) continue;
  const coverage = findCustomCoverage(entry, customEntries);
  const coverageText = coverage
    ? `${coverage.kind} (z${coverage.minZoom})`
    : "MISSING";
  if (!coverage) gapUncovered.push(entry.id);
  const suggestion = coverage
    ? ""
    : suggestOsmTag(entry, subclassTagMap, classValues) ?? "—";
  gapRows.push([
    entry.id,
    entry.class,
    entry.tier,
    desired,
    coverageText,
    suggestion,
  ]);
}
printTable(
  ["id", "class", "tier", "desired zoom", "custom coverage", "suggestion"],
  gapRows,
);
console.log(
  `  entries needing custom extract: ${gapRows.length}; uncovered: ${gapUncovered.length} (${gapUncovered.join(", ") || "none"})`,
);
console.log();

// ---- [7] Rank caps — catalogue rank_max vs built style --------------------

console.log("[7] Rank caps — catalogue rank_max vs built style.json");
const rankCapIssues = [];
const cappedEntries = [];
for (const entry of pois) {
  if (!Object.prototype.hasOwnProperty.call(entry, "rank_max")) continue;
  if (entry.source !== "ofm") {
    rankCapIssues.push(
      `${entry.id}: rank_max is only valid on ofm entries (custom tiles have no OMT rank)`,
    );
    continue;
  }
  const rm = entry.rank_max;
  if (!Number.isInteger(rm) || rm < 1 || rm > 1000) {
    rankCapIssues.push(`${entry.id}: rank_max ${rm} must be an integer in 1..1000`);
    continue;
  }
  cappedEntries.push(entry);
}

function extractRankCapValues(filter) {
  const caps = new Set();
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (node[0] === "<=" && typeof node[2] === "number") {
      const lhs = node[1];
      const field = Array.isArray(lhs) && lhs[0] === "get" ? lhs[1] : lhs;
      if (field === "rank") caps.add(node[2]);
    }
    for (const child of node.slice(1)) walk(child);
  };
  walk(filter);
  return caps;
}

const rankMaxLayers = { 1: "outdoor-poi-z1", 2: "outdoor-poi-z2" };

for (const tier of [1, 2]) {
  const layerId = rankMaxLayers[tier];
  const layer = style.layers.find((l) => l.id === layerId);
  if (!layer) {
    rankCapIssues.push(`${layerId} layer missing from built style`);
    continue;
  }
  const capValues = extractRankCapValues(layer.filter);
  for (const entry of cappedEntries.filter((e) => e.tier === tier)) {
    if (!capValues.has(entry.rank_max)) {
      rankCapIssues.push(
        `${entry.id}: rank_max ${entry.rank_max} cap missing from ${layerId} filter`,
      );
    }
  }
  for (const value of capValues) {
    if (!cappedEntries.some((e) => e.tier === tier && e.rank_max === value)) {
      rankCapIssues.push(`rank <= ${value} cap in ${layerId} has no catalogue entry`);
    }
  }
}

if (cappedEntries.length === 0) {
  console.log("  no rank_max caps in catalogue");
} else {
  for (const entry of cappedEntries) {
    console.log(
      `  ${entry.id}: rank_max ${entry.rank_max} → ${rankMaxLayers[entry.tier]}`,
    );
  }
}
if (rankCapIssues.length === 0) {
  console.log("  all rank caps valid and present in the built style");
} else {
  for (const issue of rankCapIssues) {
    console.log(`  FAIL ${issue}`);
  }
}
console.log(
  `  rank-cap issues (${rankCapIssues.length}): ${rankCapIssues.join("; ") || "none"}`,
);
console.log();

// ---- [8] Style coverage — custom kinds ------------------------------------

const outdoorLayers = style.layers.filter(
  (l) => l["source-layer"] === "outdoor_pois",
);
const outdoorSource = style.sources["outdoor-poi"] ?? {};
const outdoorMin = outdoorSource.minzoom ?? "?";
const outdoorMax = outdoorSource.maxzoom ?? "?";
let kindPairs = [];
for (const layer of outdoorLayers) {
  for (const pair of extractMatchPairs(layer.layout?.["icon-image"])) {
    kindPairs.push(pair);
  }
}
const styleKinds = new Set(kindPairs.map(([k]) => k));
const customKindSet = new Set(customEntries.map((e) => e.kind));

console.log(
  `[8] Style coverage — custom kinds (outdoor_pois layer${outdoorLayers.length ? "s" : ""}, source zoom ${outdoorMin}–${outdoorMax})`,
);
const customRows = [];
let missingKinds = [];
for (const entry of customEntries) {
  const present = styleKinds.has(entry.kind);
  if (!present) missingKinds.push(entry.kind);
  customRows.push([entry.id, entry.kind, present ? "yes" : "no"]);
}
printTable(["id", "kind", "in style?"], customRows);
console.log(
  `  custom kinds missing from style (${missingKinds.length}): ${missingKinds.join(", ") || "none"}`,
);
console.log();

// ---- [9] Dead icon mappings -----------------------------------------------

console.log("[9] Dead icon mappings (kinds in outdoor-poi icon-image with no catalogue entry)");
const deadIcons = kindPairs
  .map(([k]) => k)
  .filter((k) => !customKindSet.has(k));
console.log(`  dead icon mappings (${deadIcons.length}): ${deadIcons.join(", ")}`);

// ---- [10] Summary + exit code ---------------------------------------------

console.log("[10] Summary");
console.log(`  dead ofm entries:        ${deadOfm.length}  (${deadOfm.map((d) => d.entry.id).join(", ")})`);
console.log(`  zero-coverage entries:   ${zeroCoverage.length}  (${zeroCoverage.join(", ") || "none"})`);
console.log(`  sprite-missing icons:    ${spriteMissing.length}  (${spriteMissing.map((m) => m.name).join(", ") || "none"})`);
console.log(`  gap uncovered:           ${gapUncovered.length}  (${gapUncovered.join(", ") || "none"})`);
console.log(`  rank-cap issues:         ${rankCapIssues.length}  (${rankCapIssues.join("; ") || "none"})`);
console.log(`  custom-only entries:     ${customOnly.length}  (${customOnly.join(", ")})`);
console.log(`  OMT-equivalent custom:   ${omtEquivalent.length}`);
console.log(`  dead icon mappings:      ${deadIcons.length}`);

const exitCode =
  zeroCoverage.length === 0 &&
  deadOfm.length === 0 &&
  spriteMissing.length === 0 &&
  rankCapIssues.length === 0
    ? 0
    : 1;
console.log();
if (exitCode === 0) {
  console.log(
    "✓ all ofm entries are alive and covered by the style; all icons present in sprite; all rank caps valid and present",
  );
} else {
  const reasons = [];
  if (deadOfm.length > 0) reasons.push(`${deadOfm.length} dead ofm entr${deadOfm.length === 1 ? "y" : "ies"}`);
  if (zeroCoverage.length > 0) reasons.push(`${zeroCoverage.length} zero-coverage entr${zeroCoverage.length === 1 ? "y" : "ies"}`);
  if (spriteMissing.length > 0) reasons.push(`${spriteMissing.length} sprite-missing icon${spriteMissing.length === 1 ? "" : "s"}`);
  if (rankCapIssues.length > 0) reasons.push(`${rankCapIssues.length} rank-cap issue${rankCapIssues.length === 1 ? "" : "s"}`);
  console.log(`✗ ${reasons.join(" and ")} — see sections above`);
}
process.exitCode = exitCode;
