import { WORLDCOVER_RAMPS } from './worldcover-ramps.js';
import { CANOPY_RAMPS } from './canopy-height-ramps.js';
import { FOREST_LEAF, FOREST_PROTECT, FOREST_LABEL } from './forest-leaf-tokens.js';

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
  // Forest-cover overlay — a vivid, Google-Earth-style green highlight of
  // every wooded polygon, painted as a SEPARATE toggleable layer (not the
  // pale base `forest` wash above). `fill` is a rich leaf-green read at a
  // Forest-cover overlay — a deliberately FLAT, Google-Earth-style two-tone
  // read: `fill` is a saturated near-opaque forest green that becomes the
  // dominant surface colour, and `edge` is a darker casing that crisps every
  // stand boundary so the mass reads sharper than the soft raster reference.
  // No relief/3D shows through (forest-cover forces the flat preset), so the
  // fill no longer needs to be translucent. Consumed exclusively by
  // `src/style/forest-cover.js`.
  forestCover: Object.freeze({
    fill: '#2f7d54',
    edge: '#1c5536',
  }),
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

  // Buildings — accent-tinted clay so the urban fabric clearly
  // separates from the cream paper background. The base 2D fill
  // sits a few shades darker and warmer than `bg`, the outline
  // pulls toward the accent amber, and `building3D` is a touch
  // lighter so the extruded layer reads as illuminated walls.
  // Landmark tokens below stay as the "premium" tier — same
  // family but more saturated.
  building: '#e8d6b4',
  buildingOutline: '#a86a1d',
  building3D: '#ecd6b0',
  // Soft outer halo around every building; brighter than the
  // landmark glow so buildings pop against the cream fabric, but
  // still tuned for the same amber accent family.
  buildingGlowOuter: 'rgba(217, 119, 6, 0.36)',
  buildingGlowInner: 'rgba(217, 119, 6, 0.55)',

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

  // Place dots — bright accent core + soft halo for city / town / village /
  // hamlet markers. Same hue family as the road & landmark accents so a
  // city dot reads as an "important point" relative to the cool-cream
  // fabric. Used by labels.js — see placeDots() for the per-class radius
  // curve. Reuses the existing amber accent so we don't grow the palette.
  placeDot: '#d97706',
  placeDotStroke: '#ffffff',
  placeDotGlow: 'rgba(217, 119, 6, 0.34)',

  // Forest-mode markup accents — only consumed inside the flat
  // "Лесной покров" view (see src/style/forest-markup.js). A vivid,
  // saturated blue family that pops against the flat green forest mass:
  //   • city accent — bold blue text + matching dot so settlements read
  //     instantly on the green canvas (the headline forest-mode toggle).
  //   • water accent — a brighter, heavier waterway/label blue so rivers
  //     and lakes stand out from the forest fill.
  //   • road accent — a near-black bold casing on the road skeleton so
  //     the major network reads cleanly over the green.
  forestCityAccent: '#1d4ed8',
  forestCityAccentHalo: '#ffffff',
  forestWaterAccent: '#2563eb',
  forestWaterAccentHalo: '#eef4ff',
  forestRoadBold: '#1e293b',
  forestRoadBoldHalo: '#ffffff',

  // ---------------------------------------------------------------------
  // Relief & atmosphere — Swiss-cartography inspired light-day palette.
  // Shadow is a deep warm umber for pronounced ridge contrast (matches
  // classic OSM topo references where shaded slopes read as strong
  // sepia rather than a faint wash). Highlight stays a soft cream;
  // accent pulls toward the same umber so cliffs / cirques don't pick
  // up a competing hue.
  // ---------------------------------------------------------------------
  hillshadeShadow: '#241509',
  hillshadeHighlight: '#fff9ec',
  hillshadeAccent: '#5a3e22',

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

  // SAC mountain hiking grading (T1 walking → T6 alpine grade III).
  // The scale colours are independent of the OSMC marked-route palette;
  // they communicate physical difficulty regardless of paint markings.
  // Each pair is [inline, dim/dark accent for halo/glow].
  sacScale: {
    t1: '#2f8b3d', // hiking — green
    t2: '#e4b02e', // mountain hiking — yellow
    t3: '#e07a26', // demanding mountain hiking — orange
    t4: '#cc3b1f', // alpine — red
    t5: '#7d3aa3', // demanding alpine — purple
    t6: '#1e1e1e', // difficult alpine — black
  },
  // Marked but no SAC grade. Slightly cooler red than the T4 alpine
  // tone so a "marked but ungraded" route doesn't read as alpine.
  sacScaleNeutral: '#a04030',
  // Via-ferrata — black serration over red inline. Scale text uses
  // the same black so K1..K6 reads against the route halo.
  trailViaFerrata: '#1e1e1e',
  // Informal stitches — un-maintained social trails. Painted as a
  // thin desaturated grey dot pattern over whatever's underneath.
  trailInformal: '#7a766c',
  // Bridges — white perpendicular hatching on top of the trail
  // casing. Reads as a structural stripe at every zoom.
  trailBridge: '#ffffff',

  // ---------------------------------------------------------------------
  // Premium glow accents — derived from the existing accent family
  // (motorwayCasing amber for roads/labels, the trail red for trails,
  // hillshadeAccent earth tone for peaks). All semi-transparent so
  // the underlying terrain still reads through. Use only on layers
  // that carry the "important" filter — not for residentials, generic
  // POIs, or hamlets.
  // ---------------------------------------------------------------------
  // Roads — major (motorway/trunk/primary/secondary) gets a fuller wash;
  // minor (tertiary) gets a quieter but still visible rim. Residentials
  // and services stay bare. Two-tier glow per road: a wider OUTER ring
  // for ambient amber wash, and a tighter INNER ring for visible heat.
  roadGlowMajor: 'rgba(217, 119, 6, 0.42)',
  roadGlowMajorOuter: 'rgba(217, 119, 6, 0.22)',
  roadGlowMinor: 'rgba(180, 110, 30, 0.34)',
  roadGlowMinorOuter: 'rgba(180, 110, 30, 0.16)',

  // Buildings — landmark accent (warm clay distinguishes from the
  // generic cool-cream `building` token), outline + glow share the
  // same amber accent family for cohesion.
  buildingLandmark: '#e8c995',
  buildingLandmarkOutline: '#9c5a1c',
  buildingLandmarkGlowOuter: 'rgba(217, 119, 6, 0.22)',
  buildingLandmarkGlowInner: 'rgba(217, 119, 6, 0.40)',

  // Labels — town/city glow + key POI glow.
  textGlowImportant: 'rgba(217, 119, 6, 0.30)',
  poiGlowImportant: 'rgba(217, 119, 6, 0.32)',

  // Carpathian — peak markers and trail halo.
  peakMarker: '#3a2a1b',
  peakMarkerGlow: 'rgba(122, 90, 56, 0.45)',
  trailGlow: 'rgba(204, 59, 31, 0.38)',
  textPeakGlow: 'rgba(122, 90, 56, 0.42)',

  // ---------------------------------------------------------------------
  // Settlement outlines — heavy boundary stroke around residential
  // landuse polygons. Mirrors the road glow → casing → inline pattern
  // so villages / towns / cities read as framed plots at country
  // overview zoom (where the soft cream `residential` fill is invisible).
  //
  // Hue choice: deep violet. Roads own amber, trails own red, cliffs
  // own teal, hazards own magenta + tangerine, forests own green.
  // Violet is the only unclaimed accent in the project, so a settlement
  // frame reads as its own tier in the cartographic hierarchy without
  // colliding with any existing layer. See `settlements.js` for the
  // four-layer paint stack that consumes these tokens.
  // ---------------------------------------------------------------------
  settlementInline: '#7c3aed',                       // bright violet core
  settlementCasing: '#3b1e6e',                       // deep aubergine frame
  settlementGlow: 'rgba(124, 58, 237, 0.45)',        // inner heat ring
  settlementGlowOuter: 'rgba(124, 58, 237, 0.22)',   // outer ambient wash

  // Slope-warning overlay — translucent red gradient for steep terrain
  // (≥ 35°) painted via the native `color-relief` layer. The three
  // tokens correspond to the 35°/45°/60° stops in the layer's slope
  // expression. Light theme uses cooler reds so the overlay reads on
  // a cream paper underlay without crushing the hypso tint.
  slopeWarning: {
    soft:   'rgba(255, 80, 40, 0.25)',
    mid:    'rgba(255, 40, 20, 0.45)',
    severe: 'rgba(180, 0, 0, 0.60)',
  },

  // ESA WorldCover landcover-tint ramp — bridge to the standalone
  // `worldcover-ramps.js` dictionary. Tokens never duplicate the data,
  // they just expose it under the theme-specific slot so style modules
  // resolving via `getTokens(theme).worldcover` get the right variant
  // without branching on theme.
  worldcover: WORLDCOVER_RAMPS.light,

  // ETH Global Canopy Height ramp — same pattern as `worldcover`
  // above. Definition lives in `canopy-height-ramps.js`; tokens.js
  // is just the theme-aware bridge so style modules resolving via
  // `getTokens(theme).canopy` always get the right variant. The
  // ramp is also consumed offline by `tools/dump-canopy-ramp.mjs`
  // when emitting the gdaldem colour table — never duplicated here.
  canopy: CANOPY_RAMPS.light,

  // Carpathian forest leaf-type biom tokens. Bridge to the standalone
  // `forest-leaf-tokens.js` dictionary; style modules read
  // `t.forestLeaf.leaf.<slot>.{fill,outline,label}`,
  // `t.forestLeaf.protect.{stroke,dash}`, and `t.forestLeaf.label.*`
  // so the theme variant is resolved without branching. The data
  // lives in forest-leaf-tokens.js — tokens.js is purely the
  // theme-aware re-export.
  //
  // Note: this is a SEPARATE namespace from the `forest` token (a hex
  // string used by `base.js` to fill the upstream OMT `landcover_wood`
  // class). The new `forestLeaf` slot is consumed exclusively by
  // `carpathian.js::forestPolygonLayers` for the Carpathian-overlay
  // leaf-type biom-colour stack.
  forestLeaf: Object.freeze({
    leaf: FOREST_LEAF.light,
    protect: FOREST_PROTECT.light,
    label: FOREST_LABEL,
  }),

  // ---------------------------------------------------------------------
  // Hazardous-terrain overlay — extreme peaks, cliffs, dangerous high
  // passes. Each kind owns four slots:
  //
  //   ring   — crisp circle stroke around the marker
  //   glow   — soft outer halo (alpha-rgba) for far-away legibility
  //   label  — text fill, deliberately a hue NOT used by any other
  //            label-colour token (`textPeak`, `textPass`, `textPrimary`,
  //            `textRoad`, `textPark`, `sacScale.*`, …) so a hazard
  //            label can be told from a regular label at a glance.
  //   halo   — high-contrast text halo so the label reads on hypso /
  //            hillshade / forest fill / paper background alike.
  //
  // Hue choices in the LIGHT theme:
  //   • peak (extreme, ≥1800 m)    — vivid magenta. No other layer in
  //                                  the project uses pink/magenta, so
  //                                  the marker is unmistakable.
  //   • peakHard (1500–1800 m)     — deep crimson, sits between peak
  //                                  magenta and trail red without
  //                                  collapsing into either.
  //   • cliff                      — saturated teal. Far from the
  //                                  amber/red/green vocabulary and
  //                                  contrasts clean against forest fill.
  //   • passDanger (≥1300 m)       — bright tangerine. Distinct enough
  //                                  from the cooler amber accent
  //                                  (`motorwayCasing`) to read as
  //                                  "warning sign" rather than "road".
  // ---------------------------------------------------------------------
  hazard: Object.freeze({
    peak: Object.freeze({
      ring:  '#d61f7a',                           // vivid magenta
      glow:  'rgba(214, 31, 122, 0.42)',
      label: '#a3145c',                           // deep magenta — readable
      halo:  '#fbf4f8',
    }),
    peakHard: Object.freeze({
      ring:  '#b8264a',
      glow:  'rgba(184, 38, 74, 0.36)',
      label: '#86162f',
      halo:  '#fff2f4',
    }),
    cliff: Object.freeze({
      ring:  '#0aa5a3',                           // saturated teal
      glow:  'rgba(10, 165, 163, 0.38)',
      label: '#04706f',
      halo:  '#eafaf9',
    }),
    passDanger: Object.freeze({
      ring:  '#ff7a1a',                           // bright tangerine
      glow:  'rgba(255, 122, 26, 0.36)',
      label: '#a04a05',
      halo:  '#fff5e6',
    }),
  }),
};

