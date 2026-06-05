/**
 * CesiumJS viewer factory.
 *
 * Builds a fully configured Cesium.Viewer that renders the real world
 * as a geospatial 3D digital twin:
 *
 *   • Cesium World Terrain — high-resolution DEM mesh, 1:1 scale,
 *     with water mask and vertex normals for realistic lighting
 *   • Satellite imagery — Bing Maps Aerial via Cesium Ion (with token)
 *     or EOX Sentinel-2 cloudless (without token)
 *   • OSM Buildings — full 3D geometry via Cesium 3D Tiles
 *   • Realistic atmosphere, sun lighting, and sky
 *
 * All data is streamed on-demand with multi-level LOD, frustum culling,
 * and tile-based memory management handled internally by CesiumJS.
 *
 * Pure factory — no DOM creation (the caller passes in a container),
 * no keyboard listeners (handled by controls.js).
 */

import { CESIUM, UKRAINE_CENTER, VIEW } from '../config.js';

// ---------------------------------------------------------------------------
// Camera helpers — MapLibre ↔ Cesium conversion.
// ---------------------------------------------------------------------------

/**
 * Convert a MapLibre zoom level to an approximate camera altitude in
 * metres above the WGS84 ellipsoid.
 *
 * The formula reverses the Web Mercator pixel-to-metre relationship:
 *   metersPerPixel = C·cos(lat) / 2^(zoom+8)
 * where C = Earth circumference at equator ≈ 40075016.686 m.
 * We want the altitude at which the map viewport covers the same extent
 * as MapLibre's camera, so we multiply by half the canvas height and
 * account for the perspective FOV.
 *
 * @param {number} zoom     MapLibre zoom level.
 * @param {number} lat      Latitude in degrees.
 * @param {number} [height] Canvas pixel height (default 800).
 * @returns {number} Altitude in metres.
 */
function zoomToAltitude(zoom, lat, height = 800) {
  const C = 40075016.686;
  const latRad = (lat * Math.PI) / 180;
  const metersPerPixel = (C * Math.cos(latRad)) / Math.pow(2, zoom + 8);
  // MapLibre uses a vertical FOV of ~36.87° (atan(0.75)·2 for a
  // 0.6667 aspect shim). We approximate with 37°.
  const fovRad = (37 * Math.PI) / 180;
  return (metersPerPixel * height) / (2 * Math.tan(fovRad / 2));
}

/**
 * Sync the Cesium camera to match the current MapLibre camera position
 * as closely as possible.
 *
 * @param {Cesium.Viewer}  cesiumViewer
 * @param {maplibregl.Map} mlMap
 */
export function syncCameraFromMapLibre(cesiumViewer, mlMap) {
  if (!cesiumViewer || !mlMap) return;
  const Cesium = window.Cesium;
  if (!Cesium) return;

  const center = mlMap.getCenter();
  const zoom = mlMap.getZoom();
  const bearing = mlMap.getBearing();
  const pitch = mlMap.getPitch();
  const canvasHeight = mlMap.getCanvas()?.height ?? 800;

  const lng = center.lng;
  const lat = center.lat;
  const altitude = zoomToAltitude(zoom, lat, canvasHeight);

  // MapLibre pitch: 0 = looking straight down, 60 = 60° from nadir.
  // Cesium pitch: 0 = horizontal, -90 = straight down.
  const cesiumPitch = (pitch * Math.PI) / 180 - Math.PI / 2;

  // Both use clockwise-from-north in positive direction.
  const cesiumHeading = (bearing * Math.PI) / 180;

  cesiumViewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lng, lat, altitude),
    orientation: {
      heading: Cesium.Math.zeroToTwoPi(cesiumHeading),
      pitch: cesiumPitch,
      roll: 0,
    },
  });
}

// ---------------------------------------------------------------------------
// Viewer factory.
// ---------------------------------------------------------------------------

/**
 * Create and configure the CesiumJS viewer.
 *
 * @param {typeof Cesium} Cesium  The CesiumJS namespace (window.Cesium).
 * @param {HTMLElement}   el      Container element.
 * @param {object}        [opts]
 * @param {maplibregl.Map} [opts.map] MapLibre map for initial camera sync.
 * @returns {Promise<Cesium.Viewer>}
 */
