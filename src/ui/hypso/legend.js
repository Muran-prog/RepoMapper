/**
 * Hypsometric legend — premium floating widget.
 *
 * Visual layout (anchored bottom-right by default):
 *
 *   ┌──────────────────────────┐
 *   │  ▓  ─ 2000               │  ← gradient column + tick + label
 *   │  ▓  ─ 1500               │
 *   │  ▓  ━━━ 1842 м (cursor)  │  ← live "you-are-here" marker
 *   │  ▓  ─ 1000               │
 *   │  ▓  ─    500             │
 *   │  ▓  ─      0             │
 *   │  ▓  ─  -500              │
 *   │  ▓  ─ -1000              │
 *   ├──────────────────────────┤
 *   │ ▎ Висота               ⌃ │  ← toggle pill (always visible)
 *   └──────────────────────────┘
 *
 * The toggle pill is rendered AFTER the panel in DOM order; CSS flex
 * direction places it visually beneath the panel for bottom-anchored
 * positions (br / bl) and above for top-anchored (tr / tl), so the
 * pill always sits adjacent to the screen edge.
 *
 * Cursor
 * ------
 * On hover-capable pointers, `mousemove` events on the map drive a
 * floating accent marker on the gradient at the current elevation,
 * with a pill showing the exact value. The cursor is hidden when:
 *   • the legend is collapsed
 *   • the DEM under the pointer is missing / invalid
 *   • the pointer leaves the canvas
 *
 * Persistence
 * -----------
 * Collapse state survives reload via `store.js::savePrefs`.
 *
 * @typedef {object} LegendMountOpts
 * @property {maplibregl.Map} map
 * @property {HTMLElement} host        Container to render into.
 * @property {string} [position='br']  br | bl | tr | tl (corner anchor)
 * @property {boolean} [showCursor]    Default = true.
 * @property {Array<number>} [ticks]   Elevations to label (m).
 * @property {boolean} [defaultCollapsed=false]
 */

import { rampToCssGradient } from '../../style/hypso/index.js';
import { loadPrefs, savePrefs } from './store.js';

const DEFAULT_TICKS = [-1000, 0, 500, 1000, 1500, 2000];
const PANEL_ID = 'hypso-legend-panel';

/** The y-axis range of the legend column. Ticks outside this range
 *  are clamped to the edges; matches the ramp data domain. */
