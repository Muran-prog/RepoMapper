/**
 * Style composer — assembles the full layer stack in the correct paint order.
 *
 * The order matters. MapLibre paints in declaration order, so layers
 * earlier in the array render below layers later in the array. This
 * module owns the canonical z-order for the entire project:
 *
 *   1. background                 — paper colour
 *   2. landcover                  — wood, grass, sand, ice, rock
 *   3. landuse                    — residential, industrial, cemetery, …
 *   4. parks                      — green polygons + outline
 *   5. hypsometric tint           — color-relief or raster, covers all land
 *   6. hillshade stack            — 1× or 3× (Swiss-style) + Carpathian
 *   6a. worldcover-tint           — ESA 10m landcover multiply-blend overlay
 *   7. water-fill                 — lake / sea polygons (LAND-ONLY MASK)
 *   7a. bathymetry                — GEBCO raster, replaces water_fill in sea
 *   7b. forest_polygon (leaf-type)— Carpathian biom-colour by OSM leaf_type
 *                                   (fill + outline + protect-outline + label)
 *   8. sky-view-factor            — multiplicative canyon emphasis
 *   9. texture-shading            — Leland Brown fractional-Laplacian PNG
 *  10. contours (minor → major)   — topographic isolines
 *  11. contour labels             — line-placed elevation text
 *  12. ridges (dark → light)      — Imhof-style double-stroke
 *  13. waterways                  — rivers / canals / streams (above relief)
 *  14. aeroway                    — runways / taxiways
 *  15. roads                      — tunnel → ground → rail → bridge
 *  16. trail emphasis (Carpathian)— casing + dashed inline
 *  16a. slope-warning             — translucent red ≥35° (above trails,
 *                                   below buildings/symbols)
 *  17. buildings                  — 2D + 3D extrusion
 *  18. boundaries                 — country / oblast / raion / city
 *  19. cableway / ski piste       — mountain auxiliaries
 *  20. labels                     — places, roads, water, parks, POIs
 *  21. Carpathian labels          — peaks / passes / saddles (top priority)
 *  22. Hazardous-terrain overlay  — extreme peaks / cliffs / dangerous
 *                                   passes (very negative sort-key, wins
 *                                   every collision; emitted last so it
 *                                   paints on top of everything)
 *
 * Land-only mask: layers 5–6 (hypso + hillshade) sit BELOW the water
 * polygons in layer 7, so the colour wash never bleeds into lakes or
 * the open sea — it's the cheapest "land mask" possible (z-order, no
 * per-tile alpha). Bathymetry (7a) then re-fills the sea with depth
 * tones via its raster alpha; lakes (which GEBCO doesn't cover) stay
 * solid `t.water` blue.
 *
 * Each relief-specific group is gated by BOTH the feature flag and the
 * availability of its source — the style composer never emits a layer
 * referencing a source that wasn't added to the sources dict.
 */

import {
  baseBackground,
  baseLandcover,
  baseLanduse,
  baseParks,
  baseWaterFill,
  baseWaterways,
  baseAeroway,
} from './base.js';
import { roadLayers } from './roads.js';
import { buildingLayers } from './buildings.js';
import { boundaryLayers } from './boundaries.js';
import { labelLayers } from './labels.js';
import { settlementOutlineLayers } from './settlements.js';
import {
  hillshadeLayers,
  textureShadingLayers,
  hypsometricTintLayers,
  bathymetryLayers,
  legacyHypsoTintLayer,
  skyViewFactorLayers,
  slopeWarningLayers,
  composeWorldcoverLayer,
  composeCanopyHeightLayer,
} from './terrain.js';
import { DEFAULT_RAMP_ID } from './hypso/ramps.js';
import { DEFAULT_STRENGTH_STOPS } from './hypso/expression.js';
import { contourLayers } from './contours.js';
import {
  ridgeLayers,
  trailLayers,
  carpathianLabels,
  cablewayLayers,
  forestRoadLayers,
  informalTrailLayers,
  viaFerrataLayers,
  steepStepsLayers,
  trailFurnitureLayers,
  trailLabels,
  forestPolygonLayers,
} from './carpathian.js';
import { hikingRouteLayers } from './hiking-routes.js';
import { forestCoverLayers, forestCoverHiDetailLayers } from './forest-cover.js';
import { hazardLayers } from './hazards.js';
import { getTokens } from './tokens.js';

