/**
 * Shape templates — geometry generators for the "ready-made shapes"
 * palette in the drawing UI.
 *
 * Every helper here returns either a GeoJSON `Polygon` or `LineString`
 * geometry in `[lng, lat]` coordinates. The caller (engine.js) wraps the
 * geometry in a Feature with the appropriate `properties.kind`.
 *
 * Geodesy
 * -------
 * Shapes are authored on the sphere so a "circle of radius 5 km" really
 * is 5 km on the ground at any latitude. The destination formula uses
 * the standard great-circle bearing/distance pair, accurate to a few
 * millimetres for sub-1000-km radii — vastly more than any user can
 * detect on screen.
 *
 * Rectangle is the only exception: it's an axis-aligned LON/LAT box.
 * That maps to a *trapezoid* on the sphere as latitude increases, but
 * matches user expectation when they're "drawing a rectangle on a map"
 * (anyone who tries this on a globe at high latitude will realise the
 * top is shorter than the bottom; we keep the lon/lat semantics so the
 * box stays predictable under panning).
 */

import { haversine } from './connections.js';

const EARTH_RADIUS_M = 6_371_008.8;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Move `[lng, lat]` by `distance` metres along `bearingRad` (radians,
 * 0 = north, clockwise). Returns the destination `[lng, lat]`.
 */
function destination(origin, distanceMeters, bearingRad) {
  const φ1 = origin[1] * DEG2RAD;
  const λ1 = origin[0] * DEG2RAD;
  const δ = distanceMeters / EARTH_RADIUS_M;

  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);

  const φ2 = Math.asin(sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(bearingRad));
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(bearingRad) * sinδ * cosφ1,
      cosδ - sinφ1 * Math.sin(φ2),
    );

  return [normaliseLng(λ2 * RAD2DEG), φ2 * RAD2DEG];
}

/** Wrap longitude into [-180, 180]. */
function normaliseLng(lng) {
  let x = ((lng + 540) % 360) - 180;
  if (x === -180) x = 180;
  return x;
}

/**
 * Initial bearing (radians) of the great-circle arc from `a` to `b`.
 * Returns 0 when the two points coincide.
 */
function initialBearing(a, b) {
  const φ1 = a[1] * DEG2RAD;
  const φ2 = b[1] * DEG2RAD;
  const Δλ = (b[0] - a[0]) * DEG2RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  if (y === 0 && x === 0) return 0;
  return Math.atan2(y, x);
}

// ---------------------------------------------------------------------------
// Public shape factories.
// ---------------------------------------------------------------------------

/**
 * Geodesic circle approximated by an N-segment polygon.
 *
 * @param {[number, number]} center
 * @param {number} radiusMeters
 * @param {object} [opts]
 * @param {number} [opts.segments=64]
 */
export function makeCircle(center, radiusMeters, { segments = 64 } = {}) {
  const verts = [];
  for (let i = 0; i < segments; i++) {
    const bearing = (i / segments) * 2 * Math.PI;
    verts.push(destination(center, radiusMeters, bearing));
  }
  verts.push(verts[0]); // close ring
  return {
    type: 'Polygon',
    coordinates: [verts],
  };
}

/**
 * Axis-aligned lon/lat rectangle spanning the two corners.
 *
 * @param {[number, number]} cornerA
 * @param {[number, number]} cornerB
 */
export function makeRectangle(cornerA, cornerB) {
  const w = Math.min(cornerA[0], cornerB[0]);
  const e = Math.max(cornerA[0], cornerB[0]);
  const s = Math.min(cornerA[1], cornerB[1]);
  const n = Math.max(cornerA[1], cornerB[1]);
  const ring = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
  return { type: 'Polygon', coordinates: [ring] };
}

/**
 * Regular N-sided polygon (hexagon, pentagon, …) inscribed in a circle.
 *
 * @param {[number, number]} center
 * @param {number} radiusMeters
 * @param {number} sides         3..32
 * @param {object} [opts]
 * @param {number} [opts.rotation=0]  Radians; 0 means a vertex points north.
 */
