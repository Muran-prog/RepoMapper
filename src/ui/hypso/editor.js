/**
 * Live ramp editor.
 *
 * A modal-popover that lets the user author a custom ramp:
 *
 *   • drag colour stops up/down a gradient column (elevation axis)
 *   • click a stop to open the native colour picker
 *   • add a new stop by clicking the gradient column at the desired
 *     elevation
 *   • delete a stop with the × button (must keep ≥ 2 stops)
 *   • numeric fine-tune via the elevation input below each stop
 *   • save as new / update / delete / reset
 *   • export the ramp as JSON, import a JSON file or paste
 *
 * Every change applies immediately to the live MapLibre style so the
 * user can iterate in-place. Saving persists to localStorage via
 * `store.js`; the picker is refreshed when the editor closes.
 *
 * Why not a heavyweight UI library?
 * ---------------------------------
 * The brief explicitly rules out npm runtime deps. The editor is
 * dependency-free DOM and minimal CSS. Native pointer events drive
 * dragging; the drag math reads from the gradient column's bounding
 * box. No virtualisation needed — ramps have at most ~16 stops.
 *
 * @typedef {import('../../style/hypso/ramps.js').HypsoStop} HypsoStop
 * @typedef {import('./store.js').CustomRamp} CustomRamp
 */

import {
  getRamp,
  getRampStops,
  registerCustomRamps,
  RAMPS,
  applyHypsoRamp,
} from '../../style/hypso/index.js';
import {
  loadCustomRamps,
  upsertCustomRamp,
  deleteCustomRamp,
  validateCustomRamp,
} from './store.js';

/** Elevation axis the editor exposes (m). Keeps the drag math sane. */
const ELEV_MIN = -3000;
const ELEV_MAX = 3000;

/**
 * @typedef {object} EditorMountOpts
 * @property {maplibregl.Map} map
 * @property {HTMLElement}    host           Container the editor renders into.
 * @property {string}         rampId         Initial ramp to edit.
 * @property {'light'|'dark'} [theme='light']
 * @property {function():void} [onClose]
 * @property {function(string):void} [onSaved] Called with the saved ramp id.
 */

/**
 * Mount the editor. Returns an imperative handle for the caller to
 * unmount or re-open with a different ramp id.
 *
 * @param {EditorMountOpts} opts
 */
