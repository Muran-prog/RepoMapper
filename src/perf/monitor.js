/**
 * Performance monitor — a small, dependency-free FPS and tile-activity
 * watchdog that publishes its readings to listeners.
 *
 * The monitor is decoupled from any UI: it just emits readings via a
 * subscribe(callback) API. The HUD module (or anything else that cares)
 * subscribes and renders.
 */

export function createPerfMonitor(map) {
  const listeners = new Set();
  let frames = 0;
  let lastSampleAt = performance.now();
  let fps = 0;
  let tilesLoading = 0;
  let raf = 0;
  let running = false;

  function tick() {
    frames++;
    const now = performance.now();
    if (now - lastSampleAt >= 500) {
      fps = Math.round((frames * 1000) / (now - lastSampleAt));
      frames = 0;
      lastSampleAt = now;
      emit();
    }
    if (running) raf = requestAnimationFrame(tick);
  }

  function emit() {
    const reading = { fps, tilesLoading, zoom: map.getZoom(), center: map.getCenter() };
    for (const l of listeners) l(reading);
  }

  function onSourceData(e) {
    if (e.sourceId !== 'openmaptiles') return;
    if (e.tile) {
      // tiles loading delta — `isSourceLoaded` flips at the end of the
      // batch, so we keep our own counter for rolling reads.
      tilesLoading = map.areTilesLoaded() ? 0 : tilesLoading + 1;
    }
    emit();
  }
  function onIdle() {
    tilesLoading = 0;
    emit();
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastSampleAt = performance.now();
      raf = requestAnimationFrame(tick);
      map.on('sourcedata', onSourceData);
      map.on('idle', onIdle);
      map.on('move', emit);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      map.off('sourcedata', onSourceData);
      map.off('idle', onIdle);
      map.off('move', emit);
    },
    subscribe(fn) {
      listeners.add(fn);
      // Push a current reading immediately so subscribers can render
      // their initial DOM without waiting for the next tick.
      fn({ fps, tilesLoading, zoom: map.getZoom(), center: map.getCenter() });
      return () => listeners.delete(fn);
    },
  };
}
