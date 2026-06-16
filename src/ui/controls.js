/**
 * UI controls — dock + popover panels.
 *
 * The redesigned shell promotes the map to a fullscreen canvas. All UI
 * surfaces float on top as small glass-morphism components:
 *
 *   • Brand chip (top-left)         — logo + product name
 *   • Floating dock (left edge)     — five icon buttons + theme toggle
 *   • Popover panels (next to dock) — one per dock button; small,
 *                                     animated, focus-trapped
 *   • HUD pill (bottom-left)        — FPS / Zoom / Tiles / coords
 *
 * Each dock icon toggles its panel via a tiny controller that handles
 * keyboard (Esc, Tab), outside-pointer dismissal, and scrim sync on
 * mobile bottom-sheet form. The same DOM is used at every breakpoint;
 * CSS swaps between popover and bottom-sheet visuals.
 *
 * Panel inventory:
 *   layers   — base layers (labels, POIs, 3D buildings)
 *   relief   — relief stack + exaggeration slider
 *   hypso    — hypsometric subsystem (ramp picker + stats + profile)
 *   places   — fly-to presets (cities + Carpathian peaks)
 *   settings — quality picker + tips + meta
 *
 * Theme toggle lives as a sun/moon button at the bottom of the dock.
 */

import { applyStyle, applyMapMode } from '../map/createMap.js';
import { flyToPreset, setUserExaggeration } from '../map/interactions.js';
import { getProfileConfig } from '../device.js';
import { FEATURES, DEFAULT_THEME, MAP_MODES, DEFAULT_MAP_MODE } from '../config.js';
import { mountHypsoUI } from './hypso/index.js';
import { loadUiPrefs, saveUiPrefs, loadMapMode } from './store.js';
import { mountModeSwitcher } from './mode-switcher.js';
import { createDrawEngine } from '../draw/index.js';
import { renderDrawPanelBody, mountDrawPanel } from './draw/panel.js';
import {
  renderContourPanelBody,
  mountContourPanel,
} from './settlement-contours/panel.js';
import { createSettlementContourEngine } from '../draw/settlement-contours.js';
import { DRAW_ICONS } from './draw/icons.js';
import { mountMeasureTooltip } from './draw/tooltip.js';
import { mountLineActionTooltip } from './draw/line-action.js';
import { mountInfoTips } from './info-tip.js';
import { mountSettingsSearch } from './settings-search.js';
import { accordionMarkup, installAccordions, revealRow } from './accordion.js';
import { richRow, groupNote, sectionLede, divider, SETTING_ICONS } from './setting-icons.js';
import { renderDataPanelBody, mountDataPanel, collectLocalState } from './data-panel.js';
import { debouncedSave, onSyncEvent, loadFromServer } from '../api/client.js';

// ---------------------------------------------------------------------------
// Icon SVGs — Lucide-style line icons. Single-stroke, 1.75 width, rounded
// caps. Inlined as template strings so we keep the no-bundler footprint
// minimal and don't need a sprite sheet.
// ---------------------------------------------------------------------------

const ICONS = {
  layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 L21 8 L12 13 L3 8 Z"/><path d="M3 17 L12 22 L21 17"/><path d="M3 12.5 L12 17.5 L21 12.5"/></svg>`,
  mountain: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20 L9.5 9 L13 14.5 L17 7 L21 20 Z"/><circle cx="17" cy="5.4" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  waves: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7 Q 7.5 4 12 7 T 21 7"/><path d="M3 12 Q 7.5 9 12 12 T 21 12"/><path d="M3 17 Q 7.5 14 12 17 T 21 17"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22 S 5 14.5 5 9.5 a7 7 0 0 1 14 0 c0 5 -7 12.5 -7 12.5 z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`,
  // Pencil-on-map glyph that anchors the drawing-engine dock entry. Same
  // 1.75-stroke vocabulary as the rest of the bar so the new button reads
  // as a peer rather than an alien addition.
  draw: DRAW_ICONS.dock,
  contour: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9 L9 4 L16 5 L20 11 L17 19 L8 20 L4 14 Z"/><circle cx="5" cy="9" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="5" r="1.3" fill="currentColor" stroke="none"/><circle cx="20" cy="11" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="20" r="1.3" fill="currentColor" stroke="none"/></svg>`,
  // Two-tree landcover glyph used by the WorldCover relief toggle. Same
  // 1.75-stroke vocabulary as the rest of the relief icons so the row
  // reads as a peer of the hillshade / hypso / texture toggles.
  landcover: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 16 L8.5 8 L12 16 Z"/><line x1="8.5" y1="16" x2="8.5" y2="19"/><path d="M13 16 L16.5 6 L20 16 Z"/><line x1="16.5" y1="16" x2="16.5" y2="19"/></svg>`,
  // Single tall conifer glyph for the Canopy Height toggle. The shape
  // reads as "one tall spruce = canopy top height" — visually distinct
  // from the two-tree biom glyph so users can tell the two relief
  // toggles apart at a glance. Slightly narrower silhouette + taller
  // crown communicates "height" rather than "land class".
  canopy: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 L8 9 L10 9 L7 13.5 L9.5 13.5 L6 18 L18 18 L14.5 13.5 L17 13.5 L14 9 L16 9 Z"/><line x1="12" y1="18" x2="12" y2="21"/></svg>`,
  // Two-trees-side-by-side glyph for the Forest leaf-type toggle: a
  // triangular conifer LEFT + a round broadleaf RIGHT, communicating
  // "хвойний / листяний / мішаний ліс" at a glance. Distinct from
  // the WorldCover landcover glyph (two CONIFERS) and the canopy
  // glyph (single tall conifer), so the three forest-related toggles
  // remain visually unambiguous.
  forestLeaf: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 17 L9 8 L12 17 Z"/><line x1="9" y1="17" x2="9" y2="20"/><circle cx="16" cy="12" r="4"/><line x1="16" y1="16" x2="16" y2="20"/></svg>`,
  // FILLED two-conifer glyph for the Forest-cover overlay toggle. Unlike
  // the outline-only `landcover` (WorldCover) and `forestLeaf` glyphs, the
  // solid fill communicates "paint the whole forest mass green" — the
  // Google-Earth-style highlight this overlay produces — so the three
  // forest-related toggles stay visually distinct at a glance.
  forestCover: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M5 15 L8 8 L11 15 Z"/><rect x="7.4" y="15" width="1.2" height="3.2" stroke="none"/><path d="M13 16 L16.5 7 L20 16 Z"/><rect x="15.9" y="16" width="1.2" height="3.2" stroke="none"/></svg>`,
  // Mountain-with-warning glyph for the Hazardous-terrain toggle:
  // a sharp peak silhouette with an exclamation mark inside, calling
  // out "danger / hard-to-reach". Keeps the same single-stroke
  // 1.75-width vocabulary as every other relief glyph so the row
  // reads as a peer of the slope-warning / hillshade / hypso toggles.
  hazard: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20 L10 7 L13 12 L16 8 L21 20 Z"/><line x1="12" y1="13" x2="12" y2="17"/><circle cx="12" cy="19" r="0.6" fill="currentColor"/></svg>`,
  database: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>`,
  sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="15" cy="7" r="2.5"/><circle cx="9" cy="17" r="2.5"/></svg>`,
  // Magnifier glyph for the settings-search panel. Square block vocabulary
  // (sharp corners) to match the redesigned block UI.
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><line x1="16" y1="16" x2="21" y2="21"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2.5" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="21.5" y2="12"/><line x1="5.1" y1="5.1" x2="6.5" y2="6.5"/><line x1="17.5" y1="17.5" x2="18.9" y2="18.9"/><line x1="5.1" y1="18.9" x2="6.5" y2="17.5"/><line x1="17.5" y1="6.5" x2="18.9" y2="5.1"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8 A9 9 0 1 1 11.2 3 a7 7 0 0 0 9.8 9.8 z"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6.5" y1="6.5" x2="17.5" y2="17.5"/><line x1="6.5" y1="17.5" x2="17.5" y2="6.5"/></svg>`,
  brand: `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M6 17 L13 23 L26 9" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 11 L12 3.5 L21 11 V20 H3 Z" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 20 V14 H14.5 V20" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // 7-dot "more" glyph used by the MapLibre-controls collapse anchor.
  // Single-stroke chevron pair so it reads as "reveal a stack".
  controlsChev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9 L12 14 L17 9"/><path d="M7 15 L12 20 L17 15" opacity="0.5"/></svg>`,
  // Single chevron — rotated by CSS to point up/down for the collapse
  // toggle on the base-map block.
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9 L12 15 L18 9"/></svg>`,
  // "Pop out" glyph — a square with an arrow leaving its top-right
  // corner. Used by the detach button that ejects the base-map block
  // into a floating rail control.
  detach: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 4 H20 V11"/><path d="M20 4 L11 13"/><path d="M18 14 V19 a1 1 0 0 1 -1 1 H5 a1 1 0 0 1 -1 -1 V7 a1 1 0 0 1 1 -1 H10"/></svg>`,
  // "Dock back" glyph — an arrow pointing into a panel on the left.
  // Used by the re-dock button when the block is detached.
  dockBack: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="7" height="16" rx="1"/><path d="M21 12 H10"/><path d="M14 8 L10 12 L14 16"/></svg>`,
  // Stacked-maps glyph for the floating rail button (detached mode).
  mapStack: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 L21 7.5 L12 12 L3 7.5 Z"/><path d="M3 12.5 L12 17 L21 12.5"/></svg>`,
};

// ---------------------------------------------------------------------------
// Persisted feature flags.
//
// Most relief feature flags are device-profile-driven and reset to
// FEATURES defaults on every cold boot. The Land cover overlay is
// special: the operator points TERRAIN.worldcover.url at a hosted
// archive once and then the user's on/off choice should survive a
// reload (otherwise the toggle reads as "off by default" forever
// even after they enable it). Stored under a per-feature key so we
// can grow the set without churning the schema of `cart:ui:prefs:v1`.
//
// Canopy height shares the same lifecycle reasoning: once an
// operator wires the URL up, the user's choice should outlive the
// page. Both keys live under `cart:features:*` for consistency.
// ---------------------------------------------------------------------------

