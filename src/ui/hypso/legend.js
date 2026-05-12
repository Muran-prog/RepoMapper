/**
 * Hypsometric legend — vertical gradient bar + elevation ticks + a
 * "you-are-here" cursor that tracks the live DEM elevation under the
 * pointer.
 *
 * Sits in the map canvas as a free-floating overlay, anchored to a
 * configurable corner (defaults to bottom-right). On phones / coarse
 * pointers we hide the you-are-here puck and just show the gradient
 * column so finger-pan UX isn't degraded.
 *
 * Collapse / expand
 * -----------------
 * The legend has a small header (title + chevron icon) that's always
 * visible. Clicking / tapping the header toggles a `data-collapsed`
 * attribute on the root, which CSS uses to slide the panel away —
 * leaving just the header pill as a compact handle on the canvas
 * corner. The collapsed state is persisted via `store.js::savePrefs`
 * so a reload brings back the same arrangement.
 *
 * The toggle is a proper <button> so screen-readers and keyboards
 * work. We carry `aria-expanded` + `aria-controls` for the
 * relationship between the header and the panel.
 *
 * Where the elevation comes from
 * ------------------------------
 * `map.queryTerrainElevation(lngLat)` is the canonical API in
 * MapLibre v5+. It walks the DEM source tiles and returns either a
 * finite number (sea level + above) or `null`/`NaN` when the DEM is
 * missing or the source hasn't loaded the relevant tile yet. We treat
 * non-finite values as "out of band" and dim the marker.
 *
 * Re-render triggers
 * ------------------
 *   • mousemove          → update cursor position + readout
 *   • cart:hypso event   → re-render the gradient (ramp/strength swap)
 *   • styledata          → refresh the gradient when a theme switch
 *                          rebuilds the style and changes light↔dark
 *
 * @typedef {object} LegendMountOpts
 * @property {maplibregl.Map} map
 * @property {HTMLElement} host        Container to render into.
 * @property {string} [position='br']  br | bl | tr | tl (corner anchor)
 * @property {boolean} [showCursor]    Default = !caps.isCoarse.
 * @property {Array<number>} [ticks]   Elevations to label (m).
 * @property {boolean} [defaultCollapsed=false]
 *           Initial state used when no persisted preference is found.
 */

import { rampToCssGradient } from '../../style/hypso/index.js';
import { loadPrefs, savePrefs } from './store.js';

const DEFAULT_TICKS = [-1000, -500, 0, 500, 1000, 1500, 2000];
const PANEL_ID = 'hypso-legend-panel';

/**
 * @param {LegendMountOpts} opts
 */
