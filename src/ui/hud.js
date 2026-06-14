/**
 * Status bar (formerly the floating HUD).
 *
 * Block UI redesign (v0.5): the telemetry is no longer a floating,
 * collapsible chip. It is a FIXED status bar pinned to the bottom row of
 * the app grid (spanning the sidebar + map columns), at a single height,
 * VS Code-style. Everything reads inline, left-to-right:
 *
 *   [●fps]  МАСШТ z  ·  ЦЕНТР lat,lon  ·  ШИР  ·  ДОЛ  ·  ВЫС  ·····  МАСШТАБ bar
 *
 * • FPS survives only as a small colour dot (green/amber/red).
 * • ZOOM + CENTER update on every move (useful on all devices).
 * • LAT / LON / ELEV track the cursor on hover-capable pointers and dim
 *   when the pointer leaves the map.
 * • The map scale (distance bar) is integrated on the right so there is
 *   no separate floating scale widget any more.
 * • Two docked buttons sit beside the scale: "Высота" (toggles the
 *   elevation legend) and a data-sources (attribution) toggle.
 */

import { rampToCssGradient } from '../style/hypso/index.js';

const FMT_COORD = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const FMT_ZOOM = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FMT_ELEV = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });

function cell(key, label, initial = '—', extra = '') {
  return `
    <div class="status-cell" data-status-cell="${key}"${extra}>
      <span class="status-label">${label}</span>
      <span class="status-value" data-hud="${key}">${initial}</span>
    </div>
  `;
}