const WORLDCOVER_TINT_PREF_KEY = 'cart:features:worldcoverTint';
const CANOPY_HEIGHT_TINT_PREF_KEY = 'cart:features:canopyHeightTint';
// Base-map block view mode — how the "Базовая карта" chooser is presented:
//   'expanded'  — full card list inside the sidebar (default)
//   'collapsed' — heading only; cards hidden behind the chevron
//   'detached'  — block removed from the sidebar, shown as a floating
//                 rail button + popover instead.
const MODE_BLOCK_VIEW_PREF_KEY = 'cart:ui:modeBlockView';
const MODE_BLOCK_VIEWS = ['expanded', 'collapsed', 'detached'];
// Forest leaf-type biom polygons share the same lifecycle as the two
// raster relief overlays above: the operator rebuilds and re-uploads
// carpathian-osm.pmtiles once, then the user's on/off choice should
// outlive the page. Stored under the same `cart:features:*` namespace
// so the persistence shape stays consistent.
const FOREST_LEAF_TYPE_PREF_KEY = 'cart:features:forestLeafType';
// Forest-cover overlay (vivid green highlight of every wooded polygon).
// Pure stylistic preference with no operator-side data, but we still
// persist it so a user who turns this Google-Earth-style overlay ON sees
// it survive a reload — same `cart:features:*` namespace as the rest.
const FOREST_COVER_PREF_KEY = 'cart:features:forestCover';
// Hazardous-terrain overlay (extreme peaks, cliffs, dangerous passes).
// Defaults to ON and the user choice persists so a user who turns the
// "danger" markers off doesn't see them re-appear after every reload.
const HAZARDOUS_TERRAIN_PREF_KEY = 'cart:features:hazardousTerrain';
// Carpathian trail web (the bold red trail lines) — default ON; the user's
// "off" choice must outlive the page like the other operator-hosted overlays.
const CARPATHIAN_TRAILS_PREF_KEY = 'cart:features:carpathianTrails';
// Bold orange road treatment — orange fills + amber casings + glow +
// boosted widths on the hierarchy network (the «жирные оранжевые дороги»).
// Default ON; persists so a user who turns the heavy orange look off
// doesn't see it return on every reload.
const ROADS_ORANGE_BOLD_PREF_KEY = 'cart:features:roadsOrangeBold';
// Game-style coordinate grid — off by default; persist an ON choice so the
// battleship overlay survives a reload.
const GRID_PREF_KEY = 'cart:features:grid';
// Forest-mode markup accents — independent sub-toggles that only act
// while forestCover is on. They persist alongside the forestCover choice
// so a user's customised forest view survives a reload. Keyed by feature
// name under the same `cart:features:*` namespace and read/written through
// the generic loadBoolPref/saveBoolPref helpers below (no need for a
// bespoke function pair per flag).
const FOREST_MARKUP_PREF_KEYS = Object.freeze({
  forestCities: 'cart:features:forestCities',
  forestWaterAccent: 'cart:features:forestWaterAccent',
  forestRoadsBold: 'cart:features:forestRoadsBold',
  forestRoadsOrange: 'cart:features:forestRoadsOrange',
});

function loadWorldcoverTintPref(fallback) {
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage?.getItem(WORLDCOVER_TINT_PREF_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function saveWorldcoverTintPref(value) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage?.setItem(WORLDCOVER_TINT_PREF_KEY, value ? '1' : '0');
  } catch {
    /* quota / serialise — best-effort */
  }
}

function loadCanopyHeightTintPref(fallback) {
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage?.getItem(CANOPY_HEIGHT_TINT_PREF_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function saveCanopyHeightTintPref(value) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage?.setItem(CANOPY_HEIGHT_TINT_PREF_KEY, value ? '1' : '0');
  } catch {
    /* quota / serialise — best-effort */
  }
}

function loadForestLeafTypePref(fallback) {
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage?.getItem(FOREST_LEAF_TYPE_PREF_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function saveForestLeafTypePref(value) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage?.setItem(FOREST_LEAF_TYPE_PREF_KEY, value ? '1' : '0');
  } catch {
    /* quota / serialise — best-effort */
  }
}

function loadForestCoverPref(fallback) {
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage?.getItem(FOREST_COVER_PREF_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function saveForestCoverPref(value) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage?.setItem(FOREST_COVER_PREF_KEY, value ? '1' : '0');
  } catch {
    /* quota / serialise — best-effort */
  }
}

function loadModeBlockView(fallback = 'expanded') {
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage?.getItem(MODE_BLOCK_VIEW_PREF_KEY);
    return MODE_BLOCK_VIEWS.includes(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

function saveModeBlockView(value) {
  try {
    if (typeof window === 'undefined') return;
    if (!MODE_BLOCK_VIEWS.includes(value)) return;
    window.localStorage?.setItem(MODE_BLOCK_VIEW_PREF_KEY, value);
  } catch {
    /* quota / serialise — best-effort */
  }
}

function loadHazardousTerrainPref(fallback) {
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage?.getItem(HAZARDOUS_TERRAIN_PREF_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function saveHazardousTerrainPref(value) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage?.setItem(HAZARDOUS_TERRAIN_PREF_KEY, value ? '1' : '0');
  } catch {
    /* quota / serialise — best-effort */
  }
}

/** Generic tri-state boolean pref read ('1' → true, '0' → false, else fallback). */
function loadBoolPref(key, fallback) {
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage?.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

/** Generic boolean pref write — best-effort, swallows quota errors. */
function saveBoolPref(key, value) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage?.setItem(key, value ? '1' : '0');
  } catch {
    /* quota / serialise — best-effort */
  }
}

// ---------------------------------------------------------------------------
// MapLibre-native controls (top-right column) + collapse anchor.
//
// The MapLibre ScaleControl is intentionally OMITTED here: the redesigned
// shell installs a custom vertical scale beside the dock (see
// `installVerticalScale`), which avoids colliding with the HUD pill at
// bottom-left while keeping the whole composition on a single visual
// rhythm.
// ---------------------------------------------------------------------------

function installNativeControls(map, { caps }) {
  const ml = window.maplibregl;

  map.addControl(
    new ml.NavigationControl({
      visualizePitch: true,
      showZoom: true,
      showCompass: true,
    }),
    'top-right',
  );

  map.addControl(
    new ml.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 10_000 },
      trackUserLocation: true,
      showUserHeading: true,
      fitBoundsOptions: { maxZoom: 15 },
    }),
    'top-right',
  );

  // Attribution collapses to a compact "ⓘ" toggle so it doesn't sit as a
  // permanent text bar across the bottom — fewer always-on elements.
  map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-right');

  // NOTE: the native FullscreenControl is intentionally dropped in the
  // block-UI redesign to reduce the right-side control count. Fullscreen
  // remains reachable via the browser (F11 / OS chrome); a dedicated map
  // button added little for the clutter it cost.

  // Inject the collapse anchor at the top of the top-right column.
  // Order matters — we want the anchor to render first so the cascade
  // of native controls reveals beneath it.
  installControlsToggle(map, { caps });
}

/**
 * Inject a glass-style anchor button at the top of the top-right MapLibre
 * column. Toggling it collapses the native controls down to just the
 * anchor; expanding plays a cascade reveal animation driven entirely by
 * CSS transition delays (no JS frame loop).
 *
 * Persistence: state survives reload via `src/ui/store.js`. The default
 * is collapsed on touch / narrow viewports so the chrome doesn't crowd
 * the canvas on phones.
 */
function installControlsToggle(map, { caps } = {}) {
  const container = map.getContainer();
  const topRight = container.querySelector('.maplibregl-ctrl-top-right');
  if (!topRight) return;

  // Mark the column so CSS can target its children for the cascade.
  topRight.classList.add('maplibregl-ctrl-stack');

  const defaultCollapsed = !!(caps?.isTouch || caps?.narrow);
  const prefs = loadUiPrefs({ controlsCollapsed: defaultCollapsed });
  let collapsed = prefs.controlsCollapsed;

  // The anchor itself is a MapLibre-styled "ctrl-group" so it inherits
  // the same glass/blur/border treatment as the native cells next to it.
  const anchor = document.createElement('div');
  anchor.className = 'maplibregl-ctrl maplibregl-ctrl-group ctrl-anchor';
  anchor.innerHTML = `
    <button type="button"
            class="ctrl-anchor-btn"
            data-ctl="controls-toggle"
            aria-controls="maplibregl-ctrl-top-right"
            aria-expanded="${collapsed ? 'false' : 'true'}"
            aria-label="${collapsed ? 'Развернуть элементы управления' : 'Свернуть элементы управления'}"
            title="${collapsed ? 'Развернуть' : 'Свернуть'}">
      ${ICONS.controlsChev}
    </button>
  `;
  topRight.prepend(anchor);

  const setCollapsed = (next, { persist = true } = {}) => {
    collapsed = !!next;
    topRight.dataset.collapsed = collapsed ? 'true' : 'false';
    const btn = anchor.querySelector('button');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.setAttribute(
        'aria-label',
        collapsed ? 'Развернуть элементы управления' : 'Свернуть элементы управления',
      );
      btn.setAttribute('title', collapsed ? 'Развернуть' : 'Свернуть');
    }
    if (persist) saveUiPrefs({ controlsCollapsed: collapsed });
  };
  setCollapsed(collapsed, { persist: false });

  anchor.querySelector('button').addEventListener('click', () => {
    setCollapsed(!collapsed);
  });
}

/**
 * Custom scale control — a glass card with a small bar, mono-spaced
 * label, integrated collapse toggle, and live MapLibre updates. The
 * bar is HORIZONTAL (it grows left-to-right) so the card sits as a
 * compact pill below the dock without ever stretching past the dock's
 * own footprint vertically. The collapse toggle mirrors the HUD's
 * pattern: a small chevron button that folds the bar + label into a
 * single anchor square (centred in the dock column so the pill
 * remains visually aligned with the dock above and the HUD below).
 *
 * The bar uses MapLibre's "nice number" rounding so the label reads as
 * a clean 1/2/3/5/10×10ⁿ distance even as the user zooms.
 */
