/**
 * Connection algorithms for marker-to-marker auto-routing.
 *
 * Given an ordered list of N markers placed by the user, this module
 * produces zero or more LineString features that visually connect them
 * according to the active *connection mode*:
 *
 *   • `none`     — no auto-connections. Each marker stands alone.
 *   • `sequence` — connect markers in the order placed. 1→2→3→…→N.
 *                   Reads as a "trip" / numbered route.
 *   • `optimal`  — solve the open-TSP through all markers to find the
 *                   shortest total path. Nearest-neighbour seed + 2-opt
 *                   improvement; converges fast for N ≲ 200.
 *   • `mesh`     — connect every marker to every other (complete graph).
 *                   N(N-1)/2 lines — useful for visualising distances.
 *   • `hub`      — connect the first marker to all the others (star).
 *                   First marker is the centre / origin.
 *
 * Each line can also be rendered as a *geodesic* (great-circle arc) so
 * long-distance connections look correct at low zoom. The interpolator
 * uses the slerp formulation in radians for numerical stability near
 * the poles; well-tested and the canonical solution.
 *
 * Distance metric: Haversine, in metres. Good enough for any zoom level
 * Cart targets (sub-metre accuracy is only relevant for surveying).
 */

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Great-circle distance between two `[lng, lat]` points, in metres.
 * Implementation uses the haversine formula — numerically stable for
 * antipodal points (unlike the simpler law-of-cosines variant).
 */
export function haversine(a, b) {
  const lat1 = a[1] * DEG2RAD;
  const lat2 = b[1] * DEG2RAD;
  const dLat = (b[1] - a[1]) * DEG2RAD;
  const dLng = (b[0] - a[0]) * DEG2RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

/**
 * Spherical linear interpolation between two `[lng, lat]` points.
 *
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @param {number} t In `[0, 1]`.
 * @returns {[number, number]}
 */
function slerp(a, b, t) {
  const φ1 = a[1] * DEG2RAD;
  const λ1 = a[0] * DEG2RAD;
  const φ2 = b[1] * DEG2RAD;
  const λ2 = b[0] * DEG2RAD;

  const d = haversine(a, b) / EARTH_RADIUS_M;
  if (d < 1e-9) return [a[0], a[1]];

  const sd = Math.sin(d);
  const A = Math.sin((1 - t) * d) / sd;
  const B = Math.sin(t * d) / sd;

  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);

  const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
  const λ = Math.atan2(y, x);
  return [λ * RAD2DEG, φ * RAD2DEG];
}

/**
 * Build a geodesic polyline between `a` and `b`. The number of samples
 * scales with the angular distance so short hops stay cheap and global
 * hops still look smooth.
 *
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @param {object} [opts]
 * @param {number} [opts.maxSegments=128]
 * @param {number} [opts.minSegments=2]
 * @returns {Array<[number, number]>}
 */
export function geodesicLine(a, b, { maxSegments = 128, minSegments = 2 } = {}) {
  const dMeters = haversine(a, b);
  // ~25 km per segment, capped — long flights get ~128 samples max.
  const target = Math.min(maxSegments, Math.max(minSegments, Math.round(dMeters / 25_000)));
  const out = new Array(target + 1);
  for (let i = 0; i <= target; i++) {
    out[i] = slerp(a, b, i / target);
  }
  return out;
}

/**
 * Build the coordinates of a connection between `a` and `b`. When
 * `geodesic=false` the result is the two-point straight segment
 * MapLibre renders in projected space.
 */
export function connectionCoords(a, b, { geodesic = true } = {}) {
  if (!geodesic) return [a, b];
  return geodesicLine(a, b);
}

// ---------------------------------------------------------------------------
// Sequence / mesh / hub generators — pure index pairs.
// ---------------------------------------------------------------------------

