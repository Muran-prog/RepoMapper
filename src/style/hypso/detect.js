/**
 * Runtime feature detection for the native MapLibre `color-relief` layer.
 *
 * Why not version-pin?
 * --------------------
 * The brief calls explicitly for feature detection, not version pinning.
 * Native color-relief support was landing across maplibre-gl-js point
 * releases through 2025 and is gated by build flags. Asking the runtime
 * whether the symbol exists is cheap, exact, and survives upstream
 * version bumps that don't change semantics.
 *
 * Probe strategy
 * --------------
 * The cleanest signal is: try adding a tiny color-relief layer pointing
 * at the primary DEM source, see if the layer becomes queryable, then
 * remove it. MapLibre throws synchronously when an unknown layer type
 * is asked for; on success the layer attaches without any visible
 * side-effect because it has no `paint.color-relief-color` and zero
 * opacity.
 *
 * The probe is run ONCE per `(map instance, source presence)` pair and
 * the result memoised on the map's `_cart` namespace so repeated style
 * rebuilds don't keep probing.
 *
 * @typedef {object} HypsoCaps
 * @property {boolean} nativeColorRelief
 * @property {boolean} rasterColor      Reserved — raster-color paint
 *                                       property (separate spec from
 *                                       color-relief; not used yet).
 */

const PROBE_LAYER_ID = '__cart_native_color_relief_probe__';

/**
 * Detect native color-relief support. Idempotent + cached on the map
 * instance via `map._cart.hypsoCaps`. When the probe fails AND the live
 * style already carries a color-relief hypso layer (composeLayers
 * optimistically emitted one because the build-time validator accepts
 * the type), we surgically demote the layer to raster mode if a raster
 * source is configured, or remove it outright otherwise.
 *
 * This is the graceful-fallback boundary the brief asks for:
 *
 *   нет native → raster
 *   нет raster → off
 *
 * @param {maplibregl.Map|null} map
 * @returns {HypsoCaps}
 */
export function detectHypsoCaps(map) {
  if (!map || typeof map.addLayer !== 'function') {
    return { nativeColorRelief: false, rasterColor: false };
  }
  const cart = map._cart ?? (map._cart = {});
  if (cart.hypsoCaps) return cart.hypsoCaps;

  const supported = probeColorRelief(map);
  cart.hypsoCaps = { nativeColorRelief: supported, rasterColor: false };

  if (!supported) demoteColorReliefIfPresent(map);

  return cart.hypsoCaps;
}

/**
 * Find a live color-relief layer and swap it for a raster equivalent —
 * or remove it altogether if no raster URL is configured for the
 * active ramp. Runs after a failed probe so an unsupported runtime
 * doesn't leave the map with a "ghost" layer that occupies a slot in
 * z-order but never renders pixels.
 *
 * @param {maplibregl.Map} map
 */
function demoteColorReliefIfPresent(map) {
  if (typeof map.getStyle !== 'function') return;
  const style = map.getStyle();
  if (!style?.layers) return;

  // Look up via the hypso layer metadata so we don't depend on the
  // hardcoded id and survive future renames.
  const HYPSO_LAYER_META = 'cart:hypso';
  const layer = style.layers.find(
    (l) => l?.type === 'color-relief' && l?.metadata && HYPSO_LAYER_META in l.metadata,
  );
  if (!layer) return;

  const state = map._cart?.hypso;
  const rampId = layer.metadata[HYPSO_LAYER_META]?.rampId ?? state?.rampId;
  const url = state?.rasterUrls?.[rampId];

  // Either way we drop the color-relief layer first.
  try {
    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
  } catch {
    /* swallow — same z-slot will be reused or left empty */
  }

  if (typeof url !== 'string' || url.length === 0) {
    // No raster fallback configured — stay in 'off' state. The picker
    // will still render but ramp changes will be no-ops until the
    // operator wires HYPSO.rasterUrls in src/config.js.
    if (state) state.mode = 'off';
    return;
  }

  // Wire a raster source + layer in the same slot.
  const newSourceId = `hypso-raster-${rampId}`;
  if (!map.getSource(newSourceId)) {
    try {
      map.addSource(newSourceId, {
        type: 'raster',
        url,
        tileSize: 256,
        minzoom: 2,
        maxzoom: 12,
      });
    } catch {
      if (state) state.mode = 'off';
      return;
    }
  }

  // Slot anchor — match the original layer's z-order.
  const idx = style.layers.findIndex((l) => l.id === layer.id);
  const beforeId =
    idx >= 0 && idx + 1 < style.layers.length ? style.layers[idx + 1].id : undefined;

  try {
    map.addLayer(
      {
        id: `hypso_raster_${rampId}`,
        type: 'raster',
        source: newSourceId,
        metadata: { [HYPSO_LAYER_META]: { mode: 'raster', rampId } },
        paint: {
          'raster-opacity': layer.paint?.['color-relief-opacity'] ?? 0.5,
          'raster-resampling': 'linear',
        },
      },
      beforeId,
    );
    if (state) state.mode = 'raster';
  } catch {
    if (state) state.mode = 'off';
  }
}

function probeColorRelief(map) {
  // We need a DEM source to attach the layer; if the style doesn't
  // declare one yet, we treat support as unknown-false. The same probe
  // is rerun on the first `styledata` after the DEM source appears
  // (interactions.js wires this).
  const hasDem = typeof map.getSource === 'function' && !!map.getSource('terrain-dem');
  if (!hasDem) return false;

  try {
    map.addLayer({
      id: PROBE_LAYER_ID,
      type: 'color-relief',
      source: 'terrain-dem',
      paint: {
        // Minimal valid color-relief-color expression with zero alpha
        // so it can never render.
        'color-relief-color': [
          'interpolate',
          ['linear'],
          ['elevation'],
          0,
          'rgba(0,0,0,0)',
          1,
          'rgba(0,0,0,0)',
        ],
        'color-relief-opacity': 0,
      },
    });
  } catch {
    // Layer type rejected — feature absent.
    return false;
  }

  const attached = typeof map.getLayer === 'function' && !!map.getLayer(PROBE_LAYER_ID);
  if (attached) {
    try {
      map.removeLayer(PROBE_LAYER_ID);
    } catch {
      /* If we managed to add but can't remove, leave it: zero alpha is
         invisible. Better than crashing the page. */
    }
  }
  return attached;
}

/**
 * Force-clear the memoised probe result. Used by the test harness and
 * by `applyStyle` when the DEM source could have changed since the
 * previous probe.
 *
 * @param {maplibregl.Map} map
 */
export function clearHypsoCaps(map) {
  if (map?._cart?.hypsoCaps) {
    delete map._cart.hypsoCaps;
  }
}
