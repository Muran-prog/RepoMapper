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
  const { FEATURES, TERRAIN, OPENFREEMAP } = await importEsm('src/config.js');
  const { getTokens } = await importEsm('src/style/tokens.js');

  // ---------------------------------------------------------------------
  // Build a full MapLibre style object the same way createMap.js would.
  // Everything here is deterministic — no network, no DOM.
  // ---------------------------------------------------------------------
  const buildStyle = ({ theme, profile, features }) => {
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
      contours: features.contours && cfg.enableContours,
      ridgeOverlay: features.ridgeOverlay && cfg.enableRidgeOverlay,
      carpathian: features.carpathian && cfg.enableCarpathianOverlay,
      globeProjection: features.globeProjection && cfg.enableGlobeProjection,
    };

    const sources = composeSources({
      vectorSource,
      features: effectiveFeatures,
    });
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
      },
    },
  ];

  // ---------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------
  let failed = 0;
  const rows = [];
  for (const theme of themes) {
    for (const profile of profiles) {
      for (const pack of featurePacks) {
        const features = { ...FEATURES, ...pack.flags };
        let status = 'ok';
        let details = '';
        let layerCount = 0;
        try {
          const style = buildStyle({ theme, profile, features });
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
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('validate.cjs crashed:', err);
  process.exit(2);
});