/** Pairs of indices that should be connected for the active mode. */
function indexPairs(n, mode) {
  if (n < 2) return [];
  switch (mode) {
    case 'sequence':
      return Array.from({ length: n - 1 }, (_, i) => [i, i + 1]);
    case 'mesh': {
      const out = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) out.push([i, j]);
      }
      return out;
    }
    case 'hub':
      return Array.from({ length: n - 1 }, (_, i) => [0, i + 1]);
    case 'optimal':
    case 'none':
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Optimal-tour solver (open TSP).
//
// We treat it as an OPEN tour — start anywhere, end anywhere. That is
// what users intuitively expect when they ask for "the shortest path
// through these points": a sequence of straight legs visiting every
// marker exactly once, NOT a closed loop. (Forcing a return-to-start
// loop would surprise the user with an extra leg they didn't ask for.)
// ---------------------------------------------------------------------------

/**
 * Greedy nearest-neighbour seed. Start from the first point, repeatedly
 * pick the closest unvisited point. O(N²). Good enough as a 2-opt
 * starting point for N ≲ 200.
 *
 * @param {Array<[number, number]>} points
 * @returns {Array<number>} Permutation of `[0..n-1]`.
 */
function nearestNeighbourTour(points) {
  const n = points.length;
  if (n === 0) return [];
  const visited = new Array(n).fill(false);
  const tour = [0];
  visited[0] = true;
  for (let step = 1; step < n; step++) {
    const last = tour[tour.length - 1];
    let bestJ = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      const d = haversine(points[last], points[j]);
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    }
    visited[bestJ] = true;
    tour.push(bestJ);
  }
  return tour;
}

/** Total length of an open tour, in metres. */
function tourLength(tour, points) {
  let total = 0;
  for (let i = 0; i < tour.length - 1; i++) {
    total += haversine(points[tour[i]], points[tour[i + 1]]);
  }
  return total;
}

/**
 * 2-opt improvement for an OPEN tour. Repeatedly reverses sub-tours
 * that strictly reduce total length; terminates when a full pass
 * finds no improvement.
 *
 * Every non-adjacent edge pair `(tour[i], tour[i+1])` vs
 * `(tour[j], tour[j+1])` is considered for 1 ≤ i ≤ n-3 and
 * i+2 ≤ j ≤ n-1. When `j == n-1` there is no "right" edge, so the
 * swap replaces a single edge:
 *   before = |ab|,   after = |ac|.
 * Otherwise both edges flip:
 *   before = |ab| + |cd|,   after = |ac| + |bd|.
 *
 * Critical correctness notes:
 *
 *   • The bound is `j < n` for every i. An earlier version special-
 *     cased `i === 0` to skip `j = n-1` — that is correct for CLOSED
 *     TSP (where reversing [1..n-1] is a no-op rotation) but wrong
 *     for OPEN TSP, where it misses a common improvement that
 *     swaps the first edge `tour[0]→tour[1]` for `tour[0]→tour[n-1]`.
 *
 *   • `b` is recomputed on every iteration of the j loop. After a
 *     successful reversal `tour[i+1]` changes (it becomes what was
 *     at tour[j]), so caching `b` once per `i` leaves stale data
 *     in `before` for all subsequent j — either rejecting real
 *     improvements or accepting phantom ones. The tiny extra
 *     lookup per iteration is irrelevant versus the two haversine
 *     calls already in the inner loop.
 *
 * For realistic marker counts (≤ ~50) this converges in a handful
 * of passes; `maxIterations` is a safety net, not a hot loop bound.
 *
 * @param {Array<number>} initialTour
 * @param {Array<[number, number]>} points
 * @returns {Array<number>}
 */
