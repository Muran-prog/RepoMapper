/**
 * 3D label overlay for the Cesium world view.
 *
 * Labels are NOT baked into the draped terrain texture (that smears/distorts
 * them on steep, crowded relief). Instead we harvest the SAME label features
 * from the live 2D MapLibre style and render them as crisp, camera-facing
 * Cesium labels clamped to the (exaggerated) terrain — single source of
 * truth, zero distortion.
 *
 * How it works
 * ------------
 * A hidden "harvest" MapLibre map carries the full live style. Whenever the
 * Cesium camera settles we compute the geographic bbox the camera is looking
 * at (sampling the globe across the viewport — robust for oblique/horizon
 * views where computeViewRectangle() returns undefined), fit the harvest map
 * to it, and queryRenderedFeatures() the symbol layers. Each label feature's
 * text is resolved from its layer's `text-field`, deduped, ranked, capped,
 * and synced into a Cesium label collection.
 */

// ---------------------------------------------------------------------------
// text-field expression resolver (minimal MapLibre expression subset).
// ---------------------------------------------------------------------------

function resolveText(expr, props) {
  if (expr == null) return '';
  if (typeof expr === 'number') return String(expr);
  if (typeof expr === 'string') {
    // Token form: "{name}" / "{name}\n{ele} m"
    if (expr.includes('{')) {
      return expr
        .replace(/\{([^}]+)\}/g, (_, k) => (props[k] != null ? String(props[k]) : ''))
        .trim();
    }
    return expr;
  }
  if (!Array.isArray(expr)) return '';
  const op = expr[0];
  switch (op) {
    case 'get':
      return props[expr[1]] != null ? String(props[expr[1]]) : '';
    case 'coalesce':
      for (let i = 1; i < expr.length; i++) {
        const v = resolveText(expr[i], props);
        if (v) return v;
      }
      return '';
    case 'concat':
      return expr.slice(1).map((e) => resolveText(e, props)).join('');
    case 'to-string':
    case 'string':
      return resolveText(expr[1], props);
    case 'literal':
      return expr[1] == null ? '' : String(expr[1]);
    case 'format': {
      // ["format", inputA, optsA, inputB, optsB, ...] — opts are objects.
      let out = '';
      for (let i = 1; i < expr.length; i++) {
        const part = expr[i];
        if (part && typeof part === 'object' && !Array.isArray(part)) continue;
        out += resolveText(part, props);
      }
      return out;
    }
    case 'step':
    case 'match':
    case 'case':
      // Best-effort: scan for the first resolvable string-ish leaf.
      for (let i = 1; i < expr.length; i++) {
        const v = resolveText(expr[i], props);
        if (v) return v;
      }
      return '';
    default:
      return props.name != null ? String(props.name) : '';
  }
}

// ---------------------------------------------------------------------------
// Feature classification → rank / size / colour.
// ---------------------------------------------------------------------------

function classify(feature) {
  const layerId = (feature.layer && feature.layer.id) || '';
  const p = feature.properties || {};
  const cls = (p.class || p.type || '').toString().toLowerCase();
  const id = layerId.toLowerCase();

  // Mountain peaks.
  if (/peak|summit/.test(id) || cls === 'peak' || p.natural === 'peak') {
    return { kind: 'peak', rank: 70, size: 14, ele: p.ele || p.elevation };
  }
  // Settlements by importance.
  if (/place|city|town|village|settlement|capital/.test(id) || /city|town|village|hamlet|capital|suburb/.test(cls)) {
    if (/city|capital/.test(cls)) return { kind: 'place', rank: 100, size: 20 };
    if (/town/.test(cls)) return { kind: 'place', rank: 85, size: 17 };
    if (/village|suburb/.test(cls)) return { kind: 'place', rank: 55, size: 14 };
    return { kind: 'place', rank: 65, size: 15 };
  }
  // Water bodies.
  if (/water|lake|river|reservoir/.test(id) || /water|lake|river/.test(cls)) {
    return { kind: 'water', rank: 50, size: 13, water: true };
  }
  // Generic POI / other.
  return { kind: 'poi', rank: 30, size: 12 };
}

// ---------------------------------------------------------------------------
// Public factory.
// ---------------------------------------------------------------------------

