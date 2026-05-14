/**
 * Design tokens — the colour palette and typography that drive the entire
 * style system. Everything else in src/style/ consumes tokens from here, so
 * to retheme the map you only need to edit this file.
 *
 * The dark and light variants share the same shape so that style modules
 * stay theme-agnostic. When adding a new semantic slot, add it to BOTH
 * variants so style modules can dereference tokens unconditionally.
 *
 * Semantic groups:
 *   font              — glyph fontstacks available on the tile server
 *   bg / *            — base surfaces, landcover, landuse, parks
 *   water*            — water polygons and waterway lines
 *   *Border           — boundary lines
 *   building*         — 2D + extruded buildings
 *   motorway..path    — road inline fills
 *   *Casing           — road casings
 *   tunnelTint        — desaturated tunnel overlay
 *   text*             — label colours + halos
 *   poi*              — point-of-interest markers
 *   hillshade*        — DEM hillshade colours (multi-directional stack)
 *   sky*              — sky/atmosphere block colours
 *   contour*          — topographic contour lines
 *   hypsoStops        — hypsometric tint elevation→colour ramp (Patterson-ish,
 *                       tuned for the Ukrainian Carpathians, top = Hoverla)
 *   ridge*            — Imhof-style ridge enhancement lines
 *   textPeak/Pass     — mountain feature labels
 *   cycleway/stairs/footway/busGuideway* — secondary road classes
 *   carpathianTrail*  — hiking route emphasis (casing + dashed inline)
 */

// OpenFreeMap currently hosts only Regular / Bold / Italic. We keep four
// semantic slots (regular, medium, bold, italic) so style modules can read
// like prose, but `medium` resolves to Regular for compatibility with the
// available glyph tiles. If/when a Medium fontstack ships upstream this is
// the only line that needs editing.
const SHARED = {
  font: {
    regular: ['Noto Sans Regular'],
    medium: ['Noto Sans Regular'],
    bold: ['Noto Sans Bold'],
    italic: ['Noto Sans Italic'],
  },
};