function installVerticalScale(map, scaleHost, { caps } = {}) {
  if (!scaleHost) return () => {};
  scaleHost.classList.add('cart-scale-host');

  // Initial collapsed state — defaults to expanded on roomy desktops,
  // collapsed on touch / narrow viewports where the canvas is the
  // priority. Persists across reloads via the shared UI prefs blob.
  const defaultCollapsed = !!(caps?.narrow || caps?.isCoarse);
  const initialPrefs = loadUiPrefs({ scaleCollapsed: defaultCollapsed });
  const initiallyCollapsed = !!initialPrefs.scaleCollapsed;

  scaleHost.innerHTML = `
    <div class="cart-scale"
         data-collapsed="${initiallyCollapsed ? 'true' : 'false'}"
         role="img"
         aria-label="Масштаб карты">
      <button class="cart-scale-toggle"
              type="button"
              data-ctl="scale-toggle"
              aria-expanded="${initiallyCollapsed ? 'false' : 'true'}"
              aria-label="${initiallyCollapsed ? 'Развернуть масштаб' : 'Свернуть масштаб'}"
              title="Масштаб">
        <span class="cart-scale-toggle-dot" aria-hidden="true"></span>
        <svg class="cart-scale-chev" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 4 L10 8 L6 12" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div class="cart-scale-panel" aria-hidden="${initiallyCollapsed ? 'true' : 'false'}">
        <div class="cart-scale-bar" aria-hidden="true">
          <span class="cart-scale-fill" data-ctl="scale-fill"></span>
          <span class="cart-scale-tick" data-pos="0"></span>
          <span class="cart-scale-tick" data-pos="100"></span>
        </div>
        <span class="cart-scale-label" data-ctl="scale-label">—</span>
      </div>
    </div>
  `;
  const scale = scaleHost.querySelector('.cart-scale');
  const toggle = scaleHost.querySelector('[data-ctl="scale-toggle"]');
  const panel = scaleHost.querySelector('.cart-scale-panel');
  const label = scaleHost.querySelector('[data-ctl="scale-label"]');
  const fill = scaleHost.querySelector('[data-ctl="scale-fill"]');

  // Bar length in CSS pixels. The horizontal bar uses the same scale
  // unit as the old vertical one — picking the length first, then
  // letting MapLibre's "nice number" rounding pick the corresponding
  // distance is the canonical pattern that keeps the label clean.
  const BAR_PX = 56;

  /** Round a metres value to the nearest "map-friendly" number. Mirrors
   *  MapLibre's internal scale implementation. */
  const getRoundNum = (n) => {
    if (!Number.isFinite(n) || n <= 0) return 0;
    const pow10 = Math.pow(10, String(Math.floor(n)).length - 1);
    let d = n / pow10;
    if (d >= 10) d = 10;
    else if (d >= 5) d = 5;
    else if (d >= 3) d = 3;
    else if (d >= 2) d = 2;
    else if (d >= 1) d = 1;
    else d = 0.5;
    return pow10 * d;
  };

  const formatDistance = (m) => {
    if (m >= 1000) {
      const km = m / 1000;
      const display = km >= 10 ? Math.round(km) : km.toFixed(1).replace(/\.0$/, '');
      return `${display} км`;
    }
    return `${Math.round(m)} м`;
  };

  const update = () => {
    const canvas = map.getCanvas();
    const w = canvas?.clientWidth ?? 0;
    const h = canvas?.clientHeight ?? 0;
    if (w <= 0 || h <= 0) return;
    const cy = h / 2;
    let metresPerBar;
    try {
      // Sample the projection across `BAR_PX` horizontal pixels at the
      // canvas's vertical centre — same metric the bar visualises, so
      // the label can never disagree with what the bar shows.
      const left = map.unproject([Math.max(0, w / 2 - BAR_PX / 2), cy]);
      const right = map.unproject([Math.min(w, w / 2 + BAR_PX / 2), cy]);
      metresPerBar = left.distanceTo(right);
    } catch {
      metresPerBar = 0;
    }
    if (!Number.isFinite(metresPerBar) || metresPerBar <= 0) {
      label.textContent = '—';
      if (fill) fill.style.width = '0px';
      return;
    }
    const round = getRoundNum(metresPerBar);
    const ratio = Math.min(1, round / metresPerBar);
    label.textContent = formatDistance(round);
    if (fill) fill.style.width = `${(BAR_PX * ratio).toFixed(1)}px`;
  };

  // Collapse / expand wiring — mirrors the HUD pattern so the two
  // bottom-left controls feel like one family. Persists through the
  // same `cart:ui:prefs:v1` blob the HUD writes into.
  const setCollapsed = (collapsed, { persist = true } = {}) => {
    scale.dataset.collapsed = collapsed ? 'true' : 'false';
    if (toggle) {
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.setAttribute(
        'aria-label',
        collapsed ? 'Развернуть масштаб' : 'Свернуть масштаб',
      );
    }
    if (panel) panel.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    if (persist) saveUiPrefs({ scaleCollapsed: collapsed });
  };
  toggle?.addEventListener('click', () => {
    setCollapsed(scale.dataset.collapsed !== 'true');
  });

  map.on('move', update);
  map.on('zoom', update);
  map.on('resize', update);
  if (map.loaded?.()) update();
  else map.once('load', update);
  // Always run once now — if the map is already idle by the time we
  // hook up, the listener above wouldn't fire until the next move.
  requestAnimationFrame(update);

  return () => {
    map.off('move', update);
    map.off('zoom', update);
    map.off('resize', update);
  };
}

// ---------------------------------------------------------------------------
// Render helpers — one function per panel + one for the dock + chip.
//
// Each panel render produces innerHTML for a `<section class="panel">`
// that the dock controller will toggle via the `data-open` attribute.
// ---------------------------------------------------------------------------

function renderChip(host) {
  // The brand chip is gone in the docked shell — the rail owns the logo.
  // Kept as a no-op so any stale caller doesn't throw.
  if (host) host.innerHTML = '';
}

// Section metadata — single source of truth for the rail + sidebar.
const SECTIONS = [
  { id: 'search',   icon: 'search',   title: 'Поиск настроек' },
  { id: 'layers',   icon: 'layers',   title: 'Слои' },
  { id: 'relief',   icon: 'mountain', title: 'Рельеф' },
  { id: 'hypso',    icon: 'waves',    title: 'Гипсометрия' },
  { id: 'places',   icon: 'pin',      title: 'Места' },
  { id: 'draw',     icon: 'draw',     title: 'Рисование' },
  { id: 'contours', icon: 'contour',  title: 'Контуры' },
  { id: 'settings', icon: 'sliders',  title: 'Настройки' },
  { id: 'data',     icon: 'database', title: 'Данные' },
];

/** Render the fixed activity rail (column 1). */
function renderRail(host) {
  host.innerHTML = `
    <div class="rail-brand">
      <button class="rail-logo" type="button" data-ctl="home" title="К центру Украины" aria-label="Перелететь к центру Украины">${ICONS.home}</button>
    </div>
    <nav class="rail-nav" role="tablist" aria-label="Разделы">
      ${SECTIONS.map((s) => `
        <button class="rail-btn" type="button" role="tab"
                data-section="${s.id}" data-tip="${s.title}"
                aria-label="${s.title}" aria-selected="false">
          ${ICONS[s.icon]}
        </button>`).join('')}
    </nav>
    <div class="rail-foot">
      <button class="rail-btn theme-toggle" type="button" data-ctl="theme-toggle"
              data-tip="Тема" aria-label="Переключить тему">${ICONS.moon}</button>
    </div>
  `;
}

/** Render one sidebar section body. Persistent sections (draw) flag it. */
function sectionShell(id, body, opts = {}) {
  const persistent = opts.persistent ? ' data-persistent="1"' : '';
  return `
    <div class="section" data-panel-id="${id}" data-active="false"${persistent}
         role="tabpanel" aria-label="${opts.title || id}">
      ${body}
    </div>
  `;
}

function renderLayersPanelBody() {
  return `
    ${sectionLede('Управляет тем, что нанесено поверх базовой карты: подписи, объекты инфраструктуры и оформление дорожной сети.')}
    ${accordionMarkup({
      id: 'layers-display',
      title: 'Содержимое карты',
      meta: '3',
      open: true,
      body: `
        <div class="rows">
          ${richRow({ ctl: 'labels', title: 'Подписи', desc: 'Названия городов, рек, улиц и вершин', checked: true })}
          ${richRow({ ctl: 'pois', title: 'Точки интереса', desc: 'Кафе, магазины, заправки, достопримечательности', checked: true })}
          ${richRow({ ctl: 'b3d', title: '3D-здания', desc: 'Объёмная застройка при наклоне камеры', checked: true })}
        </div>
      `,
    })}
    ${accordionMarkup({
      id: 'layers-roads',
      title: 'Дороги и поселения',
      meta: '2',
      open: true,
      body: `
        <div class="rows">
          ${richRow({ ctl: 'roadsOrangeBold', title: 'Выделенные дороги', desc: 'Утолщённые главные дороги с заливкой и обводкой', rowAttr: 'data-ctl-row="roadsOrangeBold"' })}
          ${richRow({ ctl: 'settlementOutline', title: 'Контуры населённых пунктов', desc: 'Заметная рамка вокруг сёл, посёлков и городов', rowAttr: 'data-ctl-row="settlementOutline"' })}
        </div>
      `,
    })}
    ${accordionMarkup({
      id: 'layers-grid',
      title: 'Координатная сетка',
      meta: '1',
      open: false,
      body: `
        ${groupNote('Тактическая сетка как в играх: столбцы — буквы (A–J), строки — цифры (1–7). Каждая клетка получает обозначение как в морском бое — A1, B7, J3.')}
        <div class="rows">
          ${richRow({ ctl: 'grid', title: 'Координатная сетка', desc: 'Чёткая игровая сетка с подписями клеток (A1, B7…) поверх карты', rowAttr: 'data-ctl-row="grid"' })}
        </div>
      `,
    })}
  `;
}

function renderReliefPanelBody() {
  return `
    ${sectionLede('Слои, отражающие форму поверхности: тени, объём, цвет высот, растительность и подсказки безопасности.')}
    <div class="panel-group preset-row-group" data-ctl="flat-hypso-group">
      <label class="row preset-row">
        <span class="preset-row-ico" aria-hidden="true">${SETTING_ICONS.flatHypso}</span>
        <span class="preset-row-text">
          <strong>Быстрый режим: цвет высот</strong>
        </span>
        <input type="checkbox" data-ctl="flatHypso" aria-describedby="flat-hypso-desc">
      </label>
    </div>
    ${accordionMarkup({
      id: 'relief-base',
      title: 'Форма рельефа',
      meta: '7',
      open: true,
      body: `
        ${divider('Объём и тени')}
        <div class="rows">
          ${richRow({ ctl: 'hillshade', title: 'Отмывка теней', desc: 'Имитация теней от рельефа под виртуальным освещением', checked: true })}
          ${richRow({ ctl: 'terrain3D', title: 'Объёмный рельеф (3D)', desc: 'Реальная деформация поверхности при наклоне камеры', checked: true })}
          ${richRow({ ctl: 'textureShading', title: 'Текстурное затенение', desc: 'Подчёркивает овраги, гребни и русла мелким контрастом' })}
          ${richRow({ ctl: 'skyViewFactor', title: 'Открытость неба', desc: 'Затемняет ущелья, подсвечивает вершины и плато' })}
        </div>
        ${divider('Высоты и глубины')}
        <div class="rows">
          ${richRow({ ctl: 'contours', title: 'Изолинии высот', desc: 'Горизонтали с подписями — топографический способ показать крутизну', checked: true })}
          ${richRow({ ctl: 'hypsometricTint', title: 'Окраска по высоте', desc: 'Заливка цветом от низин к вершинам по выбранной палитре' })}
          ${richRow({ ctl: 'bathymetry', title: 'Глубины водоёмов', desc: 'Чем глубже — тем темнее синий тон под водой' })}
        </div>
      `,
    })}
    ${accordionMarkup({
      id: 'relief-cover',
      title: 'Растительность и покров',
      meta: '4',
      open: false,
      body: `
        <div class="rows">
          ${richRow({ ctl: 'worldcoverTint', title: 'Типы поверхности', desc: 'Лес, поля, вода и застройка по данным WorldCover', rowAttr: 'data-ctl-row="worldcoverTint"' })}
          ${richRow({ ctl: 'canopyHeightTint', title: 'Высота крон леса', desc: 'Тёмные участки — высокие старые леса, светлые — молодые', rowAttr: 'data-ctl-row="canopyHeightTint"' })}
          ${richRow({ ctl: 'forestLeafType', title: 'Породы леса', desc: 'Хвойный, лиственный и смешанный — каждый своим оттенком', rowAttr: 'data-ctl-row="forestLeafType"' })}
          ${richRow({ ctl: 'forestCover', title: 'Сплошной лесной покров', desc: 'Зелёная подсветка всех лесов в плоском режиме, как в Google Earth', rowAttr: 'data-ctl-row="forestCover"' })}
        </div>
        ${accordionMarkup({
          id: 'relief-forest-markup',
          title: 'Акценты лесного режима',
          open: true,
          level: 1,
          body: `
            <div class="forest-markup-panel" data-forest-markup-panel data-enabled="false">
              ${groupNote('Эти акценты действуют только при включённом «Сплошной лесной покров».', { tone: 'warn' }).replace('class="group-note"', 'class="group-note forest-markup-note" data-forest-markup-note')}
              <div class="forest-markup-rows" id="forest-markup-rows" data-forest-markup-rows>
                ${richRow({ ctl: 'forestCities', title: 'Города крупнее', desc: 'Контрастное выделение населённых пунктов на зелёном фоне', rowAttr: 'data-ctl-row="forestCities"' })}
                ${richRow({ ctl: 'forestWaterAccent', title: 'Яркие реки и водоёмы', desc: 'Усиленный синий для контраста с лесом', rowAttr: 'data-ctl-row="forestWaterAccent"' })}
                ${richRow({ ctl: 'forestRoadsBold', title: 'Жирные главные дороги', desc: 'Тёмная обводка магистралей поверх зелёного', rowAttr: 'data-ctl-row="forestRoadsBold"' })}
                ${richRow({ ctl: 'forestRoadsOrange', title: 'Цветовое выделение дорог', desc: 'Яркая окраска дорог по их значимости', rowAttr: 'data-ctl-row="forestRoadsOrange"' })}
                ${richRow({ ctl: 'settlementOutline', title: 'Контуры поселений', desc: 'Рамка вокруг сёл и городов', rowAttr: 'data-ctl-row="settlementOutline"' })}
              </div>
            </div>
          `,
        })}
      `,
    })}
    ${accordionMarkup({
      id: 'relief-safety',
      title: 'Безопасность маршрутов',
      meta: '3',
      open: false,
      body: `
        ${groupNote('Подсказки для горного туризма и планирования походов в высокогорье.')}
        <div class="rows">
          ${richRow({ ctl: 'slopeWarning', title: 'Крутые склоны (от 35°)', desc: 'Потенциально лавиноопасные и труднопроходимые участки', rowAttr: 'data-ctl-row="slopeWarning"' })}
          ${richRow({ ctl: 'hazardousTerrain', title: 'Опасные участки', desc: 'Высокие пики, обрывы и опасные перевалы', rowAttr: 'data-ctl-row="hazardousTerrain"' })}
          ${richRow({ ctl: 'ridgeOverlay', title: 'Горные хребты', desc: 'Линии гребней и водоразделов для понимания орографии' })}
        </div>
      `,
    })}
    ${accordionMarkup({
      id: 'relief-carpathian',
      title: 'Карпатский регион',
      meta: '2',
      open: false,
      body: `
        <div class="rows">
          ${richRow({ ctl: 'carpathian', title: 'Детализация Карпат', desc: 'Тропы, приюты, вершины и специальная стилизация региона' })}
          ${richRow({ ctl: 'carpathianTrails', title: 'Маркированные тропы', desc: 'Красные линии троп, виа-феррат и ступеней', rowAttr: 'data-ctl-row="carpathianTrails"' })}
        </div>
      `,
    })}
    ${accordionMarkup({
      id: 'relief-exaggeration',
      title: 'Высота рельефа',
      open: false,
      body: `
        ${groupNote('Множитель высоты влияет на 3D-рельеф и отмывку: больше единицы — выразительнее горы, меньше — мягче.')}
        <div class="slider-row">
          <label class="slider-label" for="exaggeration">
            <span>Преувеличение · 0.5×–2×</span>
            <span data-ctl="exaggeration-readout">1.0×</span>
          </label>
          <input id="exaggeration" type="range" min="0.5" max="2" step="0.1" value="1"
                 data-ctl="exaggeration" aria-label="Вертикальное преувеличение" />
        </div>
      `,
    })}
  `;
}