export function makeRegularPolygon(center, radiusMeters, sides, { rotation = 0 } = {}) {
  const n = Math.max(3, Math.min(32, sides | 0));
  const verts = [];
  for (let i = 0; i < n; i++) {
    const bearing = rotation + (i / n) * 2 * Math.PI;
    verts.push(destination(center, radiusMeters, bearing));
  }
  verts.push(verts[0]);
  return { type: 'Polygon', coordinates: [verts] };
}

/**
 * N-pointed star — outer + inner radii alternating.
 *
 * @param {[number, number]} center
 * @param {number} outerRadiusMeters
 * @param {number} [points=5]
 * @param {object} [opts]
 * @param {number} [opts.innerRatio=0.45] Inner radius / outer radius.
 * @param {number} [opts.rotation=0]
 */
export function makeStar(center, outerRadiusMeters, points = 5, opts = {}) {
  const { innerRatio = 0.45, rotation = 0 } = opts;
  const tips = Math.max(3, Math.min(20, points | 0));
  const verts = [];
  for (let i = 0; i < tips * 2; i++) {
    const bearing = rotation + (i / (tips * 2)) * 2 * Math.PI;
    const r = i % 2 === 0 ? outerRadiusMeters : outerRadiusMeters * innerRatio;
    verts.push(destination(center, r, bearing));
  }
  verts.push(verts[0]);
  return { type: 'Polygon', coordinates: [verts] };
}

/**
 * Arrow — a LineString shaft + a polygon arrowhead in two separate
 * geometries. Returned as an object so the engine can place both
 * features atomically.
 *
 * @param {[number, number]} start
 * @param {[number, number]} end
 * @param {object} [opts]
 * @param {number} [opts.headFraction=0.18] Head length as a fraction of shaft length.
 * @param {number} [opts.headSpread=0.32]   Half-width / length ratio.
 */
export function makeArrow(start, end, { headFraction = 0.18, headSpread = 0.32 } = {}) {
  const shaftLen = haversine(start, end);
  if (shaftLen < 1) {
    // Degenerate — return a minimal sliver so the feature is non-empty.
    return {
      shaft: { type: 'LineString', coordinates: [start, end] },
      head: makeCircle(end, 5, { segments: 16 }),
    };
  }
  const bearing = initialBearing(start, end);
  const headLen = shaftLen * headFraction;
  const headHalf = headLen * headSpread;

  // Tip is `end`; the base of the head sits along the shaft.
  const base = destination(end, headLen, bearing + Math.PI);
  const left = destination(base, headHalf, bearing - Math.PI / 2);
  const right = destination(base, headHalf, bearing + Math.PI / 2);

  // Truncate the shaft at the head base so the line doesn't poke past
  // the arrowhead when rendered with thick strokes.
  const shaftEnd = base;
  return {
    shaft: { type: 'LineString', coordinates: [start, shaftEnd] },
    head: {
      type: 'Polygon',
      coordinates: [[left, end, right, left]],
    },
  };
}

/**
 * Build a default-sized shape centred on `lngLat` at the given zoom.
 * Convenience helper for the "drop a shape with one click" flow — the
 * user sees a reasonably-sized template they can then resize.
 *
 * Radius scales with the camera so a hexagon at zoom 5 is ~50 km wide,
 * at zoom 12 it's ~500 m. The mapping is roughly the canvas equivalent
 * of "1/8 of the viewport".
 */
export function defaultRadiusForZoom(zoom) {
  // Pixels-per-metre at the equator: 256 * 2^zoom / (2 * π * R) is the
  // ground sample distance. For a target ~80 px shape size:
  //   r_m = 80 / pxPerMeter
  const pxPerMeter = (256 * Math.pow(2, zoom)) / (2 * Math.PI * EARTH_RADIUS_M);
  if (pxPerMeter <= 0) return 1000;
  return Math.max(20, Math.min(2_000_000, 80 / pxPerMeter));
}
