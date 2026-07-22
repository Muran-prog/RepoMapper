/**
 * Wildlife occurrence overlay — GBIF density tiles as an app-owned dynamic
 * overlay (the biodiversity sibling of `src/style/grid.js`).
 *
 * Data --------------------------------------------------------------------
 * GBIF (Global Biodiversity Information Facility) is the largest free, open
 * biodiversity aggregator on Earth — ~3 billion georeferenced occurrences
 * that federate iNaturalist, natural-history museums, eBird, national atlases
 * and ringing schemes. No API key; open licences (CC0 / CC-BY / CC-BY-NC).
 *
 * We render GBIF's own Maps API v2 *ad-hoc* Mapbox-Vector-Tiles. The server
 * aggregates every matching record into per-tile density bins (one point per
 * bin carrying a `total` count), so a SINGLE vector source paints the maximum
 * of data — millions of records — with zero client pagination, and the tile
 * cache does the heavy lifting on the GPU. The ad-hoc endpoint accepts the
 * arbitrary filter combinations the panel exposes (many taxon groups + a year
 * range + basis-of-record + country scope).
 *
 * Visual language ---------------------------------------------------------
 *   • z0–7   a heatmap density surface (teal → green → lime → gold → hot).
 *   • z6+    graduated glowing circle markers (size + colour by `total`) with
 *            a crisp white halo and abbreviated count labels on big bins.
 * The two crossfade so the country overview reads as a heat map and, as you
 * zoom, resolves into individually clickable markers.
 *
 * Everything here is PURE (no map mutation) except `syncWildlifeSource`,
 * which mirrors `syncGridSource`: it reconciles the live source URL with the
 * current filter state in place, so a filter tweak never triggers a full
 * `setStyle` rebuild.
 */

import { WILDLIFE } from '../config.js';

/** Source id for the GBIF density tiles. */
export const WILDLIFE_SOURCE_ID = 'wildlife-gbif';

/** Layer ids emitted by `wildlifeLayers()` — exported for the validator. */
export const WILDLIFE_LAYER_IDS = Object.freeze([
  'wildlife-heat',
  'wildlife-glow',
  'wildlife-markers',
  'wildlife-count',
]);

const CURRENT_YEAR = new Date().getFullYear();

/** Fresh default filter state (current year is dynamic, hence a factory). */
export function defaultWildlifeFilters() {
  return {
    group: 'all',
    yearFrom: WILDLIFE.minYear,
    yearTo: CURRENT_YEAR,
    basis: 'all',
    region: 'ua',
  };
}

const GROUP_IDS = new Set(WILDLIFE.groups.map((g) => g.id));
const BASIS_IDS = new Set(WILDLIFE.basisOptions.map((b) => b.id));
const REGION_IDS = new Set(WILDLIFE.regionOptions.map((r) => r.id));

function clampYear(value, fallback) {
  // Guard null / undefined / '' explicitly — Number(null) and Number('') are
  // both 0, which would otherwise clamp to minYear instead of the fallback.
  if (value === null || value === undefined || value === '') return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(CURRENT_YEAR, Math.max(WILDLIFE.minYear, n));
}

/**
 * Coerce an arbitrary (possibly persisted / partial) filter object into a
 * valid, fully-populated one. Never throws — bad input degrades to defaults.
 * Accepts either the current `group` (single string) shape or a legacy
 * `groups` array (first valid entry wins) for backward compatibility.
 */
export function normalizeWildlifeFilters(input) {
  const d = defaultWildlifeFilters();
  if (!input || typeof input !== 'object') return d;

  let group = input.group;
  if (!GROUP_IDS.has(group)) {
    // Legacy array shape → take the first valid, non-'all' id if present.
    if (Array.isArray(input.groups)) {
      const specific = input.groups.find((g) => GROUP_IDS.has(g) && g !== 'all');
      group = specific || (input.groups.some((g) => g === 'all') ? 'all' : 'all');
    } else {
      group = d.group;
    }
  }

  let yearFrom = clampYear(input.yearFrom, d.yearFrom);
  let yearTo = clampYear(input.yearTo, d.yearTo);
  if (yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom];

  return {
    group,
    yearFrom,
    yearTo,
    basis: BASIS_IDS.has(input.basis) ? input.basis : d.basis,
    region: REGION_IDS.has(input.region) ? input.region : d.region,
  };
}

