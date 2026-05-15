/**
 * Elevation profile mode.
 *
 * Activated by clicking the "Profile" button in the picker. While
 * active, the user draws a polyline by clicking the map; each click
 * adds a vertex. Pressing Enter (or clicking the same point twice)
 * finalises the line and renders a chart of elevation vs distance.
 *
 * Sampling
 * --------
 * Between every pair of vertices we walk the great-circle ground line
 * at a target spacing of ~150 m and call `map.queryTerrainElevation`
 * for each step. The result is a `{distance, elevation, lngLat}`
 * series that drives:
 *
 *   • The chart        — pure-DOM SVG; no Chart.js dep.
 *   • A tooltip puck    — follows the cursor over the chart and
 *                         highlights the matching map vertex via a
 *                         CustomEvent the picker can listen to.
 *   • Export            — CSV download of the same series.
 *
 * Reduced motion
 * --------------
 * The user can still draw a profile, but the drawing layer is rendered
 * without animation. Tooltip follow stays — it's not motion sensitive
 * (it's discrete + pointer-driven).
 *
 * @typedef {object} ProfileSample
 * @property {number} distance_m       Cumulative distance along the path.
 * @property {number|null} elevation_m
 * @property {{lng:number, lat:number}} lngLat
 */

import { applyHypsoStrength } from '../../style/hypso/index.js';

const SAMPLE_STEP_M = 150;

/**
 * @typedef {object} ProfileMountOpts
 * @property {maplibregl.Map} map
 * @property {HTMLElement} host
 * @property {function():void} [onExit]
 * @property {boolean} [reduceMotion]
 */

/**
 * Mount the profile mode. Returns an imperative handle.
 *
 * @param {ProfileMountOpts} opts
 */