const DARK = {
  ...SHARED,
  bg: '#0e1318',

  forest: '#1c2a1e',
  forestEdge: '#243321',
  // Forest-cover overlay — dark variant. Same saturated two-tone read as
  // LIGHT but L* pulled down so the near-opaque fill sits on the deep slate
  // canvas without glaring. See LIGHT for the per-slot rationale.
  forestCover: Object.freeze({
    fill: '#245038',
    edge: '#143524',
  }),
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

  building: '#2a2a36',
  buildingOutline: '#f0a850',
  building3D: '#36364a',
  // Outer + inner glow rings reuse the dark-theme amber so building
  // edges visibly glow against the slate canvas at every zoom.
  buildingGlowOuter: 'rgba(240, 168, 80, 0.42)',
  buildingGlowInner: 'rgba(240, 168, 80, 0.62)',

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

  // Place dot accent — same warm amber family as the dark-theme road/
  // landmark accents so a city dot pops against the deep slate canvas.
  // Slightly higher alpha on the glow than light to compensate for
  // the dimmer base palette.
  placeDot: '#f0a850',
  placeDotStroke: '#0e131a',
  placeDotGlow: 'rgba(240, 168, 80, 0.40)',

  // Forest-mode markup accents — dark-theme counterparts. Lighter blues
  // so the city/water accents stay luminous against the deep forest fill,
  // and a near-white bold road casing for the same reason.
  forestCityAccent: '#60a5fa',
  forestCityAccentHalo: '#0c1115',
  forestWaterAccent: '#7cb8f5',
  forestWaterAccentHalo: '#0d1f2a',
  forestRoadBold: '#e2e8f0',
  forestRoadBoldHalo: '#0c1115',

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

  // SAC scale — dark theme variants. Each token brightened so the
  // category reads at low alpha against the deep slate canvas.
  sacScale: {
    t1: '#7ec77d',
    t2: '#f1c84d',
    t3: '#ffa55a',
    t4: '#ff5b3d',
    t5: '#c47fde',
    t6: '#dadada',
  },
  sacScaleNeutral: '#d27660',
  trailViaFerrata: '#f0f0f0',
  trailInformal: '#7d7a72',
  trailBridge: '#f6f1e3',

  // Premium glow accents — dark theme uses warmer amber against
  // the deep slate background. Slightly higher alpha than light
  // to compensate for the dimmer base palette.
  roadGlowMajor: 'rgba(240, 168, 80, 0.46)',
  roadGlowMajorOuter: 'rgba(240, 168, 80, 0.24)',
  roadGlowMinor: 'rgba(217, 152, 82, 0.38)',
  roadGlowMinorOuter: 'rgba(217, 152, 82, 0.18)',

  buildingLandmark: '#3a2e22',
  buildingLandmarkOutline: '#d99852',
  buildingLandmarkGlowOuter: 'rgba(240, 168, 80, 0.22)',
  buildingLandmarkGlowInner: 'rgba(240, 168, 80, 0.42)',

  textGlowImportant: 'rgba(240, 168, 80, 0.34)',
  poiGlowImportant: 'rgba(240, 168, 80, 0.36)',

  peakMarker: '#f0e6cf',
  peakMarkerGlow: 'rgba(240, 230, 207, 0.40)',
  trailGlow: 'rgba(255, 91, 61, 0.42)',
  textPeakGlow: 'rgba(240, 230, 207, 0.40)',

  // Settlement outlines — dark variant. Same violet hue family as
  // light, lifted in lightness so the inline core pops against the
  // deep slate canvas without crushing into the dimmed hypso palette.
  // Casing stays dark for a crisp frame; glows carry slightly higher
  // alpha to compensate for the dimmer base background.
  settlementInline: '#a78bfa',
  settlementCasing: '#1e0e3c',
  settlementGlow: 'rgba(167, 139, 250, 0.50)',
  settlementGlowOuter: 'rgba(167, 139, 250, 0.26)',

  // Slope-warning overlay — dark theme uses slightly hotter reds with
  // a touch more alpha so the overlay reads against the deep slate
  // canvas. Same three tokens as light, mapped to the 35°/45°/60°
  // stops in `composeSlopeWarningLayer`.
  slopeWarning: {
    soft:   'rgba(255, 110, 70, 0.30)',
    mid:    'rgba(255, 70, 40, 0.50)',
    severe: 'rgba(220, 30, 20, 0.65)',
  },

  // ESA WorldCover landcover-tint ramp — dark variant. Same hue family
  // as the light theme but pulled ~15-20% darker so the multiply-blend
  // overlay reads on the deep slate canvas without re-saturating.
  worldcover: WORLDCOVER_RAMPS.dark,

  // ETH Global Canopy Height ramp — dark variant. Same hue family
  // as the light theme; canopy-height-ramps.js owns the per-stop
  // L* delta so the multiply-blend lands legibly on the deep slate
  // canvas without re-saturating the greens.
  canopy: CANOPY_RAMPS.dark,

  // Carpathian forest leaf-type biom tokens — dark variant. Same
  // hue family as the light bundle, L* pulled ~18-22 % so the fill
  // reads on the deep slate canvas without re-saturating against
  // the hillshade. Label colours are LIFTED relative to the fill
  // (instead of dropped, like in light theme) so they remain legible
  // against the darker biom backdrop. See `t.forestLeaf` in LIGHT
  // for the namespace rationale (avoids colliding with the existing
  // `forest` hex slot consumed by `base.js`).
  forestLeaf: Object.freeze({
    leaf: FOREST_LEAF.dark,
    protect: FOREST_PROTECT.dark,
    label: FOREST_LABEL,
  }),

  // Hazardous-terrain overlay — dark variant. Hues are lifted (higher
  // L*) so the rings + labels read against the deep slate canvas
  // without crushing into the dimmed hypso palette. Halo flips to the
  // dark canvas colour so the label glow reads as a clean cut-out
  // around bright glyphs.
  hazard: Object.freeze({
    peak: Object.freeze({
      ring:  '#ff5fa8',
      glow:  'rgba(255, 95, 168, 0.46)',
      label: '#ffb1d4',                           // soft rose, vivid on dark
      halo:  '#1a0a14',
    }),
    peakHard: Object.freeze({
      ring:  '#ff6c8c',
      glow:  'rgba(255, 108, 140, 0.40)',
      label: '#ffb6c5',
      halo:  '#1a0c12',
    }),
    cliff: Object.freeze({
      ring:  '#3fd0ce',
      glow:  'rgba(63, 208, 206, 0.42)',
      label: '#9ae9e7',
      halo:  '#08201f',
    }),
    passDanger: Object.freeze({
      ring:  '#ffa251',
      glow:  'rgba(255, 162, 81, 0.40)',
      label: '#ffd4a3',
      halo:  '#1d1208',
    }),
  }),
};

export const TOKENS = Object.freeze({ light: LIGHT, dark: DARK });

/** Helper: pull tokens by name with a safe fallback to light. */
export function getTokens(theme) {
  return TOKENS[theme] ?? TOKENS.light;
}