const ELEV_MIN = -3000;
const ELEV_MAX = 3000;
const elevToPct = (e) =>
  (1 - (Math.max(ELEV_MIN, Math.min(ELEV_MAX, e)) - ELEV_MIN) / (ELEV_MAX - ELEV_MIN)) * 100;

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

  const prefs = loadPrefs();
  const initiallyCollapsed =
    typeof prefs.legendCollapsed === 'boolean' ? prefs.legendCollapsed : defaultCollapsed;

  host.classList.add('hypso-legend-host');
  host.dataset.position = position;
  // Markup: square icon-toggle (40 px, MapLibre control family) + a
  // panel that slides out alongside it. The panel carries its own
  // "Висота · м" header so the toggle reads as a pure icon-pill.
  host.innerHTML = `
    <section
      class="hypso-legend"
      data-collapsed="${initiallyCollapsed ? 'true' : 'false'}"
      role="region"
      aria-label="Легенда висот"
    >
      <div class="hypso-legend-panel" id="${PANEL_ID}" data-ctl="panel"
           aria-hidden="${initiallyCollapsed ? 'true' : 'false'}">
        <header class="hypso-legend-head">
          <span class="hypso-legend-title">Висота</span>
          <span class="hypso-legend-unit">м</span>
        </header>
        <div class="hypso-legend-track">
          <div class="hypso-legend-bar" data-ctl="bar" aria-hidden="true"></div>
          <ul class="hypso-legend-ticks" data-ctl="ticks" aria-hidden="true"></ul>
          <div class="hypso-legend-cursor" data-ctl="cursor" data-state="hidden" aria-hidden="true">
            <span class="hypso-legend-cursor-mark"></span>
            <span class="hypso-legend-cursor-pill" data-ctl="readout">
              <strong>—</strong><small>м</small>
            </span>
          </div>
        </div>
      </div>
      <button
        class="hypso-legend-toggle"
        data-ctl="toggle"
        type="button"
        aria-controls="${PANEL_ID}"
        aria-expanded="${initiallyCollapsed ? 'false' : 'true'}"
        aria-label="Висота — легенда"
        title="Висота"
      >
        <span class="hypso-legend-glyph" aria-hidden="true" data-ctl="glyph"></span>
      </button>
    </section>
  `;

  const root = host.querySelector('.hypso-legend');
  const refs = {
    toggle: host.querySelector('[data-ctl=toggle]'),
    panel: host.querySelector('[data-ctl=panel]'),
    bar: host.querySelector('[data-ctl=bar]'),
    glyph: host.querySelector('[data-ctl=glyph]'),
    ticks: host.querySelector('[data-ctl=ticks]'),
    cursor: host.querySelector('[data-ctl=cursor]'),
    readout: host.querySelector('[data-ctl=readout]'),
  };

  // ------------------------------------------------------------------
  // Render: ticks + gradient bar + toggle glyph.
  // ------------------------------------------------------------------
  const renderTicks = () => {
    refs.ticks.innerHTML = ticks
      .map((t) => `<li style="--p:${elevToPct(t).toFixed(2)}%"><span>${formatTick(t)}</span></li>`)
      .join('');
  };

  const renderGradient = () => {
    const cart = map._cart ?? {};
    const rampId = cart.hypso?.rampId;
    const theme = cart.theme ?? 'light';
    if (!rampId) {
      refs.bar.style.background = 'transparent';
      if (refs.glyph) refs.glyph.style.background = 'transparent';
      return;
    }
    const gradient = rampToCssGradient(rampId, theme);
    // The bar uses a linear-RGB CSS gradient; the map itself uses
    // LAB-densified stops for perceptual uniformity. The cosmetic
    // mismatch is acceptable in a legend.
    refs.bar.style.background = gradient;
    // The toggle glyph mirrors the gradient as a tiny preview swatch.
    if (refs.glyph) refs.glyph.style.background = gradient;
  };

  renderTicks();
  renderGradient();

  // ------------------------------------------------------------------
  // Collapse / expand.
  // ------------------------------------------------------------------
  const setCollapsed = (collapsed, { persist = true } = {}) => {
    root.dataset.collapsed = collapsed ? 'true' : 'false';
    refs.toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    refs.panel.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    if (collapsed && refs.cursor) refs.cursor.dataset.state = 'hidden';
    if (persist) savePrefs({ legendCollapsed: collapsed });
  };
  refs.toggle.addEventListener('click', () => {
    setCollapsed(root.dataset.collapsed !== 'true');
  });

  // ------------------------------------------------------------------
  // Re-render on ramp/theme changes.
  // ------------------------------------------------------------------
  const onHypsoChange = () => renderGradient();
  const onStyleData = () => renderGradient();
  map.getContainer?.()?.addEventListener?.('cart:hypso', onHypsoChange);
  window.addEventListener('cart:hypso', onHypsoChange);
  map.on('styledata', onStyleData);

  // ------------------------------------------------------------------
  // "You-are-here" cursor — live elevation under the mouse.
  // ------------------------------------------------------------------
  let onMouseMove = null;
  let onMouseLeave = null;
  if (showCursor) {
    onMouseMove = (e) => {
      if (root.dataset.collapsed === 'true') return;
      const elev = sampleElevation(map, e.lngLat);
      if (elev == null || !Number.isFinite(elev)) {
        refs.cursor.dataset.state = 'hidden';
        return;
      }
      refs.cursor.dataset.state = 'shown';
      refs.cursor.style.setProperty('--p', `${elevToPct(elev).toFixed(2)}%`);
      if (refs.readout) {
        refs.readout.innerHTML = `<strong>${Math.round(elev).toLocaleString('uk-UA')}</strong><small>м</small>`;
      }
    };
    onMouseLeave = () => {
      if (refs.cursor) refs.cursor.dataset.state = 'hidden';
    };
    map.on('mousemove', onMouseMove);
    map.on('mouseout', onMouseLeave);
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
      if (onMouseLeave) map.off('mouseout', onMouseLeave);
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

/** Compact tick label — no "м" suffix (the legend's unit is in the
 *  header pill). Use thin-space thousands grouping. */
function formatTick(e) {
  return Math.round(e).toLocaleString('uk-UA');
}