export function mountHypsoLegend(opts) {
  const {
    map,
    host,
    position = 'br',
    showCursor = true,
    ticks = DEFAULT_TICKS,
    defaultCollapsed = false,
  } = opts;
  if (!host) return { unmount: () => {} };

  // Resolve the initial collapsed state. Persisted prefs win over the
  // caller-supplied default so the user's last interaction sticks.
  const prefs = loadPrefs();
  const initiallyCollapsed = typeof prefs.legendCollapsed === 'boolean'
    ? prefs.legendCollapsed
    : defaultCollapsed;

  host.classList.add('hypso-legend-host');
  host.dataset.position = position;
  host.innerHTML = `
    <div
      class="hypso-legend"
      data-collapsed="${initiallyCollapsed ? 'true' : 'false'}"
      role="region"
      aria-label="Hypsometric legend"
    >
      <button
        class="hypso-legend-toggle"
        data-ctl="toggle"
        type="button"
        aria-controls="${PANEL_ID}"
        aria-expanded="${initiallyCollapsed ? 'false' : 'true'}"
      >
        <span class="hypso-legend-title">Висота</span>
        <svg class="hypso-legend-chev" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6 L8 10 L12 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div class="hypso-legend-panel" id="${PANEL_ID}" data-ctl="panel" aria-hidden="${initiallyCollapsed ? 'true' : 'false'}">
        <div class="hypso-legend-bar" data-ctl="bar"></div>
        <ul class="hypso-legend-ticks" data-ctl="ticks"></ul>
        <div class="hypso-legend-cursor" data-ctl="cursor" data-state="hidden">
          <span class="hypso-legend-arrow"></span>
          <span class="hypso-legend-readout" data-ctl="readout">— м</span>
        </div>
      </div>
    </div>
  `;

  const root = host.querySelector('.hypso-legend');
  const refs = {
    toggle: host.querySelector('[data-ctl=toggle]'),
    panel: host.querySelector('[data-ctl=panel]'),
    bar: host.querySelector('[data-ctl=bar]'),
    ticks: host.querySelector('[data-ctl=ticks]'),
    cursor: host.querySelector('[data-ctl=cursor]'),
    readout: host.querySelector('[data-ctl=readout]'),
  };

  // The y-axis range of the legend column. ticks outside this range
  // are clamped to the edges. Match the ramp data domain.
  const elevMin = -3000;
  const elevMax = 3000;
  const elevToPct = (e) => (1 - (Math.max(elevMin, Math.min(elevMax, e)) - elevMin) / (elevMax - elevMin)) * 100;

  const renderTicks = () => {
    refs.ticks.innerHTML = ticks
      .map((t) => `<li style="top:${elevToPct(t).toFixed(1)}%"><span>${formatMeters(t)}</span></li>`)
      .join('');
  };

  const renderGradient = () => {
    const cart = map._cart ?? {};
    const rampId = cart.hypso?.rampId;
    const theme = cart.theme ?? 'light';
    if (!rampId) {
      refs.bar.style.background = 'transparent';
      return;
    }
    // We render the bar in the user's CURRENT theme so it matches the
    // map. Note: the bar uses native CSS gradient, which is linear-RGB.
    // The map itself uses LAB-densified stops for perceptual uniformity;
    // the cosmetic mismatch is acceptable in a legend.
    refs.bar.style.background = rampToCssGradient(rampId, theme);
  };

  renderTicks();
  renderGradient();

  // -----------------------------------------------------------------
  // Collapse / expand toggle. Pure attribute flip — CSS does the rest.
  // -----------------------------------------------------------------
  const setCollapsed = (collapsed, { persist = true } = {}) => {
    root.dataset.collapsed = collapsed ? 'true' : 'false';
    refs.toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    refs.panel.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    if (persist) savePrefs({ legendCollapsed: collapsed });
  };
  refs.toggle.addEventListener('click', () => {
    setCollapsed(root.dataset.collapsed !== 'true');
  });

  // -----------------------------------------------------------------
  // Re-render on cart:hypso events and on styledata.
  // -----------------------------------------------------------------
  const onHypsoChange = () => renderGradient();
  const onStyleData = () => renderGradient();
  map.getContainer?.()?.addEventListener?.('cart:hypso', onHypsoChange);
  window.addEventListener('cart:hypso', onHypsoChange);
  map.on('styledata', onStyleData);

  // -----------------------------------------------------------------
  // "You-are-here" cursor — only if showCursor and queryTerrainElevation
  // is exposed by the runtime. We hide it while collapsed so it doesn't
  // animate a phantom track behind a closed panel.
  // -----------------------------------------------------------------
  let onMouseMove = null;
  if (showCursor) {
    onMouseMove = (e) => {
      if (root.dataset.collapsed === 'true') {
        refs.cursor.dataset.state = 'hidden';
        return;
      }
      const elev = sampleElevation(map, e.lngLat);
      if (elev == null || !Number.isFinite(elev)) {
        refs.cursor.dataset.state = 'hidden';
        refs.readout.textContent = '— м';
        return;
      }
      refs.cursor.dataset.state = 'shown';
      refs.cursor.style.top = `${elevToPct(elev).toFixed(2)}%`;
      refs.readout.textContent = formatMeters(elev);
    };
    map.on('mousemove', onMouseMove);
  }

  return {
    refresh: renderGradient,
    setCollapsed(collapsed) {
      setCollapsed(!!collapsed);
    },
    unmount() {
      map.getContainer?.()?.removeEventListener?.('cart:hypso', onHypsoChange);
      window.removeEventListener('cart:hypso', onHypsoChange);
      map.off('styledata', onStyleData);
      if (onMouseMove) map.off('mousemove', onMouseMove);
      host.innerHTML = '';
      host.classList.remove('hypso-legend-host');
    },
  };
}

function sampleElevation(map, lngLat) {
  if (!lngLat || typeof map.queryTerrainElevation !== 'function') return null;
  try {
    return map.queryTerrainElevation(lngLat);
  } catch {
    return null;
  }
}

function formatMeters(e) {
  return `${Math.round(e).toLocaleString('uk-UA')} м`;
}