const LIGHT = {
  ...SHARED,
  bg: '#f4f1ea',

  // Land cover
  forest: '#cadcb4',
  forestEdge: '#bcd1a2',
  grass: '#dfe6c8',
  scrub: '#d8e0bd',
  wetland: '#cad9c2',
  sand: '#efe4c5',
  ice: '#eef3f7',
  rock: '#d8d2c2',

  // Land use
  residential: '#ece8df',
  industrial: '#e4ddcf',
  commercial: '#ecdfd6',
  cemetery: '#d9dfc6',
  hospital: '#f3dadd',
  school: '#ecddc2',
  park: '#cfe1b8',
  pitch: '#c7dca6',

  // Water
  water: '#a4c8e1',
  waterOutline: '#88b6d3',
  waterway: '#a4c8e1',

  // Boundaries — country line is a crisp white core with a dark
  // aubergine halo (`countryBorderGlow`), painted as a two-pass
  // cartographic glow in `boundaries.js`. The halo lifts the white
  // off ANY terrain colour — warm hypso, snow stops, cream paper —
  // so the boundary stays luminous everywhere. Region + city stay
  // muted lavender so the admin hierarchy (country > region > city)
  // remains visually obvious.
  countryBorder: '#ffffff',
  countryBorderGlow: '#2a1422',
  regionBorder: '#bcaab8',
  cityBorder: '#cdbac9',

  // Buildings
  building: '#e2dccd',
  buildingOutline: '#c8c0ad',
  building3D: '#e8e2d2',

  // Roads (inline / fill)
  motorway: '#ffb961',
  trunk: '#ffc870',
  primary: '#ffd180',
  secondary: '#ffe19c',
  tertiary: '#fff0b8',
  minor: '#ffffff',
  service: '#fafafa',
  track: '#f5e8d2',
  path: '#d8c89a',
  pedestrian: '#ede4d4',
  rail: '#9aa0aa',

  // Roads (casing / outline)
  motorwayCasing: '#d97706',
  trunkCasing: '#c97824',
  primaryCasing: '#a78448',
  secondaryCasing: '#a99464',
  tertiaryCasing: '#b3a37c',
  minorCasing: '#b8b0a0',
  serviceCasing: '#c7bfae',
  trackCasing: '#a08e6c',
  pathCasing: '#9d8a5a',
  pedestrianCasing: '#bcaf94',

  // Tunnels — desaturated copies blended with bg
  tunnelTint: '#efe7d6',

  // Labels
  textPrimary: '#3a342a',
  textSecondary: '#5b5447',
  textHalo: '#fbfaf6',
  textWater: '#3d6b8a',
  textWaterHalo: '#e9f0f6',
  textPark: '#3d5d2a',
  textRoad: '#2c2820',
  textRoadHalo: '#fdfaf2',
  textBoundary: '#6f5f6c',

  // POI
  poiFill: '#5a6e84',
  poiHalo: '#ffffff',

  // ---------------------------------------------------------------------
  // Relief & atmosphere — Swiss-cartography inspired light-day palette.
  // Shadow is a warm umber, highlight a soft cream, accent pulls toward
  // the same umber to unify shaded slopes with the paper background.
  // ---------------------------------------------------------------------
  hillshadeShadow: '#4a3220',
  hillshadeHighlight: '#fff9ec',
  hillshadeAccent: '#7a5a38',

  // Sky / atmosphere — daylight haze. Horizon is pale warm white, sky is
  // a gentle blue, fog is high-key to let terrain peek through at pitch.
  skyTop: '#8bb3d3',
  skyHorizon: '#f6eed7',
  skyFog: '#eadfc6',

  // Contour lines — amber/sepia, minor is near-invisible, major reads as
  // pencil. Labels use the same family with a cream halo.
  contourMinor: '#b38a54',
  contourMajor: '#8a6130',
  contourLabel: '#5f3f16',
  contourLabelHalo: '#fbf4e3',

  // Hypsometric tint — Patterson cross-blended ramp tuned to Ukraine's
  // relief: water→lowland green→foothill yellow→highland ochre→alpine
  // grey→snowy white. Top = Hoverla (2061m). Stops are [elevation_m, rgb].
  hypsoStops: [
    [-10, '#a9cfe6'],
    [0, '#d0dfb8'],
    [200, '#e9e4a8'],
    [500, '#d9b880'],
    [900, '#ad8a55'],
    [1400, '#8c7554'],
    [1800, '#b3a69a'],
    [2100, '#f1ecea'],
  ],

  // Ridge enhancement — Imhof-style double-stroke: dark bottom offset,
  // light top offset for a sculpted feel. Lighter of the two must sit on
  // top of the darker one.
  ridgeDark: '#3a2a1b',
  ridgeLight: '#fff4d9',

  // Mountain feature labels.
  textPeak: '#3a2a1b',
  textPeakHalo: '#fbf4e3',
  textPass: '#5f4420',
  textPassHalo: '#f8edd3',

  // Extra road classes (cycleway / stairs / footway / bus guideway).
  cycleway: '#ebd7f2',
  cyclewayCasing: '#8f5aa3',
  stairs: '#eadac0',
  stairsCasing: '#a08960',
  footway: '#f4ebdb',
  footwayCasing: '#a8946e',
  busGuideway: '#d9dfe9',
  busGuidewayCasing: '#5a6f8f',

  // Hiking trail emphasis — casing (light halo), dashed red inline.
  carpathianTrail: '#cc3b1f',
  carpathianTrailCasing: '#fff8e8',
  carpathianTrailDim: '#b65030',
};

