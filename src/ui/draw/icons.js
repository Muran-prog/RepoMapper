/**
 * Drawing-panel icon set — Lucide-style single-stroke line icons with
 * a 1.7 stroke width and rounded caps/joins. Matches the existing dock
 * icon vocabulary in `src/ui/controls.js` so the new panel feels like
 * part of the same family.
 */

const stroke = (path, opts = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${opts}>${path}</svg>`;

export const DRAW_ICONS = Object.freeze({
  // ----- Dock entry icon (pencil over a small map node) ----------------
  dock: stroke(`
    <path d="M3.5 20.5 L8 19 L19.5 7.5 a2 2 0 0 0 -2.8 -2.8 L5.2 16.2 L3.5 20.5 z"/>
    <path d="M14.5 7.5 L17.5 10.5"/>
    <circle cx="6.7" cy="17.3" r="1.1" fill="currentColor" stroke="none"/>
  `),

  // ----- Tool palette --------------------------------------------------
  select: stroke(`
    <path d="M5 4 L19 12 L13 13 L11 19 z"/>
  `),
  marker: stroke(`
    <path d="M12 21 S5 14 5 9 a7 7 0 0 1 14 0 c0 5 -7 12 -7 12 z"/>
    <circle cx="12" cy="9" r="2.4"/>
  `),
  line: stroke(`
    <circle cx="5" cy="6" r="2"/>
    <circle cx="19" cy="18" r="2"/>
    <line x1="6.5" y1="7.5" x2="17.5" y2="16.5"/>
  `),
  polygon: stroke(`
    <path d="M12 4 L19 9 L17 18 L7 18 L5 9 z"/>
    <circle cx="12" cy="4" r="1.6" fill="currentColor" stroke="none"/>
    <circle cx="19" cy="9" r="1.6" fill="currentColor" stroke="none"/>
    <circle cx="17" cy="18" r="1.6" fill="currentColor" stroke="none"/>
    <circle cx="7" cy="18" r="1.6" fill="currentColor" stroke="none"/>
    <circle cx="5" cy="9" r="1.6" fill="currentColor" stroke="none"/>
  `),
  pencil: stroke(`
    <path d="M4 20 C 8 12 16 12 20 4"/>
    <circle cx="4" cy="20" r="1.2" fill="currentColor" stroke="none"/>
  `),
  // Eraser — classic rubber/eraser block tilted along a diagonal so the
  // square corner reads as the active "tip" pointing toward the bottom-
  // left of the icon. The diagonal divider hints at the two-tone
  // schoolbook look; small flecks underneath suggest the wiped-off mark.
  eraser: stroke(`
    <path d="M3.5 17 L11 9.5 a2 2 0 0 1 2.8 0 L19.5 15.2 a2 2 0 0 1 0 2.8 L17.3 20.2 a2 2 0 0 1 -1.4 0.6 H8 a2 2 0 0 1 -1.4 -0.6 L3.5 17 z"/>
    <path d="M9 11.5 L17.5 20"/>
    <path d="M5 21 H10"/>
  `),

  // ----- Shape templates -----------------------------------------------
  shapeCircle: stroke(`
    <circle cx="12" cy="12" r="7.5"/>
  `),
  shapeRect: stroke(`
    <rect x="4.5" y="6.5" width="15" height="11" rx="1.4"/>
  `),
  shapeHex: stroke(`
    <path d="M12 3.5 L20 8 L20 16 L12 20.5 L4 16 L4 8 z"/>
  `),
  shapePent: stroke(`
    <path d="M12 3.5 L20.5 9.5 L17 19.5 L7 19.5 L3.5 9.5 z"/>
  `),
  shapeTri: stroke(`
    <path d="M12 4 L20 19 L4 19 z"/>
  `),
  shapeStar: stroke(`
    <path d="M12 3.5 L14.3 9.4 L20.5 9.9 L15.8 14 L17.4 20 L12 16.7 L6.6 20 L8.2 14 L3.5 9.9 L9.7 9.4 z"/>
  `),
  shapeArrow: stroke(`
    <line x1="4" y1="12" x2="17" y2="12"/>
    <path d="M13 7 L19 12 L13 17"/>
  `),

  // ----- Connection modes ----------------------------------------------
  connectionNone: stroke(`
    <circle cx="6"  cy="6"  r="2"/>
    <circle cx="18" cy="6"  r="2"/>
    <circle cx="6"  cy="18" r="2"/>
    <circle cx="18" cy="18" r="2"/>
  `),
  connectionSequence: stroke(`
    <circle cx="5"  cy="6"  r="1.8"/>
    <circle cx="12" cy="11" r="1.8"/>
    <circle cx="19" cy="18" r="1.8"/>
    <path d="M5.6 7.4 L11.4 9.6 M12.6 12.4 L18.4 16.6"/>
  `),
  connectionOptimal: stroke(`
    <circle cx="5"  cy="14" r="1.8"/>
    <circle cx="10" cy="6"  r="1.8"/>
    <circle cx="14" cy="18" r="1.8"/>
    <circle cx="19" cy="9"  r="1.8"/>
    <path d="M5.7 12.5 L9.3 7.5 M10.6 7.4 L13.4 16.6 M14.7 16.7 L18.3 10.4"/>
  `),
  connectionMesh: stroke(`
    <circle cx="6"  cy="6"  r="1.8"/>
    <circle cx="18" cy="6"  r="1.8"/>
    <circle cx="6"  cy="18" r="1.8"/>
    <circle cx="18" cy="18" r="1.8"/>
    <path d="M7.5 6 L16.5 6 M6 7.5 L6 16.5 M18 7.5 L18 16.5 M7.5 18 L16.5 18 M7.4 7.4 L16.6 16.6 M16.6 7.4 L7.4 16.6"/>
  `),
  connectionHub: stroke(`
    <circle cx="12" cy="12" r="2.4"/>
    <circle cx="4"  cy="6"  r="1.5"/>
    <circle cx="4"  cy="18" r="1.5"/>
    <circle cx="20" cy="6"  r="1.5"/>
    <circle cx="20" cy="18" r="1.5"/>
    <path d="M5.2 6.8 L10.2 10.8 M5.2 17.2 L10.2 13.2 M18.8 6.8 L13.8 10.8 M18.8 17.2 L13.8 13.2"/>
  `),

  // ----- Actions -------------------------------------------------------
  trash: stroke(`
    <path d="M5 7 H19"/>
    <path d="M10 4 H14 a1 1 0 0 1 1 1 V7 H9 V5 a1 1 0 0 1 1 -1 z"/>
    <path d="M6.5 7 L7.5 19 a1 1 0 0 0 1 1 H15.5 a1 1 0 0 0 1 -1 L17.5 7"/>
    <line x1="10" y1="11" x2="10" y2="17"/>
    <line x1="14" y1="11" x2="14" y2="17"/>
  `),
  broom: stroke(`
    <path d="M14 4 L19 9"/>
    <path d="M9 9 L15 3 L21 9 L15 15 z"/>
    <path d="M9.5 14.5 L4 20 L8 20"/>
    <path d="M11.5 16.5 L8 20"/>
    <path d="M13 18 L11 20"/>
  `),
  undo: stroke(`
    <path d="M9 14 L4 9 L9 4"/>
    <path d="M4 9 H13 a6 6 0 0 1 6 6 v0 a6 6 0 0 1 -6 6 H8"/>
  `),
  redo: stroke(`
    <path d="M15 14 L20 9 L15 4"/>
    <path d="M20 9 H11 a6 6 0 0 0 -6 6 v0 a6 6 0 0 0 6 6 h5"/>
  `),
  download: stroke(`
    <path d="M12 4 V15"/>
    <path d="M7.5 11 L12 15.5 L16.5 11"/>
    <path d="M5 19 H19"/>
  `),
  upload: stroke(`
    <path d="M12 16 V5"/>
    <path d="M7.5 9 L12 4.5 L16.5 9"/>
    <path d="M5 19 H19"/>
  `),

  // ----- Status --------------------------------------------------------
  geodesic: stroke(`
    <ellipse cx="12" cy="12" rx="9" ry="3.5"/>
    <ellipse cx="12" cy="12" rx="3.5" ry="9"/>
    <circle cx="12" cy="12" r="9"/>
  `),
  label: stroke(`
    <path d="M4 6 H13 L20 12 L13 18 H4 z"/>
    <circle cx="8.5" cy="12" r="1.2" fill="currentColor" stroke="none"/>
  `),
  ruler: stroke(`
    <rect x="3" y="9" width="18" height="6" rx="1" transform="rotate(-12 12 12)"/>
    <line x1="6.4"  y1="9.4"  x2="6.7"  y2="11.4"/>
    <line x1="9"    y1="8.6"  x2="9.3"  y2="11.4"/>
    <line x1="11.6" y1="7.8"  x2="11.9" y2="11.4"/>
    <line x1="14.2" y1="7"    x2="14.5" y2="11.4"/>
    <line x1="16.8" y1="6.2"  x2="17.1" y2="11.4"/>
  `),
});
