/**
 * Vector drape imagery for the Cesium globe.
 *
 * Replaces satellite imagery with the SAME MapLibre vector style used by the
 * 2D map (single source of truth). Works by spinning up a hidden, offscreen
 * 512-CSS-px MapLibre map and rendering ONE Web-Mercator z/x/y tile per
 * Cesium `requestImage` call.
 *
 * Why this works
 * --------------
 * A 512-CSS-px MapLibre canvas at integer zoom Z, centred on a tile's
 * mercator centre, covers EXACTLY one z=Z mercator tile. So Cesium's tile
 * level maps 1:1 to MapLibre zoom, and we can hand Cesium a perfectly aligned
 * raster of the vector style for every tile it asks for.
 *
 * The provider is duck-typed against Cesium's ImageryProvider interface
 * (Cesium 1.121 no longer requires `ready`/`readyPromise`). Tiles are rendered
 * serially (one offscreen map, one GL context) with an LRU canvas cache and
 * back-pressure: if the renderer is busy we queue the request.
 */

// ---------------------------------------------------------------------------
// Style preparation — clone the live 2D style, strip 3D-only bits so the
// offscreen map renders a flat 2D drape (Cesium provides the 3D relief).
// ---------------------------------------------------------------------------

/**
 * Layer ids / patterns to hide in the drape because Cesium renders their
 * real 3D counterparts (buildings) or because they'd double up with terrain.
 */
const HIDDEN_LAYER_PATTERNS = [
  /building/i,        // 2.5D building fills/extrusions → real 3D tiles instead
  /extrusion/i,
];

/**
 * Build the offscreen drape style from a source MapLibre style object.
 * - Removes `terrain` and `sky` (flat render).
 * - Forces globe→mercator projection.
 * - Hides building/extrusion layers (real 3D buildings come from Cesium).
 * - Hides ALL `symbol` layers (text + icon labels). Baked-in labels get
 *   stretched/distorted when draped over steep, crowded relief, so labels
 *   are rendered separately as crisp, camera-facing Cesium labels.
 *
 * @param {object} liveStyle  Result of sourceMap.getStyle().
 * @returns {object} A cloned, drape-ready style.
 */
function buildDrapeStyle(liveStyle) {
  const style = JSON.parse(JSON.stringify(liveStyle));
  delete style.terrain;
  delete style.sky;
  // Flat mercator so each 512px frame is exactly one mercator tile.
  style.projection = { type: 'mercator' };

  if (Array.isArray(style.layers)) {
    for (const layer of style.layers) {
      const id = layer.id || '';
      const isBuilding = HIDDEN_LAYER_PATTERNS.some((re) => re.test(id));
      // Symbol layers = text + icon labels → distort on relief, hide them.
      const isSymbol = layer.type === 'symbol';
      if (isBuilding || isSymbol || layer.type === 'fill-extrusion') {
        layer.layout = layer.layout || {};
        layer.layout.visibility = 'none';
      }
    }
  }
  return style;
}

// ---------------------------------------------------------------------------
// Offscreen MapLibre tile renderer.
// ---------------------------------------------------------------------------

class OffscreenTileRenderer {
  /**
   * @param {object} ml          window.maplibregl
   * @param {object} drapeStyle  Drape-ready style object.
   * @param {number} tilePx      CSS px per tile edge (512).
   */
  constructor(ml, drapeStyle, tilePx = 512) {
    this.ml = ml;
    this.tilePx = tilePx;

    const host = document.createElement('div');
    host.className = 'world3d-drape-host';
    host.style.cssText =
      `position:absolute;left:-10000px;top:0;width:${tilePx}px;height:${tilePx}px;` +
      'pointer-events:none;visibility:hidden;';
    document.body.appendChild(host);
    this.host = host;

    this.map = new ml.Map({
      container: host,
      style: drapeStyle,
      center: [31, 49],
      zoom: 0,
      bearing: 0,
      pitch: 0,
      interactive: false,
      attributionControl: false,
      preserveDrawingBuffer: true, // required to read pixels
      fadeDuration: 0,
      localIdeographFontFamily: false,
      refreshExpiredTiles: false,
      // Render each tile at 2x device pixels so the draped vector texture
      // stays crisp when stretched across steep relief (the single biggest
      // win against the "smeared texture on slopes" look).
      pixelRatio: 2,
    });

    this._ready = new Promise((resolve) => {
      this.map.once('load', () => resolve());
    });

    // Scratch 2D canvas for copying GL framebuffer pixels out.
    this._scratch = document.createElement('canvas');
  }

  ready() {
    return this._ready;
  }

  /**
   * Render a single tile and return a fresh canvas with its pixels.
   * @param {number} lng  Tile-centre longitude (deg).
   * @param {number} lat  Tile-centre latitude (deg).
   * @param {number} z    Zoom level (= Cesium tile level).
   * @returns {Promise<HTMLCanvasElement>}
   */
  async renderTile(lng, lat, z) {
    const map = this.map;
    map.jumpTo({ center: [lng, lat], zoom: z, bearing: 0, pitch: 0 });

    await this._waitIdle(4500);

    const src = map.getCanvas();
    const w = src.width;
    const h = src.height;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    ctx.drawImage(src, 0, 0);
    return out;
  }