function renderHypsoPanelBody() {
  return `
    <!-- Hypsometric subsystem mount point. mountHypsoUI() renders
         the ramp picker, strength slider, bathymetry + high-contrast
         toggles into this slot. -->
    <div data-ctl="hypso-picker"></div>

    <div class="panel-group" data-ctl="hypso-profile-launcher" hidden>
      <button class="btn-block btn-accent" type="button" data-ctl="open-profile">
        <span>Построить профиль высот по линии</span>
      </button>
    </div>

    <div class="panel-group hypso-stats" data-ctl="hypso-stats" hidden>
      <span><span class="hypso-stat-label">мин</span><span data-ctl="hypso-stat-min">— м</span></span>
      <span><span class="hypso-stat-label">средн.</span><span data-ctl="hypso-stat-mean">— м</span></span>
      <span><span class="hypso-stat-label">макс</span><span data-ctl="hypso-stat-max">— м</span></span>
      <span><span class="hypso-stat-label">регион</span><span data-ctl="hypso-stat-region">—</span></span>
    </div>
  `;
}

function renderPlacesPanelBody() {
  const city = (id, label, sub) => `
    <button data-preset="${id}" type="button">
      <span class="dot"></span>
      <span>
        <strong>${label}</strong>
        ${sub ? `<small>${sub}</small>` : ''}
      </span>
    </button>
  `;
  return `
    <div class="panel-group">
      <h4 class="panel-group-title">Украина</h4>
      <div class="presets" data-ctl="presets">
        ${city('ukraine',     'Украина',  'обзор')}
        ${city('kyiv',        'Киев',     'столица')}
        ${city('lviv',        'Львов',    '')}
        ${city('odesa',       'Одесса',   '')}
        ${city('kharkiv',     'Харьков',  '')}
        ${city('carpathians', 'Карпаты',  'регион')}
      </div>
    </div>
    <div class="panel-group">
      <h4 class="panel-group-title">Карпатские вершины</h4>
      <div class="presets" data-ctl="presets">
        ${city('hoverla',    'Говерла',   '2061 м')}
        ${city('pip_ivan',   'Поп Иван',  '2028 м')}
        ${city('petros',     'Петрос',    '2020 м')}
        ${city('svydovets',  'Свидовец',  'хребет')}
        ${city('chornohora', 'Черногора', 'хребет')}
      </div>
    </div>
  `;
}

function renderSettingsPanelBody() {
  return `
    <div class="panel-group">
      <h4 class="panel-group-title">Качество</h4>
      <div class="seg seg-3" role="tablist" data-ctl="quality">
        <button data-value="auto" role="tab" type="button">Авто</button>
        <button data-value="high" role="tab" type="button">Высокое</button>
        <button data-value="low"  role="tab" type="button">Эконом</button>
      </div>
      <p class="panel-meta">Авто учитывает память устройства, процессор и соединение, чтобы балансировать качество и частоту кадров. Используйте «Эконом» на слабых устройствах, «Высокое» — для полного визуального оформления.</p>
    </div>
    <div class="panel-group">
      <h4 class="panel-group-title">Горячие клавиши</h4>
      <ul class="tips" data-pointer="fine">
        <li><kbd>Колесо</kbd> Приближение / отдаление</li>
        <li><kbd>Перетаскивание</kbd> Перемещение карты</li>
        <li><kbd>Shift</kbd>+<kbd>Перетаскивание</kbd> Поворот и наклон</li>
        <li><kbd>Ctrl</kbd>+<kbd>Клик</kbd> Перелёт к точке</li>
        <li><kbd>Esc</kbd> Закрыть активную панель</li>
      </ul>
      <ul class="tips" data-pointer="coarse">
        <li><kbd>Щипок</kbd> Масштаб</li>
        <li><kbd>2 пальца</kbd> Наклон и поворот</li>
        <li><kbd>Двойной тап</kbd> Приближение</li>
        <li><kbd>Тап вне</kbd> Закрыть панель</li>
      </ul>
    </div>
    <p class="panel-meta">Cart — векторная картография на MapLibre GL JS. Данные тайлов © OpenMapTiles + участники OpenStreetMap.</p>
  `;
}

function renderSearchPanelBody() {
  // The search UI is mounted into this host by mountSettingsSearch().
  return `<div data-ctl="settings-search-host"></div>`;
}

/**
 * Render the docked sidebar: a header (section title + collapse button)
 * and a scrollable body holding every section stacked (only the active
 * one is shown via [data-active]).
 */