/** Resolve the active filter's taxon group to a GBIF taxonKey. */
export function wildlifeTaxonKey(filters) {
  const f = normalizeWildlifeFilters(filters);
  if (f.group === 'all') return 1; // kingdom Animalia — every animal
  const g = WILDLIFE.groups.find((x) => x.id === f.group);
  return g ? g.key : 1;
}

/** Accent colour for the active group (used by the marker/heat ramp tint). */
export function wildlifeGroupColor(filters) {
  const f = normalizeWildlifeFilters(filters);
  const g = WILDLIFE.groups.find((x) => x.id === f.group);
  return (g && g.color) || '#22d3a6';
}

/** The country code for the active region scope, or null for worldwide. */
function wildlifeCountry(filters) {
  const f = normalizeWildlifeFilters(filters);
  const region = WILDLIFE.regionOptions.find((r) => r.id === f.region);
  return region ? region.country : null;
}

/**
 * Build the fully-qualified GBIF ad-hoc tile URL (with {z}/{x}/{y} intact for
 * MapLibre to substitute) for the given filter state.
 */
export function wildlifeTileUrl(filters) {
  const f = normalizeWildlifeFilters(filters);
  const params = [['srs', 'EPSG:3857'], ['taxonKey', String(wildlifeTaxonKey(f))]];

  // Omit the year filter when the full range is selected so undated records
  // (which a year filter would exclude) are still shown — "maximum data".
  if (!(f.yearFrom <= WILDLIFE.minYear && f.yearTo >= CURRENT_YEAR)) {
    params.push(['year', `${f.yearFrom},${f.yearTo}`]);
  }
  if (f.basis !== 'all') params.push(['basisOfRecord', f.basis]);

  const country = wildlifeCountry(f);
  if (country) params.push(['country', country]);

  const query = params
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${WILDLIFE.tileUrl}?${query}`;
}

/**
 * Query params (as a plain object) for the Occurrence Search API that backs
 * the click-through popup — mirrors the tile filters so the popup shows the
 * SAME records the markers represent.
 */
export function wildlifeSearchParams(filters) {
  const f = normalizeWildlifeFilters(filters);
  const params = { taxonKey: wildlifeTaxonKey(f) };
  if (!(f.yearFrom <= WILDLIFE.minYear && f.yearTo >= CURRENT_YEAR)) {
    params.year = `${f.yearFrom},${f.yearTo}`;
  }
  if (f.basis !== 'all') params.basisOfRecord = f.basis;
  const country = wildlifeCountry(f);
  if (country) params.country = country;
  return params;
}

/** A MapLibre `vector` source spec pointed at the current filter's tiles. */
export function wildlifeSourceSpec(filters) {
  return {
    type: 'vector',
    tiles: [wildlifeTileUrl(filters)],
    minzoom: 0,
    maxzoom: WILDLIFE.tileMaxZoom,
    attribution:
      '<a href="https://www.gbif.org/" target="_blank" rel="noopener">GBIF</a>',
  };
}

// ---------------------------------------------------------------------------
// Paint expressions — shared so heat/glow/markers stay visually coherent.
// ---------------------------------------------------------------------------

const SRC_LAYER = WILDLIFE.sourceLayer;

// Colour ramp keyed by a bin's occurrence count. Cool teal at the sparse end,
// through green + lime, into a warm gold→amber core for dense hotspots.
const countColor = [
  'interpolate', ['linear'], ['get', 'total'],
  1, '#2dd4bf',
  20, '#22c55e',
  200, '#a3e635',
  2000, '#facc15',
  20000, '#fb923c',
];

// Marker radius interpolates on BOTH zoom and count (nested interpolate).
const markerRadius = [
  'interpolate', ['linear'], ['zoom'],
  5, ['interpolate', ['linear'], ['get', 'total'], 1, 3, 50, 6, 500, 10, 5000, 15],
  10, ['interpolate', ['linear'], ['get', 'total'], 1, 4, 50, 9, 500, 15, 5000, 25],
  16, ['interpolate', ['linear'], ['get', 'total'], 1, 5, 50, 12, 500, 20, 5000, 34],
];

/**
 * The wildlife layer stack (bottom → top): heat surface, soft glow, crisp
 * graduated markers, abbreviated count labels.
 *
 * @param {object} t     theme tokens (for the label font stack)
 * @param {object} [opts]
 * @param {string} [opts.source]
 */
export function wildlifeLayers(t, opts = {}) {
  const source = opts.source ?? WILDLIFE_SOURCE_ID;
  const font = (t && t.font && t.font.bold) || ['Noto Sans Bold'];

  return [
    // 1) Heatmap density surface — dominates the country overview, fades out
    //    as the graduated markers take over on zoom-in.
    {
      id: 'wildlife-heat',
      type: 'heatmap',
      source,
      'source-layer': SRC_LAYER,
      maxzoom: 8,
      paint: {
        'heatmap-weight': [
          'interpolate', ['linear'], ['get', 'total'],
          0, 0, 1, 0.2, 10, 0.45, 100, 0.7, 1000, 0.9, 10000, 1,
        ],
        'heatmap-intensity': [
          'interpolate', ['linear'], ['zoom'], 0, 0.55, 6, 1.3,
        ],
        'heatmap-radius': [
          'interpolate', ['linear'], ['zoom'], 0, 11, 4, 17, 7, 26,
        ],
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(8,47,43,0)',
          0.15, 'rgba(13,120,110,0.55)',
          0.35, '#12b886',
          0.55, '#74e34a',
          0.75, '#f4d03f',
          0.9, '#f39c12',
          1, '#ffffff',
        ],
        'heatmap-opacity': [
          'interpolate', ['linear'], ['zoom'], 4.5, 0.95, 7.5, 0,
        ],
      },
    },

    // 2) Soft glow beneath the solid markers — gives the points an aura that
    //    reads on both the light paper map and the satellite basemap.
    {
      id: 'wildlife-glow',
      type: 'circle',
      source,
      'source-layer': SRC_LAYER,
      minzoom: 5.5,
      paint: {
        'circle-color': countColor,
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          5, ['*', 1.9, ['interpolate', ['linear'], ['get', 'total'], 1, 3, 500, 10, 5000, 15]],
          16, ['*', 1.9, ['interpolate', ['linear'], ['get', 'total'], 1, 5, 500, 20, 5000, 34]],
        ],
        'circle-blur': 1,
        'circle-opacity': [
          'interpolate', ['linear'], ['zoom'], 5.5, 0, 7, 0.45,
        ],
        'circle-pitch-alignment': 'map',
      },
    },

    // 3) Crisp graduated markers — the clickable heart of the overlay.
    {
      id: 'wildlife-markers',
      type: 'circle',
      source,
      'source-layer': SRC_LAYER,
      minzoom: 5,
      paint: {
        'circle-color': countColor,
        'circle-radius': markerRadius,
        'circle-stroke-width': [
          'interpolate', ['linear'], ['zoom'], 5, 0.8, 12, 1.6,
        ],
        'circle-stroke-color': 'rgba(255,255,255,0.92)',
        'circle-opacity': [
          'interpolate', ['linear'], ['zoom'], 5, 0.35, 7, 0.9,
        ],
        'circle-stroke-opacity': [
          'interpolate', ['linear'], ['zoom'], 5, 0.2, 7, 0.85,
        ],
      },
    },

    // 4) Abbreviated count labels on the larger bins at closer zooms.
    {
      id: 'wildlife-count',
      type: 'symbol',
      source,
      'source-layer': SRC_LAYER,
      minzoom: 7,
      filter: ['>=', ['get', 'total'], 25],
      layout: {
        'text-field': [
          'case',
          ['>=', ['get', 'total'], 1000],
          ['concat', ['to-string', ['round', ['/', ['get', 'total'], 1000]]], 'k'],
          ['to-string', ['get', 'total']],
        ],
        'text-font': font,
        'text-size': ['interpolate', ['linear'], ['zoom'], 7, 9, 12, 12],
        'text-allow-overlap': false,
        'text-ignore-placement': false,
      },
      paint: {
        'text-color': '#08312b',
        'text-halo-color': 'rgba(255,255,255,0.95)',
        'text-halo-width': 1.3,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 8, 1],
      },
    },
  ];
}

/**
 * Return a NEW style object with the wildlife source + layer stack appended
 * (top of the paint order) when enabled. Idempotent and pure — mirrors
 * `withGridOverlay`. Safe to call for every map mode.
 *
 * @param {object} style     a spec-valid MapLibre style
 * @param {object} t         theme tokens
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]
 * @param {object}  [opts.filters]
 * @param {string}  [opts.source]
 */
export function withWildlifeOverlay(style, t, opts = {}) {
  if (!opts.enabled || !style || typeof style !== 'object') return style;

  const source = opts.source ?? WILDLIFE_SOURCE_ID;
  const filters = normalizeWildlifeFilters(opts.filters);

  const sources = { ...(style.sources ?? {}) };
  if (!sources[source]) sources[source] = wildlifeSourceSpec(filters);

  const layers = Array.isArray(style.layers) ? style.layers : [];
  const existingIds = new Set(layers.map((l) => l && l.id).filter(Boolean));
  const overlayLayers = wildlifeLayers(t, { source }).filter(
    (l) => !existingIds.has(l.id),
  );

  return { ...style, sources, layers: [...layers, ...overlayLayers] };
}

/**
 * Reconcile the live wildlife source with the current filter state, in place.
 *
 * A vector source's tiles can be swapped with `setTiles()`, which updates the
 * endpoint AND reloads the visible tiles in one call — no layer teardown, and
 * it refetches even when the camera is stationary (a plain remove+re-add does
 * not, which is a subtle trap). We keep a remove+re-add fallback for runtimes
 * without `setTiles`. Between filter changes this is a cheap signature no-op.
 * Mirrors `syncGridSource`.
 */
export function syncWildlifeSource(map, t) {
  if (!map || typeof map.getSource !== 'function') return;

  const cart = map._cart ?? {};
  const wantEnabled = !!(cart.features && cart.features.wildlife);
  const filters = normalizeWildlifeFilters(cart.wildlife && cart.wildlife.filters);
  const url = wildlifeTileUrl(filters);

  let source;
  try {
    source = map.getSource(WILDLIFE_SOURCE_ID);
  } catch {
    source = null;
  }

  // Overlay is off — nothing to reconcile. (Removal on toggle-off is handled
  // by the style rebuild in applyStyle.)
  if (!wantEnabled) return;

  // Enabled but the source isn't present yet (style still settling) — defer;
  // the next styledata tick retries.
  if (!source) return;

  if (cart.wildlifeUrl === url) return; // already current

  try {
    if (typeof source.setTiles === 'function') {
      // Preferred: swap the tile endpoint in place and reload immediately.
      source.setTiles([url]);
    } else {
      // Fallback: remove dependent layers, drop the source, re-add both.
      const tokens = t || (cart.tokens ?? null);
      for (const id of WILDLIFE_LAYER_IDS) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(WILDLIFE_SOURCE_ID)) map.removeSource(WILDLIFE_SOURCE_ID);
      map.addSource(WILDLIFE_SOURCE_ID, wildlifeSourceSpec(filters));
      for (const layer of wildlifeLayers(tokens, { source: WILDLIFE_SOURCE_ID })) {
        if (!map.getLayer(layer.id)) map.addLayer(layer);
      }
    }
    cart.wildlifeUrl = url;
    if (map._cart) map._cart = cart;
    // Ensure a frame is scheduled so the new tiles are fetched even when the
    // camera is idle.
    if (typeof map.triggerRepaint === 'function') map.triggerRepaint();
  } catch {
    /* style may be mid-swap; the next styledata pass retries */
  }
}