export function mountHypsoEditor(opts) {
  const { map, host, theme = 'light' } = opts;
  let rampId = opts.rampId;

  // Working copy — stops the user is editing. Always sorted asc.
  /** @type {Array<[number, string]>} */
  let stops = cloneStops(getRampStops(rampId, theme));
  let name = getRamp(rampId).name;
  let summary = getRamp(rampId).summary;
  let region = getRamp(rampId).region || 'global';
  let cbSafe = !!getRamp(rampId).colorblindSafe;
  let isCustom = !RAMPS[rampId];

  host.innerHTML = `
    <div class="hypso-editor" role="dialog" aria-label="Редактор шкалы">
      <header class="hypso-editor-head">
        <h3>Редактор шкалы</h3>
        <button data-ctl="close" type="button" aria-label="Закрыть">×</button>
      </header>

      <div class="hypso-editor-body">
        <div class="hypso-editor-stops">
          <div class="hypso-grad" data-ctl="grad" aria-hidden="true"></div>
          <div class="hypso-stops" data-ctl="stops"></div>
          <div class="hypso-axis" aria-hidden="true">
            <span class="hypso-axis-tick" style="top:0%">3000 м</span>
            <span class="hypso-axis-tick" style="top:33%">1000 м</span>
            <span class="hypso-axis-tick" style="top:50%">0 м</span>
            <span class="hypso-axis-tick" style="top:67%">-1000 м</span>
            <span class="hypso-axis-tick" style="top:100%">-3000 м</span>
          </div>
        </div>

        <div class="hypso-editor-fields">
          <label class="field"><span>Название</span><input data-ctl="name" type="text"></label>
          <label class="field"><span>Описание</span><input data-ctl="summary" type="text"></label>
          <label class="field"><span>Регион</span>
            <select data-ctl="region">
              <option value="global">Глобальный</option>
              <option value="alpine">Альпийский</option>
              <option value="carpathian">Карпатский</option>
              <option value="steppe">Степной</option>
              <option value="sea">Море</option>
            </select>
          </label>
          <label class="row hypso-row"><input type="checkbox" data-ctl="cb"> <span>Безопасно для дальтоников</span></label>
        </div>

        <div class="hypso-stop-list" data-ctl="stop-list"></div>

        <div class="hypso-editor-actions">
          <button data-ctl="add" type="button">+ Добавить точку</button>
          <button data-ctl="reset" type="button">Сброс</button>
          <button data-ctl="export" type="button">Экспорт</button>
          <label class="hypso-import">
            Импорт
            <input type="file" accept=".json,application/json" data-ctl="import-file" hidden>
          </label>
          ${
            isCustom
              ? `<button data-ctl="delete" type="button" class="hypso-danger">Удалить</button>`
              : ''
          }
          <button data-ctl="save" type="button" class="hypso-primary">Сохранить как новую</button>
          ${isCustom ? `<button data-ctl="update" type="button" class="hypso-primary">Обновить</button>` : ''}
        </div>
      </div>
    </div>
  `;

  const refs = {
    close: host.querySelector('[data-ctl=close]'),
    grad: host.querySelector('[data-ctl=grad]'),
    stops: host.querySelector('[data-ctl=stops]'),
    name: host.querySelector('[data-ctl=name]'),
    summary: host.querySelector('[data-ctl=summary]'),
    region: host.querySelector('[data-ctl=region]'),
    cb: host.querySelector('[data-ctl=cb]'),
    stopList: host.querySelector('[data-ctl=stop-list]'),
    add: host.querySelector('[data-ctl=add]'),
    reset: host.querySelector('[data-ctl=reset]'),
    export: host.querySelector('[data-ctl=export]'),
    import: host.querySelector('[data-ctl=import-file]'),
    delete: host.querySelector('[data-ctl=delete]'),
    save: host.querySelector('[data-ctl=save]'),
    update: host.querySelector('[data-ctl=update]'),
  };

  refs.name.value = name;
  refs.summary.value = summary;
  refs.region.value = region;
  refs.cb.checked = cbSafe;

  // ----- Drag math --------------------------------------------------
  /** Convert pointerY to elevation given the grad column rect. */
  const yToElev = (y, rect) => {
    const t = (y - rect.top) / rect.height;
    return Math.round(ELEV_MAX - t * (ELEV_MAX - ELEV_MIN));
  };
  /** Convert elevation to top% position. */
  const elevToPct = (e) => (1 - (e - ELEV_MIN) / (ELEV_MAX - ELEV_MIN)) * 100;

  const render = () => {
    refs.grad.style.background = stopsToCssGradient(stops);
    refs.stops.innerHTML = stops
      .map(
        ([elev, color], i) => `
          <button
            class="hypso-stop"
            type="button"
            data-i="${i}"
            style="top:${elevToPct(elev).toFixed(2)}%; --c:${escAttr(color)};"
            aria-label="Точка на ${elev} м, ${color}"
          ></button>`,
      )
      .join('');
    refs.stopList.innerHTML = stops
      .map(
        ([elev, color], i) => `
          <div class="hypso-stop-row" data-i="${i}">
            <input class="hypso-elev" data-i="${i}" type="number" min="${ELEV_MIN}" max="${ELEV_MAX}" step="10" value="${elev}">
            <input class="hypso-color" data-i="${i}" type="color" value="${escAttr(color)}">
            <button data-ctl="del-stop" data-i="${i}" type="button" class="hypso-icon" aria-label="Удалить точку">×</button>
          </div>`,
      )
      .join('');

    // Wire stop drag.
    refs.stops.querySelectorAll('.hypso-stop').forEach((el) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture?.(e.pointerId);
        const i = Number(el.dataset.i);
        const onMove = (ev) => {
          const rect = refs.grad.getBoundingClientRect();
          const elev = Math.max(ELEV_MIN, Math.min(ELEV_MAX, yToElev(ev.clientY, rect)));
          stops[i][0] = elev;
          stops.sort((a, b) => a[0] - b[0]);
          render();
          applyLive();
        };
        const onUp = () => {
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerup', onUp);
          el.removeEventListener('pointercancel', onUp);
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
      });
    });

    // Numeric elev edit.
    refs.stopList.querySelectorAll('.hypso-elev').forEach((el) => {
      el.addEventListener('change', () => {
        const i = Number(el.dataset.i);
        stops[i][0] = Math.max(ELEV_MIN, Math.min(ELEV_MAX, Number(el.value) || 0));
        stops.sort((a, b) => a[0] - b[0]);
        render();
        applyLive();
      });
    });

    // Colour edit.
    refs.stopList.querySelectorAll('.hypso-color').forEach((el) => {
      el.addEventListener('input', () => {
        const i = Number(el.dataset.i);
        stops[i][1] = el.value;
        render();
        applyLive();
      });
    });

    // Delete stop.
    refs.stopList.querySelectorAll('[data-ctl=del-stop]').forEach((el) => {
      el.addEventListener('click', () => {
        const i = Number(el.dataset.i);
        if (stops.length <= 2) return; // keep minimum 2 stops
        stops.splice(i, 1);
        render();
        applyLive();
      });
    });
  };

  // Add stop by clicking the gradient column.
  refs.grad.addEventListener('pointerdown', (e) => {
    const rect = refs.grad.getBoundingClientRect();
    const elev = yToElev(e.clientY, rect);
    // Pick the colour interpolated at the click position.
    const c = sampleStopColor(stops, elev) || '#888888';
    stops.push([elev, c]);
    stops.sort((a, b) => a[0] - b[0]);
    render();
    applyLive();
  });

  refs.add.addEventListener('click', () => {
    // Append a stop in the middle of the current range.
    const lo = stops[0][0];
    const hi = stops[stops.length - 1][0];
    const elev = Math.round((lo + hi) / 2);
    const c = sampleStopColor(stops, elev) || '#888888';
    stops.push([elev, c]);
    stops.sort((a, b) => a[0] - b[0]);
    render();
    applyLive();
  });

  refs.reset.addEventListener('click', () => {
    stops = cloneStops(getRampStops(rampId, theme));
    render();
    applyLive();
  });

  refs.export.addEventListener('click', () => {
    const blob = makeExportBlob({ rampId, name, summary, region, cbSafe, stops });
    triggerDownload(`${rampId}.hypso.json`, blob);
  });

  refs.import.addEventListener('change', async () => {
    const file = refs.import.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const err = validateCustomRamp(parsed);
      if (err) {
        alert(`Не удалось импортировать: ${err}`);
        return;
      }
      stops = cloneStops(parsed.light);
      refs.name.value = parsed.name;
      refs.summary.value = parsed.summary ?? '';
      refs.region.value = parsed.region ?? 'global';
      refs.cb.checked = !!parsed.colorblindSafe;
      render();
      applyLive();
    } catch {
      alert('Не удалось импортировать: некорректный JSON');
    }
    refs.import.value = '';
  });

  refs.delete?.addEventListener('click', () => {
    if (!confirm(`Удалить шкалу «${rampId}»?`)) return;
    deleteCustomRamp(rampId);
    registerCustomRamps(loadCustomRamps());
    opts.onSaved?.(null);
    opts.onClose?.();
  });

  refs.save.addEventListener('click', () => {
    const out = buildCustomRamp({ rampId: makeId(refs.name.value), refs, stops, theme });
    upsertCustomRamp(out);
    registerCustomRamps(loadCustomRamps());
    applyHypsoRamp(map, out.id);
    opts.onSaved?.(out.id);
  });

  refs.update?.addEventListener('click', () => {
    const out = buildCustomRamp({ rampId, refs, stops, theme });
    upsertCustomRamp(out);
    registerCustomRamps(loadCustomRamps());
    applyHypsoRamp(map, out.id);
    opts.onSaved?.(out.id);
  });

  refs.close.addEventListener('click', () => opts.onClose?.());

  const applyLive = () => {
    // Build a synthetic "ramp" and shove it into the runtime as
    // an unnamed override. The cleanest way: register a temporary
    // ramp under a reserved id and apply it.
    const tmpId = '__hypso_editor_preview__';
    registerCustomRamps({
      ...loadCustomRamps(),
      [tmpId]: buildPreviewRamp({ rampId: tmpId, refs, stops, theme }),
    });
    applyHypsoRamp(map, tmpId);
  };

  render();
  applyLive();

  return {
    unmount() {
      host.innerHTML = '';
      // Restore the previously-active ramp from the user's prefs.
      registerCustomRamps(loadCustomRamps());
    },
    setRampId(id) {
      rampId = id;
      stops = cloneStops(getRampStops(rampId, theme));
      const r = getRamp(rampId);
      refs.name.value = r.name;
      refs.summary.value = r.summary;
      refs.region.value = r.region || 'global';
      refs.cb.checked = !!r.colorblindSafe;
      render();
      applyLive();
    },
  };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function cloneStops(stops) {
  return stops.map(([e, c]) => [e, c]);
}

