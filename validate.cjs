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
  const { getProfileConfig } = await importEsm('src/device.js');
  const { FEATURES, TERRAIN, OPENFREEMAP, HYPSO } = await importEsm('src/config.js');
  const { getTokens } = await importEsm('src/style/tokens.js');
  const { RAMP_IDS } = await importEsm('src/style/hypso/ramps.js');

  // ---------------------------------------------------------------------
  // Build a full MapLibre style object the same way createMap.js would.
  // Everything here is deterministic — no network, no DOM.
  // ---------------------------------------------------------------------
  const buildStyle = ({ theme, profile, features, hypso, sourceStubs }) => {
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
      hypsometricTint: features.hypsometricTint && cfg.enableHypsoTint,
      bathymetry: features.bathymetry && cfg.enableHypsoTint,
      contours: features.contours && cfg.enableContours,
      ridgeOverlay: features.ridgeOverlay && cfg.enableRidgeOverlay,
      carpathian: features.carpathian && cfg.enableCarpathianOverlay,
      globeProjection: features.globeProjection && cfg.enableGlobeProjection,
      hypsoRampId: hypso?.rampId ?? HYPSO.defaultRampId,
    };

    const sources = composeSources({
      vectorSource,
      features: effectiveFeatures,
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
    return buildStyle({ theme, profile, features, hypso, sourceStubs });
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

  process.exit(failed + rampFails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('validate.cjs crashed:', err);
  process.exit(2);
});