export function mountHUD(map, perf, root, { caps } = {}) {
  const showCursor = !!caps?.hasHover && !!caps?.hasFinePointer;

  root.classList.add('statusbar');
  root.innerHTML = `
    <div class="status-cell" data-status-cell="fps" title="Частота кадров">
      <span class="status-fps-dot" data-hud="fps-dot" aria-hidden="true"></span>
    </div>
    ${cell('zoom', 'Масшт', '—')}
    ${cell('center', 'Центр', '—', ' data-status-action="goto" tabindex="0" role="button" title="Нажмите, чтобы перейти к координатам (широта, долгота)"')}
    <button class="status-copy-btn" type="button" data-hud="copy-coords"
            title="Скопировать координаты центра карты"
            aria-label="Скопировать координаты центра карты">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
           stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="5" y="5" width="8" height="9" rx="1"/>
        <path d="M3 11 H2.5 A1 1 0 0 1 1.5 10 V2.5 A1 1 0 0 1 2.5 1.5 H10 A1 1 0 0 1 11 2.5 V3"/>
      </svg>
    </button>
    <input class="status-goto-input" data-hud="goto-input" type="text" inputmode="decimal"
           spellcheck="false" autocomplete="off" hidden
           placeholder="широта, долгота"
           aria-label="Перейти к координатам: широта, долгота" />
    <span class="status-goto-error" data-hud="goto-error" role="alert" hidden></span>
    ${showCursor ? `
      ${cell('lat', 'Шир', '—', ' data-state="idle"')}
      ${cell('lon', 'Дол', '—', ' data-state="idle"')}
      ${cell('elev', 'Выс', '—', ' data-state="idle"')}
    ` : ''}
    <div class="status-spacer status-cell"></div>
    <div class="status-cell" data-status-cell="scale" title="Масштаб">
      <span class="status-label">Масштаб</span>
      <span class="status-scale-bar"><span class="status-scale-fill" data-hud="scale-fill"></span></span>
      <span class="status-value" data-hud="scale">—</span>
    </div>
    <button class="status-btn" type="button" data-ctl="legend-toggle"
            aria-pressed="false" title="Легенда высот">
      <span class="status-legend-swatch" data-hud="legend-swatch" aria-hidden="true"></span>
      <span class="status-label">Высота</span>
    </button>
    <button class="status-btn" type="button" data-ctl="attrib-toggle"
            aria-pressed="false" aria-label="Источники данных" title="Источники данных">
      <svg viewBox="0 0 16 16" aria-hidden="true" width="13" height="13">
        <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2"/>
        <line x1="8" y1="6.6" x2="8" y2="11.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="8" cy="4.3" r="0.9" fill="currentColor"/>
      </svg>
    </button>
  `;

  const refs = {
    zoom: root.querySelector('[data-hud=zoom]'),
    center: root.querySelector('[data-hud=center]'),
    centerCell: root.querySelector('[data-status-cell="center"]'),
    copyBtn: root.querySelector('[data-hud="copy-coords"]'),
    gotoInput: root.querySelector('[data-hud="goto-input"]'),
    gotoError: root.querySelector('[data-hud="goto-error"]'),
    lat: root.querySelector('[data-hud=lat]'),
    lon: root.querySelector('[data-hud=lon]'),
    elev: root.querySelector('[data-hud=elev]'),
    scale: root.querySelector('[data-hud=scale]'),
    scaleFill: root.querySelector('[data-hud="scale-fill"]'),
    cursorCells: [...root.querySelectorAll('[data-status-cell="lat"],[data-status-cell="lon"],[data-status-cell="elev"]')],
    legendBtn: root.querySelector('[data-ctl="legend-toggle"]'),
    legendSwatch: root.querySelector('[data-hud="legend-swatch"]'),
    attribBtn: root.querySelector('[data-ctl="attrib-toggle"]'),
  };

  // ----- Legend toggle (docks the elevation legend above the status bar)
  //
  // The legend is owned by the hypso subsystem; we stay decoupled by
  // dispatching a window event it listens for. The button's pressed
  // state mirrors `cart:legend-state` events the legend emits back.
  refs.legendBtn?.addEventListener('click', () => {
    const next = refs.legendBtn.getAttribute('aria-pressed') !== 'true';
    window.dispatchEvent(new CustomEvent('cart:legend-toggle', { detail: { open: next } }));
  });
  window.addEventListener('cart:legend-state', (e) => {
    const open = !!e?.detail?.open;
    refs.legendBtn?.setAttribute('aria-pressed', open ? 'true' : 'false');
  });
  // Mirror the active ramp gradient onto the swatch (same source the
  // legend uses, so the two never disagree).
  const syncLegendSwatch = () => {
    if (!refs.legendSwatch) return;
    const cart = map._cart ?? {};
    const rampId = cart.hypso?.rampId;
    const theme = cart.theme ?? 'light';
    if (!rampId) return;
    try {
      refs.legendSwatch.style.background = rampToCssGradient(rampId, theme);
    } catch { /* ignore */ }
  };
  window.addEventListener('cart:hypso', syncLegendSwatch);
  map.on('styledata', syncLegendSwatch);
  requestAnimationFrame(syncLegendSwatch);

  // ----- Attribution toggle (shows/hides the data-sources popover) -----
  refs.attribBtn?.addEventListener('click', () => {
    const next = refs.attribBtn.getAttribute('aria-pressed') !== 'true';
    refs.attribBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
    const attrib = document.querySelector('.maplibregl-ctrl-attrib');
    if (attrib) attrib.dataset.statusOpen = next ? '1' : '0';
  });

  // ----- Copy centre coordinates to clipboard -------------------------
  //
  // The small clipboard button next to the CENTER cell copies the current
  // map centre as "lat, lon" (same 4-decimal en-US format the readout
  // shows). A brief "✓" flash on the button confirms the copy without
  // any intrusive toast. Falls back gracefully when the Clipboard API is
  // unavailable (e.g. non-secure context).
  if (refs.copyBtn) {
    let copyFlashTimer = null;
    refs.copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't trigger the goto-input on the CENTER cell
      const c = map.getCenter();
      const text = `${FMT_COORD.format(c.lat)}, ${FMT_COORD.format(c.lng)}`;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback: execCommand (deprecated but still works in some envs)
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch { return; }
      }
      // Flash ✓ on the button icon for 1.4 s.
      refs.copyBtn.dataset.copied = '1';
      clearTimeout(copyFlashTimer);
      copyFlashTimer = setTimeout(() => {
        if (refs.copyBtn) delete refs.copyBtn.dataset.copied;
      }, 1400);
    });
  }

  // ----- "Go to coordinates" — click the CENTER cell to type a target -
  //
  // The CENTER cell shows the live map centre as `lat, lon` (4-decimal,
  // en-US). Clicking (or pressing Enter/Space when focused) swaps the
  // readout for a text input pre-filled with that same string, so the
  // user edits in exactly the format they were just reading. Submitting
  // parses `lat, lon` and flies the camera there; Escape / blur cancels
  // without moving. The parser is permissive: it accepts the trailing
  // `°` the cursor cells use, a comma OR whitespace separator, and an
  // optional N/S/E/W hemisphere suffix, so pasting any of the formats
  // the status bar itself emits "just works".
  const parseLatLon = (raw) => {
    if (typeof raw !== 'string') return null;
    // Normalise: strip degree marks, collapse separators to a single
    // comma, trim. Accept "lat, lon", "lat lon", "lat;lon".
    const cleaned = raw
      .replace(/°/g, ' ')
      .replace(/[;\t]+/g, ',')
      .trim();
    if (!cleaned) return null;

    // Split on comma if present, else on whitespace.
    const parts = (cleaned.includes(',') ? cleaned.split(',') : cleaned.split(/\s+/))
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length !== 2) return null;

    // Pull an optional hemisphere letter off each part and apply its sign.
    const toSigned = (token, posLetter, negLetter) => {
      const m = token.match(/^([+-]?\d+(?:\.\d+)?)\s*([nsewNSEW])?$/);
      if (!m) return NaN;
      let v = parseFloat(m[1]);
      if (!Number.isFinite(v)) return NaN;
      const hemi = m[2] ? m[2].toUpperCase() : '';
      if (hemi === negLetter) v = -Math.abs(v);
      else if (hemi === posLetter) v = Math.abs(v);
      else if (hemi && hemi !== posLetter && hemi !== negLetter) return NaN;
      return v;
    };

    const lat = toSigned(parts[0], 'N', 'S');
    const lon = toSigned(parts[1], 'E', 'W');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  };

  let editingGoto = false;

  const closeGoto = () => {
    if (!editingGoto) return;
    editingGoto = false;
    if (refs.gotoInput) refs.gotoInput.hidden = true;
    if (refs.gotoError) {
      refs.gotoError.hidden = true;
      refs.gotoError.textContent = '';
    }
    if (refs.gotoInput) refs.gotoInput.dataset.invalid = '0';
    refs.centerCell?.removeAttribute('data-editing');
  };

  const openGoto = () => {
    if (!refs.gotoInput || !refs.centerCell || editingGoto) return;
    editingGoto = true;
    refs.centerCell.setAttribute('data-editing', '1');
    // Pre-fill with the current readout so the format is self-documenting.
    const c = map.getCenter();
    refs.gotoInput.value = `${FMT_COORD.format(c.lat)}, ${FMT_COORD.format(c.lng)}`;
    refs.gotoInput.hidden = false;
    refs.gotoInput.dataset.invalid = '0';
    if (refs.gotoError) refs.gotoError.hidden = true;
    refs.gotoInput.focus();
    refs.gotoInput.select();
  };

  const submitGoto = () => {
    if (!refs.gotoInput) return;
    const parsed = parseLatLon(refs.gotoInput.value);
    if (!parsed) {
      refs.gotoInput.dataset.invalid = '1';
      if (refs.gotoError) {
        refs.gotoError.textContent = 'Введите: широта, долгота';
        refs.gotoError.hidden = false;
      }
      refs.gotoInput.focus();
      return;
    }
    closeGoto();
    map.flyTo({
      center: [parsed.lon, parsed.lat],
      // Keep the current zoom unless we're zoomed way out; a pinpoint
      // jump from a country overview lands at a sensible street zoom.
      zoom: Math.max(map.getZoom(), 12),
      essential: true,
    });
  };

  refs.centerCell?.addEventListener('click', openGoto);
  refs.centerCell?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      openGoto();
    }
  });
  refs.gotoInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitGoto();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeGoto();
      refs.centerCell?.focus();
    }
  });
  refs.gotoInput?.addEventListener('input', () => {
    if (refs.gotoInput) refs.gotoInput.dataset.invalid = '0';
    if (refs.gotoError) refs.gotoError.hidden = true;
  });
  refs.gotoInput?.addEventListener('blur', () => {
    // Defer so an Enter that triggers submit isn't pre-empted by blur.
    setTimeout(closeGoto, 120);
  });

  // ----- FPS dot + zoom + center (perf subscription) ------------------
  const stop = perf.subscribe((r) => {
    const tier = r.fps >= 50 ? 'good' : r.fps >= 30 ? 'mid' : 'low';
    root.dataset.tier = tier;
    if (refs.zoom) refs.zoom.textContent = FMT_ZOOM.format(r.zoom);
    if (refs.center && r.center) {
      refs.center.textContent =
        `${FMT_COORD.format(r.center.lat)}, ${FMT_COORD.format(r.center.lng)}`;
    }
  });

  // ----- Scale bar ----------------------------------------------------
  const BAR_PX = 48;
  const getRoundNum = (n) => {
    if (!Number.isFinite(n) || n <= 0) return 0;
    const pow10 = Math.pow(10, String(Math.floor(n)).length - 1);
    let d = n / pow10;
    if (d >= 10) d = 10; else if (d >= 5) d = 5; else if (d >= 3) d = 3;
    else if (d >= 2) d = 2; else if (d >= 1) d = 1; else d = 0.5;
    return pow10 * d;
  };
  const fmtDist = (m) => {
    if (m >= 1000) {
      const km = m / 1000;
      const disp = km >= 10 ? Math.round(km) : km.toFixed(1).replace(/\.0$/, '');
      return `${disp} км`;
    }
    return `${Math.round(m)} м`;
  };
  const updateScale = () => {
    const canvas = map.getCanvas();
    const w = canvas?.clientWidth ?? 0;
    const h = canvas?.clientHeight ?? 0;
    if (w <= 0 || h <= 0) return;
    const cy = h / 2;
    let mpb;
    try {
      const left = map.unproject([Math.max(0, w / 2 - BAR_PX / 2), cy]);
      const right = map.unproject([Math.min(w, w / 2 + BAR_PX / 2), cy]);
      mpb = left.distanceTo(right);
    } catch { mpb = 0; }
    if (!Number.isFinite(mpb) || mpb <= 0) {
      if (refs.scale) refs.scale.textContent = '—';
      if (refs.scaleFill) refs.scaleFill.style.width = '0px';
      return;
    }
    const round = getRoundNum(mpb);
    const ratio = Math.min(1, round / mpb);
    if (refs.scale) refs.scale.textContent = fmtDist(round);
    if (refs.scaleFill) refs.scaleFill.style.width = `${(BAR_PX * ratio).toFixed(1)}px`;
  };
  map.on('move', updateScale);
  map.on('zoom', updateScale);
  map.on('resize', updateScale);
  requestAnimationFrame(updateScale);

  // ----- Cursor lat/lon/elev (hover pointers) -------------------------
  let onMouseMove = null;
  let onMouseLeave = null;
  let flushTimer = null;

  const setCursorState = (state) => {
    refs.cursorCells.forEach((c) => { c.dataset.state = state; });
  };

  if (showCursor) {
    let pendingLngLat = null;
    let lastSample = 0;
    const sampleElev = (lngLat) => {
      if (!map.queryTerrainElevation) return null;
      try { return map.queryTerrainElevation(lngLat); } catch { return null; }
    };

    onMouseMove = (e) => {
      setCursorState('active');
      if (refs.lat) refs.lat.textContent = `${FMT_COORD.format(e.lngLat.lat)}°`;
      if (refs.lon) refs.lon.textContent = `${FMT_COORD.format(e.lngLat.lng)}°`;
      const now = performance.now();
      if (now - lastSample < 32) { pendingLngLat = e.lngLat; return; }
      lastSample = now;
      pendingLngLat = null;
      const elev = sampleElev(e.lngLat);
      if (refs.elev) {
        refs.elev.textContent = (elev == null || !Number.isFinite(elev))
          ? '—' : `${FMT_ELEV.format(elev)} м`;
      }
    };
    onMouseLeave = () => setCursorState('idle');

    map.on('mousemove', onMouseMove);
    map.on('mouseout', onMouseLeave);

    flushTimer = setInterval(() => {
      if (!pendingLngLat) return;
      onMouseMove({ lngLat: pendingLngLat });
    }, 100);
  }

  return () => {
    stop();
    map.off('move', updateScale);
    map.off('zoom', updateScale);
    map.off('resize', updateScale);
    if (onMouseMove) map.off('mousemove', onMouseMove);
    if (onMouseLeave) map.off('mouseout', onMouseLeave);
    if (flushTimer) clearInterval(flushTimer);
  };
}