function twoOpt(initialTour, points, { maxIterations = 200 } = {}) {
  const tour = initialTour.slice();
  const n = tour.length;
  if (n < 4) return tour;

  for (let iter = 0; iter < maxIterations; iter++) {
    let improved = false;
    for (let i = 0; i < n - 2; i++) {
      const a = points[tour[i]];
      for (let j = i + 2; j < n; j++) {
        // `b` may have been changed by an earlier successful swap
        // in this pass; read it fresh every iteration.
        const b = points[tour[i + 1]];
        const c = points[tour[j]];
        const hasRight = j + 1 < n;
        const d = hasRight ? points[tour[j + 1]] : null;
        const before = haversine(a, b) + (hasRight ? haversine(c, d) : 0);
        const after = haversine(a, c) + (hasRight ? haversine(b, d) : 0);
        if (after + 1e-9 < before) {
          // Reverse the sub-tour [i+1 .. j].
          let lo = i + 1;
          let hi = j;
          while (lo < hi) {
            const tmp = tour[lo];
            tour[lo] = tour[hi];
            tour[hi] = tmp;
            lo++;
            hi--;
          }
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return tour;
}

/**
 * Solve the open TSP. Returns the optimised marker order as an array
 * of indices into the input `points` array.
 *
 * @param {Array<[number, number]>} points
 * @returns {Array<number>}
 */
export function optimalTour(points) {
  if (points.length < 2) return points.map((_, i) => i);
  // Try every starting node (cheap for small N) and keep the best.
  // For N ≤ 32 this gives near-optimal results without resorting to
  // exact dynamic programming.
  const n = points.length;
  const seedLimit = Math.min(n, n <= 32 ? n : 8);
  let best = null;
  let bestLen = Infinity;
  for (let s = 0; s < seedLimit; s++) {
    const tour = nearestNeighbourTourFrom(points, s);
    const refined = twoOpt(tour, points);
    const len = tourLength(refined, points);
    if (len < bestLen) {
      bestLen = len;
      best = refined;
    }
  }
  return best ?? nearestNeighbourTour(points);
}

/** Nearest-neighbour tour starting from a specified index. */
function nearestNeighbourTourFrom(points, start) {
  const n = points.length;
  const visited = new Array(n).fill(false);
  const tour = [start];
  visited[start] = true;
  for (let step = 1; step < n; step++) {
    const last = tour[tour.length - 1];
    let bestJ = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      const d = haversine(points[last], points[j]);
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    }
    visited[bestJ] = true;
    tour.push(bestJ);
  }
  return tour;
}

// ---------------------------------------------------------------------------
// Public entry — turn marker coords + mode into LineString features.
// ---------------------------------------------------------------------------

/**
 * Build the connection LineString features for the given markers.
 *
 * @param {Array<{id: string, lngLat: [number, number]}>} markers
 *        Markers in the order the user placed them.
 * @param {object} opts
 * @param {string} opts.mode      Connection mode.
 * @param {boolean} [opts.geodesic=true]
 * @returns {{
 *   features: Array<GeoJSON.Feature>,
 *   order: Array<string>,        // marker ids in tour order (optimal/sequence)
 *   totalMeters: number,         // total connection length
 * }}
 */
export function buildConnections(markers, { mode, geodesic = true } = {}) {
  if (!markers || markers.length < 2 || mode === 'none') {
    return { features: [], order: markers.map((m) => m.id), totalMeters: 0 };
  }

  const points = markers.map((m) => m.lngLat);
  let pairs;
  let order;

  if (mode === 'optimal') {
    const tour = optimalTour(points);
    order = tour.map((i) => markers[i].id);
    pairs = [];
    for (let i = 0; i < tour.length - 1; i++) {
      pairs.push([tour[i], tour[i + 1]]);
    }
  } else {
    order = markers.map((m) => m.id);
    pairs = indexPairs(markers.length, mode);
  }

  let totalMeters = 0;
  const features = pairs.map(([i, j], idx) => {
    const a = points[i];
    const b = points[j];
    totalMeters += haversine(a, b);
    return {
      type: 'Feature',
      id: `__conn_${idx}_${markers[i].id}_${markers[j].id}`,
      geometry: {
        type: 'LineString',
        coordinates: connectionCoords(a, b, { geodesic }),
      },
      properties: {
        kind: 'connection',
        connectionMode: mode,
        fromId: markers[i].id,
        toId: markers[j].id,
        legIndex: idx,
        readonly: true,
      },
    };
  });

  return { features, order, totalMeters };
}

/** Human-readable distance label — KM at long range, M at short. */
export function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return '—';
  if (meters >= 10_000) return `${(meters / 1000).toFixed(0)} км`;
  if (meters >= 1_000) return `${(meters / 1000).toFixed(1)} км`;
  return `${Math.round(meters)} м`;
}