  _waitIdle(timeoutMs) {
    const map = this.map;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        map.off('idle', onIdle);
        // One extra frame so the just-uploaded tiles are painted.
        map.triggerRepaint();
        requestAnimationFrame(() => resolve());
      };
      const onIdle = () => finish();
      const t = setTimeout(finish, timeoutMs);
      map.on('idle', onIdle);
      map.triggerRepaint();
    });
  }

  destroy() {
    try {
      this.map.remove();
    } catch {
      /* noop */
    }
    if (this.host && this.host.parentNode) {
      this.host.parentNode.removeChild(this.host);
    }
  }
}

// ---------------------------------------------------------------------------
// Simple LRU cache of rendered tile canvases.
// ---------------------------------------------------------------------------

class LRU {
  constructor(max = 256) {
    this.max = max;
    this.map = new Map();
  }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
  }
  clear() {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// Public factory — build a Cesium ImageryProvider backed by the vector style.
// ---------------------------------------------------------------------------

/**
 * @param {typeof Cesium} Cesium
 * @param {maplibregl.Map} sourceMap  The live 2D map (source of truth).
 * @param {object} [opts]
 * @param {number} [opts.maximumLevel=17]
 * @param {number} [opts.cacheSize=256]
 * @returns {Promise<{provider: object, destroy: () => void}>}
 */
export async function createVectorDrapeProvider(Cesium, sourceMap, opts = {}) {
  const ml = window.maplibregl;
  if (!ml) throw new Error('[world3d] maplibre-gl not on window');
  if (!sourceMap) throw new Error('[world3d] no source map for vector drape');

  const tilePx = 512;
  const maximumLevel = opts.maximumLevel ?? 17;
  const cache = new LRU(opts.cacheSize ?? 256);

  const drapeStyle = buildDrapeStyle(sourceMap.getStyle());
  const renderer = new OffscreenTileRenderer(ml, drapeStyle, tilePx);
  await renderer.ready();

  const tilingScheme = new Cesium.WebMercatorTilingScheme();
  const errorEvent = new Cesium.Event();

  // Serialise renders — one GL context, one tile at a time.
  let chain = Promise.resolve();

  function tileCenterDegrees(x, y, level) {
    const rect = tilingScheme.tileXYToNativeRectangle(x, y, level); // metres
    const cx = (rect.west + rect.east) / 2;
    const cy = (rect.south + rect.north) / 2;
    const carto = tilingScheme.projection.unproject(
      new Cesium.Cartesian3(cx, cy, 0),
    );
    return {
      lng: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    };
  }

  const provider = {
    // --- ImageryProvider interface (duck-typed) ---
    get tilingScheme() {
      return tilingScheme;
    },
    get rectangle() {
      return tilingScheme.rectangle;
    },
    get tileWidth() {
      return tilePx;
    },
    get tileHeight() {
      return tilePx;
    },
    get maximumLevel() {
      return maximumLevel;
    },
    get minimumLevel() {
      return 0;
    },
    get ready() {
      return true;
    },
    get readyPromise() {
      return Promise.resolve(true);
    },
    get credit() {
      return undefined;
    },
    get errorEvent() {
      return errorEvent;
    },
    get tileDiscardPolicy() {
      return undefined;
    },
    get proxy() {
      return undefined;
    },
    get hasAlphaChannel() {
      return false;
    },
    get defaultAlpha() {
      return undefined;
    },
    get defaultNightAlpha() {
      return undefined;
    },
    get defaultDayAlpha() {
      return undefined;
    },
    getTileCredits() {
      return [];
    },
    pickFeatures() {
      return undefined;
    },

    /**
     * @returns {Promise<HTMLCanvasElement>|undefined}
     */
    requestImage(x, y, level /*, request */) {
      const key = `${level}/${x}/${y}`;
      const cached = cache.get(key);
      if (cached) return Promise.resolve(cached);

      const job = chain.then(async () => {
        const hit = cache.get(key);
        if (hit) return hit;
        const { lng, lat } = tileCenterDegrees(x, y, level);
        const canvas = await renderer.renderTile(lng, lat, level);
        cache.set(key, canvas);
        return canvas;
      });
      // Keep the chain alive even if a job throws.
      chain = job.catch(() => {});
      return job;
    },
  };

  function destroy() {
    cache.clear();
    renderer.destroy();
  }

  // Rebuild the drape when the 2D style changes (keep single source of truth).
  const onStyleData = () => {
    try {
      const next = buildDrapeStyle(sourceMap.getStyle());
      renderer.map.setStyle(next);
      cache.clear();
    } catch {
      /* noop */
    }
  };
  sourceMap.on('styledata', onStyleData);
  const _origDestroy = destroy;
  const wrappedDestroy = () => {
    try {
      sourceMap.off('styledata', onStyleData);
    } catch {
      /* noop */
    }
    _origDestroy();
  };

  return { provider, destroy: wrappedDestroy };
}
