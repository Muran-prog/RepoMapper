/**
 * Style-spec validator.
 *
 *   node validate.cjs
 *
 * Walks the full matrix of theme × profile × feature-flag combinations,
 * runs each composed style through @maplibre/maplibre-gl-style-spec's
 * validator, and prints a pass/fail table. Exit code is 1 if any combo
 * fails so CI can gate merges.
 *
 * The validator only checks structural correctness — it doesn't hit any
 * tile URLs, so placeholder `pmtiles://…` strings pass as long as they're
 * well-formed. That matches how the browser MapLibre handles unreachable
 * sources: they emit a silent `error` and the rest of the map keeps
 * rendering, which is exactly the graceful-fallback behaviour we want.
 *
 * This file is CommonJS by design — it `await import()`s the ESM style
 * modules so we can reuse their pure functions without a build step.
 */

'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Convert a local ESM file path to a file:// URL that works on every
 * platform, then dynamic-import it.
 */
async function importEsm(rel) {
  const abs = path.resolve(__dirname, rel);
  return import(pathToFileURL(abs).href);
}

async function main() {
  // ---------------------------------------------------------------------
  // Load validator & project modules
  // ---------------------------------------------------------------------
  let validate;
  try {
    ({ validateStyleMin: validate } = await import('@maplibre/maplibre-gl-style-spec'));
  } catch (e) {
    console.error(
      '@maplibre/maplibre-gl-style-spec is not installed.\n' +
        '   Run:  npm install  (in the repo root)\n' +
        '   or:   npm install --no-save @maplibre/maplibre-gl-style-spec\n',
    );
    process.exit(2);
  }

  const { composeLayers } = await importEsm('src/style/index.js');
  const { composeSources, sourceAvailability } = await importEsm('src/style/sources.js');
  const { composeSky, composeTerrain, composeProjection } = await importEsm('src/style/terrain.js');
  const {
    composeSatelliteStyle,
    resolveSatelliteImageryPlan,
  } = await importEsm('src/style/satellite.js');
  const { getProfileConfig } = await importEsm('src/device.js');
  const {
    FEATURES,
    TERRAIN,
    OPENFREEMAP,
    HYPSO,
    MAP_MODES,
    STANDARD_STYLE_URL,
    SATELLITE_TILES,
  } = await importEsm('src/config.js');
  const { getTokens } = await importEsm('src/style/tokens.js');
  const { RAMP_IDS } = await importEsm('src/style/hypso/ramps.js');

  // ---------------------------------------------------------------------
  // Build a full MapLibre style object the same way createMap.js would.
  // Everything here is deterministic — no network, no DOM.
  // ---------------------------------------------------------------------
  const buildStyle = ({ theme, profile, features, hypso, sourceStubs, terrainOverride }) => {
    const cfg = getProfileConfig(profile);

    // Stub vector source — the validator only checks its shape.
    const vectorSource = {
      type: 'vector',
      url: OPENFREEMAP.tilejson,
      attribution: OPENFREEMAP.attribution,
    };

    const effectiveFeatures = {
      ...features,
      // Same AND gating that createMap.js applies.
      buildings3D: features.buildings3D && cfg.buildings3D,
      hillshade: features.hillshade,
      terrain3D: features.terrain3D && cfg.enableTerrain3D,
      textureShading: features.textureShading && cfg.enableTextureShading,
      skyViewFactor: features.skyViewFactor && cfg.enableTextureShading,
      worldcoverTint: features.worldcoverTint,
      canopyHeightTint: features.canopyHeightTint,
      slopeWarning: features.slopeWarning,
      hypsometricTint: features.hypsometricTint && cfg.enableHypsoTint,
      bathymetry: features.bathymetry && cfg.enableHypsoTint,
      contours: features.contours && cfg.enableContours,
      ridgeOverlay: features.ridgeOverlay && cfg.enableRidgeOverlay,
      carpathian: features.carpathian && cfg.enableCarpathianOverlay,
      // Forest leaf-type biom polygons share Carpathian capability —
      // the source-layer lives inside carpathian-osm.pmtiles, so the
      // umbrella enableCarpathianOverlay capability gates emission.
      forestLeafType:
        features.forestLeafType && cfg.enableCarpathianOverlay,
      // Forest-cover overlay reads the global base vector source, so it
      // has no Carpathian/device-profile gate — the raw user flag wins.
      forestCover: features.forestCover,
      // Hazardous-terrain overlay also rides the umbrella Carpathian
      // capability since the data lives in carpathian-osm.pmtiles.
      hazardousTerrain:
        features.hazardousTerrain && cfg.enableCarpathianOverlay,
      // Hiking-route ribbons share the same source-layer parent
      // (`hiking_route` inside carpathian-osm.pmtiles), so they ride
      // the same umbrella capability gate as forest-leaf and hazards.
      hikingRoutes:
        features.hikingRoutes && cfg.enableCarpathianOverlay,
      globeProjection: features.globeProjection && cfg.enableGlobeProjection,
      hypsoRampId: hypso?.rampId ?? HYPSO.defaultRampId,
    };

    // Mirror the flat-preset coupling from resolveFeatures() in
    // createMap.js: forest-cover forces a deliberately flat, Google-Earth
    // style view, so every relief / 3D / elevation cue is suppressed while
    // the overlay is on. Kept in sync here so the harness models the same
    // effective feature set the runtime composes.
    if (effectiveFeatures.forestCover) {
      effectiveFeatures.terrain3D = false;
      effectiveFeatures.hillshade = false;
      effectiveFeatures.hypsometricTint = false;
      effectiveFeatures.textureShading = false;
      effectiveFeatures.skyViewFactor = false;
      effectiveFeatures.ridgeOverlay = false;
      effectiveFeatures.slopeWarning = false;
      effectiveFeatures.contours = false;
      effectiveFeatures.worldcoverTint = false;
      effectiveFeatures.canopyHeightTint = false;
    }

    const sources = composeSources({
      vectorSource,
      features: effectiveFeatures,
      ...(terrainOverride ? { terrain: terrainOverride } : {}),
    });
    if (sourceStubs) Object.assign(sources, sourceStubs);
    const has = sourceAvailability(sources);

    const layerOpts = {
      theme,
      buildings3D: effectiveFeatures.buildings3D,
      pois: features.pois,
      labels: features.labels,

      density: cfg.labelDensity,
      placeRankCutoff: cfg.placeRankCutoff,
      poiRankCutoff: cfg.poiRankCutoff,
      poiDotRankCutoff: cfg.poiDotRankCutoff,
      textPaddingMul: cfg.textPaddingMul,
      poiSizeMul: cfg.poiSizeMul,
      enableNeighbourhoods: cfg.enableNeighbourhoods,
      enableHamlets: cfg.enableHamlets,
      enableSuburbs: cfg.enableSuburbs,
      enableRoadShieldsMinor: cfg.enableRoadShieldsMinor,
      roadsCarpathianDoubleCasing: cfg.roadsCarpathianDoubleCasing,
      settlementOutline: features.settlementOutline,

      hillshade: effectiveFeatures.hillshade,
      multiDirHillshade: cfg.enableMultiDirHillshade && effectiveFeatures.hillshade,
      hasPrimaryDem: has.primaryDem,
      hasCarpathianDem: has.carpathianDem,
      hypsometricTint: effectiveFeatures.hypsometricTint,
      hasHypsoSource: has.hypsometricTint,
      hasHypsoRasterRamp: !!has.hypsoRasterRampId,
      hypsoMode: hypso?.mode ?? (features.colorRelief && has.primaryDem
        ? 'native'
        : has.hypsoRasterRampId
        ? 'raster'
        : has.hypsometricTint
        ? 'legacy'
        : 'off'),
      hypsoRampId: hypso?.rampId ?? HYPSO.defaultRampId,
      hypsoStrength: hypso?.strength ?? HYPSO.defaultStrength,
      hypsoBathymetry: hypso?.bathymetry ?? HYPSO.bathymetryDefault,
      hypsoRasterSourceId: has.hypsoRasterRampId
        ? `hypso-raster-${has.hypsoRasterRampId}`
        : null,
      bathymetry: effectiveFeatures.bathymetry,
      hasBathymetrySource: has.bathymetry,
      textureShading: effectiveFeatures.textureShading,
      hasTextureSource: has.textureShading,
      skyViewFactor: effectiveFeatures.skyViewFactor,
      hasSkyViewFactorSource: has.skyViewFactor,
      worldcoverTint: effectiveFeatures.worldcoverTint,
      hasWorldcoverSource: has.worldcoverTint,
      canopyHeightTint: effectiveFeatures.canopyHeightTint,
      hasCanopyHeightSource: has.canopyHeightTint,
      slopeWarning: effectiveFeatures.slopeWarning,
      // The style-spec validator we ship for CI doesn't yet recognise
      // the `['slope']` expression input (added to MapLibre 5.6 after
      // the spec package's last npm publish). The runtime probes for
      // it via `hypso/detect.js::probeColorReliefSlope` and prunes the
      // layer if missing — exactly the same graceful fallback the
      // validator triggers here. New CI matrix entries that exercise
      // slopeWarning still verify the rest of the layer stack stays
      // valid; the slope-warning layer itself becomes a no-op in this
      // environment.
      hasSlopeExpression: false,
      colorRelief: features.colorRelief && has.primaryDem,

      // Contours: validator can't actually register the worker source, but
      // the composed style is still valid if it references an existing
      // "contours-dynamic" vector source. We inject a stub to satisfy it.
      contours: effectiveFeatures.contours,
      contoursSourceId: 'contours-dynamic',
      hasContoursSource: effectiveFeatures.contours && has.primaryDem,
      contourLabels: true,

      ridgeOverlay: effectiveFeatures.ridgeOverlay,
      hasRidgesSource: has.ridges,
      carpathian: effectiveFeatures.carpathian,
      hasCarpathianOsmSource: has.carpathianOsm,
      forestLeafType: effectiveFeatures.forestLeafType,
      hasForestPolygonSource: has.forestPolygon,
      forestCover: effectiveFeatures.forestCover,
      hasForest10mSource: has.forest10m,
      // Forest-mode markup accents — passed straight through; the style
      // builder only emits them inside the forestCover block, so they're
      // structurally forest-mode-only.
      forestCities: effectiveFeatures.forestCities,
      forestWaterAccent: effectiveFeatures.forestWaterAccent,
      forestRoadsBold: effectiveFeatures.forestRoadsBold,
      forestRoadsOrange: effectiveFeatures.forestRoadsOrange,
      hazardousTerrain: effectiveFeatures.hazardousTerrain,
      hikingRoutes: effectiveFeatures.hikingRoutes,
    };

    // Inject a stub dynamic-contours source if the feature is on, since
    // the actual worker registration happens at runtime.
    if (layerOpts.hasContoursSource) {
      sources['contours-dynamic'] = { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] };
    }

    const t = getTokens(theme);
    const style = {
      version: 8,
      name: `Cart · Ukraine (${theme})`,
      metadata: { theme, profile, schema: 'openmaptiles' },
      sources,
      glyphs: OPENFREEMAP.glyphs,
      sprite: OPENFREEMAP.sprite,
      layers: composeLayers(layerOpts),
      transition: { duration: 220, delay: 0 },
      light: { anchor: 'viewport', color: 'white', intensity: 0.4 },
      sky: composeSky(t, { reduceMotion: false }),
    };

    const terrain = composeTerrain({
      enable: effectiveFeatures.terrain3D,
      hasPrimaryDem: has.primaryDem,
      // Use the z=9 stop value as the initial exaggeration — matches the
      // average sensible value we'd want before the first zoom event
      // triggers interactions.js to recompute.
      initialExaggeration: cfg.terrainExaggerationMul,
    });
    if (terrain) style.terrain = terrain;

    const projection = composeProjection({
      globe: effectiveFeatures.globeProjection,
    });
    if (projection) style.projection = projection;

    return style;
  };

  // ---------------------------------------------------------------------
  // Combination matrix
  // ---------------------------------------------------------------------
  const themes = ['light', 'dark'];
  const profiles = ['high', 'medium', 'low'];

  // Baseline = all features on; the variants test feature-flag OFF states
  // that actually change the layer stack.
  const featurePacks = [
    { name: 'all-on', flags: {} },
    { name: 'no-buildings3D', flags: { buildings3D: false } },
    { name: 'no-pois', flags: { pois: false } },
    { name: 'no-labels', flags: { labels: false } },
    { name: 'no-hillshade', flags: { hillshade: false } },
    { name: 'no-terrain3D', flags: { terrain3D: false } },
    { name: 'no-contours', flags: { contours: false } },
    { name: 'no-texture', flags: { textureShading: false } },
    { name: 'no-hypso', flags: { hypsometricTint: false } },
    { name: 'no-ridge', flags: { ridgeOverlay: false } },
    { name: 'no-carpathian', flags: { carpathian: false } },
    { name: 'no-settlement-outline', flags: { settlementOutline: false } },
    {
      name: 'minimal',
      flags: {
        hillshade: false,
        terrain3D: false,
        contours: false,
        textureShading: false,
        hypsometricTint: false,
        ridgeOverlay: false,
        carpathian: false,
        bathymetry: false,
      },
    },
    // Carpathian trail-overlay smoke packs — exercise the new
    // forest-roads → trails → via-ferrata → steps → furniture →
    // labels pipeline. Without a real `carpathian-osm` source the
    // composer must NOT emit any of those layers (graceful fallback);
    // the matching with-source pack confirms we DO emit them when
    // the source is present.
    {
      name: 'carpathian-trails-no-source',
      flags: { carpathian: true },
      // No stub source — composeSources() leaves carpathian-osm out.
    },
    {
      name: 'carpathian-trails-with-source',
      flags: { carpathian: true },
      stubCarpathianOsmUrl: true,
    },
    // Sky-View Factor overlay — multiplicative wash of canyon detail.
    // Without a source, the layer must NOT emit (graceful fallback);
    // with the stub source it emits a single raster layer above the
    // hillshade stack.
    {
      name: 'svf-no-source',
      flags: { skyViewFactor: true },
    },
    {
      name: 'svf-with-source',
      flags: { skyViewFactor: true },
      stubSkyViewFactorUrl: true,
    },
    // Slope-warning overlay — native color-relief on the slope
    // expression. Always emits when the feature flag is on AND the
    // primary DEM is available; the runtime probe in hypso/detect.js
    // demotes it if the live MapLibre build doesn't accept the slope
    // expression. The validator only checks structural shape, which
    // is identical between supported and unsupported runtimes.
    {
      name: 'slope-warning-on',
      flags: { slopeWarning: true },
    },
    {
      name: 'slope-warning-with-carpathian-dem',
      flags: { slopeWarning: true, carpathian: true },
      stubCarpathianOsmUrl: true,
      stubCarpathianDemUrl: true,
    },
    // ESA WorldCover landcover-tint — multiply-blend overlay above
    // hillshade. Without a source: layer NOT emitted (graceful
    // fallback). With a source AND hypsometric tint OFF: full-opacity
    // curve. With a source AND hypsometric tint ON: opacity rescaled
    // down so the elevation tint stays the dominant signal.
    {
      name: 'worldcover-no-source',
      flags: { worldcoverTint: true },
    },
    {
      name: 'worldcover-with-source-no-hypso',
      flags: { worldcoverTint: true, hypsometricTint: false },
      stubWorldcoverUrl: true,
    },
    {
      name: 'worldcover-with-source-with-hypso',
      flags: { worldcoverTint: true, hypsometricTint: true, colorRelief: true },
      hypso: { mode: 'native' },
      stubWorldcoverUrl: true,
    },
    // ETH Global Canopy Height (Lang et al. 2023) — multiply-blend
    // overlay above WorldCover that modulates the tree-cover wash by
    // per-pixel canopy top height. Without a source: layer NOT
    // emitted (graceful fallback). The matrix below exercises every
    // (worldcover on/off) × (hypso on/off) combination so the
    // composer's opacity-multiplier branching (default / hypsoActive
    // / worldcoverActive / both → MIN) is covered.
    {
      name: 'canopy-no-source',
      flags: { canopyHeightTint: true },
    },
    {
      name: 'canopy-source-no-worldcover-no-hypso',
      flags: {
        canopyHeightTint: true,
        worldcoverTint: false,
        hypsometricTint: false,
      },
      stubCanopyHeightUrl: true,
    },
    {
      name: 'canopy-source-with-worldcover-no-hypso',
      flags: {
        canopyHeightTint: true,
        worldcoverTint: true,
        hypsometricTint: false,
      },
      stubCanopyHeightUrl: true,
      stubWorldcoverUrl: true,
    },
    {
      name: 'canopy-source-no-worldcover-with-hypso',
      flags: {
        canopyHeightTint: true,
        worldcoverTint: false,
        hypsometricTint: true,
        colorRelief: true,
      },
      hypso: { mode: 'native' },
      stubCanopyHeightUrl: true,
    },
    {
      name: 'canopy-source-with-worldcover-with-hypso',
      flags: {
        canopyHeightTint: true,
        worldcoverTint: true,
        hypsometricTint: true,
        colorRelief: true,
      },
      hypso: { mode: 'native' },
      stubCanopyHeightUrl: true,
      stubWorldcoverUrl: true,
    },
    // Forest leaf-type biom polygons. Without a carpathian-osm
    // source the layers must NOT emit (graceful fallback); with the
    // production URL plus the feature flag on, the four sub-layers
    // (fill / outline / protect-outline / label) appear in the
    // composed stack. The "no-source" pack explicitly clears
    // `TERRAIN.carpathianOsm.url` to `null` so we exercise the real
    // null-URL code path in `composeSources`, not just a
    // missing-stub artefact.
    {
      name: 'forest-leaf-no-source',
      flags: { carpathian: true, forestLeafType: true },
      disableCarpathianOsmUrl: true,
    },
    {
      name: 'forest-leaf-with-source',
      flags: { carpathian: true, forestLeafType: true },
      // Production URL is hardcoded in TERRAIN.carpathianOsm.url, so
      // composeSources() picks the source up automatically — no stub
      // needed. We still pin a stub here for parity with the trail
      // matrix and so the test stays robust if the hardcoded URL is
      // ever moved.
      stubCarpathianOsmUrl: true,
    },
    // Cross-product: forestLeafType ON together with worldcover +
    // canopy-height ON, so the composer's z-order ladder (water_fill
    // → bathymetry → forest_polygon → SVF → texture → contours) is
    // exercised end-to-end with every relevant overlay present.
    {
      name: 'forest-leaf-with-worldcover-canopy',
      flags: {
        carpathian: true,
        forestLeafType: true,
        worldcoverTint: true,
        canopyHeightTint: true,
      },
      stubCarpathianOsmUrl: true,
      stubWorldcoverUrl: true,
      stubCanopyHeightUrl: true,
    },
    // Forest-cover overlay — flat green forest highlight from the GLOBAL
    // base vector source. No `has*Source` gate, so it emits on the
    // feature flag ALONE (the openmaptiles source is always there).
    // Exercise it standalone, and also with every relief flag flipped on
    // so the flat-preset coupling (relief suppressed) stays exercised by
    // the full validity sweep.
    {
      name: 'forest-cover-on',
      flags: { forestCover: true },
    },
    {
      name: 'forest-cover-flattens-relief',
      flags: {
        forestCover: true,
        hillshade: true,
        hypsometricTint: true,
        colorRelief: true,
        contours: true,
        terrain3D: true,
        textureShading: true,
      },
      hypso: { mode: 'native' },
    },
    // High-detail 10 m forest vector (Carpathian-only). With the real
    // config URL the forest-10m source is present, so the crisp
    // `forestcover_hi_*` layers ride on top of the global landcover
    // forest. The "no-source" pack blanks the URL to prove the overlay
    // falls back cleanly to the global forest alone.
    {
      name: 'forest-cover-10m-detail',
      flags: { forestCover: true },
    },
    {
      name: 'forest-cover-no-10m-source',
      flags: { forestCover: true },
      disableForest10mUrl: true,
    },
    // Forest-mode markup accents — only act inside forest mode. The
    // "all" pack flips every accent on with forestCover; the "off-mode"
    // pack proves the accents stay absent when forestCover is off even
    // with all sub-flags set (structural forest-mode gating).
    {
      name: 'forest-markup-all',
      flags: {
        forestCover: true,
        forestCities: true,
        forestWaterAccent: true,
        forestRoadsBold: true,
        forestRoadsOrange: true,
      },
    },
    {
      name: 'forest-markup-cities-only',
      flags: {
        forestCover: true,
        forestCities: true,
        forestWaterAccent: false,
        forestRoadsBold: false,
        forestRoadsOrange: false,
      },
    },
    {
      name: 'forest-markup-roads-orange',
      flags: {
        forestCover: true,
        forestCities: false,
        forestWaterAccent: false,
        forestRoadsBold: false,
        forestRoadsOrange: true,
      },
    },
    {
      name: 'forest-markup-off-mode',
      flags: {
        forestCover: false,
        forestCities: true,
        forestWaterAccent: true,
        forestRoadsBold: true,
        forestRoadsOrange: true,
      },
    },
    // Hazardous-terrain overlay — extreme peaks / cliffs / dangerous
    // passes. Without a carpathian-osm source the layers must not
    // emit (graceful fallback); with the source on, all 12 sub-layers
    // (4 hazard kinds × glow / ring / label) appear in the stack.
    {
      name: 'hazard-no-source',
      flags: { hazardousTerrain: true },
      disableCarpathianOsmUrl: true,
    },
    {
      name: 'hazard-with-source',
      flags: { hazardousTerrain: true },
      stubCarpathianOsmUrl: true,
    },
    // Cross-product: hazardousTerrain ON together with the full
    // Carpathian trail web ON. Verifies the two independent feature
    // toggles (a user can run hazards alone, or with full detail)
    // co-emit cleanly without colliding sort-keys / source-layer
    // references.
    {
      name: 'hazard-with-carpathian',
      flags: { hazardousTerrain: true, carpathian: true },
      stubCarpathianOsmUrl: true,
    },
    // Hiking-route ribbons — `hiking_route` source-layer of the
    // carpathian-osm archive, painted as continuous coloured
    // underlay-bands beneath the per-trail glow / casing / inline.
    // Without a source the layers must NOT emit (graceful fallback);
    // with the source on, the base-ribbon, highlight and label all
    // appear. The cross-product pack also stacks the ribbons with the
    // full Carpathian trail web to verify the two pipelines co-emit
    // without z-order conflicts.
    {
      name: 'hiking-routes-no-source',
      flags: { hikingRoutes: true, carpathian: false },
      disableCarpathianOsmUrl: true,
    },
    {
      name: 'hiking-routes-with-source',
      flags: { hikingRoutes: true, carpathian: false },
      stubCarpathianOsmUrl: true,
    },
    {
      name: 'hiking-routes-with-carpathian',
      flags: { hikingRoutes: true, carpathian: true },
      stubCarpathianOsmUrl: true,
    },
    {
      name: 'hiking-routes-off',
      flags: { hikingRoutes: false, carpathian: true },
      stubCarpathianOsmUrl: true,
    },
    // Hypso-specific feature packs — every mode the renderer can pick.
    {
      name: 'hypso-native',
      flags: { hypsometricTint: true, colorRelief: true },
      hypso: { mode: 'native' },
    },
    {
      name: 'hypso-raster',
      flags: { hypsometricTint: true, colorRelief: false },
      hypso: { mode: 'raster' },
      // Stuff every preset's raster URL with a synthetic placeholder so
      // composeSources adds the per-ramp source — without these URLs the
      // raster path silently degrades to 'off' and we'd be testing the
      // wrong path.
      stubHypsoRasterUrls: true,
    },
    {
      name: 'hypso-off',
      flags: { hypsometricTint: false },
      hypso: { mode: 'off' },
    },
    {
      name: 'hypso-bathymetry',
      flags: { hypsometricTint: true, bathymetry: true, colorRelief: true },
      hypso: { mode: 'native', bathymetry: true },
      stubBathymetryUrl: true,
    },
    {
      name: 'hypso-no-bathy',
      flags: { hypsometricTint: true, bathymetry: false },
      hypso: { mode: 'native', bathymetry: false },
    },
    // Cycle through every named ramp once on light/high so a new ramp
    // can't slip in with a syntactic bug (negative-elevation stop wrong
    // type, etc.). The full theme × profile matrix already covers the
    // default ramp via every other pack.
    ...RAMP_IDS.map((rampId) => ({
      name: `ramp-${rampId}`,
      flags: { hypsometricTint: true, colorRelief: true },
      hypso: { rampId, mode: 'native' },
      onlyThemeProfile: { theme: 'light', profile: 'high' },
    })),
  ];

  // ---------------------------------------------------------------------
  // Mode-specific style builders.
  //
  // Cart-mode validation walks the whole feature/profile/theme matrix
  // above (it's the heaviest branch). The new modes only need their
  // own skeleton checked — the brief explicitly excludes our internal
  // composition from the Standard / Satellite validators.
  //
  //   • standard — substitute a stub MapLibre style that points at the
  //                same upstream tile source URL the runtime would
  //                receive. We validate the SHAPE of that stub (a
  //                spec-valid style root with sources + at least one
  //                layer); the runtime then trusts the upstream
  //                JSON as-is.
  //
  //   • satellite — locally composed via `composeSatelliteStyle()` and
  //                 validated as a regular spec-valid style.
  // ---------------------------------------------------------------------

  /**
   * Stub Standard style. Real runtime fetches STANDARD_STYLE_URL and
   * applies the upstream JSON unchanged. Here we synthesise the
   * smallest spec-valid style that REFERENCES the same source URL,
   * which is what the brief asks for.
   */
  const buildStandardStubStyle = () => ({
    version: 8,
    name: 'Cart · Standard (stub)',
    metadata: { mode: 'standard', upstream: STANDARD_STYLE_URL },
    sources: {
      // The same OMT TileJSON URL the upstream Liberty style points at —
      // we keep the source id stable so any consumers that probe for
      // `openmaptiles` keep working in tests.
      openmaptiles: {
        type: 'vector',
        // Exact URL the runtime would receive when it fetches the
        // upstream style; placeholder for the real upstream descriptor.
        url: OPENFREEMAP.tilejson,
        attribution: OPENFREEMAP.attribution,
      },
    },
    glyphs: OPENFREEMAP.glyphs,
    layers: [
      // Single background layer so the validator has at least one
      // rendered layer to chew on. Upstream Liberty has 100+ layers;
      // we don't enumerate them here because the brief explicitly
      // says we don't validate the third-party stack.
      {
        id: 'standard_background',
        type: 'background',
        paint: { 'background-color': '#f4f1ea' },
      },
    ],
  });

  /**
   * Locally-built Satellite style — same module the runtime uses, so
   * we validate the actual JSON the user will see.
   */
  const buildSatelliteStubStyle = () => composeSatelliteStyle();

  /**
   * Lightweight mode-aware builder. Cart re-uses `buildStyleWithStubs`
   * (the full feature-matrix path); the other two modes return their
   * skeleton.
   */
  const buildStyleForMode = (mode, args) => {
    if (mode === 'standard') return buildStandardStubStyle();
    if (mode === 'satellite') return buildSatelliteStubStyle();
    return buildStyleWithStubs(args);
  };

  // ---------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------
  let failed = 0;
  const rows = [];

  for (const theme of themes) {
    for (const profile of profiles) {
      for (const pack of featurePacks) {
        if (pack.onlyThemeProfile) {
          const { theme: t, profile: p } = pack.onlyThemeProfile;
          if (t && t !== theme) continue;
          if (p && p !== profile) continue;
        }
        const features = { ...FEATURES, ...pack.flags };

        // Per-pack environment stubs are threaded through composeSources
        // by way of an override on features.hypsoRasterUrls + an
        // explicit sourceStubs param (see buildStyle below).
        if (pack.stubHypsoRasterUrls) {
          features.hypsoRasterUrls = Object.fromEntries(
            Object.keys(HYPSO.rasterUrls).map((id) => [
              id,
              `pmtiles://https://example.com/${id}.pmtiles`,
            ]),
          );
        }

        let status = 'ok';
        let details = '';
        let layerCount = 0;
        try {
          const style = buildStyleWithStubs({ theme, profile, features, pack });
          layerCount = style.layers.length;
          const errors = validate(style) || [];
          if (errors.length > 0) {
            status = 'fail';
            details = errors
              .slice(0, 5)
              .map((e) => `${e.line ? `L${e.line}: ` : ''}${e.message}`)
              .join(' | ');
            failed++;
          }
        } catch (err) {
          status = 'throw';
          details = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
          failed++;
        }

        rows.push({ theme, profile, pack: pack.name, status, layers: layerCount, details });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Map-mode matrix.
  //
  // The brief asks the validator to verify every (mode × theme ×
  // profile) combination. Cart already covers the full feature-pack
  // matrix above; here we add Standard + Satellite passes, also
  // walking theme × profile so we don't accidentally regress one of
  // them on a particular device tier (none of those parameters
  // affect the upstream / satellite skeletons today, but the matrix
  // is cheap and prevents future drift).
  // ---------------------------------------------------------------------
  for (const mode of MAP_MODES) {
    if (mode === 'cart') continue; // already covered above
    for (const theme of themes) {
      for (const profile of profiles) {
        const features = { ...FEATURES };
        let status = 'ok';
        let details = '';
        let layerCount = 0;
        try {
          const style = buildStyleForMode(mode, { theme, profile, features, pack: { name: `mode-${mode}` } });
          layerCount = style.layers.length;
          const errors = validate(style) || [];
          if (errors.length > 0) {
            status = 'fail';
            details = errors
              .slice(0, 5)
              .map((e) => `${e.line ? `L${e.line}: ` : ''}${e.message}`)
              .join(' | ');
            failed++;
          }
        } catch (err) {
          status = 'throw';
          details = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
          failed++;
        }
        rows.push({ theme, profile, pack: `mode-${mode}`, status, layers: layerCount, details });
      }
    }
  }

  /**
   * Wraps buildStyle with per-pack environment stubs that can't be
   * cleanly expressed through `features`. Specifically: a synthetic
   * bathymetry source when `pack.stubBathymetryUrl` is on.
   */
  function buildStyleWithStubs({ theme, profile, features, pack }) {
    const hypso = pack.hypso ?? null;
    const sourceStubs = {};
    if (pack.stubBathymetryUrl) {
      sourceStubs['bathymetry'] = {
        type: 'raster',
        url: 'pmtiles://https://example.com/gebco.pmtiles',
        tileSize: 256,
        minzoom: 3,
        maxzoom: 9,
      };
    }
    if (pack.stubCarpathianOsmUrl) {
      sourceStubs['carpathian-osm'] = {
        type: 'vector',
        url: 'pmtiles://https://example.com/carpathian-osm.pmtiles',
      };
    }
    if (pack.stubSkyViewFactorUrl) {
      sourceStubs['sky-view-factor'] = {
        type: 'raster',
        url: 'pmtiles://https://example.com/svf.pmtiles',
        tileSize: 256,
        minzoom: 7,
        maxzoom: 14,
      };
    }
    if (pack.stubWorldcoverUrl) {
      sourceStubs['worldcover'] = {
        type: 'raster',
        url: 'pmtiles://https://example.com/worldcover.pmtiles',
        tileSize: 256,
        minzoom: 6,
        maxzoom: 13,
      };
    }
    if (pack.stubCanopyHeightUrl) {
      sourceStubs['canopy-height'] = {
        type: 'raster',
        url: 'pmtiles://https://example.com/canopy-height.pmtiles',
        tileSize: 256,
        minzoom: 8,
        maxzoom: 13,
      };
    }
    if (pack.stubCarpathianDemUrl) {
      sourceStubs['terrain-dem-carpathian'] = {
        type: 'raster-dem',
        url: 'pmtiles://https://example.com/carpathian-dem.pmtiles',
        encoding: 'terrarium',
        tileSize: 256,
        minzoom: 5,
        maxzoom: 14,
      };
    }
    // Optional terrain override — packs can synthesise a TERRAIN clone
    // with one or more URLs blanked to test the graceful-fallback
    // path. The override is shallow: every other terrain block keeps
    // its production URL so the rest of the matrix exercises the real
    // source-availability map.
    let terrainOverride = null;
    if (pack.disableCarpathianOsmUrl) {
      terrainOverride = {
        ...TERRAIN,
        carpathianOsm: { ...TERRAIN.carpathianOsm, url: null },
      };
    }
    // Blank the high-detail 10 m forest archive URL to exercise the
    // graceful-fallback path: forestCover stays on the global landcover
    // forest and the `forestcover_hi_*` layers must not emit.
    if (pack.disableForest10mUrl) {
      terrainOverride = {
        ...(terrainOverride ?? TERRAIN),
        forest10m: { ...TERRAIN.forest10m, url: null },
      };
    }
    return buildStyle({ theme, profile, features, hypso, sourceStubs, terrainOverride });
  }

  // ---------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------
  const width = {
    theme: Math.max(5, ...rows.map((r) => r.theme.length)),
    profile: Math.max(7, ...rows.map((r) => r.profile.length)),
    pack: Math.max(4, ...rows.map((r) => r.pack.length)),
    status: 6,
    layers: 6,
  };
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad('theme', width.theme),
    pad('profile', width.profile),
    pad('pack', width.pack),
    pad('status', width.status),
    pad('layers', width.layers),
  );
  console.log('-'.repeat(width.theme + width.profile + width.pack + width.status + width.layers + 4));

  for (const r of rows) {
    const statusMarker = r.status === 'ok' ? 'OK' : r.status.toUpperCase();
    console.log(
      pad(r.theme, width.theme),
      pad(r.profile, width.profile),
      pad(r.pack, width.pack),
      pad(statusMarker, width.status),
      pad(r.layers, width.layers),
    );
    if (r.details) console.log('   ->', r.details);
  }

  console.log();
  console.log(`Total: ${rows.length}   Failed: ${failed}`);

  // ---------------------------------------------------------------------
  // Ramp dictionary sanity — sniff every preset for well-formed stops.
  // Catches typos like '#abcd' or unsorted elevations before the live
  // map sees them.
  // ---------------------------------------------------------------------
  const { RAMPS, FALLBACK_RAMP_ID } = await importEsm('src/style/hypso/ramps.js');
  console.log();
  console.log('Hypsometric ramp dictionary sanity:');
  let rampFails = 0;
  for (const [id, ramp] of Object.entries(RAMPS)) {
    const errs = [];
    if (typeof ramp.id !== 'string') errs.push('missing id');
    if (typeof ramp.name !== 'string') errs.push('missing name');
    for (const variant of ['light', 'dark']) {
      const stops = ramp[variant];
      if (!Array.isArray(stops) || stops.length < 2) {
        errs.push(`${variant}: not an array of ≥ 2 stops`);
        continue;
      }
      let lastElev = -Infinity;
      let hasNeg = false;
      for (const stop of stops) {
        if (!Array.isArray(stop) || stop.length !== 2) {
          errs.push(`${variant}: stop is not [number, '#rrggbb']`);
          break;
        }
        const [elev, hex] = stop;
        if (typeof elev !== 'number' || !Number.isFinite(elev)) errs.push(`${variant}: non-numeric elevation`);
        if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) errs.push(`${variant}: bad hex ${hex}`);
        if (elev < lastElev) errs.push(`${variant}: stops not sorted ascending`);
        lastElev = elev;
        if (elev < 0) hasNeg = true;
      }
      if (!hasNeg) errs.push(`${variant}: no bathymetry stop (elev < 0)`);
    }
    if (errs.length === 0) {
      console.log(`  OK   ${id}`);
    } else {
      rampFails++;
      console.log(`  FAIL ${id}: ${errs.join('; ')}`);
    }
  }
  if (!RAMPS[FALLBACK_RAMP_ID]) {
    rampFails++;
    console.log(`  FAIL fallback ramp '${FALLBACK_RAMP_ID}' is missing from RAMPS`);
  }
  console.log(`Total ramps: ${Object.keys(RAMPS).length}   Failed: ${rampFails}`);

  // ---------------------------------------------------------------------
  // ESA WorldCover ramp sanity — every canonical class must have a
  // colour in BOTH light and dark variants, water (80) must be
  // transparent in both, and every non-transparent value must be a
  // well-formed `#rrggbb`.
  // ---------------------------------------------------------------------
  const {
    WORLDCOVER_RAMPS,
    WORLDCOVER_CLASSES,
    WORLDCOVER_OPACITY,
  } = await importEsm('src/style/worldcover-ramps.js');
  console.log();
  console.log('WorldCover ramp dictionary sanity:');
  let wcFails = 0;
  for (const variant of ['light', 'dark']) {
    const ramp = WORLDCOVER_RAMPS[variant];
    const errs = [];
    if (!ramp || typeof ramp !== 'object') {
      errs.push(`${variant}: not an object`);
    } else {
      for (const value of WORLDCOVER_CLASSES) {
        const hex = ramp[value];
        if (typeof hex !== 'string' || hex.length === 0) {
          errs.push(`${variant}: missing colour for class ${value}`);
          continue;
        }
        if (value === 80) {
          if (hex !== 'transparent') {
            errs.push(`${variant}: class 80 (water) must be 'transparent', got ${hex}`);
          }
          continue;
        }
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
          errs.push(`${variant}: bad hex for class ${value}: ${hex}`);
        }
      }
    }
    if (errs.length === 0) {
      console.log(`  OK   ${variant}`);
    } else {
      wcFails += errs.length;
      for (const e of errs) console.log(`  FAIL ${e}`);
    }
  }
  // Opacity ceilings must obey: hypsoActive < default (so the elevation
  // tint stays the dominant signal when both are on).
  if (
    typeof WORLDCOVER_OPACITY?.default !== 'number' ||
    typeof WORLDCOVER_OPACITY?.hypsoActive !== 'number' ||
    !(WORLDCOVER_OPACITY.hypsoActive < WORLDCOVER_OPACITY.default)
  ) {
    wcFails++;
    console.log(
      `  FAIL WORLDCOVER_OPACITY must satisfy hypsoActive < default (got ${JSON.stringify(WORLDCOVER_OPACITY)})`,
    );
  } else {
    console.log(
      `  OK   WORLDCOVER_OPACITY: default=${WORLDCOVER_OPACITY.default}, hypsoActive=${WORLDCOVER_OPACITY.hypsoActive}`,
    );
  }
  console.log(`WorldCover ramps: ${wcFails === 0 ? 'all OK' : `${wcFails} FAILED`}`);
  if (wcFails > 0) failed += wcFails;

  // ---------------------------------------------------------------------
  // ETH Canopy Height ramp sanity — every stop must be
  // [height_m, '#rrggbb', alpha_0_255], stops must be sorted
  // ascending by height, the first stop must carry alpha = 0 (the
  // brief's hard requirement: pixels with height = 0 must NEVER
  // tint the canvas), every alpha must be in [0, 255], and the
  // opacity ceilings must satisfy hypsoActive < default <
  // worldcoverActive (so hypso suppresses while WorldCover
  // reinforces).
  // ---------------------------------------------------------------------
  const {
    CANOPY_RAMPS,
    CANOPY_OPACITY,
    CANOPY_TREE_VALUE,
  } = await importEsm('src/style/canopy-height-ramps.js');
  console.log();
  console.log('Canopy Height ramp dictionary sanity:');
  let chFails = 0;
  for (const variant of ['light', 'dark']) {
    const stops = CANOPY_RAMPS?.[variant];
    const errs = [];
    if (!Array.isArray(stops) || stops.length < 2) {
      errs.push(`${variant}: not an array of ≥ 2 stops`);
    } else {
      let lastH = -Infinity;
      for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        if (!Array.isArray(stop) || stop.length !== 3) {
          errs.push(`${variant}: stop[${i}] is not [h, '#rrggbb', alpha]`);
          continue;
        }
        const [h, hex, alpha] = stop;
        if (typeof h !== 'number' || !Number.isFinite(h)) {
          errs.push(`${variant}: stop[${i}] non-numeric height`);
        }
        if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
          errs.push(`${variant}: stop[${i}] bad hex ${hex}`);
        }
        if (
          typeof alpha !== 'number' ||
          !Number.isFinite(alpha) ||
          alpha < 0 ||
          alpha > 255
        ) {
          errs.push(`${variant}: stop[${i}] bad alpha ${alpha}`);
        }
        if (h < lastH) errs.push(`${variant}: stops not sorted ascending`);
        lastH = h;
        // The first stop (height = 0) MUST be fully transparent.
        if (i === 0) {
          if (h !== 0) errs.push(`${variant}: first stop must be height = 0`);
          if (alpha !== 0) {
            errs.push(
              `${variant}: first stop alpha must be 0 (got ${alpha}) — non-forest pixels must never tint`,
            );
          }
        }
      }
    }
    if (errs.length === 0) {
      console.log(`  OK   ${variant}`);
    } else {
      chFails += errs.length;
      for (const e of errs) console.log(`  FAIL ${e}`);
    }
  }
  // Opacity ceilings: hypsoActive < default (hypso suppresses canopy
  // so the elevation tint stays dominant); worldcoverActive > default
  // (canopy reinforces over the flat WorldCover wash so stand-age
  // detail reads through).
  const o = CANOPY_OPACITY ?? {};
  if (
    typeof o.default !== 'number' ||
    typeof o.hypsoActive !== 'number' ||
    typeof o.worldcoverActive !== 'number' ||
    !(o.hypsoActive < o.default) ||
    !(o.worldcoverActive > o.default)
  ) {
    chFails++;
    console.log(
      `  FAIL CANOPY_OPACITY must satisfy hypsoActive < default < worldcoverActive (got ${JSON.stringify(o)})`,
    );
  } else {
    console.log(
      `  OK   CANOPY_OPACITY: hypsoActive=${o.hypsoActive}, default=${o.default}, worldcoverActive=${o.worldcoverActive}`,
    );
  }
  // Tree-value sanity — should be the WorldCover tree-cover class (10).
  if (CANOPY_TREE_VALUE !== 10) {
    chFails++;
    console.log(
      `  FAIL CANOPY_TREE_VALUE must equal 10 (WorldCover tree-cover class), got ${CANOPY_TREE_VALUE}`,
    );
  } else {
    console.log(`  OK   CANOPY_TREE_VALUE === 10`);
  }
  console.log(`Canopy Height ramps: ${chFails === 0 ? 'all OK' : `${chFails} FAILED`}`);
  if (chFails > 0) failed += chFails;

  // ---------------------------------------------------------------------
  // Forest leaf-type token dictionary sanity — every canonical leaf
  // slot (needleleaved / broadleaved / mixed / leafless / unknown)
  // must have well-formed `fill`, `outline` and `label` colours in
  // BOTH light and dark variants. The protected-area accent must
  // carry a hex stroke and a tuple-of-2 dasharray. Label-area
  // thresholds must be a sane non-empty zoom→m² ladder.
  // ---------------------------------------------------------------------
  const {
    FOREST_LEAF,
    FOREST_PROTECT,
    FOREST_LABEL,
    FOREST_LEAF_KEYS,
  } = await importEsm('src/style/forest-leaf-tokens.js');
  console.log();
  console.log('Forest leaf-type token dictionary sanity:');
  let flFails = 0;
  for (const variant of ['light', 'dark']) {
    const bundle = FOREST_LEAF[variant];
    if (!bundle || typeof bundle !== 'object') {
      flFails++;
      console.log(`  FAIL ${variant}: bundle is not an object`);
      continue;
    }
    let bundleErrors = 0;
    for (const slot of FOREST_LEAF_KEYS) {
      const tok = bundle[slot];
      if (!tok || typeof tok !== 'object') {
        flFails++;
        bundleErrors++;
        console.log(`  FAIL ${variant}.${slot}: missing token`);
        continue;
      }
      for (const role of ['fill', 'outline', 'label']) {
        const hex = tok[role];
        if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
          flFails++;
          bundleErrors++;
          console.log(`  FAIL ${variant}.${slot}.${role}: bad hex ${hex}`);
        }
      }
    }
    if (bundleErrors === 0) console.log(`  OK   ${variant} bundle (${FOREST_LEAF_KEYS.length} slots × 3 roles)`);
    // Protected-area accent.
    const prot = FOREST_PROTECT[variant];
    if (!prot || typeof prot !== 'object') {
      flFails++;
      console.log(`  FAIL ${variant}.protect: missing accent`);
    } else {
      const stroke = prot.stroke;
      if (typeof stroke !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(stroke)) {
        flFails++;
        console.log(`  FAIL ${variant}.protect.stroke: bad hex ${stroke}`);
      }
      const dash = prot.dash;
      if (!Array.isArray(dash) || dash.length !== 2 || !dash.every((n) => typeof n === 'number' && n > 0)) {
        flFails++;
        console.log(`  FAIL ${variant}.protect.dash: not a [n, n] tuple`);
      } else {
        console.log(`  OK   ${variant}.protect: stroke ${stroke}, dash ${JSON.stringify(dash)}`);
      }
    }
  }
  // Label thresholds — keys must be ascending zoom integers, values
  // must be strictly DECREASING m² thresholds (deeper zoom → smaller
  // mass labelled). fontScale must be a positive number.
  if (typeof FOREST_LABEL?.fontScale !== 'number' || FOREST_LABEL.fontScale <= 0) {
    flFails++;
    console.log(`  FAIL FOREST_LABEL.fontScale must be a positive number`);
  }
  const minAreaKeys = Object.keys(FOREST_LABEL?.minAreaForName ?? {})
    .map((k) => Number(k))
    .sort((a, b) => a - b);
  if (minAreaKeys.length === 0) {
    flFails++;
    console.log(`  FAIL FOREST_LABEL.minAreaForName must not be empty`);
  } else {
    let lastVal = Number.POSITIVE_INFINITY;
    let monotonic = true;
    for (const k of minAreaKeys) {
      const v = FOREST_LABEL.minAreaForName[k];
      if (typeof v !== 'number' || v <= 0) {
        flFails++;
        monotonic = false;
        console.log(`  FAIL FOREST_LABEL.minAreaForName[${k}]: not a positive number`);
        break;
      }
      if (v >= lastVal) {
        flFails++;
        monotonic = false;
        console.log(`  FAIL FOREST_LABEL.minAreaForName not strictly decreasing at z=${k}`);
        break;
      }
      lastVal = v;
    }
    if (monotonic) {
      console.log(
        `  OK   FOREST_LABEL.minAreaForName: ${minAreaKeys
          .map((k) => `z${k}→${FOREST_LABEL.minAreaForName[k]}m²`)
          .join(', ')}`,
      );
    }
  }
  console.log(`Forest leaf-type tokens: ${flFails === 0 ? 'all OK' : `${flFails} FAILED`}`);
  if (flFails > 0) failed += flFails;

  // ---------------------------------------------------------------------
  // Forest leaf-type LAYER invariants — graceful fallback + emission +
  // ordering. Same pattern as the Carpathian trail invariants above:
  //
  //   • carpathianOsm.url=null AND forestLeafType=true →
  //     NO carpathian_forest_* layers (graceful fallback).
  //   • carpathianOsm.url=set  AND forestLeafType=true →
  //     fill / outline / protect_outline / label all present, in
  //     paint order.
  //   • The fill paints AFTER water_fill (no leaf-type bleed into
  //     water) and BEFORE roads/trails (so the trail web reads on
  //     top of the biom-clusters).
  // ---------------------------------------------------------------------
  console.log();
  console.log('Forest leaf-type layer invariants:');
  let forestLayerFails = 0;
  const forestIds = [
    'carpathian_forest_fill',
    'carpathian_forest_outline',
    'carpathian_forest_protect_outline',
    'carpathian_forest_label',
  ];

  // Graceful fallback — URL null, feature flag on.
  const forestNoSourceStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, carpathian: true, forestLeafType: true },
    sourceStubs: {},
    terrainOverride: {
      ...TERRAIN,
      carpathianOsm: { ...TERRAIN.carpathianOsm, url: null },
    },
  });
  for (const id of forestIds) {
    if (forestNoSourceStyle.layers.some((l) => l.id === id)) {
      forestLayerFails++;
      console.log(`  FAIL ${id} emitted with carpathianOsm.url=null (should be off)`);
    } else {
      console.log(`  OK   ${id} absent without source (graceful fallback)`);
    }
  }

  // Emission — production URL, feature flag on.
  const forestWithSourceStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, carpathian: true, forestLeafType: true },
    sourceStubs: {
      'carpathian-osm': {
        type: 'vector',
        url: 'pmtiles://https://example.com/carpathian-osm.pmtiles',
      },
    },
  });
  const forestIdsByPos = forestWithSourceStyle.layers
    .map((l, i) => ({ id: l.id, i }))
    .filter((e) => forestIds.includes(e.id));
  for (const id of forestIds) {
    if (!forestIdsByPos.some((e) => e.id === id)) {
      forestLayerFails++;
      console.log(`  FAIL ${id} not emitted with carpathianOsm source present`);
    } else {
      console.log(`  OK   ${id} present`);
    }
  }
  // Paint order: fill → outline → protect_outline → label.
  const positions = forestIds
    .map((id) => forestWithSourceStyle.layers.findIndex((l) => l.id === id));
  if (positions.every((p) => p >= 0) &&
      positions[0] < positions[1] &&
      positions[1] < positions[2] &&
      positions[2] < positions[3]) {
    console.log('  OK   fill → outline → protect_outline → label order');
  } else {
    forestLayerFails++;
    console.log(`  FAIL forest layers not in expected order: ${JSON.stringify(positions)}`);
  }
  // Z-order vs water_fill: forest fill paints AFTER water_fill so it
  // overlays water-bordering land and won't ever bleed under a lake.
  // (We also rely on this for the canopy-height stack interaction.)
  const waterFillIdx = forestWithSourceStyle.layers.findIndex((l) => l.id === 'water_fill');
  const fillIdx = positions[0];
  if (waterFillIdx === -1 || fillIdx === -1) {
    forestLayerFails++;
    console.log(`  FAIL water_fill or forest_fill not found (water=${waterFillIdx}, fill=${fillIdx})`);
  } else if (fillIdx > waterFillIdx) {
    console.log(`  OK   forest_fill (idx ${fillIdx}) paints after water_fill (idx ${waterFillIdx})`);
  } else {
    forestLayerFails++;
    console.log(`  FAIL forest_fill (idx ${fillIdx}) must paint AFTER water_fill (idx ${waterFillIdx})`);
  }
  console.log(`Forest leaf-type layer invariants: ${forestLayerFails === 0 ? 'all OK' : `${forestLayerFails} FAILED`}`);
  if (forestLayerFails > 0) failed += forestLayerFails;

  // ---------------------------------------------------------------------
  // Forest-cover overlay invariants — the toggleable Google-Earth-style
  // green forest highlight. Unlike every other forest treatment it reads
  // the GLOBAL base vector source, so:
  //   • feature flag OFF → none of the three layers emit.
  //   • feature flag ON  → fill / edge / rim all emit, in paint order,
  //     with NO source stub required (the base source is always there).
  //   • the fill paints AFTER water_fill (so it never bleeds under a
  //     lake) and BEFORE the first road layer (so the road network and
  //     labels stay legible on top of the canopy).
  // ---------------------------------------------------------------------
  console.log();
  console.log('Forest-cover overlay invariants:');
  let forestCoverFails = 0;
  const forestCoverIds = ['forestcover_fill', 'forestcover_edge'];

  // Flag OFF — nothing emits.
  const forestCoverOffStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, forestCover: false },
    sourceStubs: {},
  });
  const offEmitted = forestCoverOffStyle.layers.filter((l) =>
    forestCoverIds.includes(l.id),
  );
  if (offEmitted.length === 0) {
    console.log('  OK   flag OFF → no forest-cover layers emitted');
  } else {
    forestCoverFails++;
    console.log(`  FAIL flag OFF but emitted: ${offEmitted.map((l) => l.id).join(', ')}`);
  }

  // Flag ON — both layers emit with NO source stub (global base source).
  const forestCoverOnStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, forestCover: true },
    sourceStubs: {},
  });
  const fcLayers = forestCoverOnStyle.layers;
  for (const id of forestCoverIds) {
    if (fcLayers.some((l) => l.id === id)) {
      console.log(`  OK   ${id} present`);
    } else {
      forestCoverFails++;
      console.log(`  FAIL ${id} not emitted with feature flag on`);
    }
  }
  // Every forest-cover layer must reference the global openmaptiles
  // source-layer `landcover` (never a hosted archive).
  for (const id of forestCoverIds) {
    const layer = fcLayers.find((l) => l.id === id);
    if (layer && layer.source === 'openmaptiles' && layer['source-layer'] === 'landcover') {
      console.log(`  OK   ${id} reads openmaptiles/landcover`);
    } else if (layer) {
      forestCoverFails++;
      console.log(`  FAIL ${id} wrong source: ${layer.source}/${layer['source-layer']}`);
    }
  }
  // Paint order: fill → edge.
  const fcPos = forestCoverIds.map((id) => fcLayers.findIndex((l) => l.id === id));
  if (fcPos.every((p) => p >= 0) && fcPos[0] < fcPos[1]) {
    console.log('  OK   fill → edge order');
  } else {
    forestCoverFails++;
    console.log(`  FAIL forest-cover layers not in expected order: ${JSON.stringify(fcPos)}`);
  }

  // Flat preset: with forest-cover ON, every relief / 3D / elevation cue
  // must be suppressed (resolveFeatures coupling) — the Google-Earth flat
  // read. Assert the relief layers are absent AND no 3D terrain block.
  const reliefAbsent = (label, pred) => {
    const hit = fcLayers.find(pred);
    if (!hit) {
      console.log(`  OK   flat preset: no ${label} layer with forest-cover on`);
    } else {
      forestCoverFails++;
      console.log(`  FAIL flat preset: ${label} layer "${hit.id}" emitted with forest-cover on`);
    }
  };
  reliefAbsent('hillshade', (l) => /^hillshade_/.test(l.id));
  reliefAbsent('hypso-tint', (l) => l.id === 'hypso_tint');
  reliefAbsent('contour', (l) => /^contour_/.test(l.id));
  reliefAbsent('texture-shading', (l) => l.id === 'texture_shading');
  reliefAbsent('worldcover-tint', (l) => l.id === 'worldcover-tint');
  if (!forestCoverOnStyle.terrain) {
    console.log('  OK   flat preset: no 3D terrain block with forest-cover on');
  } else {
    forestCoverFails++;
    console.log('  FAIL flat preset: style.terrain present with forest-cover on');
  }
  // Z-order: fill AFTER water_fill, BEFORE the first road layer.
  const fcWaterIdx = fcLayers.findIndex((l) => l.id === 'water_fill');
  const fcFillIdx = fcPos[0];
  const fcFirstRoadIdx = fcLayers.findIndex((l) => /^road/.test(l.id));
  if (fcWaterIdx === -1 || fcFillIdx === -1) {
    forestCoverFails++;
    console.log(`  FAIL water_fill or forestcover_fill not found (water=${fcWaterIdx}, fill=${fcFillIdx})`);
  } else if (fcFillIdx > fcWaterIdx) {
    console.log(`  OK   forestcover_fill (idx ${fcFillIdx}) paints after water_fill (idx ${fcWaterIdx})`);
  } else {
    forestCoverFails++;
    console.log(`  FAIL forestcover_fill (idx ${fcFillIdx}) must paint AFTER water_fill (idx ${fcWaterIdx})`);
  }
  if (fcFirstRoadIdx !== -1 && fcPos[1] >= 0) {
    if (fcPos[1] < fcFirstRoadIdx) {
      console.log(`  OK   forest-cover edge (idx ${fcPos[1]}) paints before first road (idx ${fcFirstRoadIdx})`);
    } else {
      forestCoverFails++;
      console.log(`  FAIL forest-cover layers must paint BEFORE roads (edge=${fcPos[1]}, road=${fcFirstRoadIdx})`);
    }
  }
  console.log(`Forest-cover overlay invariants: ${forestCoverFails === 0 ? 'all OK' : `${forestCoverFails} FAILED`}`);
  if (forestCoverFails > 0) failed += forestCoverFails;

  // ---------------------------------------------------------------------
  // High-detail 10 m forest invariants — the Carpathian-only vector
  // upgrade layered ON TOP of the global landcover forestCover. Asserts:
  //   • source-gated: forestCover ON + forest-10m archive present → the
  //     `forestcover_hi_fill` / `forestcover_hi_edge` layers emit, reading
  //     the `forest-10m` vector source / `forest` source-layer.
  //   • graceful fallback: forestCover ON but archive URL null → the hi
  //     layers must NOT emit, while the base forestcover layers stay.
  //   • the hi layers paint AFTER the base landcover forestcover layers
  //     (so the crisp 10 m mass supersedes the coarse forest inside the
  //     bbox) and BEFORE the first road (legibility).
  // ---------------------------------------------------------------------
  console.log();
  console.log('High-detail 10 m forest invariants:');
  let forest10mFails = 0;
  const forest10mIds = ['forestcover_hi_fill', 'forestcover_hi_edge'];

  // Source present (real config URL) → hi layers emit.
  const forest10mOnStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, forestCover: true },
    sourceStubs: {},
  });
  const f10Layers = forest10mOnStyle.layers;
  for (const id of forest10mIds) {
    const layer = f10Layers.find((l) => l.id === id);
    if (!layer) {
      forest10mFails++;
      console.log(`  FAIL ${id} not emitted with forest-10m source present`);
    } else if (layer.source === 'forest-10m' && layer['source-layer'] === 'forest') {
      console.log(`  OK   ${id} reads forest-10m/forest`);
    } else {
      forest10mFails++;
      console.log(`  FAIL ${id} wrong source: ${layer.source}/${layer['source-layer']}`);
    }
  }
  // Hi layers paint AFTER the base landcover forestcover layers.
  const baseFillIdx = f10Layers.findIndex((l) => l.id === 'forestcover_fill');
  const hiFillIdx = f10Layers.findIndex((l) => l.id === 'forestcover_hi_fill');
  const hiEdgeIdx = f10Layers.findIndex((l) => l.id === 'forestcover_hi_edge');
  if (baseFillIdx >= 0 && hiFillIdx > baseFillIdx && hiEdgeIdx > hiFillIdx) {
    console.log(`  OK   hi layers paint after base forest (base=${baseFillIdx}, hiFill=${hiFillIdx}, hiEdge=${hiEdgeIdx})`);
  } else {
    forest10mFails++;
    console.log(`  FAIL hi layers order wrong (base=${baseFillIdx}, hiFill=${hiFillIdx}, hiEdge=${hiEdgeIdx})`);
  }
  // Hi layers paint BEFORE the first road layer.
  const f10FirstRoadIdx = f10Layers.findIndex((l) => /^road/.test(l.id));
  if (f10FirstRoadIdx !== -1 && hiEdgeIdx >= 0 && hiEdgeIdx < f10FirstRoadIdx) {
    console.log(`  OK   hi edge (idx ${hiEdgeIdx}) paints before first road (idx ${f10FirstRoadIdx})`);
  } else if (f10FirstRoadIdx !== -1) {
    forest10mFails++;
    console.log(`  FAIL hi layers must paint BEFORE roads (hiEdge=${hiEdgeIdx}, road=${f10FirstRoadIdx})`);
  }

  // Source absent (URL blanked) → hi layers must NOT emit; base stays.
  const forest10mOffStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, forestCover: true },
    sourceStubs: {},
    terrainOverride: { ...TERRAIN, forest10m: { ...TERRAIN.forest10m, url: null } },
  });
  const f10OffEmitted = forest10mOffStyle.layers.filter((l) => forest10mIds.includes(l.id));
  if (f10OffEmitted.length === 0) {
    console.log('  OK   no forest-10m source → hi layers suppressed (fallback)');
  } else {
    forest10mFails++;
    console.log(`  FAIL hi layers emitted without source: ${f10OffEmitted.map((l) => l.id).join(', ')}`);
  }
  if (forest10mOffStyle.layers.some((l) => l.id === 'forestcover_fill')) {
    console.log('  OK   base forestcover_fill still present in fallback');
  } else {
    forest10mFails++;
    console.log('  FAIL base forestcover_fill missing in fallback');
  }
  // And the source itself must be absent when the URL is null.
  if (!forest10mOffStyle.sources['forest-10m']) {
    console.log('  OK   forest-10m source omitted when URL null');
  } else {
    forest10mFails++;
    console.log('  FAIL forest-10m source present despite null URL');
  }
  console.log(`High-detail 10 m forest invariants: ${forest10mFails === 0 ? 'all OK' : `${forest10mFails} FAILED`}`);
  if (forest10mFails > 0) failed += forest10mFails;

  // ---------------------------------------------------------------------
  // Forest-mode markup invariants — the independent accent toggles that
  // only act inside the flat "Лесной покров" view. Asserts:
  //   • forest-mode only: with forestCover OFF none of the accent layers
  //     emit, even when every sub-flag is ON (structural gating).
  //   • independence: each sub-flag emits ONLY its own layer ids.
  //   • on-top ordering: the accents paint AFTER the base label stack so
  //     the highlight semantics hold (bold-blue city wins the collision).
  // ---------------------------------------------------------------------
  console.log();
  console.log('Forest-mode markup invariants:');
  let forestMarkupFails = 0;
  const markupIds = {
    forestCities: ['forest_city_dot', 'forest_city_label'],
    forestWaterAccent: ['forest_water_accent_line', 'forest_water_accent_label'],
    forestRoadsBold: ['forest_roads_bold'],
    forestRoadsOrange: ['forest_roads_orange_casing', 'forest_roads_orange'],
  };
  const allMarkupIds = Object.values(markupIds).flat();

  // Forest mode OFF + every sub-flag ON → no accent layer may emit.
  const markupOffMode = buildStyle({
    theme: 'light',
    profile: 'high',
    features: {
      ...FEATURES,
      forestCover: false,
      forestCities: true,
      forestWaterAccent: true,
      forestRoadsBold: true,
      forestRoadsOrange: true,
    },
    sourceStubs: {},
  });
  const leakedOff = markupOffMode.layers.filter((l) => allMarkupIds.includes(l.id));
  if (leakedOff.length === 0) {
    console.log('  OK   forestCover OFF → no markup accents emitted (forest-mode only)');
  } else {
    forestMarkupFails++;
    console.log(`  FAIL markup accents leaked outside forest mode: ${leakedOff.map((l) => l.id).join(', ')}`);
  }

  // Forest mode ON + all accents ON → every accent id emits exactly once.
  const markupAllOn = buildStyle({
    theme: 'light',
    profile: 'high',
    features: {
      ...FEATURES,
      forestCover: true,
      forestCities: true,
      forestWaterAccent: true,
      forestRoadsBold: true,
      forestRoadsOrange: true,
    },
    sourceStubs: {},
  });
  for (const id of allMarkupIds) {
    const n = markupAllOn.layers.filter((l) => l.id === id).length;
    if (n === 1) {
      console.log(`  OK   ${id} emitted once with forestCover + accents on`);
    } else {
      forestMarkupFails++;
      console.log(`  FAIL ${id} emitted ${n} times (expected 1)`);
    }
  }

  // Independence: cities-only must emit the city ids and NOT the others.
  const markupCitiesOnly = buildStyle({
    theme: 'light',
    profile: 'high',
    features: {
      ...FEATURES,
      forestCover: true,
      forestCities: true,
      forestWaterAccent: false,
      forestRoadsBold: false,
      forestRoadsOrange: false,
    },
    sourceStubs: {},
  });
  const citiesOnlyIds = markupCitiesOnly.layers.map((l) => l.id);
  const cityPresent = markupIds.forestCities.every((id) => citiesOnlyIds.includes(id));
  const othersAbsent = [
    ...markupIds.forestWaterAccent,
    ...markupIds.forestRoadsBold,
    ...markupIds.forestRoadsOrange,
  ].every((id) => !citiesOnlyIds.includes(id));
  if (cityPresent && othersAbsent) {
    console.log('  OK   sub-flags are independent (cities on, water/roads off)');
  } else {
    forestMarkupFails++;
    console.log(`  FAIL sub-flag independence broken (cityPresent=${cityPresent}, othersAbsent=${othersAbsent})`);
  }

  // Independence (mirror case): roads-orange-only must emit the orange
  // road ids and NOT the cities/water/dark-roads ids.
  const markupRoadsOrangeOnly = buildStyle({
    theme: 'light',
    profile: 'high',
    features: {
      ...FEATURES,
      forestCover: true,
      forestCities: false,
      forestWaterAccent: false,
      forestRoadsBold: false,
      forestRoadsOrange: true,
    },
    sourceStubs: {},
  });
  const orangeOnlyIds = markupRoadsOrangeOnly.layers.map((l) => l.id);
  const orangePresent = markupIds.forestRoadsOrange.every((id) => orangeOnlyIds.includes(id));
  const orangeOthersAbsent = [
    ...markupIds.forestCities,
    ...markupIds.forestWaterAccent,
    ...markupIds.forestRoadsBold,
  ].every((id) => !orangeOnlyIds.includes(id));
  if (orangePresent && orangeOthersAbsent) {
    console.log('  OK   sub-flags are independent (orange roads on, others off)');
  } else {
    forestMarkupFails++;
    console.log(`  FAIL orange-roads independence broken (present=${orangePresent}, othersAbsent=${orangeOthersAbsent})`);
  }

  // On-top ordering: the bold-blue city label paints AFTER the base
  // city label so the global symbol collision favours the accent.
  const baseCityIdx = markupAllOn.layers.findIndex((l) => l.id === 'label_city_large');
  const accentCityIdx = markupAllOn.layers.findIndex((l) => l.id === 'forest_city_label');
  if (baseCityIdx >= 0 && accentCityIdx > baseCityIdx) {
    console.log(`  OK   forest_city_label (idx ${accentCityIdx}) paints after base label_city_large (idx ${baseCityIdx})`);
  } else {
    forestMarkupFails++;
    console.log(`  FAIL city accent must paint after base city label (accent=${accentCityIdx}, base=${baseCityIdx})`);
  }
  console.log(`Forest-mode markup invariants: ${forestMarkupFails === 0 ? 'all OK' : `${forestMarkupFails} FAILED`}`);
  if (forestMarkupFails > 0) failed += forestMarkupFails;

  // ---------------------------------------------------------------------
  // Hazardous-terrain LAYER invariants — graceful fallback + emission
  // + always-on-top ordering. Without a carpathian-osm source the 12
  // hazard layers must NOT emit; with the source they all emit, AFTER
  // every other label/symbol layer (so they win every collision).
  // ---------------------------------------------------------------------
  console.log();
  console.log('Hazardous-terrain layer invariants:');
  let hazardLayerFails = 0;
  const hazardIds = [
    'hazard_peak_extreme_glow',
    'hazard_peak_extreme_ring',
    'hazard_peak_extreme_label',
    'hazard_peak_hard_glow',
    'hazard_peak_hard_ring',
    'hazard_peak_hard_label',
    'hazard_cliff_glow',
    'hazard_cliff_ring',
    'hazard_cliff_label',
    'hazard_pass_danger_glow',
    'hazard_pass_danger_ring',
    'hazard_pass_danger_label',
  ];

  // Graceful fallback — URL null, feature flag on.
  const hazardNoSourceStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, hazardousTerrain: true },
    sourceStubs: {},
    terrainOverride: {
      ...TERRAIN,
      carpathianOsm: { ...TERRAIN.carpathianOsm, url: null },
    },
  });
  let absentCount = 0;
  for (const id of hazardIds) {
    if (hazardNoSourceStyle.layers.some((l) => l.id === id)) {
      hazardLayerFails++;
      console.log(`  FAIL ${id} emitted with carpathianOsm.url=null (should be off)`);
    } else {
      absentCount++;
    }
  }
  console.log(`  OK   all 12 hazard_* layers absent without source (${absentCount}/12)`);

  // Emission — production URL, feature flag on.
  const hazardWithSourceStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, hazardousTerrain: true },
    sourceStubs: {
      'carpathian-osm': {
        type: 'vector',
        url: 'pmtiles://https://example.com/carpathian-osm.pmtiles',
      },
    },
  });
  let presentCount = 0;
  for (const id of hazardIds) {
    if (!hazardWithSourceStyle.layers.some((l) => l.id === id)) {
      hazardLayerFails++;
      console.log(`  FAIL ${id} not emitted with carpathian-osm source present`);
    } else {
      presentCount++;
    }
  }
  console.log(`  OK   all 12 hazard_* layers present with source (${presentCount}/12)`);

  // Always-on-top: every hazard layer's index must be greater than
  // the index of the LAST non-hazard layer in the stack. Equivalent
  // to "hazards are emitted last".
  const hazardLayers = hazardWithSourceStyle.layers
    .map((l, i) => ({ id: l.id, i }))
    .filter((e) => hazardIds.includes(e.id));
  const minHazardIdx = Math.min(...hazardLayers.map((e) => e.i));
  const maxNonHazardIdx = hazardWithSourceStyle.layers
    .map((l, i) => ({ id: l.id, i }))
    .filter((e) => !hazardIds.includes(e.id))
    .reduce((max, e) => Math.max(max, e.i), -1);
  if (minHazardIdx > maxNonHazardIdx) {
    console.log(`  OK   hazard_* layers all paint after every other layer (min=${minHazardIdx} > max-other=${maxNonHazardIdx})`);
  } else {
    hazardLayerFails++;
    console.log(`  FAIL hazard_* layers must paint last (min hazard idx ${minHazardIdx}, max other idx ${maxNonHazardIdx})`);
  }

  // Sort-key arbitration: every hazard label's symbol-sort-key must be
  // more negative than any peak-label sort-key (peak sort-key is
  // `coalesce(rank, 0)` which on Hoverla is -2061, so hazard labels
  // need to be < -2061; in practice they sit at -7e8 .. -1e9).
  let sortKeyOk = true;
  for (const layer of hazardWithSourceStyle.layers) {
    if (!layer.id.endsWith('_label') || !layer.id.startsWith('hazard_')) continue;
    const sk = layer.layout?.['symbol-sort-key'];
    if (typeof sk !== 'number' || sk > -1e6) {
      hazardLayerFails++;
      sortKeyOk = false;
      console.log(`  FAIL ${layer.id}: symbol-sort-key ${sk} not aggressively negative`);
    }
  }
  if (sortKeyOk) {
    console.log('  OK   every hazard label has symbol-sort-key < -1e6 (always wins collisions)');
  }
  console.log(`Hazardous-terrain layer invariants: ${hazardLayerFails === 0 ? 'all OK' : `${hazardLayerFails} FAILED`}`);
  if (hazardLayerFails > 0) failed += hazardLayerFails;

  // ---------------------------------------------------------------------
  // Hiking-route ribbon LAYER invariants — graceful fallback + emission
  // + z-order. The ribbons live BETWEEN the relief stack (hillshade /
  // hypso / texture) and the per-trail glow (`carpathian_trail_glow`),
  // so a single named route reads as one coloured underlay while the
  // SAC-scale dashed inline still paints crisply on top.
  //
  //   • hikingRoutes=true + carpathianOsm.url=null →
  //     NO hiking_route_* layers (graceful fallback).
  //   • hikingRoutes=true + carpathianOsm source present →
  //     hiking_route_ribbon, hiking_route_ribbon_highlight,
  //     hiking_route_label all emitted, in paint order.
  //   • hikingRoutes=false + carpathianOsm source present →
  //     NO hiking_route_* layers (feature flag wins).
  //   • Z-order: every hiking_route_* paints AFTER hillshade/hypso/
  //     texture (so the ribbon reads on top of relief) and BEFORE
  //     `carpathian_trail_glow` (so trail glow + dashes paint on top).
  // ---------------------------------------------------------------------
  console.log();
  console.log('Hiking-route ribbon layer invariants:');
  let hikingFails = 0;
  const hikingIds = [
    'hiking_route_ribbon',
    'hiking_route_ribbon_highlight',
    'hiking_route_label',
  ];

  // 1. Graceful fallback — feature on, source URL=null.
  const hikingNoSourceStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, hikingRoutes: true, carpathian: true },
    sourceStubs: {},
    terrainOverride: {
      ...TERRAIN,
      carpathianOsm: { ...TERRAIN.carpathianOsm, url: null },
    },
  });
  for (const id of hikingIds) {
    if (hikingNoSourceStyle.layers.some((l) => l.id === id)) {
      hikingFails++;
      console.log(`  FAIL ${id} emitted with carpathianOsm.url=null (should be off)`);
    } else {
      console.log(`  OK   ${id} absent without source (graceful fallback)`);
    }
  }

  // 2. Feature flag off — source present, but feature disabled.
  const hikingFeatureOffStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, hikingRoutes: false, carpathian: true },
    sourceStubs: {
      'carpathian-osm': {
        type: 'vector',
        url: 'pmtiles://https://example.com/carpathian-osm.pmtiles',
      },
    },
  });
  for (const id of hikingIds) {
    if (hikingFeatureOffStyle.layers.some((l) => l.id === id)) {
      hikingFails++;
      console.log(`  FAIL ${id} emitted with FEATURES.hikingRoutes=false`);
    } else {
      console.log(`  OK   ${id} absent with feature flag off`);
    }
  }

  // 3. Emission — feature on, source present.
  const hikingWithSourceStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, hikingRoutes: true, carpathian: true },
    sourceStubs: {
      'carpathian-osm': {
        type: 'vector',
        url: 'pmtiles://https://example.com/carpathian-osm.pmtiles',
      },
    },
  });
  const hikingPositions = hikingIds.map((id) =>
    hikingWithSourceStyle.layers.findIndex((l) => l.id === id),
  );
  for (let i = 0; i < hikingIds.length; i++) {
    if (hikingPositions[i] === -1) {
      hikingFails++;
      console.log(`  FAIL ${hikingIds[i]} not emitted with source present`);
    } else {
      console.log(`  OK   ${hikingIds[i]} present (idx ${hikingPositions[i]})`);
    }
  }
  // Paint order: ribbon → ribbon_highlight → label.
  if (
    hikingPositions.every((p) => p >= 0) &&
    hikingPositions[0] < hikingPositions[1] &&
    hikingPositions[1] < hikingPositions[2]
  ) {
    console.log('  OK   ribbon → ribbon_highlight → label paint order');
  } else {
    hikingFails++;
    console.log(`  FAIL hiking layers not in expected order: ${JSON.stringify(hikingPositions)}`);
  }

  // 4. Z-order — ribbon must paint AFTER hypso/hillshade and BEFORE
  //    carpathian_trail_glow. Pick the FIRST ribbon idx vs the
  //    relevant landmark layers.
  const ribbonIdx = hikingPositions[0];
  const trailGlowIdx = hikingWithSourceStyle.layers.findIndex(
    (l) => l.id === 'carpathian_trail_glow',
  );
  const hikingHillshadeIdx = hikingWithSourceStyle.layers.findIndex(
    (l) => l.id === 'hillshade' || l.id === 'hillshade_nw' || l.id === 'hillshade_top',
  );
  const hikingHypsoIdx = hikingWithSourceStyle.layers.findIndex(
    (l) => l.id === 'hypso_color_relief' || l.id === 'hypso_tint' || l.id === 'hypso',
  );
  if (ribbonIdx === -1) {
    // already reported above
  } else {
    // Above relief — only check when these layers actually emit (low
    // device profiles disable hillshade/hypso entirely).
    if (hikingHillshadeIdx >= 0 && ribbonIdx <= hikingHillshadeIdx) {
      hikingFails++;
      console.log(`  FAIL ribbon (idx ${ribbonIdx}) must paint AFTER hillshade (idx ${hikingHillshadeIdx})`);
    } else if (hikingHillshadeIdx >= 0) {
      console.log(`  OK   ribbon (idx ${ribbonIdx}) paints after hillshade (idx ${hikingHillshadeIdx})`);
    }
    if (hikingHypsoIdx >= 0 && ribbonIdx <= hikingHypsoIdx) {
      hikingFails++;
      console.log(`  FAIL ribbon (idx ${ribbonIdx}) must paint AFTER hypso (idx ${hikingHypsoIdx})`);
    } else if (hikingHypsoIdx >= 0) {
      console.log(`  OK   ribbon (idx ${ribbonIdx}) paints after hypso (idx ${hikingHypsoIdx})`);
    }
    // Below trail glow — only check when carpathian trail web is
    // also emitted (carpathian flag on AND source present, which is
    // exactly the test condition here).
    if (trailGlowIdx === -1) {
      hikingFails++;
      console.log('  FAIL carpathian_trail_glow not emitted in cross-product test');
    } else if (ribbonIdx >= trailGlowIdx) {
      hikingFails++;
      console.log(`  FAIL ribbon (idx ${ribbonIdx}) must paint BEFORE carpathian_trail_glow (idx ${trailGlowIdx})`);
    } else {
      console.log(`  OK   ribbon (idx ${ribbonIdx}) paints before carpathian_trail_glow (idx ${trailGlowIdx})`);
    }
  }
  console.log(`Hiking-route ribbon layer invariants: ${hikingFails === 0 ? 'all OK' : `${hikingFails} FAILED`}`);
  if (hikingFails > 0) failed += hikingFails;

  // ---------------------------------------------------------------------
  // Satellite imagery invariants — the hybrid stack must keep the clean
  // EOX overview, Esri as a no-key fallback, and Mapbox as the active
  // high-detail provider without overzooming past native source limits.
  // ---------------------------------------------------------------------
  console.log();
  console.log('Satellite imagery invariants:');
  let satelliteFails = 0;

  const satelliteStyle1x = composeSatelliteStyle({ pixelRatio: 1 });
  const satelliteStyle2x = composeSatelliteStyle({ pixelRatio: 2 });
  const satellitePlan1x = resolveSatelliteImageryPlan({ pixelRatio: 1 });
  const eoxFallbackPlan = resolveSatelliteImageryPlan({ providerId: 'eox', pixelRatio: 1 });
  const satIds = satelliteStyle1x.layers.map((l) => l.id);
  const expectedSatLayers = [
    'satellite_imagery_base_eox',
    'satellite_imagery_primary_mapbox',
  ];
  const expectedSatSources = [
    ['satellite-imagery-base-eox', 14],
    // Mapbox is pinned to its native-resolution ceiling (19), not the
    // tileset's advertised 22 — see SATELLITE_PROVIDERS.mapbox in config.js.
    // This is what stops the camera from overzooming into blurry upsampled
    // imagery above native detail.
    ['satellite-imagery-primary-mapbox', 19],
  ];

  for (let i = 0; i < expectedSatLayers.length; i++) {
    const id = expectedSatLayers[i];
    const idx = satIds.indexOf(id);
    if (idx !== i) {
      satelliteFails++;
      console.log(`  FAIL ${id} expected at imagery index ${i}, got ${idx}`);
    } else {
      console.log(`  OK   ${id} paints at imagery index ${i}`);
    }
  }

  for (const [sourceId, expectedMaxzoom] of expectedSatSources) {
    const source = satelliteStyle1x.sources[sourceId];
    if (!source) {
      satelliteFails++;
      console.log(`  FAIL ${sourceId} missing`);
      continue;
    }
    if (source.maxzoom !== expectedMaxzoom) {
      satelliteFails++;
      console.log(`  FAIL ${sourceId}.maxzoom expected ${expectedMaxzoom}, got ${source.maxzoom}`);
    } else {
      console.log(`  OK   ${sourceId}.maxzoom === ${expectedMaxzoom}`);
    }
  }

  const zoomChecks = [
    [satelliteStyle1x.layers.find((l) => l.id === 'satellite_imagery_base_eox'), 'base', 0, 14.01],
    [satelliteStyle1x.layers.find((l) => l.id === 'satellite_imagery_primary_mapbox'), 'primary', 14, 19.01],
  ];
  for (const [layer, label, minzoom, maxzoom] of zoomChecks) {
    if (!layer) continue;
    if (layer.minzoom !== minzoom || layer.maxzoom !== maxzoom) {
      satelliteFails++;
      console.log(`  FAIL ${label} layer zoom window expected ${minzoom}-${maxzoom}, got ${layer.minzoom}-${layer.maxzoom}`);
    } else {
      console.log(`  OK   ${label} layer zoom window ${minzoom}-${maxzoom}`);
    }
    if (layer.paint?.['raster-resampling'] !== 'linear') {
      satelliteFails++;
      console.log(`  FAIL ${layer.id}: raster-resampling is not linear`);
    } else {
      console.log(`  OK   ${layer.id}: raster-resampling is linear`);
    }
  }

  const primary1xUrl = satelliteStyle1x.sources['satellite-imagery-primary-mapbox']?.tiles?.[0] ?? '';
  const primary2xUrl = satelliteStyle2x.sources['satellite-imagery-primary-mapbox']?.tiles?.[0] ?? '';
  if (!primary1xUrl.includes('@2x')) {
    satelliteFails++;
    console.log('  FAIL DPR=1 Mapbox URL does not use forced @2x');
  } else {
    console.log('  OK   DPR=1 Mapbox URL uses forced @2x tiles');
  }
  if (!primary2xUrl.includes('@2x')) {
    satelliteFails++;
    console.log('  FAIL DPR=2 Mapbox URL does not use @2x');
  } else {
    console.log('  OK   DPR=2 Mapbox URL uses @2x tiles');
  }
  if (satellitePlan1x.maxZoom !== 19 || satelliteStyle1x.metadata?.maxZoom !== 19) {
    satelliteFails++;
    console.log(`  FAIL satellite maxZoom expected 19, got plan=${satellitePlan1x.maxZoom}, metadata=${satelliteStyle1x.metadata?.maxZoom}`);
  } else {
    console.log('  OK   satellite maxZoom is capped at 19 (Mapbox native ceiling)');
  }
  if (satellitePlan1x.fallbackProviderId !== null) {
    satelliteFails++;
    console.log(`  FAIL default Mapbox plan unexpectedly uses fallback ${satellitePlan1x.fallbackProviderId}`);
  } else {
    console.log('  OK   default Mapbox plan does not render Esri underlay');
  }
  const eoxFallback = eoxFallbackPlan.entries.find((entry) => entry.role === 'fallback');
  if (eoxFallback?.provider?.id !== 'esri' || eoxFallbackPlan.maxZoom !== 19) {
    satelliteFails++;
    console.log(`  FAIL EOX-only fallback expected Esri maxZoom 19, got provider=${eoxFallback?.provider?.id}, maxZoom=${eoxFallbackPlan.maxZoom}`);
  } else {
    console.log('  OK   Esri fallback is still available when EOX is the active provider');
  }
  console.log(`Satellite imagery invariants: ${satelliteFails === 0 ? 'all OK' : `${satelliteFails} FAILED`}`);
  if (satelliteFails > 0) failed += satelliteFails;

  // ---------------------------------------------------------------------
  // Layer-level invariants — assert that the relief stack carries the
  // exact paint properties the renderer relies on. The style-spec
  // validator only checks that EACH property is well-formed; these
  // invariants check the relationships BETWEEN properties (e.g. zero
  // transition on opacity, single owner of hillshade-exaggeration).
  // ---------------------------------------------------------------------
  console.log();
  console.log('Layer invariants:');
  let invariantFails = 0;
  const invariantStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: { ...FEATURES, hypsometricTint: true, colorRelief: true, hillshade: true },
    hypso: { mode: 'native', rampId: HYPSO.defaultRampId, strength: 1, bathymetry: true },
  });
  for (const layer of invariantStyle.layers) {
    // 1. Native hypso layer carries a zero-duration opacity transition.
    if (layer.type === 'color-relief') {
      const tr = layer.paint?.['color-relief-opacity-transition'];
      if (!tr || tr.duration !== 0) {
        invariantFails++;
        console.log(`  FAIL ${layer.id}: missing or non-zero color-relief-opacity-transition`);
      } else {
        console.log(`  OK   ${layer.id}: color-relief-opacity-transition.duration === 0`);
      }
      // The color-relief-color expression must use ['elevation'] (the
      // sentinel introduced for `color-relief` layers). Anything else
      // means the ramp won't read DEM data.
      const colorExpr = layer.paint?.['color-relief-color'];
      if (!Array.isArray(colorExpr)) {
        invariantFails++;
        console.log(`  FAIL ${layer.id}: color-relief-color is not an expression`);
      } else {
        const usesElevation = JSON.stringify(colorExpr).includes('"elevation"');
        if (!usesElevation) {
          invariantFails++;
          console.log(`  FAIL ${layer.id}: color-relief-color does not use ["elevation"]`);
        } else {
          console.log(`  OK   ${layer.id}: color-relief-color uses ["elevation"]`);
        }
      }
      // The opacity expression must be a zoom interpolation.
      const opaExpr = layer.paint?.['color-relief-opacity'];
      if (!Array.isArray(opaExpr) || opaExpr[0] !== 'interpolate') {
        invariantFails++;
        console.log(`  FAIL ${layer.id}: color-relief-opacity is not an interpolate expression`);
      } else {
        console.log(`  OK   ${layer.id}: color-relief-opacity is a zoom interpolation`);
      }
    }
    // 2. Every hillshade layer carries a zero-duration exaggeration
    //    transition and the cart:hillshadeBaseMul metadata that the
    //    runtime needs for the smart-blend formula.
    if (layer.type === 'hillshade') {
      const tr = layer.paint?.['hillshade-exaggeration-transition'];
      if (!tr || tr.duration !== 0) {
        invariantFails++;
        console.log(`  FAIL ${layer.id}: missing or non-zero hillshade-exaggeration-transition`);
      } else {
        console.log(`  OK   ${layer.id}: hillshade-exaggeration-transition.duration === 0`);
      }
      if (typeof layer.metadata?.['cart:hillshadeBaseMul'] !== 'number') {
        invariantFails++;
        console.log(`  FAIL ${layer.id}: missing cart:hillshadeBaseMul metadata`);
      } else {
        console.log(`  OK   ${layer.id}: cart:hillshadeBaseMul = ${layer.metadata['cart:hillshadeBaseMul']}`);
      }
    }
  }

  // 3. Layer ordering invariant: hypso must come BEFORE water_fill so
  //    the land-only mask works (water polygons paint over hypso).
  const ids = invariantStyle.layers.map((l) => l.id);
  const hypsoIdx = ids.findIndex((id) => id.startsWith('hypso_'));
  const waterIdx = ids.indexOf('water_fill');
  if (hypsoIdx === -1) {
    invariantFails++;
    console.log('  FAIL no hypso layer emitted in default style');
  } else if (waterIdx === -1) {
    invariantFails++;
    console.log('  FAIL no water_fill layer emitted in default style');
  } else if (hypsoIdx >= waterIdx) {
    invariantFails++;
    console.log(`  FAIL hypso layer (idx ${hypsoIdx}) renders ABOVE water_fill (idx ${waterIdx})`);
  } else {
    console.log(`  OK   hypso (idx ${hypsoIdx}) renders BELOW water_fill (idx ${waterIdx})`);
  }
  // Hillshade must be BETWEEN hypso and water_fill so hillshade
  // shadows/highlights mix WITH the elevation tint.
  const hillshadeIdx = ids.findIndex((id) => id.startsWith('hillshade'));
  if (hillshadeIdx === -1) {
    invariantFails++;
    console.log('  FAIL no hillshade layer emitted in default style');
  } else if (hillshadeIdx > hypsoIdx && hillshadeIdx < waterIdx) {
    console.log(`  OK   hillshade (idx ${hillshadeIdx}) sits between hypso and water_fill`);
  } else {
    invariantFails++;
    console.log(`  FAIL hillshade (idx ${hillshadeIdx}) not between hypso (${hypsoIdx}) and water_fill (${waterIdx})`);
  }
  console.log(`Layer invariants: ${invariantFails === 0 ? 'all OK' : `${invariantFails} FAILED`}`);

  // ---------------------------------------------------------------------
  // Carpathian trail-pipeline invariants — verify graceful fallback and
  // ordering of the new layer stack.
  //
  //   • Without a carpathian-osm source: composer MUST NOT emit any
  //     trail/forest-road/via-ferrata/etc. layer (graceful fallback).
  //   • With a source: the layers MUST be emitted AND must appear in
  //     the documented z-order: forest_road → informal → trail →
  //     via-ferrata → steps → furniture → labels.
  // ---------------------------------------------------------------------
  console.log();
  console.log('Carpathian trail invariants:');
  let trailFails = 0;
  const trailFeaturesOn = { ...FEATURES, carpathian: true };

  // Without source.
  const noSourceStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: trailFeaturesOn,
    sourceStubs: {},
    // The production TERRAIN.carpathianOsm.url is a real URL, so
    // composeSources would otherwise add the carpathian-osm source
    // unconditionally and the "no source" arm of this test would
    // be a no-op. Override the URL to null to exercise the actual
    // graceful-fallback code path.
    terrainOverride: {
      ...TERRAIN,
      carpathianOsm: { ...TERRAIN.carpathianOsm, url: null },
    },
  });
  const trailIds = [
    'carpathian_forest_road',
    'carpathian_trail_informal',
    'carpathian_trail_inline',
    'carpathian_via_ferrata_inline',
    'carpathian_trail_steps',
    'carpathian_trail_bridge',
    'carpathian_trail_label',
  ];
  for (const id of trailIds) {
    const present = noSourceStyle.layers.some((l) => l.id === id);
    if (present) {
      trailFails++;
      console.log(`  FAIL ${id} emitted without carpathian-osm source (should be off)`);
    } else {
      console.log(`  OK   ${id} absent without source (graceful fallback)`);
    }
  }

  // With source.
  const withSourceStyle = buildStyle({
    theme: 'light',
    profile: 'high',
    features: trailFeaturesOn,
    sourceStubs: {
      'carpathian-osm': {
        type: 'vector',
        url: 'pmtiles://https://example.com/carpathian-osm.pmtiles',
      },
    },
  });
  const withIds = withSourceStyle.layers.map((l) => l.id);
  for (const id of trailIds) {
    if (!withIds.includes(id)) {
      trailFails++;
      console.log(`  FAIL ${id} not emitted even though carpathian-osm source is present`);
    } else {
      console.log(`  OK   ${id} present`);
    }
  }
  // Ordering: the indices must be strictly increasing in this sequence.
  const orderSeq = [
    'carpathian_forest_road',
    'carpathian_trail_informal',
    'carpathian_trail_inline',
    'carpathian_via_ferrata_inline',
    'carpathian_trail_steps',
    'carpathian_trail_bridge',
    'carpathian_trail_label',
  ];
  let lastIdx = -1;
  let lastId = null;
  for (const id of orderSeq) {
    const idx = withIds.indexOf(id);
    if (idx <= lastIdx) {
      trailFails++;
      console.log(`  FAIL ${id} (idx ${idx}) appears at or before ${lastId} (idx ${lastIdx})`);
    }
    lastIdx = idx;
    lastId = id;
  }
  if (lastIdx !== -1 && trailFails === 0) {
    console.log('  OK   forest → informal → trail → via-ferrata → steps → furniture → labels order');
  }
  console.log(`Carpathian trail invariants: ${trailFails === 0 ? 'all OK' : `${trailFails} FAILED`}`);

  process.exit(failed + rampFails + invariantFails + trailFails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('validate.cjs crashed:', err);
  process.exit(2);
});