export function mountHypsoProfile(opts) {
  const { map, host, reduceMotion = false } = opts;

  /** @type {Array<{lng:number, lat:number}>} */
  let vertices = [];
  /** @type {Array<ProfileSample>} */
  let samples = [];
  let drawing = true;

  host.innerHTML = `
    <div class="hypso-profile" role="dialog" aria-label="Профиль высот">
      <header class="hypso-profile-head">
        <h3>Профиль высот</h3>
        <span class="hypso-profile-hint">Кликайте по карте, чтобы добавить точки · Enter — завершить · Esc — выйти</span>
        <button data-ctl="exit" type="button" aria-label="Закрыть">×</button>
      </header>
      <div class="hypso-profile-chart" data-ctl="chart" data-state="empty"></div>
      <div class="hypso-profile-stats">
        <span data-ctl="stat-len">— м</span>
        <span data-ctl="stat-min">— м</span>
        <span data-ctl="stat-max">— м</span>
        <span data-ctl="stat-gain">↑ — м</span>
      </div>
      <div class="hypso-profile-actions">
        <button data-ctl="clear" type="button">Очистить</button>
        <button data-ctl="csv" type="button" disabled>Экспорт CSV</button>
      </div>
    </div>
  `;

  const refs = {
    exit: host.querySelector('[data-ctl=exit]'),
    chart: host.querySelector('[data-ctl=chart]'),
    statLen: host.querySelector('[data-ctl=stat-len]'),
    statMin: host.querySelector('[data-ctl=stat-min]'),
    statMax: host.querySelector('[data-ctl=stat-max]'),
    statGain: host.querySelector('[data-ctl=stat-gain]'),
    clear: host.querySelector('[data-ctl=clear]'),
    csv: host.querySelector('[data-ctl=csv]'),
  };

  // -----------------------------------------------------------------
  // Drawing overlay — a GeoJSON LineString source + two layers (line
  // + vertex circles).
  // -----------------------------------------------------------------
  const SRC = '__hypso_profile_src__';
  const LINE_LAYER = '__hypso_profile_line__';
  const VTX_LAYER = '__hypso_profile_vtx__';

  ensureDrawingLayers(map, SRC, LINE_LAYER, VTX_LAYER);

  const onClick = (e) => {
    if (!drawing) return;
    vertices.push({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    updateDrawing();
  };
  const onDblClick = () => finalize();
  const onKey = (e) => {
    if (e.key === 'Enter') finalize();
    else if (e.key === 'Escape') exit();
  };

  map.on('click', onClick);
  map.on('dblclick', onDblClick);
  window.addEventListener('keydown', onKey);

  refs.exit.addEventListener('click', exit);
  refs.clear.addEventListener('click', clearAll);
  refs.csv.addEventListener('click', exportCsv);

  const finalize = () => {
    if (vertices.length < 2) return;
    drawing = false;
    samples = sampleAlongPath(map, vertices);
    renderChart();
  };

  const clearAll = () => {
    vertices = [];
    samples = [];
    drawing = true;
    refs.chart.innerHTML = '';
    refs.chart.dataset.state = 'empty';
    refs.statLen.textContent = '— м';
    refs.statMin.textContent = '— м';
    refs.statMax.textContent = '— м';
    refs.statGain.textContent = '↑ — м';
    refs.csv.disabled = true;
    updateDrawing();
  };

  function updateDrawing() {
    setSourceData(map, SRC, vertices);
  }

  function renderChart() {
    if (samples.length < 2) {
      refs.chart.dataset.state = 'empty';
      refs.chart.innerHTML = '';
      refs.csv.disabled = true;
      return;
    }
    const elevs = samples.map((s) => s.elevation_m).filter((e) => e != null);
    if (elevs.length < 2) {
      refs.chart.dataset.state = 'noelev';
      refs.chart.innerHTML = `<div class="hypso-profile-msg">Для этого региона DEM недоступен.</div>`;
      refs.csv.disabled = true;
      return;
    }
    const minE = Math.min(...elevs);
    const maxE = Math.max(...elevs);
    const totalDist = samples[samples.length - 1].distance_m;

    const w = 320; // viewBox width
    const h = 110; // viewBox height
    const padL = 30;
    const padR = 6;
    const padT = 6;
    const padB = 16;

    const xs = samples.map((s) => padL + (s.distance_m / totalDist) * (w - padL - padR));
    const ys = samples.map((s) =>
      s.elevation_m == null
        ? null
        : padT + (1 - (s.elevation_m - minE) / Math.max(1e-6, maxE - minE)) * (h - padT - padB),
    );

    // Build a polyline path string; gaps are emitted as line breaks.
    let d = '';
    let lifted = true;
    for (let i = 0; i < samples.length; i++) {
      const y = ys[i];
      if (y == null) {
        lifted = true;
        continue;
      }
      d += `${lifted ? 'M' : 'L'} ${xs[i].toFixed(2)} ${y.toFixed(2)} `;
      lifted = false;
    }

    refs.chart.dataset.state = 'shown';
    refs.chart.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" class="hypso-profile-svg">
        <rect x="${padL}" y="${padT}" width="${w - padL - padR}" height="${h - padT - padB}" class="hypso-profile-frame"/>
        <text x="2" y="${padT + 8}" class="hypso-profile-y-tick">${Math.round(maxE)}</text>
        <text x="2" y="${h - padB - 2}" class="hypso-profile-y-tick">${Math.round(minE)}</text>
        <text x="${padL}" y="${h - 2}" class="hypso-profile-x-tick">0</text>
        <text x="${w - padR}" y="${h - 2}" class="hypso-profile-x-tick" text-anchor="end">${formatDist(totalDist)}</text>
        <path d="${d}" class="hypso-profile-line"/>
        <line data-ctl="cursor-line" x1="-10" y1="${padT}" x2="-10" y2="${h - padB}" class="hypso-profile-cursor"/>
        <circle data-ctl="cursor-dot" cx="-10" cy="-10" r="3.5" class="hypso-profile-dot"/>
      </svg>
      <div class="hypso-profile-tooltip" data-ctl="tt" data-state="hidden">— м · — м</div>
    `;
    refs.csv.disabled = false;

    refs.statLen.textContent = formatDist(totalDist);
    refs.statMin.textContent = `${Math.round(minE)} м`;
    refs.statMax.textContent = `${Math.round(maxE)} м`;
    refs.statGain.textContent = `↑ ${Math.round(elevationGain(samples))} м`;

    // Wire tooltip / cursor follow.
    const svg = refs.chart.querySelector('svg');
    const cursorLine = svg.querySelector('[data-ctl=cursor-line]');
    const cursorDot = svg.querySelector('[data-ctl=cursor-dot]');
    const tt = refs.chart.querySelector('[data-ctl=tt]');

    svg.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const tX = ((e.clientX - rect.left) / rect.width) * w;
      // Map pixelX → sample index.
      const t = Math.max(0, Math.min(1, (tX - padL) / (w - padL - padR)));
      const i = Math.min(samples.length - 1, Math.max(0, Math.round(t * (samples.length - 1))));
      const s = samples[i];
      if (s.elevation_m == null) {
        tt.dataset.state = 'hidden';
        return;
      }
      cursorLine.setAttribute('x1', xs[i]);
      cursorLine.setAttribute('x2', xs[i]);
      cursorDot.setAttribute('cx', xs[i]);
      cursorDot.setAttribute('cy', ys[i]);
      tt.dataset.state = 'shown';
      tt.style.left = `${(xs[i] / w) * 100}%`;
      tt.textContent = `${Math.round(s.elevation_m)} м · ${formatDist(s.distance_m)}`;
      // Notify the map so other modules can highlight the cursor position.
      window.dispatchEvent(new CustomEvent('cart:hypso:profileCursor', { detail: { lngLat: s.lngLat } }));
    });
    svg.addEventListener('pointerleave', () => {
      tt.dataset.state = 'hidden';
    });
  }

  function exportCsv() {
    const header = 'distance_m,elevation_m,longitude,latitude\n';
    const lines = samples.map(
      (s) =>
        `${s.distance_m.toFixed(2)},${s.elevation_m ?? ''},${s.lngLat.lng.toFixed(6)},${s.lngLat.lat.toFixed(6)}`,
    );
    const blob = new Blob([header + lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cart-profile-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exit() {
    map.off('click', onClick);
    map.off('dblclick', onDblClick);
    window.removeEventListener('keydown', onKey);
    removeDrawingLayers(map, SRC, LINE_LAYER, VTX_LAYER);
    host.innerHTML = '';
    opts.onExit?.();
  }

  // reduce-motion: nothing motion-y to disable here. Hook kept for future tuning.
  void reduceMotion;
  void applyHypsoStrength;

  return { unmount: exit, clear: clearAll };
}

// ---------------------------------------------------------------------
// MapLibre drawing layer management
// ---------------------------------------------------------------------

function ensureDrawingLayers(map, srcId, lineLayerId, vtxLayerId) {
  if (!map.getSource(srcId)) {
    map.addSource(srcId, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }
  if (!map.getLayer(lineLayerId)) {
    map.addLayer({
      id: lineLayerId,
      type: 'line',
      source: srcId,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: {
        'line-color': '#d97706',
        'line-width': 3,
        'line-opacity': 0.85,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
  }
  if (!map.getLayer(vtxLayerId)) {
    map.addLayer({
      id: vtxLayerId,
      type: 'circle',
      source: srcId,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#fff',
        'circle-stroke-color': '#d97706',
        'circle-stroke-width': 2,
      },
    });
  }
}

function removeDrawingLayers(map, srcId, ...layerIds) {
  for (const id of layerIds) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(srcId)) map.removeSource(srcId);
}

function setSourceData(map, srcId, vertices) {
  const src = map.getSource(srcId);
  if (!src) return;
  const points = vertices.map((v) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
  }));
  const features = [...points];
  if (vertices.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: vertices.map((v) => [v.lng, v.lat]) },
    });
  }
  src.setData({ type: 'FeatureCollection', features });
}

// ---------------------------------------------------------------------
// Path sampling
// ---------------------------------------------------------------------

/**
 * Walk every segment of the user-drawn polyline at ~SAMPLE_STEP_M
 * spacing and sample DEM elevation at each step. Cheap and accurate
 * enough for the chart — the DEM resolution itself is the lower bound.
 *
 * @param {maplibregl.Map} map
 * @param {Array<{lng:number, lat:number}>} vertices
 * @returns {Array<ProfileSample>}
 */
function sampleAlongPath(map, vertices) {
  if (vertices.length < 2) return [];
  const out = [];
  let cumDist = 0;
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i];
    const b = vertices[i + 1];
    const segDist = haversine(a, b);
    const steps = Math.max(2, Math.ceil(segDist / SAMPLE_STEP_M));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const lng = a.lng + (b.lng - a.lng) * t;
      const lat = a.lat + (b.lat - a.lat) * t;
      const dist = cumDist + segDist * t;
      out.push({
        distance_m: dist,
        elevation_m: queryElev(map, lng, lat),
        lngLat: { lng, lat },
      });
    }
    cumDist += segDist;
  }
  // Tail vertex.
  const last = vertices[vertices.length - 1];
  out.push({
    distance_m: cumDist,
    elevation_m: queryElev(map, last.lng, last.lat),
    lngLat: { lng: last.lng, lat: last.lat },
  });
  return out;
}

function queryElev(map, lng, lat) {
  if (typeof map.queryTerrainElevation !== 'function') return null;
  try {
    return map.queryTerrainElevation({ lng, lat });
  } catch {
    return null;
  }
}

function haversine(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function elevationGain(samples) {
  let gain = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].elevation_m;
    const b = samples[i].elevation_m;
    if (a != null && b != null && b > a) gain += b - a;
  }
  return gain;
}

function formatDist(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} км`;
  return `${Math.round(m)} м`;
}