export async function createWorld3DViewer(Cesium, el, opts = {}) {
  const hasToken = typeof CESIUM.ionToken === 'string' && CESIUM.ionToken.length > 10;

  if (hasToken) {
    Cesium.Ion.defaultAccessToken = CESIUM.ionToken;
  }

  // Credit container — we show attribution but keep it minimal.
  const creditDiv = document.createElement('div');
  creditDiv.className = 'cesium-credit-host';
  el.appendChild(creditDiv);

  // ----- Viewer construction -----------------------------------------
  const viewerOpts = {
    // Disable every built-in widget — we have our own UI.
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    animation: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    infoBox: false,
    creditContainer: creditDiv,

    // Continuous rendering for smooth flight animation.
    requestRenderMode: false,
    maximumRenderTimeChange: Infinity,

    // We'll set terrain manually after construction.
    // Suppress the default imagery layer; we add our own below.
    baseLayer: false,

    // Depth testing against terrain so buildings / labels occlude
    // correctly behind mountains.
    depthPlaneEllipsoidOffset: 0,

    // MSAA for smoother edges.
    msaaSamples: 4,

    // Shadows off by default (performance).
    shadows: false,
  };

  const viewer = new Cesium.Viewer(el, viewerOpts);
  const scene = viewer.scene;
  const globe = scene.globe;

  // ----- Terrain -------------------------------------------------------
  if (hasToken) {
    try {
      scene.setTerrain(
        new Cesium.Terrain(
          Cesium.CesiumTerrainProvider.fromIonAssetId(CESIUM.ionTerrainAssetId, {
            requestWaterMask: true,
            requestVertexNormals: true,
          }),
        ),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[world3d] Cesium World Terrain unavailable, using ellipsoid.', err);
    }
  }

  // ----- Imagery -------------------------------------------------------
  if (hasToken) {
    // Bing Maps Aerial from Cesium Ion — highest-quality imagery.
    try {
      const bingProvider = await Cesium.IonImageryProvider.fromAssetId(
        CESIUM.ionBingAssetId,
      );
      viewer.imageryLayers.addImageryProvider(bingProvider);
    } catch {
      // Fallback to EOX Sentinel-2 (free, no key).
      addFallbackImagery(Cesium, viewer);
    }
  } else {
    await addFallbackImagery(Cesium, viewer);
  }

  // ----- OSM Buildings -------------------------------------------------
  if (hasToken) {
    try {
      const buildings = await Cesium.Cesium3DTileset.fromIonAssetId(
        CESIUM.ionOsmBuildingsAssetId,
        {
          // Aggressive screen-space error for performance at distance.
          maximumScreenSpaceError: 16,
          // Don't cast shadows (heavy on GPU).
          shadows: Cesium.ShadowMode.DISABLED,
        },
      );
      scene.primitives.add(buildings);
      viewer._cart3dBuildings = buildings;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[world3d] OSM Buildings unavailable:', err);
    }
  }

  // ----- Scene tuning --------------------------------------------------
  configureScene(Cesium, scene, globe);

  // ----- Initial camera ------------------------------------------------
  if (opts.map) {
    syncCameraFromMapLibre(viewer, opts.map);
  } else {
    // Default: Ukraine overview.
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        UKRAINE_CENTER[0],
        UKRAINE_CENTER[1],
        600_000,
      ),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-45),
        roll: 0,
      },
    });
  }

  return viewer;
}

/**
 * Add fallback imagery when no Cesium Ion token is available.
 *
 * Uses CesiumJS's bundled Natural Earth II as the base (always
 * available, no network/CORS issues) and overlays OpenStreetMap
 * tiles for detail at higher zoom levels. Free, no API key needed.
 */
async function addFallbackImagery(Cesium, viewer) {
  // Natural Earth II — low-res satellite-like imagery bundled with CesiumJS.
  try {
    const naturalEarth = await Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
    );
    viewer.imageryLayers.addImageryProvider(naturalEarth);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[world3d] Natural Earth imagery unavailable:', err);
  }

  // OpenStreetMap tiles on top for detailed roads/labels.
  try {
    const osm = new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
      maximumLevel: 19,
      credit: new Cesium.Credit(
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        true,
      ),
    });
    viewer.imageryLayers.addImageryProvider(osm);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[world3d] OSM tiles unavailable:', err);
  }
}

/**
 * Configure scene-level rendering parameters for realism and performance.
 */
function configureScene(Cesium, scene, globe) {
  // Enable atmospheric effects.
  scene.skyAtmosphere.show = true;
  scene.fog.enabled = true;
  scene.fog.density = 2.0e-4;
  scene.fog.minimumBrightness = 0.03;

  // Globe rendering quality.
  globe.enableLighting = true;
  globe.showGroundAtmosphere = true;
  globe.atmosphereLightIntensity = 10.0;
  globe.maximumScreenSpaceError = 1.5; // Higher quality terrain mesh.

  // Depth testing against terrain — objects behind terrain are hidden.
  globe.depthTestAgainstTerrain = true;

  // Underwater rendering.
  globe.showWaterEffect = true;

  // Tile loading — aggressive preloading for smooth flight.
  globe.preloadAncestors = true;
  globe.preloadSiblings = true;
  globe.tileCacheSize = 1000;

  // Anti-aliasing.
  scene.postProcessStages.fxaa.enabled = true;

  // Sun and moon.
  scene.sun.show = true;
  scene.moon.show = true;
  scene.skyBox.show = true;

  // Logarithmic depth buffer for z-fighting prevention across large
  // depth ranges (ground to space).
  scene.logarithmicDepthBuffer = true;
}

/**
 * Fully destroy the viewer and release all GPU resources.
 *
 * @param {Cesium.Viewer} viewer
 */
export function destroyWorld3DViewer(viewer) {
  if (!viewer || viewer.isDestroyed()) return;
  try {
    viewer.destroy();
  } catch {
    /* already destroyed or context lost */
  }
}