/**
 * @param {typeof Cesium} Cesium
 * @param {Cesium.Viewer} viewer
 * @param {maplibregl.Map} sourceMap  The live 2D map (source of truth).
 * @param {object} [opts]
 * @param {number} [opts.maxLabels=140]
 * @returns {{ destroy: () => void, refresh: () => void }}
 */
export function createLabelOverlay(Cesium, viewer, sourceMap, opts = {}) {
  const ml = window.maplibregl;
  if (!ml || !sourceMap) {
    return { destroy() {}, refresh() {} };
  }
  const maxLabels = opts.maxLabels ?? 140;

  const liveStyle = sourceMap.getStyle();
  const symbolLayers = (liveStyle.layers || []).filter((l) => l.type === 'symbol');
  const symbolLayerIds = symbolLayers.map((l) => l.id);
  const textFieldById = {};
  for (const l of symbolLayers) {
    textFieldById[l.id] = (l.layout || {})['text-field'];
  }

  // ----- Hidden harvest map (full style, mercator, no terrain/sky) -----
  const host = document.createElement('div');
  host.className = 'world3d-label-harvest';
  host.style.cssText =
    'position:absolute;left:-10000px;top:0;width:1100px;height:760px;' +
    'pointer-events:none;visibility:hidden;';
  document.body.appendChild(host);

  const harvestStyle = JSON.parse(JSON.stringify(liveStyle));
  delete harvestStyle.terrain;
  delete harvestStyle.sky;
  harvestStyle.projection = { type: 'mercator' };

  const hmap = new ml.Map({
    container: host,
    style: harvestStyle,
    center: [31, 49],
    zoom: 5,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    preserveDrawingBuffer: false,
  });
  let harvestReady = false;
  hmap.once('load', () => {
    harvestReady = true;
    refreshSoon();
  });

  // ----- Cesium label collection ---------------------------------------
  // `scene` is REQUIRED when labels use heightReference CLAMP_TO_GROUND —
  // the clamping path reads scene.globe internally.
  const labels = viewer.scene.primitives.add(
    new Cesium.LabelCollection({ scene: viewer.scene }),
  );
  const DARK = Cesium.Color.fromCssColorString('#2A2A33');
  const HALO = Cesium.Color.WHITE.withAlpha(0.95);
  const WATER = Cesium.Color.fromCssColorString('#2C5C8A');

  // ----- Geographic bbox the camera is looking at ----------------------
  function viewBBox() {
    const scene = viewer.scene;
    const camera = viewer.camera;
    // Try the cheap path first.
    const rect = camera.computeViewRectangle(scene.globe.ellipsoid);
    if (rect) {
      return {
        w: Cesium.Math.toDegrees(rect.west),
        s: Cesium.Math.toDegrees(rect.south),
        e: Cesium.Math.toDegrees(rect.east),
        n: Cesium.Math.toDegrees(rect.north),
      };
    }
    // Oblique / horizon view: sample the globe across the viewport.
    const canvas = scene.canvas;
    const W = canvas.clientWidth || canvas.width;
    const H = canvas.clientHeight || canvas.height;
    const cols = 7;
    const rows = 6;
    let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90;
    let any = false;
    for (let r = 0; r < rows; r++) {
      // Bias sampling toward the lower part of the screen (ground, not sky).
      const fy = 0.15 + (0.85 * r) / (rows - 1);
      for (let c = 0; c < cols; c++) {
        const fx = c / (cols - 1);
        const win = new Cesium.Cartesian2(fx * W, fy * H);
        const ray = camera.getPickRay(win);
        if (!ray) continue;
        const pos = scene.globe.pick(ray, scene);
        if (!pos) continue;
        const carto = Cesium.Cartographic.fromCartesian(pos);
        const lng = Cesium.Math.toDegrees(carto.longitude);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
        any = true;
      }
    }
    if (!any) return null;
    return { w: minLng, s: minLat, e: maxLng, n: maxLat };
  }

  // ----- Harvest + sync -------------------------------------------------
  let busy = false;
  let queued = false;

  async function refresh() {
    if (!harvestReady) return;
    if (busy) {
      queued = true;
      return;
    }
    busy = true;
    try {
      const bbox = viewBBox();
      if (!bbox) return;
      const seen = new Map();

      const HW = 1100;
      const HH = 760;
      const widthDeg = Math.max(1e-4, bbox.e - bbox.w);
      const heightDeg = Math.max(1e-4, bbox.n - bbox.s);

      // Pick a harvest zoom that actually reveals peak/POI labels (they only
      // appear at higher zooms), then tile the visible bbox into a small grid
      // so we cover the whole view at that zoom. Cap the grid so we never run
      // away on huge oblique views.
      const zFitW = Math.log2((360 * HW) / (512 * widthDeg));
      let z = Math.max(7, Math.min(13, Math.round(zFitW) + 2));
      let cols, rows;
      for (;;) {
        const cellW = (360 * HW) / (512 * Math.pow(2, z)); // deg per viewport
        const cellH = (170 * HH) / (512 * Math.pow(2, z));
        cols = Math.max(1, Math.ceil(widthDeg / cellW));
        rows = Math.max(1, Math.ceil(heightDeg / cellH));
        if (cols * rows <= 12 || z <= 7) break;
        z -= 1;
      }
      const cellW = widthDeg / cols;
      const cellH = heightDeg / rows;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cLng = bbox.w + cellW * (c + 0.5);
          const cLat = bbox.s + cellH * (r + 0.5);
          hmap.jumpTo({ center: [cLng, cLat], zoom: z, bearing: 0, pitch: 0 });
          // eslint-disable-next-line no-await-in-loop
          await waitIdle(hmap, 3500);
          const feats = hmap.queryRenderedFeatures({ layers: symbolLayerIds });
          for (const f of feats) {
            if (!f.geometry || f.geometry.type !== 'Point') continue;
            const [lng, lat] = f.geometry.coordinates;
            const text = resolveText(textFieldById[f.layer.id], f.properties || {});
            if (!text) continue;
            const meta = classify(f);
            let label = text;
            if (meta.kind === 'peak' && meta.ele) {
              label = `${text}\n${Math.round(Number(meta.ele))} m`;
            }
            const key = `${label}@${lng.toFixed(3)},${lat.toFixed(3)}`;
            const prev = seen.get(key);
            if (!prev || meta.rank > prev.meta.rank) {
              seen.set(key, { lng, lat, label, meta });
            }
          }
        }
      }

      const list = Array.from(seen.values())
        .sort((a, b) => b.meta.rank - a.meta.rank)
        .slice(0, maxLabels);

      // Rebuild the label collection (small N, cheap).
      labels.removeAll();
      for (const item of list) {
        const isWater = item.meta.water;
        labels.add({
          position: Cesium.Cartesian3.fromDegrees(item.lng, item.lat),
          text: item.label,
          font: `600 ${item.meta.size}px "Inter","Helvetica Neue",Arial,sans-serif`,
          fillColor: isWater ? WATER : DARK,
          outlineColor: HALO,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: false,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          // Always crisp & on top — never clipped by the relief.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(1.0e3, 1.15, 6.0e5, 0.55),
          translucencyByDistance: new Cesium.NearFarScalar(3.0e5, 1.0, 1.2e6, 0.0),
        });
      }
      viewer.scene.requestRender();
    } catch {
      /* harvest failed — keep previous labels */
    } finally {
      busy = false;
      if (queued) {
        queued = false;
        refreshSoon();
      }
    }
  }

  let debounceTimer = null;
  function refreshSoon() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => refresh(), 250);
  }

  const removeCamListener = viewer.camera.changed.addEventListener(refreshSoon);
  viewer.camera.percentageChanged = 0.15;

  function destroy() {
    try {
      removeCamListener();
    } catch {
      /* noop */
    }
    clearTimeout(debounceTimer);
    try {
      if (!viewer.isDestroyed()) viewer.scene.primitives.remove(labels);
    } catch {
      /* noop */
    }
    try {
      hmap.remove();
    } catch {
      /* noop */
    }
    if (host.parentNode) host.parentNode.removeChild(host);
  }

  return { destroy, refresh };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function waitIdle(map, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      map.off('idle', onIdle);
      resolve();
    };
    const onIdle = () => finish();
    const t = setTimeout(finish, timeoutMs);
    map.on('idle', onIdle);
    map.triggerRepaint();
  });
}