function stopsToCssGradient(stops) {
  if (stops.length === 0) return 'transparent';
  const elevMin = stops[0][0];
  const elevMax = stops[stops.length - 1][0];
  const span = elevMax - elevMin || 1;
  const pieces = stops.map(([e, c]) => `${c} ${(((e - elevMin) / span) * 100).toFixed(2)}%`);
  return `linear-gradient(to top, ${pieces.join(', ')})`;
}

/**
 * Sample the colour at a target elevation by linearly interpolating
 * between the two surrounding stops in sRGB. Good enough for picking a
 * sensible default when adding a new stop — the perceptual interpolator
 * elsewhere kicks in for the actual paint expression.
 */
function sampleStopColor(stops, target) {
  if (stops.length === 0) return null;
  if (target <= stops[0][0]) return stops[0][1];
  if (target >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [e0, c0] = stops[i];
    const [e1, c1] = stops[i + 1];
    if (target >= e0 && target <= e1) {
      const t = (target - e0) / (e1 - e0 || 1);
      return lerpHex(c0, c1, t);
    }
  }
  return stops[0][1];
}

function lerpHex(a, b, t) {
  const [r1, g1, b1] = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const [r2, g2, b2] = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const mix = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return '#' + mix(r1, r2) + mix(g1, g2) + mix(b1, b2);
}

function makeId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  return `custom-${slug || 'ramp'}-${Date.now().toString(36).slice(-4)}`;
}

function buildCustomRamp({ rampId, refs, stops, theme }) {
  // For a custom ramp we mirror the editor's stops into both light and
  // dark variants. The user can always re-edit to differentiate them.
  const cloned = cloneStops(stops);
  return {
    id: rampId,
    name: refs.name.value.trim() || rampId,
    summary: refs.summary.value.trim() || '',
    region: refs.region.value || 'global',
    colorblindSafe: !!refs.cb.checked,
    light: theme === 'light' ? cloned : cloneStops(stops),
    dark: theme === 'dark' ? cloned : cloneStops(stops),
  };
}

function buildPreviewRamp(args) {
  return buildCustomRamp(args);
}

function makeExportBlob({ rampId, name, summary, region, cbSafe, stops }) {
  const text = JSON.stringify(
    {
      id: rampId,
      name,
      summary,
      region,
      colorblindSafe: cbSafe,
      light: stops,
      dark: stops,
    },
    null,
    2,
  );
  return new Blob([text], { type: 'application/json' });
}

function triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escAttr(s) {
  return String(s).replace(/["&<>]/g, (c) => ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
