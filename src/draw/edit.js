/**
 * Edit operations on draw features — vertex manipulation, translation,
 * deletion, geometry mutation helpers.
 *
 * Kept separate from the engine so each operation is testable in
 * isolation. Every helper here is a pure function over GeoJSON
 * geometries; the engine handles persistence and source updates.
 */

/**
 * Vertex coordinate ref: feature id + path describing how to reach the
 * `[lng, lat]` array inside the geometry.
 *
 * Paths:
 *   Point:        []                       (the whole `coordinates` is the vertex)
 *   LineString:   [i]                      (coordinates[i])
 *   Polygon:      [ring, i]                (coordinates[ring][i])
 *   MultiLine:    [line, i]                (multi geometries are not authored here yet)
 *
 * @typedef {object} VertexRef
 * @property {string} featureId
 * @property {Array<number>} path
 */

/**
 * Walk the geometry of `feature` and yield `{ ref, lngLat }` for every
 * editable vertex. Used by the engine to emit vertex-handle features
 * when a single feature is selected.
 */
export function* listVertices(feature) {
  if (!feature?.geometry) return;
  const id = feature.id;
  const g = feature.geometry;
  switch (g.type) {
    case 'Point': {
      yield { ref: { featureId: id, path: [] }, lngLat: g.coordinates };
      break;
    }
    case 'LineString': {
      for (let i = 0; i < g.coordinates.length; i++) {
        yield { ref: { featureId: id, path: [i] }, lngLat: g.coordinates[i] };
      }
      break;
    }
    case 'Polygon': {
      for (let r = 0; r < g.coordinates.length; r++) {
        const ring = g.coordinates[r];
        // Skip the last point (it's a duplicate of the first to close
        // the ring). The closure is re-stitched on every mutation.
        for (let i = 0; i < ring.length - 1; i++) {
          yield { ref: { featureId: id, path: [r, i] }, lngLat: ring[i] };
        }
      }
      break;
    }
    default:
      // MultiPoint / MultiLineString / MultiPolygon — not authored by
      // the engine, ignore so legacy data doesn't crash the UI.
      break;
  }
}

/**
 * Yield `{ ref, lngLat }` for every *midpoint* between adjacent vertices.
 * Clicking a midpoint inserts a new vertex at the midpoint position —
 * a friendlier interaction than expecting the user to find an empty
 * segment to click on.
 */
export function* listMidpoints(feature) {
  if (!feature?.geometry) return;
  const id = feature.id;
  const g = feature.geometry;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

  switch (g.type) {
    case 'LineString': {
      for (let i = 0; i < g.coordinates.length - 1; i++) {
        const lngLat = mid(g.coordinates[i], g.coordinates[i + 1]);
        yield {
          ref: { featureId: id, path: [i + 1], op: 'insert' },
          lngLat,
        };
      }
      break;
    }
    case 'Polygon': {
      for (let r = 0; r < g.coordinates.length; r++) {
        const ring = g.coordinates[r];
        for (let i = 0; i < ring.length - 1; i++) {
          const lngLat = mid(ring[i], ring[i + 1]);
          yield {
            ref: { featureId: id, path: [r, i + 1], op: 'insert' },
            lngLat,
          };
        }
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Replace the vertex at `ref` with `lngLat`. Returns a NEW feature so
 * downstream code can compare by reference (cheap update detection).
 *
 * @param {GeoJSON.Feature} feature
 * @param {VertexRef} ref
 * @param {[number, number]} lngLat
 */
export function updateVertex(feature, ref, lngLat) {
  if (!feature || !ref) return feature;
  const next = cloneFeature(feature);
  const g = next.geometry;
  switch (g.type) {
    case 'Point':
      g.coordinates = lngLat;
      break;
    case 'LineString':
      g.coordinates[ref.path[0]] = lngLat;
      break;
    case 'Polygon': {
      const ring = g.coordinates[ref.path[0]];
      ring[ref.path[1]] = lngLat;
      // Maintain the closure invariant — if the user moved index 0 the
      // last element must follow.
      if (ref.path[1] === 0) ring[ring.length - 1] = lngLat;
      break;
    }
    default:
      break;
  }
  return next;
}

/**
 * Insert a new vertex at `ref` (which carries `op: 'insert'`). The path
 * tells us where to splice in the new vertex.
 */
export function insertVertex(feature, ref, lngLat) {
  if (!feature || !ref || ref.op !== 'insert') return feature;
  const next = cloneFeature(feature);
  const g = next.geometry;
  switch (g.type) {
    case 'LineString':
      g.coordinates.splice(ref.path[0], 0, lngLat);
      break;
    case 'Polygon': {
      const ring = g.coordinates[ref.path[0]];
      ring.splice(ref.path[1], 0, lngLat);
      break;
    }
    default:
      break;
  }
  return next;
}

/**
 * Delete a vertex. For lines this collapses to a `Point` once two
 * vertices remain; for polygons it requires at least three corners.
 *
 * @returns {GeoJSON.Feature|null} `null` if the feature must be deleted.
 */
export function deleteVertex(feature, ref) {
  if (!feature || !ref) return feature;
  const next = cloneFeature(feature);
  const g = next.geometry;
  switch (g.type) {
    case 'Point':
      return null;
    case 'LineString': {
      g.coordinates.splice(ref.path[0], 1);
      if (g.coordinates.length === 0) return null;
      if (g.coordinates.length === 1) {
        next.geometry = { type: 'Point', coordinates: g.coordinates[0] };
      }
      break;
    }
    case 'Polygon': {
      const ring = g.coordinates[ref.path[0]];
      ring.splice(ref.path[1], 1);
      // The first/last duplicate must stay in sync.
      if (ref.path[1] === 0 && ring.length > 0) {
        ring[ring.length - 1] = ring[0];
      }
      // Polygon needs ≥ 4 entries (3 distinct corners + closure).
      if (ring.length < 4) return null;
      break;
    }
    default:
      break;
  }
  return next;
}

/**
 * Translate every vertex of a feature by a `[Δlng, Δlat]` offset. Used
 * by drag-to-move on a non-vertex part of the feature.
 */
export function translateFeature(feature, deltaLng, deltaLat) {
  if (!feature) return feature;
  const next = cloneFeature(feature);
  const shift = (c) => [c[0] + deltaLng, c[1] + deltaLat];
  const g = next.geometry;
  switch (g.type) {
    case 'Point':
      g.coordinates = shift(g.coordinates);
      break;
    case 'LineString':
      g.coordinates = g.coordinates.map(shift);
      break;
    case 'Polygon':
      g.coordinates = g.coordinates.map((ring) => ring.map(shift));
      break;
    default:
      break;
  }
  return next;
}

/** Deep-clone a Feature so caller mutations don't affect the original. */
function cloneFeature(feature) {
  return JSON.parse(JSON.stringify(feature));
}

/**
 * Compute the centroid of any supported geometry. Used to anchor
 * editing affordances (e.g. the "rotate handle" we may add later).
 */
export function centroidOf(feature) {
  const g = feature?.geometry;
  if (!g) return null;
  switch (g.type) {
    case 'Point':
      return g.coordinates;
    case 'LineString':
      return averageCoords(g.coordinates);
    case 'Polygon':
      return averageCoords(g.coordinates[0]);
    default:
      return null;
  }
}

function averageCoords(coords) {
  if (!coords?.length) return null;
  let lng = 0;
  let lat = 0;
  for (const c of coords) {
    lng += c[0];
    lat += c[1];
  }
  return [lng / coords.length, lat / coords.length];
}
