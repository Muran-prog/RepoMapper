/**
 * Setting-row icon set + rich-row markup helpers.
 *
 * The redesigned panels give every individual setting its own small,
 * purpose-built icon, a bold title and a one-line plain-language
 * description, instead of a bare label + switch. This module is the
 * single source of truth for:
 *
 *   • SETTING_ICONS  — one Lucide-style line glyph per setting id
 *   • richRow()      — markup for an icon + title + description + control
 *   • groupNote()    — an accent callout block (HTML divider / hint)
 *   • sectionLede()  — a short intro paragraph that opens a section
 *
 * All glyphs share the dock's visual vocabulary: 24×24 viewBox, single
 * stroke, 1.7 width, rounded caps/joins, `currentColor` so they inherit
 * the row's text colour (and the accent colour when active).
 *
 * The markup intentionally leans on HTML structure — semantic lists,
 * hairline dividers, accent rails, descriptor lines — so the panels read
 * as a properly designed settings surface rather than a flat checklist.
 */

const svg = (path, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${path}</svg>`;

/**
 * Per-setting icons. Keyed by the control's `data-ctl` id so a row can
 * look its glyph up automatically. Each shape is chosen to read as its
 * function at 18–20 px.
 */
export const SETTING_ICONS = Object.freeze({
  // ---- Layers ----------------------------------------------------------
  labels: svg('<path d="M4 7 H13 L20 12 L13 17 H4 z"/><circle cx="8" cy="12" r="1.2" fill="currentColor" stroke="none"/>'),
  pois: svg('<circle cx="12" cy="10" r="2.4"/><path d="M12 21 S5 14 5 9.5 a7 7 0 0 1 14 0 C19 14 12 21 12 21 z"/>'),
  b3d: svg('<path d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 z"/><path d="M12 3 V21 M4 7.5 L12 12 L20 7.5"/>'),
  roadsOrangeBold: svg('<path d="M8 21 L10 3"/><path d="M16 21 L14 3"/><path d="M12 6 V8 M12 11 V13 M12 16 V18"/>'),
  settlementOutline: svg('<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 2"/><rect x="9" y="9" width="6" height="6"/>'),
  grid: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="1"/><path d="M9 3.5 V20.5 M15 3.5 V20.5 M3.5 9 H20.5 M3.5 15 H20.5"/>'),

  // ---- Relief: base ----------------------------------------------------
  flatHypso: svg('<rect x="3.5" y="6" width="17" height="12" rx="1"/><path d="M3.5 11 H20.5 M3.5 14 H20.5"/>'),
  hillshade: svg('<path d="M3 19 L9 8 L13 14 L17 7 L21 19 z"/><path d="M9 8 L11 19 M17 7 L15.5 19" opacity="0.5"/>'),
  terrain3D: svg('<path d="M2 18 L8 7 L12 13 L16 6 L22 18 z"/><path d="M2 18 L12 22 L22 18" opacity="0.6"/>'),
  contours: svg('<path d="M4 18 C 8 14 16 14 20 18"/><path d="M6 14 C 9 11 15 11 18 14"/><path d="M8.5 10.5 C 10.5 9 13.5 9 15.5 10.5"/>'),
  hypsometricTint: svg('<path d="M3 20 L9 9 L13 15 L17 8 L21 20 z"/><path d="M3 20 H21" stroke-width="2.4"/>'),
  bathymetry: svg('<path d="M3 8 Q 7.5 5 12 8 T 21 8"/><path d="M3 13 Q 7.5 10 12 13 T 21 13" opacity="0.7"/><path d="M3 18 Q 7.5 15 12 18 T 21 18" opacity="0.4"/>'),
  textureShading: svg('<path d="M4 20 L10 6 L16 20 z"/><path d="M6.5 14 H13.5 M8 11 H12" opacity="0.6"/>'),
  skyViewFactor: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3 V5.5 M12 18.5 V21 M3 12 H5.5 M18.5 12 H21 M5.6 5.6 L7.3 7.3 M16.7 16.7 L18.4 18.4 M5.6 18.4 L7.3 16.7 M16.7 7.3 L18.4 5.6"/>'),

  // ---- Relief: land cover & forest ------------------------------------
  worldcoverTint: svg('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1" opacity="0.55"/><rect x="3" y="13" width="8" height="8" rx="1" opacity="0.55"/><rect x="13" y="13" width="8" height="8" rx="1"/>'),
  canopyHeightTint: svg('<path d="M12 3 L9 8 L11 8 L8 12 L10 12 L7 16 L17 16 L14 12 L16 12 L13 8 L15 8 z"/><path d="M12 16 V21"/>'),
  forestLeafType: svg('<path d="M6 17 L9 8 L12 17 z"/><path d="M9 17 V20"/><circle cx="16" cy="12" r="4"/><path d="M16 16 V20"/>'),
  forestCover: svg('<path d="M5 16 L8 9 L11 16 z" fill="currentColor" stroke="none"/><path d="M13 17 L16.5 8 L20 17 z" fill="currentColor" stroke="none"/><path d="M8 16 V19 M16.5 17 V20" stroke-width="1.4"/>'),
  forestCities: svg('<path d="M4 21 V11 L9 8 V21 z"/><path d="M9 21 V6 L15 9 V21 z"/><path d="M12 12 H12.01 M12 16 H12.01"/>'),
  forestWaterAccent: svg('<path d="M5 6 Q 9 3 12 6 T 19 6"/><path d="M5 12 Q 9 9 12 12 T 19 12"/><path d="M5 18 Q 9 15 12 18 T 19 18"/>'),
  forestRoadsBold: svg('<path d="M9 21 L11 3"/><path d="M15 21 L13 3"/><path d="M12 6 V9 M12 12 V15"/>'),
  forestRoadsOrange: svg('<path d="M6 20 L18 4"/><path d="M9 11 L11 12 M13 8 L15 9" opacity="0.6"/>'),

  // ---- Relief: safety & routes ----------------------------------------
  slopeWarning: svg('<path d="M3 20 L19 6"/><path d="M19 6 V12 M19 6 H13"/><path d="M3 20 H10" opacity="0.5"/>'),
  hazardousTerrain: svg('<path d="M3 20 L10 7 L13 12 L16 8 L21 20 z"/><path d="M12 12 V15.5"/><circle cx="12" cy="18" r="0.6" fill="currentColor"/>'),
  ridgeOverlay: svg('<path d="M3 16 L8 9 L11 13 L15 6 L21 15"/><path d="M8 9 L8 19 M15 6 L15 19" opacity="0.4"/>'),

  // ---- Relief: Carpathians --------------------------------------------
  carpathian: svg('<path d="M2 19 L7 8 L10 13 L14 5 L18 13 L22 19 z"/><circle cx="14" cy="4" r="1" fill="currentColor" stroke="none"/>'),
  carpathianTrails: svg('<path d="M6 21 C 6 16 12 16 12 12 S 18 8 18 3"/><circle cx="6" cy="21" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="3" r="1.4" fill="currentColor" stroke="none"/>'),
  exaggeration: svg('<path d="M12 3 V21"/><path d="M8 7 L12 3 L16 7 M8 17 L12 21 L16 17"/>'),

  // ---- Settings --------------------------------------------------------
  quality: svg('<path d="M12 3 L14.6 8.3 L20.5 9.1 L16.2 13.2 L17.3 19 L12 16.2 L6.7 19 L7.8 13.2 L3.5 9.1 L9.4 8.3 z"/>'),
});

/** HTML-escape helper for any interpolated copy. */
function esc(s) {
  return (s || '').toString().replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Rich toggle row — icon + (title / description) + switch.
 *
 * @param {object} o
 * @param {string} o.ctl        the `data-ctl` id (also selects the icon)
 * @param {string} o.title      bold setting name
 * @param {string} o.desc       one-line plain-language description
 * @param {boolean} [o.checked] initial checked state
 * @param {string} [o.rowAttr]  extra attributes for the <label> (e.g. data-ctl-row)
 * @param {string} [o.icon]     icon override (defaults to SETTING_ICONS[ctl])
 * @returns {string}
 */
export function richRow({ ctl, title, desc, checked = false, rowAttr = '', icon }) {
  const glyph = icon ?? SETTING_ICONS[ctl] ?? '';
  return `
    <label class="row row-rich" ${rowAttr}>
      <span class="row-ico" aria-hidden="true">${glyph}</span>
      <span class="row-main">
        <span class="row-title">${esc(title)}</span>
        <span class="row-desc">${esc(desc)}</span>
      </span>
      <input type="checkbox" data-ctl="${esc(ctl)}"${checked ? ' checked' : ''}>
    </label>
  `;
}

/**
 * Accent callout block — a hairline-railed note used to explain a group
 * dependency or give context. Reads as a clearly separated HTML block.
 *
 * @param {string} text
 * @param {object} [o]
 * @param {'info'|'warn'} [o.tone='info']
 */
export function groupNote(text, { tone = 'info' } = {}) {
  return `<p class="group-note" data-tone="${tone}">${esc(text)}</p>`;
}

/** Short section intro paragraph (HTML lede above the first group). */
export function sectionLede(text) {
  return `<p class="section-lede">${esc(text)}</p>`;
}

/** A labelled horizontal divider used to separate sub-areas in a group. */
export function divider(label = '') {
  return label
    ? `<div class="rule-label"><span>${esc(label)}</span></div>`
    : `<hr class="rule">`;
}