/**
 * @typedef {object} ComposeOpts
 * @property {string}  [theme='light']          'light' | 'dark'
 *
 * Density bundle (from device profile, passed through to labels):
 * @property {boolean} [buildings3D=true]
 * @property {boolean} [pois=true]
 * @property {boolean} [labels=true]
 * @property {number}  [density=1.0]
 * @property {number}  [placeRankCutoff=12]
 * @property {number}  [poiRankCutoff=6]
 * @property {number}  [poiDotRankCutoff=8]
 * @property {number}  [textPaddingMul=1.0]
 * @property {number}  [poiSizeMul=1.0]
 * @property {boolean} [enableNeighbourhoods=true]
 * @property {boolean} [enableHamlets=true]
 * @property {boolean} [enableSuburbs=true]
 * @property {boolean} [enableRoadShieldsMinor=true]
 * @property {boolean} [roadsCarpathianDoubleCasing=true]
 * @property {boolean} [settlementOutline=true]
 *           Heavy road-style violet outline around residential /
 *           suburb / quarter / neighbourhood polygons so populated
 *           places read at country-overview zoom. Mirrors the road
 *           glow → casing → inline paint pattern; see
 *           `src/style/settlements.js` for the layer stack. Off →
 *           layers not emitted (graceful fallback).
 *
 * Relief & terrain stack:
 * @property {boolean} [hillshade=false]        Emit hillshade layer(s).
 * @property {boolean} [multiDirHillshade=false] 3-layer Swiss-style stack.
 * @property {boolean} [hasPrimaryDem=false]    Primary DEM source exists.
 * @property {boolean} [hasCarpathianDem=false] Carpathian DEM source exists.
 * @property {boolean} [hypsometricTint=false]  Emit hypso layer(s).
 * @property {'native'|'raster'|'off'} [hypsoMode='off']
 * @property {string}  [hypsoRampId]            Active ramp id.
 * @property {number}  [hypsoStrength=1.0]      0..1.5 opacity multiplier.
 * @property {boolean} [hypsoBathymetry=true]   Include negative-elev stops.
 * @property {string|null} [hypsoRasterSourceId] Source id when raster mode.
 * @property {boolean} [bathymetry=false]       Pre-rendered seabed tint.
 * @property {boolean} [hasBathymetrySource=false]
 * @property {boolean} [hasHypsoSource=false]   Legacy hypso-tint source.
 * @property {boolean} [hasHypsoRasterRamp=false] Active raster ramp source.
 * @property {boolean} [textureShading=false]
 * @property {boolean} [hasTextureSource=false]
 * @property {boolean} [skyViewFactor=false]
 * @property {boolean} [hasSkyViewFactorSource=false]
 * @property {boolean} [worldcoverTint=false]
 * @property {boolean} [hasWorldcoverSource=false]
 *           ESA WorldCover landcover-tint raster source is available.
 * @property {boolean} [canopyHeightTint=false]
 * @property {boolean} [hasCanopyHeightSource=false]
 *           ETH Global Canopy Height (Lang et al. 2023) raster source
 *           is available.
 * @property {boolean} [slopeWarning=false]
 *           Slope-warning overlay (color-relief on ['slope']).
 * @property {boolean} [hasSlopeExpression=false]
 *           Runtime supports `['slope']` in color-relief expressions.
 *
 * Contours:
 * @property {boolean} [contours=false]
 * @property {string}  [contoursSourceId='contours-dynamic']  id registered by createMap.
 * @property {boolean} [hasContoursSource=false]              Source exists at compose-time.
 * @property {boolean} [contourLabels=true]
 * @property {number}  [contoursMinzoom=9]
 *
 * Carpathian:
 * @property {boolean} [ridgeOverlay=false]
 * @property {boolean} [hasRidgesSource=false]
 * @property {boolean} [carpathian=false]
 * @property {boolean} [hasCarpathianOsmSource=false]
 * @property {boolean} [forestLeafType=false]
 *           Carpathian forest leaf-type biom polygons (landuse=forest /
 *           natural=wood with leaf_type / wood / leaf_cycle resolved
 *           through resolveLeafExpr in carpathian.js).
 * @property {boolean} [hasForestPolygonSource=false]
 *           `forest_polygon` source-layer is reachable. Maps to
 *           availability.forestPolygon in sources.js — true iff the
 *           carpathian-osm vector source is present (the layer lives
 *           inside that pmtiles).
 * @property {boolean} [forestCover=false]
 *           Forest-cover overlay — vivid Google-Earth-style green highlight
 *           of every OpenMapTiles `landcover` class=wood polygon, painted
 *           from the always-present base vector source (no `has*Source`
 *           gate). Emit-gated by the feature flag alone.
 * @property {boolean} [hasForest10mSource=false]
 *           High-detail 10 m forest vector archive (`forest-10m`) is
 *           reachable. When true AND `forestCover` is on, crisp 10 m
 *           Carpathian stand boundaries are painted on top of the global
 *           landcover forest; when false the overlay uses the global
 *           landcover forest alone (graceful fallback).
 * @property {boolean} [hazardousTerrain=false]
 *           Hazardous-terrain overlay (extreme peaks, cliffs,
 *           dangerous passes). Backed by the same carpathian-osm
 *           pmtiles archive — emit-gated by both the feature flag
 *           and `hasCarpathianOsmSource`.
 *
 * Accessibility:
 * @property {boolean} [reduceMotion=false]     Static relief, no 3D.
 */

