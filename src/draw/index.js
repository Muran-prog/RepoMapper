/**
 * Draw module — public barrel.
 *
 * Re-exports the engine factory and a handful of helpers consumers may
 * want without reaching into the internal module layout.
 */

export { createDrawEngine, SOURCE_ID, LAYERS } from './engine.js';
export { buildConnections, formatDistance, haversine } from './connections.js';
export {
  makeCircle,
  makeRectangle,
  makeRegularPolygon,
  makeStar,
  makeArrow,
} from './shapes.js';
export { loadPrefs, savePrefs, defaultPrefs } from './store.js';