const DARK = {
  ...SHARED,
  bg: '#0e1318',

  forest: '#1c2a1e',
  forestEdge: '#243321',
  grass: '#1f2a1d',
  scrub: '#21291b',
  wetland: '#1a2622',
  sand: '#2a2820',
  ice: '#1d262b',
  rock: '#23232b',

  residential: '#171c22',
  industrial: '#191e22',
  commercial: '#1d1e23',
  cemetery: '#1a2018',
  hospital: '#241a1d',
  school: '#231e16',
  park: '#1f2c1c',
  pitch: '#1c2c17',

  water: '#0e2a3c',
  waterOutline: '#0a1f2c',
  waterway: '#0e2a3c',

  // Country line is a crisp white core with a pure-black halo
  // (`countryBorderGlow`) so it stays luminous against the dimmed
  // dark-theme hypso palette. Region + city remain progressively
  // darker to preserve admin hierarchy.
  countryBorder: '#ffffff',
  countryBorderGlow: '#000000',
  regionBorder: '#3d3742',
  cityBorder: '#2c2730',

  building: '#1d2229',
  buildingOutline: '#262c34',
  building3D: '#252b34',

  motorway: '#7d4d12',
  trunk: '#7a4f1a',
  primary: '#6f4f24',
  secondary: '#574326',
  tertiary: '#403521',
  minor: '#2e3138',
  service: '#272a32',
  track: '#3a3326',
  path: '#5b4f36',
  pedestrian: '#2a2c34',
  rail: '#3a3f48',

  motorwayCasing: '#f0a850',
  trunkCasing: '#d99852',
  primaryCasing: '#b08c5c',
  secondaryCasing: '#766240',
  tertiaryCasing: '#5b4d34',
  minorCasing: '#414853',
  serviceCasing: '#363b46',
  trackCasing: '#5a4d34',
  pathCasing: '#7c6c48',
  pedestrianCasing: '#3c3f4a',

  tunnelTint: '#181c22',

  textPrimary: '#d8d6cf',
  textSecondary: '#aeaba0',
  textHalo: '#0c1115',
  textWater: '#79b3d4',
  textWaterHalo: '#0d1f2a',
  textPark: '#9bbf7a',
  textRoad: '#e8e4d4',
  textRoadHalo: '#11151a',
  textBoundary: '#8f7e8d',

  poiFill: '#a5b6c8',
  poiHalo: '#0e131a',

  // ---------------------------------------------------------------------
  // Relief & atmosphere — inverted twilight palette. Shadow is deep cold
  // slate; highlight is a dim cream that still keeps ridges legible
  // against the black background without glaring.
  // ---------------------------------------------------------------------
  hillshadeShadow: '#050812',
  hillshadeHighlight: '#5b6570',
  hillshadeAccent: '#263145',

  skyTop: '#0a1220',
  skyHorizon: '#1a2330',
  skyFog: '#0a0e14',

  contourMinor: '#5a4a34',
  contourMajor: '#8a6f48',
  contourLabel: '#d0b67c',
  contourLabelHalo: '#0e1318',

  // Darker tint ramp — keep the hue sequence but pull all values down.
  hypsoStops: [
    [-10, '#0e2a3c'],
    [0, '#16231a'],
    [200, '#232b1f'],
    [500, '#302a1b'],
    [900, '#3e3224'],
    [1400, '#46382a'],
    [1800, '#4f463e'],
    [2100, '#6f6b66'],
  ],

  ridgeDark: '#0a0a0a',
  ridgeLight: '#f0e1b4',

  textPeak: '#f0e6cf',
  textPeakHalo: '#0e131a',
  textPass: '#cbb38a',
  textPassHalo: '#0e131a',

  cycleway: '#34263a',
  cyclewayCasing: '#a37ab6',
  stairs: '#332a1f',
  stairsCasing: '#8a7250',
  footway: '#2c2820',
  footwayCasing: '#6f6244',
  busGuideway: '#222933',
  busGuidewayCasing: '#8096b6',

  carpathianTrail: '#ff5b3d',
  carpathianTrailCasing: '#0e1318',
  carpathianTrailDim: '#c2432a',
};

export const TOKENS = Object.freeze({ light: LIGHT, dark: DARK });

/** Helper: pull tokens by name with a safe fallback to light. */
export function getTokens(theme) {
  return TOKENS[theme] ?? TOKENS.light;
}