/**
 * @param {ComposeOpts} [opts]
 * @returns {Array<object>} Ordered MapLibre layer specs.
 */
export function composeLayers(opts = {}) {
  const {
    theme = 'light',
    buildings3D = true,
    pois = true,
    labels = true,

    density = 1.0,
    placeRankCutoff = 12,
    poiRankCutoff = 6,
    poiDotRankCutoff = 8,
    textPaddingMul = 1.0,
    poiSizeMul = 1.0,
    enableNeighbourhoods = true,
    enableHamlets = true,
    enableSuburbs = true,
    enableRoadShieldsMinor = true,
    roadsCarpathianDoubleCasing = true,
    settlementOutline = true,

    hillshade = false,
    multiDirHillshade = false,
    hasPrimaryDem = false,
    hasCarpathianDem = false,
    hypsometricTint = false,
    hypsoMode = 'off',
    hypsoRampId = DEFAULT_RAMP_ID,
    hypsoStrength = 1.0,
    hypsoBathymetry = true,
    hypsoRasterSourceId = null,
    hypsoStrengthStops = DEFAULT_STRENGTH_STOPS,
    bathymetry = false,
    hasBathymetrySource = false,
    hasHypsoSource = false,
    hasHypsoRasterRamp = false,
    textureShading = false,
    hasTextureSource = false,
    skyViewFactor = false,
    hasSkyViewFactorSource = false,
    worldcoverTint = false,
    hasWorldcoverSource = false,
    canopyHeightTint = false,
    hasCanopyHeightSource = false,
    slopeWarning = false,
    hasSlopeExpression = false,

    contours = false,
    contoursSourceId = 'contours-dynamic',
    hasContoursSource = false,
    contourLabels = true,
    contoursMinzoom = 9,

    ridgeOverlay = false,
    hasRidgesSource = false,
    carpathian = false,
    hasCarpathianOsmSource = false,
    forestLeafType = false,
    hasForestPolygonSource = false,
    hasForest10mSource = false,
    forestCover = false,
    hazardousTerrain = false,
    hikingRoutes = false,

    reduceMotion = false,
  } = opts;

  const t = getTokens(theme);
  const stack = [];

  // 1–4: Base surfaces.
  stack.push(...baseBackground(t));
  stack.push(...baseLandcover(t));
  stack.push(...baseLanduse(t));
  stack.push(...baseParks(t));

  // 5: Hypsometric tint — emitted BEFORE water_fill so the
  //    land-only mask works: any pixel under a water polygon (lake /
  //    ocean) gets masked by water_fill below, never tinted by hypso.
  //    The composer in `hypso/layers.js` picks the path (native /
  //    raster / off) based on `hypsoMode`; we just feed it options.
  if (hypsometricTint) {
    const mode = resolveHypsoMode({
      hypsoMode,
      hasPrimaryDem,
      hasHypsoRasterRamp,
      hasHypsoSource,
    });
    if (mode === 'legacy' && hasHypsoSource) {
      stack.push(...legacyHypsoTintLayer(t));
    } else if (mode !== 'off') {
      stack.push(
        ...hypsometricTintLayers(t, {
          mode,
          rampId: hypsoRampId,
          theme,
          strength: hypsoStrength,
          bathymetry: hypsoBathymetry,
          rasterSourceId: hypsoRasterSourceId,
          strengthStops: hypsoStrengthStops,
        }),
      );
    }
  }

  // 6: Hillshade stack — drawn on top of hypso so each slope's
  //    highlight / shadow mixes WITH the elevation tint, producing
  //    the topographic-atlas feel (colour-by-elevation + shaded
  //    relief). 1 layer (low-profile) or 3 (Swiss-style), plus the
  //    optional Carpathian high-res DEM hillshade.
  if (hillshade && hasPrimaryDem) {
    stack.push(
      ...hillshadeLayers(t, {
        multiDir: multiDirHillshade,
        carpathian,
        hasCarpathianSource: hasCarpathianDem,
        reduceMotion,
      }),
    );
  }

  // 6a: ESA WorldCover landcover-tint — multiply-blend raster painted
  //     ABOVE the hillshade stack so the satellite-classified surface
  //     colours read on top of the shaded relief, but BELOW water_fill
  //     so the vector water polygons remain the canonical land mask.
  //     The class-80 (water) stop in `worldcover-ramps.js` is also
  //     transparent — that's a defence-in-depth so the raster doesn't
  //     tint coastline approximations even where the OMT water layer
  //     happens to disagree with the WorldCover classifier.
  //
  //     Source-gated: `hasWorldcoverSource` is true only when
  //     `TERRAIN.worldcover.url` is populated AND
  //     `features.worldcoverTint` is on, so a missing archive renders
  //     the map identically to its previous version (graceful
  //     fallback).
  if (worldcoverTint && hasWorldcoverSource) {
    // Hypso "active" means the elevation-tint mode actually emits
    // something (native or raster); 'off' / 'legacy' don't compete
    // for the same hue budget here, so we treat them as inactive.
    const hypsoActive =
      hypsometricTint &&
      resolveHypsoMode({
        hypsoMode,
        hasPrimaryDem,
        hasHypsoRasterRamp,
        hasHypsoSource,
      }) !== 'off';
    stack.push(
      ...composeWorldcoverLayer(t, { hypsoActive, reduceMotion }),
    );
  }

  // 6b: ETH Global Canopy Height tint (Lang et al. 2023). Sits
  //     directly above the WorldCover tree-cover wash — it details
  //     that wash by per-pixel canopy top height, so younger stands
  //     read light grass-green and старі смерекові ліси Чорногори
  //     darken into emerald. Stays BELOW water_fill so the same
  //     land-only mask that protects WorldCover protects this layer
  //     (the height = 0 stop in `canopy-height-ramps.js` is also
  //     fully transparent — defence in depth so non-forest pixels
  //     never get tinted even if the upstream raster has noise).
  //
  //     Source-gated: `hasCanopyHeightSource` is true only when
  //     `TERRAIN.canopyHeight.url` is populated AND
  //     `features.canopyHeightTint` is on, so a missing archive
  //     renders the map identically to its previous version
  //     (graceful fallback). Opacity adapts to the active relief
  //     state: hypso suppresses, WorldCover reinforces, both at
  //     once → conservative MIN (hypso wins).
  if (canopyHeightTint && hasCanopyHeightSource) {
    const hypsoActive =
      hypsometricTint &&
      resolveHypsoMode({
        hypsoMode,
        hasPrimaryDem,
        hasHypsoRasterRamp,
        hasHypsoSource,
      }) !== 'off';
    const worldcoverActive = worldcoverTint && hasWorldcoverSource;
    stack.push(
      ...composeCanopyHeightLayer(t, {
        hypsoActive,
        worldcoverActive,
        reduceMotion,
      }),
    );
  }

  // 7: Water polygons — drawn AFTER hypso + hillshade so they act as
  //    the canonical land-only mask. Lakes render as the flat blue
  //    `t.water` colour; sea + ocean polygons get the same blue
  //    initially and are then overpainted by the GEBCO bathymetry
  //    raster (layer 7a) so the seabed reads as a depth gradient.
  stack.push(...baseWaterFill(t));

  // 7a: Bathymetry — pre-rendered GEBCO seabed tint that sits ABOVE
  //     water_fill. The raster's alpha channel is 1 over ocean tiles
  //     and 0 outside, so the layer overrides water_fill colour only
  //     where there's actual sea. Lakes (which GEBCO doesn't cover)
  //     stay flat blue.
  if (bathymetry && hasBathymetrySource) {
    stack.push(...bathymetryLayers(t));
  }

  // 7b: Carpathian forest leaf-type biom polygons. Sits ABOVE the
  //     water_fill / bathymetry mask so the vector polygons never
  //     bleed into open water, and ABOVE the canopy-height tint so
  //     the OSM-derived biom-colour is the dominant cue at z9-13
  //     (Чорногора cool dark needleleaved vs Закарпаття warm
  //     yellow-green broadleaved). The fill-opacity curve drops
  //     past z14 so canopy-height detail reads through the fill at
  //     hiking zooms — biom layer becomes a subtle подложка rather
  //     than the primary signal.
  //
  //     Stays BELOW texture-shading / contours / trails / roads so
  //     terrain structure and the trail web continue to read on top
  //     of the biom-clusters. Source-gated: `hasForestPolygonSource`
  //     is true only when carpathian-osm.pmtiles is reachable AND
  //     `features.forestLeafType` is on; absent → silent no-op
  //     (graceful fallback). The fourth sub-layer (forest_label)
  //     is folded into this block so it paints in the same stack
  //     position; it's a symbol layer with its own collision logic
  //     that ranks BELOW peak labels via symbol-sort-key (peaks
  //     use −ele which is far more negative than the forest-mass
  //     `−area` key).
  if (forestLeafType && hasForestPolygonSource) {
    stack.push(...forestPolygonLayers(t));
  }

  // 7c: Forest-cover overlay — vivid green highlight of every wooded
  //     polygon, read from the GLOBAL OpenMapTiles `landcover` source the
  //     base map already uses (so it works country-wide with no hosted
  //     archive — unlike worldcover / canopy / forest-leaf). Sits ABOVE
  //     the water_fill mask (so it never bleeds under a lake) and ABOVE
  //     the relief stack (so the canopy reads clearly), but BELOW
  //     texture-shading / contours / trails / roads / labels so terrain
  //     structure and the network still paint on top. Opacity stays < 1
  //     so the hillshade gives the forest mass volume. Emit-gated by the
  //     feature flag ALONE — the base vector source is always present.
  if (forestCover) {
    stack.push(...forestCoverLayers(t));
    // High-detail 10 m forest (Carpathian-only) sits ON TOP of the global
    // landcover forest above. Source-gated: only when the forest-10m
    // vector archive is reachable. Inside the bbox the near-opaque 10 m
    // fill supersedes the coarse z14-capped landcover; outside it there is
    // no data, so the global forest remains the visible surface.
    if (hasForest10mSource) {
      stack.push(...forestCoverHiDetailLayers(t));
    }
  }

  // 8: Sky-View Factor multiplicative overlay. Emitted between
  //    bathymetry and texture-shading so it darkens hillshade-shaded
  //    canyons before the fractional-Laplacian texture stamp goes on
  //    top. Source-gated; minzoom 9 inside the layer itself.
  if (skyViewFactor && hasSkyViewFactorSource) {
    stack.push(...skyViewFactorLayers(t, { reduceMotion }));
  }

  // 9: Texture shading overlay (pre-rendered PNG).
  if (textureShading && hasTextureSource) {
    stack.push(...textureShadingLayers(t, { reduceMotion }));
  }

  // 10–11: Contours + their labels.
  if (contours && hasContoursSource) {
    stack.push(
      ...contourLayers(t, {
        sourceId: contoursSourceId,
        labels: contourLabels,
        minzoom: contoursMinzoom,
      }),
    );
  }

  // 12: Ridge enhancement (Imhof double-stroke).
  if (ridgeOverlay && hasRidgesSource) {
    stack.push(...ridgeLayers(t));
  }

  // 13: Linear waterways — above relief so rivers stay legible.
  stack.push(...baseWaterways(t));

  // 14: Aeroway.
  stack.push(...baseAeroway(t));

  // 14a: Settlement outlines — heavy road-style violet frame around
  //      residential / suburb / quarter / neighbourhood polygons so
  //      villages, towns and cities read as framed plots at country
  //      overview zoom. Mirrors the road glow → casing → inline
  //      paint pattern. Sits ABOVE every base / landcover / landuse
  //      fill (so the violet wash isn't buried) and BELOW the road
  //      stack (so road network paints cleanly across settlement
  //      boundaries at high zoom). Toggleable via the user-facing
  //      Layers panel checkbox; default ON. See settlements.js for
  //      the four-layer stack and the rationale behind the violet
  //      hue choice.
  if (settlementOutline) {
    stack.push(...settlementOutlineLayers(t));
  }

  // 15: Roads.
  stack.push(
    ...roadLayers(t, {
      shieldsMinor: enableRoadShieldsMinor,
      carpathianDoubleCasing: roadsCarpathianDoubleCasing,
    }),
  );

  // 15a: Hiking-route ribbons — coloured underlay-bands for OSM
  //      `route=hiking` relations from the `hiking_route` source-layer.
  //      Sits ABOVE the relief stack (hillshade / hypso / texture /
  //      contours / ridges) and ABOVE the road network so the ribbon
  //      reads as a wash carrying the route colour, but BELOW
  //      `carpathian_trail_glow` so the per-SAC inline + glow paint
  //      crisply ON TOP of the ribbon (the trail web stays the
  //      dominant cue at hiking zooms; the ribbon is the
  //      "this-segment-belongs-to-Чорногірський хребет" cue).
  //
  //      Independent of the umbrella `carpathian` toggle — a user can
  //      run a clean overview map with route ribbons on but the
  //      trail-web off, or vice-versa. Source-gated through
  //      `hasCarpathianOsmSource` so a missing archive renders the
  //      map identically to its previous version (graceful fallback).
  if (hikingRoutes && hasCarpathianOsmSource) {
    stack.push(...hikingRouteLayers(t));
  }

  // 16: Carpathian trail emphasis — above roads so trails read over them.
  //     Order is critical for legibility:
  //       a. forest roads          (broadest, lowest contrast)
  //       b. informal social paths (grey dots)
  //       c. marked trails         (glow → casing → inline, by sac_scale)
  //       d. via-ferrata           (red + black serration)
  //       e. steps                 (perpendicular hatching)
  //       f. bridges/ladders/fords (structural symbols on top)
  //       g. trail labels          (above their geometry)
  if (carpathian && hasCarpathianOsmSource) {
    stack.push(...forestRoadLayers(t));
    stack.push(...informalTrailLayers(t));
    stack.push(...trailLayers(t));
    stack.push(...viaFerrataLayers(t));
    stack.push(...steepStepsLayers(t));
    stack.push(...trailFurnitureLayers(t));
    stack.push(...trailLabels(t));
  }

  // 16a: Slope-warning overlay. Sits ABOVE the Carpathian trails so
  //      the steep-zone wash is visible THROUGH the stitched dashes
  //      (which is the point — the user must see which trail
  //      segments cross avalanche-prone terrain). Stays BELOW
  //      buildings + symbols so the red wash never obscures icons,
  //      summit labels or bridge/ladder markers. Native color-relief
  //      with `['slope']` expression — graceful fallback when the
  //      runtime doesn't support either capability.
  if (slopeWarning && hasPrimaryDem && hasSlopeExpression) {
    stack.push(
      ...slopeWarningLayers(t, {
        hasCarpathianSource: hasCarpathianDem,
      }),
    );
  }

  // 17: Buildings.
  stack.push(...buildingLayers(t, { threeD: buildings3D }));

  // 18: Admin boundaries.
  stack.push(...boundaryLayers(t));

  // 19: Cableway + ski piste (deep-zoom auxiliaries).
  if (carpathian && hasCarpathianOsmSource) {
    stack.push(...cablewayLayers(t));
  }

  // 20: Labels.
  if (labels) {
    let labelStack = labelLayers(t, {
      density,
      placeRankCutoff,
      poiRankCutoff,
      poiDotRankCutoff,
      textPaddingMul,
      poiSizeMul,
      enableNeighbourhoods,
      enableHamlets,
      enableSuburbs,
      enableRoadShieldsMinor,
    });
    if (!pois) labelStack = labelStack.filter((l) => !l.id.startsWith('poi_'));
    stack.push(...labelStack);
  }

  // 21: Carpathian-specific labels — peaks, passes, saddles. Emitted
  //     after generic labels so collisions favour mountain features.
  if (labels && carpathian && hasCarpathianOsmSource) {
    stack.push(...carpathianLabels(t));
  }

  // 22: Hazardous-terrain overlay — high-visibility magenta/teal/tangerine
  //     rings + safety-labels for extreme peaks, cliffs, and dangerous
  //     mountain passes. Emitted LAST so the markers and labels paint
  //     on top of everything else, including peak labels. Source-gated:
  //     the data lives in the same `mountain_feature` source-layer used
  //     by `carpathianLabels`, so availability mirrors the umbrella
  //     Carpathian-overlay capability. The label sort-keys (-1e9 ..
  //     -7e8) sit far below any other symbol-sort-key in the project,
  //     so MapLibre's collision arbiter always favours hazard markers.
  //
  //     Toggle independent from `carpathian`: a user who turned the
  //     full Carpathian detail off can still leave the hazard overlay
  //     on so the overview map stays free of trail clutter while
  //     keeping the safety-relevant signal visible. The opposite
  //     direction (carpathian ON, hazardousTerrain OFF) is also valid
  //     — that's why we don't AND with `carpathian` here.
  if (hazardousTerrain && hasCarpathianOsmSource) {
    stack.push(...hazardLayers(t));
  }

  return stack;
}

