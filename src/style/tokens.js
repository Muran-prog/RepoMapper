/**
 * Design tokens — the colour palette and typography that drive the entire
 * style system. Everything else in src/style/ consumes tokens from here, so
 * to retheme the map you only need to edit this file.
 *
 * The dark and light variants share the same shape so that style modules
 * stay theme-agnostic.
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

  // Boundaries
  countryBorder: '#9b8b9a',
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

  countryBorder: '#5a4f60',
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
};

export const TOKENS = Object.freeze({ light: LIGHT, dark: DARK });

/** Helper: pull tokens by name with a safe fallback to light. */
export function getTokens(theme) {
  return TOKENS[theme] ?? TOKENS.light;
}
