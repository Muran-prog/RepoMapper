/**
 * Viewport heuristics for the hypso subsystem.
 *
 * Two related responsibilities:
 *
 *   1. Auto-pick   — classify the visible viewport's dominant terrain
 *                    (alpine / carpathian / steppe / sea / global) and
 *                    apply the matching ramp preset from HYPSO.regionRamp.
 *   2. Stats       — sample the DEM at a 5×5 grid of viewport points
 *                    each `idle` event and emit { min, mean, max } via
 *                    a CustomEvent so the HUD (or any other listener)
 *                    can read live elevation statistics.
 *
 * Both run only when the map is idle so they don't fight active pan/zoom.
 * Auto-pick is opt-in — the user can disable it from the picker; once
 * the user explicitly picks a ramp the auto-pick is disengaged until
 * the next reload.
 *
 * Region thresholds
 * -----------------
 * The classifier reads the viewport's center against the Carpathian
 * bbox from `config.js::CARPATHIAN.bbox`, and against a hard-coded
 * Black-Sea + Sea-of-Azov rectangle (the OpenMapTiles "water" layer
 * doesn't give us a per-pixel "is this sea" query, so a bbox suffices
 * for the heuristic). Anything else above a mean-elevation threshold
 * is 'alpine'; below is 'steppe'.
 */

import { CARPATHIAN, HYPSO } from '../../config.js';
import { applyHypsoRamp } from '../../style/hypso/index.js';
import { hasPersistedRampPref, savePrefs } from './store.js';

/** [west, south, east, north] of the Ukrainian Black Sea + Azov shelf. */
const SEA_BBOX = [29.0, 41.0, 41.5, 47.5];
/** Mean elevation above this (m) tips a region to 'alpine'. */
const ALPINE_MEAN_THRESHOLD = 600;

/**
 * Sample grid resolution. 5×5 = 25 DEM lookups per idle event — cheap.
 */
const SAMPLE_GRID = 5;

/**
 * @typedef {'global'|'alpine'|'carpathian'|'steppe'|'sea'} RegionKind
 *
 * @typedef {object} ElevStats
 * @property {number|null} min
 * @property {number|null} mean
 * @property {number|null} max
 * @property {number}      sampled  Successful sample count.
 * @property {number}      grid     Total grid count (sampled or not).
 * @property {RegionKind}  region
 */

/**
 * Install the heuristics. Returns an unsubscribe function.
 *
 * @param {object} opts
 * @param {maplibregl.Map} opts.map
 * @param {boolean} [opts.autoPick=true]
 * @param {boolean} [opts.stats=true]
 * @param {function(ElevStats):void} [opts.onStats]
 */
export function installAutoRegion(opts) {
  const { map, autoPick = true, stats = true, onStats } = opts;

  // If the user has a persisted ramp preference in localStorage they
  // have already made a choice — auto-pick must NEVER override it.
  // The previous behaviour fired on the first `idle` after boot and
  // silently swapped their saved ramp for a region-matched one, while
  // the picker UI continued to show the saved choice as selected.
  // Result: persistent UI ↔ map state desync — exactly the
  // "сменa ramp/strength иногда видна, иногда нет" symptom.
  let userOverrode = autoPick && hasPersistedRampPref();
  /** Track the last applied region so we don't thrash setPaintProperty. */
  let lastRegion = null;

  // Listen for user-initiated ramp changes (UI radio click) — once the
  // user picks anything, disable auto-pick for the rest of the session.
  const onHypso = (e) => {
    if (!autoPick) return;
    if (e?.detail?._autopick) return; // skip our own dispatches
    userOverrode = true;
  };
  window.addEventListener('cart:hypso', onHypso);

  const tick = () => {
    if (!map.getBounds) return;
    const bounds = map.getBounds();
    const center = map.getCenter();
    const samples = sampleViewportElevation(map, bounds);
    const sea = bboxContains(SEA_BBOX, center.lng, center.lat) && samples.mean != null && samples.mean < -5;
    const inCarpathian = bboxContains(CARPATHIAN.bbox, center.lng, center.lat);

    let region = 'global';
    if (sea) region = 'sea';
    else if (inCarpathian) region = 'carpathian';
    else if ((samples.mean ?? 0) >= ALPINE_MEAN_THRESHOLD) region = 'alpine';
    else region = 'steppe';

    if (stats && onStats) onStats({ ...samples, region });

    if (autoPick && !userOverrode && region !== lastRegion) {
      lastRegion = region;
      const rampId = HYPSO.regionRamp[region] ?? HYPSO.regionRamp.global;
      applyHypsoRamp(map, rampId);
      // Persist the auto-picked ramp so subsequent reloads see it as
      // the user's "current choice" and `hasPersistedRampPref` short-
      // circuits auto-pick on those reloads. Without this the user
      // gets a different ramp every hard-refresh as auto-pick keeps
      // re-firing — exactly the "ramp leaks at hard-refresh" symptom.
      savePrefs({ rampId });
      userOverrode = true;
      // Tag this dispatch so onHypso doesn't lock us out a second time.
      window.dispatchEvent(new CustomEvent('cart:hypso', { detail: { _autopick: true, rampId } }));
    }
  };

  // Debounce via idle: MapLibre fires idle when render queue is empty.
  map.on('idle', tick);

  return () => {
    map.off('idle', tick);
    window.removeEventListener('cart:hypso', onHypso);
  };
}

/**
 * Sample the DEM at a SAMPLE_GRID × SAMPLE_GRID lattice across the
 * given lat-lng bounds, returning min/mean/max of finite samples.
 *
 * @param {maplibregl.Map} map
 * @param {maplibregl.LngLatBounds} bounds
 * @returns {ElevStats}
 */
export function sampleViewportElevation(map, bounds) {
  if (!bounds || typeof map.queryTerrainElevation !== 'function') {
    return { min: null, mean: null, max: null, sampled: 0, grid: 0, region: 'global' };
  }
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const lngStep = (ne.lng - sw.lng) / (SAMPLE_GRID - 1);
  const latStep = (ne.lat - sw.lat) / (SAMPLE_GRID - 1);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < SAMPLE_GRID; i++) {
    for (let j = 0; j < SAMPLE_GRID; j++) {
      const lng = sw.lng + i * lngStep;
      const lat = sw.lat + j * latStep;
      let e = null;
      try {
        e = map.queryTerrainElevation({ lng, lat });
      } catch {
        e = null;
      }
      if (e != null && Number.isFinite(e)) {
        if (e < min) min = e;
        if (e > max) max = e;
        sum += e;
        n++;
      }
    }
  }
  return {
    min: n > 0 ? min : null,
    mean: n > 0 ? sum / n : null,
    max: n > 0 ? max : null,
    sampled: n,
    grid: SAMPLE_GRID * SAMPLE_GRID,
    region: 'global',
  };
}

function bboxContains([w, s, e, n], lng, lat) {
  return lng >= w && lng <= e && lat >= s && lat <= n;
}