export { getTokens };

/**
 * Resolve the effective hypso layer mode given availability flags.
 *
 * Priority:
 *   1. Caller's preferred mode ('native' | 'raster' | 'legacy') if its
 *      backing data is available.
 *   2. Native if a DEM exists and the caller didn't object.
 *   3. Raster if a per-ramp source is present.
 *   4. Legacy if the old single-archive `hypso-tint` source is present.
 *   5. 'off' — produce no hypso layer.
 *
 * @param {object} a
 * @param {'native'|'raster'|'legacy'|'off'|undefined} a.hypsoMode
 * @param {boolean} a.hasPrimaryDem
 * @param {boolean} a.hasHypsoRasterRamp
 * @param {boolean} a.hasHypsoSource
 * @returns {'native'|'raster'|'legacy'|'off'}
 */
function resolveHypsoMode({ hypsoMode, hasPrimaryDem, hasHypsoRasterRamp, hasHypsoSource }) {
  if (hypsoMode === 'native' && hasPrimaryDem) return 'native';
  if (hypsoMode === 'raster' && hasHypsoRasterRamp) return 'raster';
  if (hypsoMode === 'legacy' && hasHypsoSource) return 'legacy';
  if (hypsoMode === 'off') return 'off';
  // Fall-through preference order — same as the brief's graceful
  // fallback policy: prefer native, then raster, then legacy, then off.
  if (hasPrimaryDem) return 'native';
  if (hasHypsoRasterRamp) return 'raster';
  if (hasHypsoSource) return 'legacy';
  return 'off';
}
