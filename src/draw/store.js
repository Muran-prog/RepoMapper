/**
 * Draw engine — localStorage persistence layer.
 *
 * The drawing state survives reloads so a sketch the user started this
 * morning is still there in the afternoon. Two top-level blobs are
 * persisted:
 *
 *   • `cart:draw:features:v1` — the GeoJSON FeatureCollection of every
 *                                user-authored marker / line / polygon /
 *                                free-draw stroke / shape.
 *   • `cart:draw:prefs:v1`    — the user's tool + connection-mode +
 *                                style choices. Restored when the panel
 *                                is reopened.
 *
 * All reads/writes are defensive. Storage can be disabled (Safari
 * private mode, 3rd-party cookies blocked) or quota-exceeded; in either
 * case we silently fall back to in-memory state.
 *
 * @typedef {object} DrawPrefs
 * @property {string} tool                 Active tool slug (select/marker/…)
 * @property {string} connectionMode       'none'|'sequence'|'mesh'|'hub'
 *   `optimal` is deliberately NOT a persisted mode — it is an action
 *   (`engine.optimizeRoute()`), not a state. Stale persisted `optimal`
 *   from earlier schema versions is migrated to `none` on load.
 * @property {string} shapeType            'circle'|'rectangle'|'regular'|'arrow'|'star'
 * @property {number} shapeSides           Sides count for regular polygon.
 * @property {number} shapeSize            Placement radius in PIXELS at the
 *                                         current zoom. Single knob that
 *                                         drives every shape's initial size
 *                                         so a circle, star and rectangle
 *                                         all come out visually similar.
 * @property {string} color                CSS colour for new features.
 * @property {string} fill                 CSS fill for polygons.
 * @property {number} weight               Line weight in px.
 * @property {number} opacity              0..1 stroke opacity (fill follows
 *                                         at a fixed fraction so one slider
 *                                         controls all transparency).
 * @property {boolean} geodesic            Render connections as geodesics.
 * @property {boolean} labels              Show marker number labels.
 * @property {boolean} snap                Snap-to-vertex when placing.
 */

const FEATURES_KEY = 'cart:draw:features:v1';
const PREFS_KEY = 'cart:draw:prefs:v1';

/**
 * Allow-list of connection modes recognised by the current schema.
 * Matches `VALID_CONNECTION_MODES` in engine.js — kept here in
 * addition so the storage layer can sanitise stale values BEFORE
 * they reach the live engine state. Pre-refactor builds persisted
 * `'optimal'` as a mode; that value is migrated to `'none'` on load.
 */
const VALID_MODES = new Set(['none', 'sequence', 'mesh', 'hub']);

/** Probe localStorage availability without throwing. */
function ls() {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage;
    s.getItem(FEATURES_KEY);
    return s;
  } catch {
    return null;
  }
}

/** @returns {DrawPrefs} */
export function defaultPrefs() {
  return {
    tool: 'select',
    connectionMode: 'sequence',
    shapeType: 'circle',
    shapeSides: 6,
    shapeSize: 100,
    color: '#c66809',
    fill: '#c66809',
    weight: 3,
    opacity: 0.95,
    geodesic: true,
    labels: true,
    snap: true,
  };
}

/**
 * Load persisted preferences. Missing fields fall back to the defaults
 * so the returned object is always fully populated.
 *
 * @returns {DrawPrefs}
 */
export function loadPrefs() {
  const fallback = defaultPrefs();
  const storage = ls();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const merged = {
      ...fallback,
      ...Object.fromEntries(
        Object.entries(parsed).filter(([k]) => k in fallback),
      ),
    };
    // Migrate stale `connectionMode: 'optimal'` from pre-refactor
    // builds. Optimal is no longer a mode — it's an action — so we
    // coerce it to the safe default. The user can re-trigger the TSP
    // any time via the optimise button; we never silently re-draw
    // their committed routes for them on load.
    if (!VALID_MODES.has(merged.connectionMode)) merged.connectionMode = 'none';
    return merged;
  } catch {
    return fallback;
  }
}

/**
 * Patch persisted preferences. Best-effort — quota errors are swallowed.
 *
 * @param {Partial<DrawPrefs>} patch
 */
export function savePrefs(patch) {
  const storage = ls();
  if (!storage) return;
  try {
    const next = { ...loadPrefs(), ...patch };
    storage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* quota / serialise error — best-effort */
  }
}

/**
 * Load the persisted feature collection. Returns an empty array when
 * none are configured or the blob is malformed.
 *
 * @returns {Array<GeoJSON.Feature>}
 */
export function loadFeatures() {
  const storage = ls();
  if (!storage) return [];
  try {
    const raw = storage.getItem(FEATURES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.features)) return [];
    return parsed.features.filter(isValidFeature);
  } catch {
    return [];
  }
}

/**
 * Persist the feature collection. Best-effort.
 *
 * @param {Array<GeoJSON.Feature>} features
 */
export function saveFeatures(features) {
  const storage = ls();
  if (!storage) return;
  try {
    storage.setItem(
      FEATURES_KEY,
      JSON.stringify({ version: 1, features }),
    );
  } catch {
    /* quota / serialise error — best-effort */
  }
}

/** Defensive validation — discards anything that isn't a sane Feature. */
function isValidFeature(f) {
  if (!f || typeof f !== 'object') return false;
  if (f.type !== 'Feature') return false;
  if (!f.geometry || typeof f.geometry !== 'object') return false;
  if (typeof f.geometry.type !== 'string') return false;
  if (!Array.isArray(f.geometry.coordinates) && f.geometry.coordinates != null) {
    return false;
  }
  return true;
}
