/**
 * Measure (ruler) — pure helpers for the marker pairwise distance
 * overlay. No MapLibre, no DOM: this module is fully unit-testable.
 *
 * Shape of the feature
 * --------------------
 * For an ordered list of N markers (N ≥ 2), the build function emits
 * 2 × (N-1) GeoJSON features sharing one logical source:
 *
 *   • A two-point LineString between markers[i] and markers[i+1].
 *     (`kind: 'measure-line'`)
 *   • A Point at the midpoint carrying the formatted label as a
 *     property the symbol layer reads via `['get', 'label']`.
 *     (`kind: 'measure-badge'`)
 *
 * All segments are pairwise — never accumulating to a total. Marker N
 * has no "next" so the last leg is between (N-2, N-1).
 *
 * Distance formatting mirrors the vertical scale: integers below 1 km
 * read in metres ("420 м"), 1..10 km read with one decimal trimmed of
 * trailing .0 ("4.2 км" / "5 км"), and ≥ 10 km round to whole km
 * ("12 км"). That keeps every distance readout in the app consistent.
 *
 * Persistence note
 * ----------------
 * The features built here are NEVER stored. The engine regenerates
 * them on every render and they live in a separate source from the
 * persistent drawing collection — adding/moving/deleting markers
 * yields fresh measure features instantly, with zero migration on
 * load.
 */

import { haversine } from './connections.js';

/**
 * Format a metres value as "xxx м" / "xx.x км" / "xxx км".
 * Mirrors the rounding rules used by the vertical scale control so
 * every distance readout in the app reads the same way.
 *
 * @param {number} meters
 * @returns {string}
 */
export function formatMeasure(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return '0 м';
  if (meters >= 1000) {
    const km = meters / 1000;
    const display = km >= 10
      ? String(Math.round(km))
      : km.toFixed(1).replace(/\.0$/, '');
    return `${display} км`;
  }
  return `${Math.round(meters)} м`;
}

/**
 * Midpoint between two `[lng, lat]` points in lng/lat space, with
 * antimeridian-safe longitude wrap. Linear midpoint is plenty for
 * badge placement at the zoom levels users actually measure at; a
 * slerp midpoint would be marginally more accurate at trans-Pacific
 * scale but identical in screen pixels at every realistic camera.
 *
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {[number, number]}
 */
function midpoint(a, b) {
  let dLng = b[0] - a[0];
  if (dLng > 180) dLng -= 360;
  else if (dLng < -180) dLng += 360;
  const lng = a[0] + dLng / 2;
  const lat = (a[1] + b[1]) / 2;
  // Re-wrap into [-180, 180] so MapLibre's projection picks the short
  // way around when the midpoint sits near the antimeridian.
  const wrapped = ((lng + 540) % 360) - 180;
  return [wrapped, lat];
}

/**
 * @typedef {object} MeasureMarker
 * @property {string} id
 * @property {[number, number]} coordinates
 */

/**
 * Build the line + badge features for the given ordered markers.
 *
 *   • < 2 markers → empty list (the caller renders nothing).
 *   • Each consecutive pair (i, i+1) gets one line + one badge.
 *   • Total tour distance is intentionally NOT computed — the brief
 *     calls for pairwise readouts only, and the engine's existing
 *     auto-connection metric (over auto-gen lines) covers the
 *     "route total" use case separately.
 *
 * @param {Array<MeasureMarker>} markers
 * @returns {{ features: Array<GeoJSON.Feature> }}
 */
export function buildMeasureFeatures(markers) {
  if (!Array.isArray(markers) || markers.length < 2) {
    return { features: [] };
  }
  const features = [];
  for (let i = 0; i < markers.length - 1; i++) {
    const from = markers[i];
    const to = markers[i + 1];
    const a = from.coordinates;
    const b = to.coordinates;
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    const meters = haversine(a, b);
    const mid = midpoint(a, b);
    const label = formatMeasure(meters);
    features.push({
      type: 'Feature',
      id: `__measure_line_${i}`,
      geometry: { type: 'LineString', coordinates: [a, b] },
      properties: {
        kind: 'measure-line',
        meters,
        label,
        pairIndex: i,
        fromId: from.id,
        toId: to.id,
      },
    });
    features.push({
      type: 'Feature',
      id: `__measure_badge_${i}`,
      geometry: { type: 'Point', coordinates: mid },
      properties: {
        kind: 'measure-badge',
        meters,
        label,
        pairIndex: i,
        fromId: from.id,
        toId: to.id,
      },
    });
  }
  return { features };
}

/**
 * Resolve the distance to display in the floating tooltip when the
 * user clicks marker `markerId`.
 *
 *   • Any non-last marker → distance to the next marker.
 *   • The last marker     → distance to the previous marker.
 *   • Fewer than 2 markers, or unknown id → null.
 *
 * Returns the matching pair so the tooltip can highlight which
 * neighbour the readout refers to (currently used only for diagnostics
 * but cheap to compute and keeps the contract complete).
 *
 * @param {Array<MeasureMarker>} markers
 * @param {string} markerId
 * @returns {null | { meters: number, label: string, fromId: string, toId: string }}
 */
export function distanceForMarker(markers, markerId) {
  if (!Array.isArray(markers) || markers.length < 2) return null;
  const idx = markers.findIndex((m) => m.id === markerId);
  if (idx < 0) return null;
  let from;
  let to;
  if (idx === markers.length - 1) {
    from = markers[idx - 1];
    to = markers[idx];
  } else {
    from = markers[idx];
    to = markers[idx + 1];
  }
  const meters = haversine(from.coordinates, to.coordinates);
  return {
    meters,
    label: formatMeasure(meters),
    fromId: from.id,
    toId: to.id,
  };
}