function renderSidebar(host) {
  host.innerHTML = `
    <div class="sidebar-head">
      <span class="sidebar-title" data-ctl="sidebar-title">Слои</span>
      <button class="sidebar-collapse" type="button" data-ctl="sidebar-collapse"
              aria-label="Свернуть панель" title="Свернуть панель">${ICONS.close}</button>
    </div>
    <div class="sidebar-body" data-ctl="sidebar-body">
      ${sectionShell('search',   renderSearchPanelBody(),   { title: 'Поиск настроек' })}
      ${sectionShell('layers',   renderLayersPanelBody(),   { title: 'Слои' })}
      ${sectionShell('relief',   renderReliefPanelBody(),   { title: 'Рельеф' })}
      ${sectionShell('hypso',    renderHypsoPanelBody(),    { title: 'Гипсометрия' })}
      ${sectionShell('places',   renderPlacesPanelBody(),   { title: 'Места' })}
      ${sectionShell('draw',     renderDrawPanelBody(),     { title: 'Рисование', persistent: true })}
      ${sectionShell('contours', renderContourPanelBody(), { title: 'Контуры', persistent: true })}
      ${sectionShell('settings', renderSettingsPanelBody(), { title: 'Настройки' })}
      ${sectionShell('data',     renderDataPanelBody(),     { title: 'Данные', persistent: true })}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Sidebar controller — selects which docked section is shown.
//
// Unlike the old floating DockController, this never overlaps the map:
// the sidebar is a real grid column. Selecting a rail button switches the
// active section; clicking the already-active button collapses the
// sidebar (column → 0, map reflows). The active selection persists.
//
// On mobile the same DOM is reused; CSS turns the sidebar into a bottom
// sheet and the scrim/drag-to-close gesture applies there.
// ---------------------------------------------------------------------------

const SIDEBAR_PREF_KEY = 'cart:ui:sidebar:v1';

class SidebarController {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.app        the #app grid root (carries data-side)
   * @param {HTMLElement} opts.rail       activity rail (holds .rail-btn)
   * @param {HTMLElement} opts.sidebar    docked sidebar element
   * @param {HTMLElement} opts.scrim      mobile backdrop
   * @param {object} opts.caps
   */
  constructor({ app, rail, sidebar, scrim, caps }) {
    this.app = app;
    this.rail = rail;
    this.sidebar = sidebar;
    this.scrim = scrim;
    this.caps = caps;
    this.entries = new Map();
    this.activeId = null;
    this.collapsed = false;
    this.titleEl = sidebar.querySelector('[data-ctl="sidebar-title"]');
    this.bodyEl = sidebar.querySelector('[data-ctl="sidebar-body"]');
    this.mqMobile = window.matchMedia('(max-width: 540px)');
  }

  register(id) {
    const button = this.rail.querySelector(`.rail-btn[data-section="${id}"]`);
    const section = this.bodyEl?.querySelector(`.section[data-panel-id="${id}"]`);
    if (!button || !section) return null;
    const meta = SECTIONS.find((s) => s.id === id);
    this.entries.set(id, { button, section, title: meta?.title || id });

    button.addEventListener('click', () => this.toggle(id));
    return { button, section };
  }

  /** Show a section: mark active section + rail button, set the title. */
  select(id, { collapseIfSame = true } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return;

    // Re-selecting the active section collapses the sidebar (toggle off).
    if (this.activeId === id && !this.collapsed && collapseIfSame) {
      this.setCollapsed(true);
      return;
    }

    // Switch active section.
    for (const [otherId, e] of this.entries) {
      const on = otherId === id;
      e.section.dataset.active = on ? 'true' : 'false';
      e.button.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    this.activeId = id;
    if (this.titleEl) this.titleEl.textContent = entry.title;
    this.setCollapsed(false);
    this._persist();

    if (this.scrim && this.mqMobile.matches) this.scrim.dataset.visible = '1';

    requestAnimationFrame(() => {
      const focusable = entry.section.querySelector(
        'input:not([type=hidden]):not([disabled]), select, button, [tabindex]:not([tabindex="-1"])',
      );
      try { focusable?.focus({ preventScroll: true }); } catch { /* ignore */ }
    });
  }

  toggle(id) {
    this.select(id);
  }

  /** Open a section without collapse-on-same behaviour (used by search). */
  open(id) {
    this.select(id, { collapseIfSame: false });
  }

  setCollapsed(next) {
    this.collapsed = !!next;
    this.app.dataset.side = this.collapsed ? 'collapsed' : 'expanded';
    if (this.collapsed) {
      // Deselect rail buttons so nothing reads as "open".
      for (const [, e] of this.entries) e.button.setAttribute('aria-selected', 'false');
      if (this.scrim) this.scrim.dataset.visible = '0';
    } else if (this.activeId) {
      const e = this.entries.get(this.activeId);
      e?.button.setAttribute('aria-selected', 'true');
    }
    this._persist();
  }

  _persist() {
    try {
      window.localStorage?.setItem(
        SIDEBAR_PREF_KEY,
        JSON.stringify({ activeId: this.activeId, collapsed: this.collapsed }),
      );
    } catch { /* best-effort */ }
  }

  _restore(defaultId) {
    let pref = {};
    try { pref = JSON.parse(window.localStorage?.getItem(SIDEBAR_PREF_KEY) || '{}') || {}; }
    catch { pref = {}; }
    // On mobile default to collapsed so the map is the priority.
    const startCollapsed = this.mqMobile.matches ? true : !!pref.collapsed;
    const startId = this.entries.has(pref.activeId) ? pref.activeId : defaultId;
    // Always mark a section active in the DOM (so re-expanding shows it),
    // but honour the collapsed flag for the visible state.
    this.activeId = startId;
    for (const [otherId, e] of this.entries) {
      const on = otherId === startId;
      e.section.dataset.active = on ? 'true' : 'false';
    }
    if (this.titleEl) {
      this.titleEl.textContent = this.entries.get(startId)?.title || '';
    }
    this.setCollapsed(startCollapsed);
  }

  install({ defaultId = 'layers' } = {}) {
    // Collapse button in the sidebar header.
    this.sidebar.querySelector('[data-ctl="sidebar-collapse"]')
      ?.addEventListener('click', () => this.setCollapsed(true));

    // Esc collapses on mobile (where the sheet overlays); on desktop the
    // sidebar is docked so Esc just blurs — keep it collapsing for parity.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.collapsed && this.mqMobile.matches) {
        e.preventDefault();
        this.setCollapsed(true);
      }
    });

    // Mobile scrim tap closes the sheet.
    this.scrim?.addEventListener('click', () => this.setCollapsed(true));

    // Mobile drag-to-close on the sidebar header.
    this._installDragHandle();

    this._restore(defaultId);
  }

  /** Mobile bottom-sheet drag-to-close on the sidebar header. */
  _installDragHandle() {
    const head = this.sidebar.querySelector('.sidebar-head');
    if (!head) return;
    let pointerId = null, startY = 0, dragY = 0, lastY = 0, lastT = 0, dragging = false;

    const reset = () => {
      this.sidebar.style.transition = '';
      this.sidebar.style.transform = '';
      this.sidebar.removeAttribute('data-dragging');
      dragging = false; pointerId = null; dragY = 0;
    };
    head.addEventListener('pointerdown', (e) => {
      if (!this.mqMobile.matches || this.collapsed) return;
      if (e.target.closest('[data-ctl="sidebar-collapse"]')) return;
      pointerId = e.pointerId; startY = lastY = e.clientY; lastT = e.timeStamp;
      dragY = 0; dragging = true;
      this.sidebar.dataset.dragging = '1';
      this.sidebar.style.transition = 'none';
      try { head.setPointerCapture(pointerId); } catch { /* ignore */ }
    });
    head.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const raw = e.clientY - startY;
      dragY = raw > 0 ? raw : raw / 4;
      this.sidebar.style.transform = `translateY(${dragY}px)`;
      lastY = e.clientY; lastT = e.timeStamp;
    });
    const up = (e) => {
      if (!dragging || (e.pointerId != null && e.pointerId !== pointerId)) return;
      try { head.releasePointerCapture(pointerId); } catch { /* ignore */ }
      const dt = Math.max(1, e.timeStamp - lastT);
      const velocity = (e.clientY - lastY) / dt;
      const threshold = this.sidebar.offsetHeight * 0.25;
      const shouldClose = dragY > threshold || velocity > 0.5;
      reset();
      if (shouldClose) this.setCollapsed(true);
    };
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  }

  // Back-compat alias used by older call sites (e.g. preset/home handlers
  // that called controller.close() to dismiss on mobile).
  close() { if (this.mqMobile.matches) this.setCollapsed(true); }
}

// ---------------------------------------------------------------------------
// Mount.
// ---------------------------------------------------------------------------

/**
 * @param {maplibregl.Map} map
 * @param {HTMLElement}    sidebar       Host for the dock + panels.
 * @param {HTMLElement|null} scrim
 * @param {object} ctx
 * @param {DeviceCaps} ctx.caps
 * @param {string} ctx.profile
 */
export function mountControls(map, sidebar, scrim, { caps, profile } = {}) {
  installNativeControls(map, { caps });

  const app = document.getElementById('app');
  const rail = document.getElementById('rail');

  // ----- Build the docked shell ---------------------------------------
  // The activity rail (column 1) and the docked sidebar (column 2). The
  // sidebar's body holds every section stacked; the controller toggles
  // which one is visible. `panelsHost` aliases the sidebar BODY so all
  // existing `panelsHost.querySelector(...)` wiring keeps working.
  rail.className = 'rail';
  renderRail(rail);
  sidebar.className = 'sidebar';
  renderSidebar(sidebar);
  const panelsHost = sidebar.querySelector('[data-ctl="sidebar-body"]');

  // Mode switcher (Cart / Standard / Satellite) — a docked card list
  // pinned to the top of the sidebar body so it's always reachable and
  // never floats over the map. A small heading labels the group so its
  // purpose ("base map") is obvious.
  const modeWrap = document.createElement('div');
  modeWrap.className = 'mode-switcher-block';
  modeWrap.innerHTML = `
    <div class="mode-switcher-head">
      <h4 class="mode-switcher-heading">Базовая карта</h4>
      <div class="mode-switcher-head-actions">
        <button type="button" class="mode-switcher-act" data-ctl="mode-collapse"
                aria-expanded="true" title="Свернуть" aria-label="Свернуть базовую карту">
          ${ICONS.chevron}
        </button>
        <button type="button" class="mode-switcher-act" data-ctl="mode-detach"
                title="Открепить" aria-label="Открепить базовую карту в плавающую кнопку">
          ${ICONS.detach}
        </button>
      </div>
    </div>
  `;
  const modeHost = document.createElement('div');
  modeHost.dataset.ctl = 'mode-switcher';
  modeHost.className = 'mode-switcher-host';
  modeWrap.appendChild(modeHost);
  panelsHost.prepend(modeWrap);

  // Floating rail control (only visible in the 'detached' view). It lives
  // in the rail nav so it sits alongside the section buttons; clicking it
  // opens a small popover that hosts the same mode cards + a re-dock
  // button. We build the scaffold up-front and toggle visibility via the
  // view-mode state below.
  const railNav = rail.querySelector('.rail-nav');
  const modeFab = document.createElement('button');
  modeFab.type = 'button';
  modeFab.className = 'rail-btn rail-mode-fab';
  modeFab.dataset.ctl = 'mode-fab';
  modeFab.hidden = true;
  modeFab.setAttribute('aria-haspopup', 'true');
  modeFab.setAttribute('aria-expanded', 'false');
  modeFab.setAttribute('data-tip', 'Базовая карта');
  modeFab.setAttribute('aria-label', 'Базовая карта');
  modeFab.innerHTML = ICONS.mapStack;
  railNav?.appendChild(modeFab);

  const modePopover = document.createElement('div');
  modePopover.className = 'mode-switcher-popover';
  modePopover.dataset.ctl = 'mode-popover';
  modePopover.hidden = true;
  modePopover.innerHTML = `
    <div class="mode-switcher-head">
      <h4 class="mode-switcher-heading">Базовая карта</h4>
      <button type="button" class="mode-switcher-act" data-ctl="mode-redock"
              title="Вернуть в панель" aria-label="Вернуть базовую карту в панель">
        ${ICONS.dockBack}
      </button>
    </div>
  `;
  const modePopHost = document.createElement('div');
  modePopHost.className = 'mode-switcher-host';
  modePopover.appendChild(modePopHost);
  app.appendChild(modePopover);

  // ----- State the user can toggle -------------------------------------
  const state = {
    theme: DEFAULT_THEME,
    qualityChoice: 'auto',
    detectedProfile: profile ?? 'medium',
    // Read from the map's stored state if available so we stay in
    // sync with what createMap() actually applied; loadMapMode() is
    // a safe fallback for tests that mount controls without a real
    // _cart attached.
    mode: map._cart?.mode ?? loadMapMode(),
    layerFeatures: {
      labels: FEATURES.labels,
      pois: FEATURES.pois,
      buildings3D: FEATURES.buildings3D,
      hillshade: FEATURES.hillshade,
      terrain3D: FEATURES.terrain3D,
      contours: FEATURES.contours,
      hypsometricTint: FEATURES.hypsometricTint,
      bathymetry: FEATURES.bathymetry,
      textureShading: FEATURES.textureShading,
      skyViewFactor: FEATURES.skyViewFactor,
      worldcoverTint: loadWorldcoverTintPref(FEATURES.worldcoverTint),
      canopyHeightTint: loadCanopyHeightTintPref(FEATURES.canopyHeightTint),
      // Forest leaf-type biom polygons. Off in FEATURES until the
      // operator rebuilds carpathian-osm.pmtiles with the new
      // forest_polygon source-layer; once they flip the toggle on
      // (here or via the UI) the choice survives reload.
      forestLeafType: loadForestLeafTypePref(FEATURES.forestLeafType),
      // Forest-cover overlay — vivid green forest highlight from the
      // global base vector source. Pure stylistic preference, but the
      // user's ON choice persists under `cart:features:forestCover`.
      forestCover: loadForestCoverPref(FEATURES.forestCover),
      // Forest-mode markup accents — independent sub-toggles that only act
      // while forestCover is on. Persisted alongside the forestCover choice
      // so a customised forest view survives a reload.
      forestCities: loadBoolPref(
        FOREST_MARKUP_PREF_KEYS.forestCities,
        FEATURES.forestCities,
      ),
      forestWaterAccent: loadBoolPref(
        FOREST_MARKUP_PREF_KEYS.forestWaterAccent,
        FEATURES.forestWaterAccent,
      ),
      forestRoadsBold: loadBoolPref(
        FOREST_MARKUP_PREF_KEYS.forestRoadsBold,
        FEATURES.forestRoadsBold,
      ),
      forestRoadsOrange: loadBoolPref(
        FOREST_MARKUP_PREF_KEYS.forestRoadsOrange,
        FEATURES.forestRoadsOrange,
      ),
      slopeWarning: FEATURES.slopeWarning,
      ridgeOverlay: FEATURES.ridgeOverlay,
      carpathian: FEATURES.carpathian,
      // Carpathian trail web — bold red trail lines, on by default; the
      // user's choice persists under `cart:features:carpathianTrails` so an
      // "off" decision (hide the red clutter) outlives the page.
      carpathianTrails: loadBoolPref(
        CARPATHIAN_TRAILS_PREF_KEY,
        FEATURES.carpathianTrails,
      ),
      // Hazardous-terrain overlay — on by default; user choice persists
      // under `cart:features:hazardousTerrain` for the same reason
      // worldcover/canopy/forestLeaf do (operator-side data is hosted,
      // so the user's "off" decision should outlive the page).
      hazardousTerrain: loadHazardousTerrainPref(FEATURES.hazardousTerrain),
      // Settlement outlines — heavy road-style violet frame around
      // residential / suburb / quarter / neighbourhood polygons.
      // Pure stylistic preference (no operator-side data is involved
      // — the polygons ship in the upstream OMT tiles), so we don't
      // persist it: every cold boot starts from the FEATURES default.
      settlementOutline: FEATURES.settlementOutline,
      // Bold orange road treatment — orange fills + casings + glow +
      // boosted widths on hierarchy roads. Default ON; the user's choice
      // (especially "off") persists under `cart:features:roadsOrangeBold`
      // so the heavy orange look doesn't return on every reload.
      roadsOrangeBold: loadBoolPref(
        ROADS_ORANGE_BOLD_PREF_KEY,
        FEATURES.roadsOrangeBold,
      ),
      // Game-style coordinate grid — off by default; the user's ON choice
      // persists under `cart:features:grid` so the overlay survives reload.
      grid: loadBoolPref(GRID_PREF_KEY, FEATURES.grid),
    },
  };
  const effectiveProfile = () =>
    state.qualityChoice === 'auto' ? state.detectedProfile : state.qualityChoice;

  const rebuildStyle = async () => {
    const profileName = effectiveProfile();
    await applyStyle(map, {
      theme: state.theme,
      profile: profileName,
      profileConfig: getProfileConfig(profileName, caps),
      featureOverrides: state.layerFeatures,
    });
  };

  // ----- Map-mode switcher (segmented control beside the brand chip) ---
  // The active mode is stamped on `<html>` so CSS can dim irrelevant
  // panels (Relief / Hypso are Cart-only) without JS having to chase
  // every input on every switch. The applyMapMode call already
  // persists the choice via localStorage; we just keep `state.mode`
  // in sync so subsequent style rebuilds (theme / quality switches)
  // route through the right branch.
  const syncModeAttr = () => {
    document.documentElement.dataset.mapMode = state.mode;
  };
  syncModeAttr();
  const modeSwitcher = mountModeSwitcher({
    host: modeHost,
    activeMode: state.mode,
    onChange: async (next) => {
      if (state.mode === next) return;
      state.mode = next;
      syncModeAttr();
      try {
        await applyMapMode(map, next);
      } catch (err) {
        // The mode router itself does graceful fallback for Standard;
        // if anything else throws here we want the user to know the
        // switch didn't take so they can retry.
        // eslint-disable-next-line no-console
        console.error('[cart] applyMapMode failed:', err);
      }
    },
  });

  // ----- Base-map block view modes (collapse / detach / re-dock) -------
  // Three presentations, persisted across reloads:
  //   • expanded  — full card list docked in the sidebar (default)
  //   • collapsed — heading only, cards hidden behind the chevron
  //   • detached  — block ejected from the sidebar into a floating rail
  //                 button + popover, freeing sidebar space
  //
  // The single mounted switcher (`modeHost`) is physically relocated
  // between the sidebar block and the popover on detach/re-dock, so all
  // event wiring + the active selection survive the move untouched.
  const modeCollapseBtn = modeWrap.querySelector('[data-ctl="mode-collapse"]');
  const modeDetachBtn = modeWrap.querySelector('[data-ctl="mode-detach"]');
  const modeRedockBtn = modePopover.querySelector('[data-ctl="mode-redock"]');
  let modeBlockView = loadModeBlockView();

  const closeModePopover = () => {
    modePopover.hidden = true;
    modePopover.dataset.open = 'false';
    modeFab.setAttribute('aria-expanded', 'false');
  };
  const openModePopover = () => {
    if (modeBlockView !== 'detached') return;
    modePopover.hidden = false;
    modePopover.dataset.open = 'true';
    modeFab.setAttribute('aria-expanded', 'true');
  };

  const applyModeBlockView = (view, { persist = true } = {}) => {
    if (!MODE_BLOCK_VIEWS.includes(view)) view = 'expanded';
    modeBlockView = view;

    const detached = view === 'detached';
    const collapsed = view === 'collapsed';

    // Move the live switcher host into whichever container is active.
    if (detached) {
      if (modeHost.parentNode !== modePopover) modePopover.appendChild(modeHost);
    } else if (modeHost.parentNode !== modeWrap) {
      modeWrap.appendChild(modeHost);
    }

    modeWrap.hidden = detached;
    modeWrap.dataset.collapsed = collapsed ? 'true' : 'false';
    modeFab.hidden = !detached;
    if (!detached) closeModePopover();

    modeCollapseBtn?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    modeCollapseBtn?.setAttribute('title', collapsed ? 'Развернуть' : 'Свернуть');
    modeCollapseBtn?.setAttribute(
      'aria-label',
      collapsed ? 'Развернуть базовую карту' : 'Свернуть базовую карту',
    );

    if (persist) saveModeBlockView(view);
  };

  modeCollapseBtn?.addEventListener('click', () => {
    applyModeBlockView(modeBlockView === 'collapsed' ? 'expanded' : 'collapsed');
  });
  modeDetachBtn?.addEventListener('click', () => {
    applyModeBlockView('detached');
    openModePopover();
  });
  modeRedockBtn?.addEventListener('click', () => {
    applyModeBlockView('expanded');
  });
  modeFab.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modePopover.dataset.open === 'true') closeModePopover();
    else openModePopover();
  });
  // Dismiss the popover on outside click / Escape.
  document.addEventListener('pointerdown', (e) => {
    if (modePopover.hidden) return;
    const t = e.target;
    if (modePopover.contains(t) || modeFab.contains(t)) return;
    closeModePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modePopover.hidden) closeModePopover();
  });

  // Apply the restored view without re-persisting (no-op if 'expanded').
  applyModeBlockView(modeBlockView, { persist: false });

  // ----- Sidebar controller --------------------------------------------
  const controller = new SidebarController({
    app,
    rail,
    sidebar,
    scrim,
    caps,
  });
  ['search', 'layers', 'relief', 'hypso', 'places', 'draw', 'contours', 'settings', 'data'].forEach((id) =>
    controller.register(id),
  );
  controller.install({ defaultId: 'layers' });

  // ----- Theme toggle (in the rail foot) ------------------------------
  const themeBtn = rail.querySelector('[data-ctl="theme-toggle"]');
  const syncTheme = () => {
    document.documentElement.dataset.theme = state.theme;
    if (themeBtn) {
      themeBtn.innerHTML = state.theme === 'dark' ? ICONS.sun : ICONS.moon;
      themeBtn.setAttribute(
        'data-tip',
        state.theme === 'dark' ? 'Светлая тема' : 'Тёмная тема',
      );
      themeBtn.setAttribute(
        'aria-label',
        state.theme === 'dark' ? 'Переключить на светлую тему' : 'Переключить на тёмную тему',
      );
    }
  };
  syncTheme();
  themeBtn?.addEventListener('click', async () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    syncTheme();
    await rebuildStyle();
  });

  // ----- Home button (fly to Ukraine centroid) ------------------------
  const homeBtn = rail.querySelector('[data-ctl="home"]');
  homeBtn?.addEventListener('click', () => {
    flyToPreset(map, 'ukraine', {
      reduceMotion: !!caps?.prefersReducedMotion,
    });
    if (caps?.narrow) controller.close();
  });

  // ----- Quality picker (in the Settings panel) -----------------------
  const qualBtns = panelsHost.querySelectorAll('[data-ctl=quality] button');
  const syncQuality = () => {
    qualBtns.forEach((b) =>
      b.classList.toggle('on', b.dataset.value === state.qualityChoice),
    );
  };
  syncQuality();
  qualBtns.forEach((b) =>
    b.addEventListener('click', async () => {
      if (state.qualityChoice === b.dataset.value) return;
      state.qualityChoice = b.dataset.value;
      syncQuality();
      await rebuildStyle();
    }),
  );

  // ----- Layer toggles -------------------------------------------------
  //
  // The "Flat hypsometric" preset is a *computed* state: it's checked
  // iff the four managed feature flags are in the exact configuration
  // that produces a flat hypso-only render. This means every regular
  // feature toggle has to refresh the preset checkbox after it
  // changes, and the preset checkbox itself fires a single batched
  // applyStyle() rather than four serial setStates.
  const FLAT_HYPSO_KEYS = ['hillshade', 'terrain3D', 'contours', 'hypsometricTint'];
  const isFlatHypsoActive = (features) =>
    features.hypsometricTint === true &&
    features.hillshade === false &&
    features.terrain3D === false &&
    features.contours === false;
  const flatHypsoEl = panelsHost.querySelector('[data-ctl=flatHypso]');
  const syncFlatHypsoCheckbox = () => {
    if (!flatHypsoEl) return;
    const next = isFlatHypsoActive(state.layerFeatures);
    if (flatHypsoEl.checked !== next) flatHypsoEl.checked = next;
  };

  // Forest-mode markup sub-panel handle + reveal helper. Declared ahead
  // of wireToggle so the forest-cover change handler (which lives inside
  // wireToggle) can call the helper. The panel element is resolved after
  // the toggles are wired; the helper no-ops until then.
  let forestMarkupPanel = null;
  // Forest-mode accents only do anything while "Лесной покров" is on.
  // Rather than HIDE the whole sub-panel (which left the expanded
  // accordion looking empty), we keep the rows visible and switch an
  // `data-enabled` state: enabled = active toggles, disabled = dimmed
  // rows + a short explanatory note. The accordion is never empty.
  function setForestMarkupPanelVisible(enabled) {
    if (!forestMarkupPanel) return;
    forestMarkupPanel.dataset.enabled = enabled ? 'true' : 'false';
    // Disable the inputs while inactive so they can't be toggled with
    // no visible effect, but keep them readable.
    forestMarkupPanel
      .querySelectorAll('[data-forest-markup-rows] input')
      .forEach((input) => { input.disabled = !enabled; });
  }

  const wireToggle = (selector, key = selector) => {
    // A control may be MIRRORED across panels (e.g. `settlementOutline`
    // lives both in the Layers panel and in the forest-mode markup
    // sub-panel). Wire every matching checkbox to the same feature flag
    // and keep them visually in sync so toggling one updates the other.
    const els = [...panelsHost.querySelectorAll(`[data-ctl=${selector}]`)];
    if (!els.length) return;
    const seed = !!state.layerFeatures[key];
    els.forEach((node) => {
      node.checked = seed;
    });
    els.forEach((el) => el.addEventListener('change', async () => {
      state.layerFeatures[key] = el.checked;
      // Mirror the new state onto any sibling checkboxes for this flag.
      els.forEach((other) => {
        if (other !== el && other.checked !== el.checked) other.checked = el.checked;
      });
      // The Land cover toggle is the one feature whose user choice
      // outlives the page — persist it through `cart:features:*`
      // keys so a refresh restores the user's selection. Other
      // feature toggles intentionally reset to FEATURES defaults
      // each cold boot (they're tied to the device profile).
      if (key === 'worldcoverTint') saveWorldcoverTintPref(el.checked);
      // Canopy height shares the same persistence reasoning — once
      // an operator wires `TERRAIN.canopyHeight.url` the user's
      // selection should outlive the page.
      if (key === 'canopyHeightTint') saveCanopyHeightTintPref(el.checked);
      // Forest leaf-type follows the same pattern: once the operator
      // rebuilds carpathian-osm.pmtiles with the forest_polygon
      // source-layer, the user's on/off choice persists across
      // reloads under `cart:features:forestLeafType`.
      if (key === 'forestLeafType') saveForestLeafTypePref(el.checked);
      // Forest-cover overlay — persist the user's choice so the green
      // forest highlight survives a reload once enabled.
      if (key === 'forestCover') {
        saveForestCoverPref(el.checked);
        // Enabling the flat forest view: level the camera to a top-down
        // pitch so the map reads truly flat (no oblique pseudo-3D), to
        // match the Google-Earth landcover reference. The relief/3D
        // layers themselves are dropped by resolveFeatures().
        if (el.checked && typeof map.getPitch === 'function' && map.getPitch() > 0.5) {
          if (caps?.prefersReducedMotion) map.jumpTo({ pitch: 0 });
          else map.easeTo({ pitch: 0, duration: 300 });
        }
        // The hypsometric elevation legend is meaningless in the flat
        // preset (hypso tint is suppressed), so hide it while forest-cover
        // is on and restore it when the user switches back.
        const legendEl = document.getElementById('hypso-legend-host');
        if (legendEl) legendEl.hidden = el.checked;
        // Reveal the forest-mode markup sub-panel only while forest-cover
        // is on — its toggles have no effect outside this mode.
        setForestMarkupPanelVisible(el.checked);
      }
      // Hazardous-terrain overlay defaults to ON; the user's choice
      // (especially "off") needs to outlive the page so the markers
      // don't reappear on every reload.
      if (key === 'hazardousTerrain') saveHazardousTerrainPref(el.checked);
      // Carpathian trail web defaults to ON; persist the user's choice
      // (especially "off") so the red trail lines don't reappear on reload.
      if (key === 'carpathianTrails') saveBoolPref(CARPATHIAN_TRAILS_PREF_KEY, el.checked);
      // Bold orange roads default to ON; persist the user's choice
      // (especially "off") so the heavy orange treatment doesn't
      // reappear on every reload.
      if (key === 'roadsOrangeBold') {
        saveBoolPref(ROADS_ORANGE_BOLD_PREF_KEY, el.checked);
      }
      // Coordinate grid — persist the user's choice (default off) so an
      // ON decision restores the battleship overlay after a reload.
      if (key === 'grid') {
        saveBoolPref(GRID_PREF_KEY, el.checked);
      }
      // Forest-mode markup accents — persist each independent sub-toggle
      // so a customised forest view survives a reload. The flags only
      // emit layers inside the forestCover block, so toggling them while
      // forest-cover is off simply stores the preference for next time.
      if (key in FOREST_MARKUP_PREF_KEYS) {
        saveBoolPref(FOREST_MARKUP_PREF_KEYS[key], el.checked);
      }
      // Any user-driven change to one of the four managed flags is
      // the natural deactivation signal for the Flat hypso preset —
      // the computed predicate handles that automatically here.
      if (FLAT_HYPSO_KEYS.includes(key)) syncFlatHypsoCheckbox();
      await rebuildStyle();
    }));
  };
  wireToggle('labels');
  wireToggle('pois');
  wireToggle('b3d', 'buildings3D');
  wireToggle('hillshade');
  wireToggle('terrain3D');
  wireToggle('contours');
  wireToggle('hypsometricTint');
  wireToggle('bathymetry');
  wireToggle('textureShading');
  wireToggle('skyViewFactor');
  wireToggle('worldcoverTint');
  wireToggle('canopyHeightTint');
  wireToggle('forestLeafType');
  wireToggle('forestCover');
  wireToggle('forestCities');
  wireToggle('forestWaterAccent');
  wireToggle('forestRoadsBold');
  wireToggle('forestRoadsOrange');
  wireToggle('slopeWarning');
  wireToggle('ridgeOverlay');
  wireToggle('carpathian');
  wireToggle('hazardousTerrain');
  wireToggle('carpathianTrails');
  wireToggle('settlementOutline');
  wireToggle('roadsOrangeBold');
  wireToggle('grid');

  // ----- Forest-mode markup sub-panel ----------------------------------
  //
  // Collapse is now owned by the surrounding accordion (its chevron), so
  // there's no bespoke collapse button any more. We only resolve the
  // panel element and seed its enabled/disabled state from the restored
  // forest-cover choice so the rows read correctly on mount.
  forestMarkupPanel = panelsHost.querySelector('[data-forest-markup-panel]');
  setForestMarkupPanelVisible(!!state.layerFeatures.forestCover);

  // ----- Cold-load reconcile of persisted layer prefs ------------------
  //
  // createMap() paints the first frame straight from the FEATURES
  // defaults (main.js passes no featureOverrides). Several layer toggles,
  // however, persist the user's choice across reloads via the
  // `cart:features:*` keys, and `state.layerFeatures` is seeded from those
  // restored prefs above. When a restored pref diverges from its default,
  // the first paint would show the DEFAULT while the checkbox shows the
  // RESTORED value — a silent map/control mismatch (e.g. forest-cover
  // toggled ON last session renders OFF until the user clicks it again).
  //
  // Re-apply the restored feature state exactly once so the rendered map
  // matches the controls. rebuildStyle() routes through resolveFeatures()
  // (so reduced-motion / profile guards still win) and is idempotent, and
  // the guard means a user whose prefs equal the defaults pays no extra
  // style build.
  const PERSISTED_FEATURE_KEYS = [
    'worldcoverTint',
    'canopyHeightTint',
    'forestLeafType',
    'forestCover',
    'forestCities',
    'forestWaterAccent',
    'forestRoadsBold',
    'forestRoadsOrange',
    'hazardousTerrain',
    'carpathianTrails',
    'roadsOrangeBold',
    'grid',
  ];
  if (PERSISTED_FEATURE_KEYS.some((k) => state.layerFeatures[k] !== FEATURES[k])) {
    rebuildStyle().catch(() => {
      /* first-paint reconcile is best-effort — never break boot */
    });
  }

  // ----- Flat hypsometric preset --------------------------------------
  //
  // Atomic batch-patch of the four managed flags + a single applyStyle
  // call. We mirror the new values back onto every dependent checkbox
  // synchronously BEFORE awaiting rebuildStyle so the UI never shows
  // a half-applied state mid-render. If the flags already match the
  // target configuration, this is a no-op (no extra applyStyle).
  if (flatHypsoEl) {
    syncFlatHypsoCheckbox();
    flatHypsoEl.addEventListener('change', async () => {
      // Activation is the only meaningful user action here. Unchecking
      // the preset directly is interpreted as "leave the preset", but
      // since the flat configuration IS the preset, the cleanest
      // behaviour is to toggle Hillshade back on (the most common
      // base relief layer) so the user sees a visible change.
      if (flatHypsoEl.checked) {
        const target = {
          hillshade: false,
          terrain3D: false,
          contours: false,
          hypsometricTint: true,
        };
        const changed = FLAT_HYPSO_KEYS.some(
          (k) => state.layerFeatures[k] !== target[k],
        );
        Object.assign(state.layerFeatures, target);
        // Reflect new flag values on the regular feature checkboxes
        // so the panel rows match state immediately.
        for (const k of FLAT_HYPSO_KEYS) {
          const ctlSel = k === 'hypsometricTint' ? 'hypsometricTint' : k;
          const row = panelsHost.querySelector(`[data-ctl=${ctlSel}]`);
          if (row && row.checked !== state.layerFeatures[k]) {
            row.checked = state.layerFeatures[k];
          }
        }
        if (changed) await rebuildStyle();
      } else {
        // User unticked the preset directly — restore Hillshade so the
        // computed predicate pivots away from "flat hypso" cleanly.
        state.layerFeatures.hillshade = true;
        const hsRow = panelsHost.querySelector('[data-ctl=hillshade]');
        if (hsRow) hsRow.checked = true;
        syncFlatHypsoCheckbox();
        await rebuildStyle();
      }
    });
  }

  // ----- Exaggeration slider ------------------------------------------
  const slider = panelsHost.querySelector('[data-ctl=exaggeration]');
  const readout = panelsHost.querySelector('[data-ctl=exaggeration-readout]');
  if (slider) {
    const updateFill = () => {
      const min = Number(slider.min);
      const max = Number(slider.max);
      const v = Number(slider.value);
      const pct = ((v - min) / (max - min)) * 100;
      slider.style.setProperty('--fill', `${pct}%`);
    };
    const update = () => {
      const v = Number(slider.value);
      if (readout) readout.textContent = `${v.toFixed(1)}×`;
      setUserExaggeration(map, v);
      updateFill();
    };
    slider.addEventListener('input', update);
    update();
  }

  // ----- Preset buttons (Places panel) --------------------------------
  const presetButtons = panelsHost.querySelectorAll('[data-ctl=presets] [data-preset]');
  presetButtons.forEach((b) =>
    b.addEventListener('click', () => {
      flyToPreset(map, b.dataset.preset, {
        reduceMotion: !!caps?.prefersReducedMotion,
      });
      // On narrow screens, close the panel so the map is visible.
      if (caps?.narrow || controller.mqMobile.matches) {
        controller.close();
      }
    }),
  );

  // ----- Drawing engine ------------------------------------------------
  //
  // The engine renders into the map's GeoJSON layer stack and consumes
  // pointer events when "armed". We arm it whenever the drawing panel
  // is open and disarm it as soon as the user closes the panel or
  // switches to another panel — that way the map's default pan/zoom
  // behaviour stays uninterrupted unless the user is actively drawing.
  //
  // The engine survives style rebuilds (theme / quality switches) via
  // its own `styledata` listener so persistent drawings re-appear after
  // a switch without any extra wiring here.
  installDrawingUI(map, panelsHost, controller);

  // ----- Manual settlement contours -----------------------------------
  //
  // Trace settlement outlines the automatic detection missed. Like the
  // drawing engine it owns its own style-rebuild resilience, so no theme
  // wiring is needed here — it re-reads the active theme on reinstall.
  installContourUI(map, panelsHost);

  // ----- Data management panel ------------------------------------------
  //
  // Unified hub for export/import, access control and server sync.
  // Mounts after draw so the draw engine reference is available.
  installDataUI(map, panelsHost);

  // ----- Hypso subsystem ----------------------------------------------
  installHypsoUI(map, panelsHost, { caps, profile: effectiveProfile() });

  // Listen for cart:hypso events on the tint toggle so when external
  // code flips bathymetry, our Relief checkbox follows.
  window.addEventListener('cart:hypso', (e) => {
    if (!e?.detail) return;
    if (typeof e.detail.bathymetry === 'boolean') {
      const el = panelsHost.querySelector('[data-ctl=bathymetry]');
      if (el && el.checked !== e.detail.bathymetry) el.checked = e.detail.bathymetry;
    }
  });

  // ----- Per-parameter explanations (info "?" buttons + popover) ------
  //
  // Inject a "?" affordance beside every labelled control that has a
  // registered description, so the panels can keep only short labels
  // while still offering a full explanation on click / hover. Run after
  // every panel body exists; idempotent, so safe to re-run.
  mountInfoTips(panelsHost);

  // ----- Collapsible block categories (accordions) --------------------
  //
  // One delegated handler toggles every `.acc-head` in the panels root.
  // Restructured panels (Relief, …) build their categories via
  // accordionMarkup(); this activates them and restores saved open state.
  installAccordions(panelsHost);

  // ----- Settings search (fuzzy, multi-field) -------------------------
  //
  // Mounted into the dedicated Search panel. Activating a result opens
  // the owning panel via the DockController, unfolds the accordion that
  // contains the matched control, and flashes the row.
  const searchHost = panelsHost.querySelector('[data-ctl=settings-search-host]');
  if (searchHost) {
    mountSettingsSearch({
      host: searchHost,
      panelsHost,
      onReveal: (panelId, row) => {
        if (panelId && panelId !== 'search') controller.open(panelId);
        if (row) revealRow(panelsHost, row);
      },
    });
  }

  // Reflect detected profile on the UI.
  sidebar.dataset.detectedProfile = state.detectedProfile;

  return state;
}

/**
 * Mount the hypso UI bundle into the panels-root. Manages its own
 * teardown when the style is rebuilt (theme/quality swap).
 */
function installHypsoUI(map, panelsHost, { caps, profile } = {}) {
  const pickerHost = panelsHost.querySelector('[data-ctl=hypso-picker]');
  if (!pickerHost) return;
  const profileLauncher = panelsHost.querySelector('[data-ctl=hypso-profile-launcher]');
  const profileLauncherBtn = panelsHost.querySelector('[data-ctl=open-profile]');
  const statsHost = panelsHost.querySelector('[data-ctl=hypso-stats]');
  const statRefs = {
    min: panelsHost.querySelector('[data-ctl=hypso-stat-min]'),
    mean: panelsHost.querySelector('[data-ctl=hypso-stat-mean]'),
    max: panelsHost.querySelector('[data-ctl=hypso-stat-max]'),
    region: panelsHost.querySelector('[data-ctl=hypso-stat-region]'),
  };

  // Free-floating overlay hosts for legend, editor, and profile drawer.
  const mapEl = map.getContainer();
  const ensureFloat = (id) => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      mapEl.parentElement?.appendChild(el);
    }
    return el;
  };
  const legendHost = ensureFloat('hypso-legend-host');
  const editorHost = ensureFloat('hypso-editor-host');
  const profileHost = ensureFloat('hypso-profile-host');

  const profileConfig = getProfileConfig(profile, caps);

  if (statsHost) statsHost.hidden = !profileConfig.enableHypsoStats;
  const profileEnabled = profileConfig.enableHypsoProfile && !caps?.prefersReducedMotion;
  if (profileLauncher) profileLauncher.hidden = !profileEnabled;

  const handle = mountHypsoUI({
    map,
    pickerHost,
    legendHost: profileConfig.enableHypsoLegend ? legendHost : null,
    editorHost: profileConfig.enableHypsoEditor ? editorHost : null,
    profileHost,
    profile: profileConfig,
    caps,
    theme: document.documentElement.dataset.theme || DEFAULT_THEME,
    showEditor: profileConfig.enableHypsoEditor,
    showLegend: profileConfig.enableHypsoLegend,
    showStats: profileConfig.enableHypsoStats,
    showProfile: profileConfig.enableHypsoProfile,
    autoRegion: profileConfig.enableHypsoAutoRegion,
    onStats: profileConfig.enableHypsoStats
      ? (stats) => {
          if (!statRefs.min) return;
          statRefs.min.textContent = stats.min == null ? '— м' : `${Math.round(stats.min)} м`;
          statRefs.mean.textContent = stats.mean == null ? '— м' : `${Math.round(stats.mean)} м`;
          statRefs.max.textContent = stats.max == null ? '— м' : `${Math.round(stats.max)} м`;
          statRefs.region.textContent = stats.region;
        }
      : undefined,
  });

  if (profileLauncherBtn && profileEnabled) {
    profileLauncherBtn.addEventListener('click', () => handle.openProfile());
  }

  // Cold-load: if forest-cover restored ON, the flat preset is active, so
  // the elevation legend must start hidden to match (the wired change
  // handler keeps it in sync on subsequent toggles). Read the persisted
  // pref directly — this runs in installHypsoUI, which has no `state`.
  if (loadForestCoverPref(FEATURES.forestCover)) {
    legendHost.hidden = true;
  }

  if (typeof window !== 'undefined') {
    window.__cart_hypso = handle;
  }
}

/**
 * Mount the drawing engine + its panel body into the existing dock
 * scaffold. The engine attaches its source/layers to the map; the
 * panel populates the `data-panel-id="draw"` body that `renderPanels`
 * already produced.
 *
 * Lifecycle integration
 * ---------------------
 * The engine is always live — what determines whether map events do
 * anything is the active *tool*. `select` (the default) is passive:
 * it never blocks pan/zoom and only acts when you click an existing
 * draw feature. Every other tool (marker, line, polygon, pencil,
 * shape) actively authors geometry.
 *
 * Why not gate on the panel's open state? The DockController closes
 * the panel on the first outside-pointerdown, which on mobile means
 * the user can NEVER tap the map while the panel is open (the scrim
 * eats the tap). On desktop the close-on-outside fires before the
 * `click` event reaches the engine, so a panel-gated engine misses
 * the very click that should drop a marker. Always-live + passive-
 * select is the only timing-safe model.
 *
 * Idempotent: if the engine is already mounted on the map (e.g. after
 * a hot-reload), the existing handle is reused.
 */
/**
 * Mount the manual settlement-contour UI bundle.
 *
 * Hydrates the `contours` sidebar section with the live panel and binds
 * it to the contour engine. The engine is idempotent and survives style
 * rebuilds on its own; the panel is wired once for the page lifetime.
 */
function installContourUI(map, panelsHost) {
  const section = panelsHost.querySelector('.section[data-panel-id="contours"]');
  if (!section) return;

  // Idempotent factory — a second call returns the existing handle.
  const engine = createSettlementContourEngine(map);
  const unmountPanel = mountContourPanel({ engine, host: section });

  // ── Coordinate with the freehand draw engine ───────────────────────
  // Both engines are ALWAYS live and listen to the same map clicks (see
  // installDrawingUI's lifecycle note). The draw engine authors geometry
  // whenever its active tool is an authoring tool (marker / line / …).
  // So if the user left the draw tool on "Маркеры", every click that
  // traces a settlement contour ALSO drops a numbered draw marker right
  // on top of the contour. When the user starts tracing OR editing a
  // contour we flip the draw engine into its passive "select" tool, so
  // contour clicks no longer double as marker placements. The freehand
  // tool is one tap away in the «Рисование» panel when they want it back.
  // createDrawEngine is idempotent → this is the same instance that
  // installDrawingUI uses, regardless of mount order.
  const drawEngine = createDrawEngine(map);
  engine.on('mode', ({ mode }) => {
    if (mode === 'draw' || mode === 'edit') {
      try { drawEngine.setTool('select'); }
      catch { /* draw engine mid-init — safe to ignore */ }
    }
  });

  // Cancel an in-flight draft when the user navigates away from the
  // panel, so they don't return to a stale rubber-band edge.
  const onPanelToggle = () => {
    const open = section.dataset.active === 'true';
    if (!open) engine.cancelDrawing?.();
  };
  onPanelToggle();
  const observer = new MutationObserver(onPanelToggle);
  observer.observe(section, { attributes: true, attributeFilter: ['data-active'] });

  if (typeof window !== 'undefined') {
    window.__cart_contours = engine;
    window.__cart_contours_panel = { unmount: unmountPanel, observer };
  }
}

function installDrawingUI(map, panelsHost, controller) {
  const drawPanel = panelsHost.querySelector('.section[data-panel-id="draw"]');
  if (!drawPanel) return;
  // In the docked shell the section IS the body container.
  const body = drawPanel;
  if (!body) return;

  // Engine: idempotent factory — calling twice on the same map returns
  // the existing handle.
  const engine = createDrawEngine(map);

  // Panel UI — wires the form controls in `body` to the engine. The
  // returned unmount fn is held for symmetry; we don't call it during
  // normal operation since the panel persists for the page lifetime.
  const unmountPanel = mountDrawPanel({ engine, host: body });

  // Floating distance tooltip — appears on marker click when the
  // measure overlay is enabled. Mounts inside the map container so
  // it overlays the canvas and inherits map-relative coordinates
  // without re-projection. Independent of the panel so the tap
  // affordance keeps working with the panel closed.
  const unmountTooltip = mountMeasureTooltip({ engine, map });

  // Line-action tooltip — tap any line to see a "detach" button.
  const unmountLineAction = mountLineActionTooltip({ engine, map });

  // Single observer drives BOTH (a) the cosmetic drawing-mode flag on
  // <html> for any CSS hooks that want to react to "panel visible",
  // and (b) the cancel-draft-on-close affordance — so the user
  // doesn't return to a stale rubber-band edge after dismissing the
  // panel mid-line.
  const onPanelToggle = () => {
    const open = drawPanel.dataset.active === 'true';
    document.documentElement.dataset.drawing = open ? '1' : '0';
    if (!open) engine.cancelDraft?.();
  };
  onPanelToggle();
  const observer = new MutationObserver(onPanelToggle);
  observer.observe(drawPanel, { attributes: true, attributeFilter: ['data-active'] });

  // Expose for ad-hoc console debugging during development.
  if (typeof window !== 'undefined') {
    window.__cart_draw = engine;
    window.__cart_draw_panel = { unmount: unmountPanel, observer };
    window.__cart_draw_tooltip = { unmount: unmountTooltip };
  }
}


// ---------------------------------------------------------------------------
// Data management panel — export / import / access / sync
// ---------------------------------------------------------------------------

function installDataUI(map, panelsHost) {
  const section = panelsHost.querySelector('.section[data-panel-id="data"]');
  if (!section) return;

  // Get the draw engine reference (idempotent factory)
  const drawEngine = createDrawEngine(map);

  // Mount the data panel and wire all its event handlers
  const panelAPI = mountDataPanel(section, drawEngine);

  // Hook into draw engine changes to auto-sync to server
  if (drawEngine && drawEngine.on) {
    drawEngine.on('change', () => {
      const state = collectLocalState(drawEngine);
      debouncedSave(state);
    });
  }

  // Also sync on localStorage changes (settings, prefs, etc.)
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.startsWith('cart:')) {
      const state = collectLocalState(drawEngine);
      debouncedSave(state);
    }
  });

  // Expose for debugging
  if (typeof window !== 'undefined') {
    window.__cart_data_panel = panelAPI;
  }
}
