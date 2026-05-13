/**
 * Drawing panel — UI for the drawing engine.
 *
 * Mounts a tool palette + options into the host element (the body of
 * the dock's "Малювання" panel). The panel is intentionally compact:
 *
 *   • Tool palette (select / marker / line / polygon / pencil / shape)
 *   • Shape sub-selector (visible only when the shape tool is active)
 *   • Connection-mode picker (none / sequence / mesh / hub)
 *   • "Optimise route" action button — explicit one-shot TSP on the
 *     current markers. Intentionally OUT of the radio group above,
 *     because it's an operation over existing data rather than a
 *     preference for future placements.
 *   • Geodesic toggle + label toggle
 *   • Style fields — colour pickers, stroke width + opacity sliders
 *   • Live stats (marker count, total path length, feature count)
 *   • Action row — undo / redo / delete selected / clear all
 *   • Import / export GeoJSON
 *
 * The panel takes ownership of "drawing mode": it calls `engine.enable()`
 * when the host gets the `data-active="true"` attribute (the dock
 * controller toggles this), and `engine.disable()` otherwise. So opening
 * the panel arms the engine, closing it returns the map to normal pan/
 * zoom behaviour.
 */

import { DRAW_ICONS as I } from './icons.js';

const TOOL_DEFS = [
  { id: 'select',  label: 'Вибір',      tip: 'Виділити та редагувати', icon: I.select },
  { id: 'marker',  label: 'Мітка',      tip: 'Поставити мітку',         icon: I.marker },
  { id: 'line',    label: 'Лінія',      tip: 'Накреслити лінію',        icon: I.line },
  { id: 'polygon', label: 'Полігон',    tip: 'Накреслити багатокутник', icon: I.polygon },
  { id: 'pencil',  label: 'Олівець',    tip: 'Вільне малювання',        icon: I.pencil },
  { id: 'shape',   label: 'Фігура',     tip: 'Готова фігура',            icon: I.shapeHex },
];

const SHAPE_DEFS = [
  { id: 'circle',     label: 'Коло',         icon: I.shapeCircle },
  { id: 'rectangle',  label: 'Прямокутник',  icon: I.shapeRect },
  { id: 'regular',    label: 'N-кутник',     icon: I.shapeHex },
  { id: 'star',       label: 'Зірка',        icon: I.shapeStar },
  { id: 'arrow',      label: 'Стрілка',      icon: I.shapeArrow },
];

/**
 * Connection mode radio group. `optimal` is NOT here — it's an
 * explicit action (see the "Оптимізувати маршрут" button below),
 * not a mode. Keeping them separate avoids the old UX confusion
 * where clicking a radio button silently rewrote committed lines
 * AND silently reverted the selection to "none".
 */
const CONN_DEFS = [
  { id: 'none',     label: 'Без зʼєднань', tip: 'Нові мітки не зʼєднуються автоматично', icon: I.connectionNone },
  { id: 'sequence', label: 'Послідовно',    tip: 'Кожну нову мітку зʼєднувати з попередньою', icon: I.connectionSequence },
  { id: 'mesh',     label: 'Усі з усіма',   tip: 'Кожну нову мітку зʼєднувати з усіма попередніми', icon: I.connectionMesh },
  { id: 'hub',      label: 'Зірка',         tip: 'Кожну нову мітку зʼєднувати з першою (центром)', icon: I.connectionHub },
];

/**
 * Render the panel body. Pure HTML — the caller (controls.js) injects
 * this into the existing `.panel-body` shell.
 */
export function renderDrawPanelBody() {
  return `
    <div class="panel-group draw-tools-group">
      <h4 class="panel-group-title">Інструмент</h4>
      <div class="draw-tool-grid" data-ctl="draw-tools" role="radiogroup" aria-label="Активний інструмент малювання">
        ${TOOL_DEFS
          .map((t) => `
            <button
              class="draw-tool"
              type="button"
              role="radio"
              aria-checked="false"
              data-tool="${t.id}"
              data-tip="${t.tip}"
              aria-label="${t.label}">
              <span class="draw-tool-icon">${t.icon}</span>
              <span class="draw-tool-label">${t.label}</span>
            </button>
          `)
          .join('')}
      </div>
    </div>

    <div class="panel-group draw-shape-group" data-ctl="draw-shape-group" hidden>
      <h4 class="panel-group-title">Фігура</h4>
      <div class="draw-shape-grid" data-ctl="draw-shapes" role="radiogroup" aria-label="Тип фігури">
        ${SHAPE_DEFS
          .map((s) => `
            <button
              class="draw-shape"
              type="button"
              role="radio"
              aria-checked="false"
              data-shape="${s.id}"
              aria-label="${s.label}">
              <span class="draw-shape-icon">${s.icon}</span>
              <span class="draw-shape-label">${s.label}</span>
            </button>
          `)
          .join('')}
      </div>
      <div class="draw-shape-size">
        <div class="slider-row">
          <label class="slider-label" for="draw-shape-size">
            <span>Розмір</span>
            <span data-ctl="draw-shape-size-readout">100 px</span>
          </label>
          <input id="draw-shape-size" type="range" min="20" max="220" step="5" value="100" data-ctl="draw-shape-size">
        </div>
      </div>
      <div class="draw-shape-sides" data-ctl="draw-shape-sides-row" hidden>
        <div class="slider-row">
          <label class="slider-label" for="draw-shape-sides">
            <span>Сторони</span>
            <span data-ctl="draw-shape-sides-readout">6</span>
          </label>
          <input id="draw-shape-sides" type="range" min="3" max="12" step="1" value="6" data-ctl="draw-shape-sides">
        </div>
      </div>
    </div>

    <div class="panel-group">
      <h4 class="panel-group-title">Зʼєднання міток</h4>
      <div class="draw-conn-list" data-ctl="draw-connections" role="radiogroup" aria-label="Режим зʼєднання міток">
        ${CONN_DEFS
          .map((c) => `
            <button
              class="draw-conn"
              type="button"
              role="radio"
              aria-checked="false"
              data-conn="${c.id}"
              title="${c.tip}"
              aria-label="${c.label}">
              <span class="draw-conn-icon">${c.icon}</span>
              <span class="draw-conn-text">
                <strong>${c.label}</strong>
                <small>${c.tip}</small>
              </span>
            </button>
          `)
          .join('')}
      </div>
      <button
        class="draw-optimize"
        type="button"
        data-ctl="draw-optimize"
        disabled
        title="Перебудує всі авто-зʼєднання у найкоротший маршрут через наявні мітки. Режим зʼєднань не змінюється.">
        <span class="draw-optimize-icon">${I.connectionOptimal}</span>
        <span class="draw-optimize-text">
          <strong>Оптимізувати маршрут</strong>
          <small>Перебудувати авто-зʼєднання у найкоротший маршрут</small>
        </span>
      </button>
      <div class="rows">
        <label class="row">
          <span>Геодезичні (з кривиною Землі)</span>
          <input type="checkbox" data-ctl="draw-geodesic" checked>
        </label>
        <label class="row">
          <span>Нумерація міток</span>
          <input type="checkbox" data-ctl="draw-labels" checked>
        </label>
      </div>
    </div>

    <div class="panel-group">
      <h4 class="panel-group-title">Стиль</h4>
      <div class="draw-style-row">
        <label class="draw-color">
          <span>Контур</span>
          <input type="color" data-ctl="draw-color" value="#c66809">
        </label>
        <label class="draw-color">
          <span>Заливка</span>
          <input type="color" data-ctl="draw-fill" value="#c66809">
        </label>
      </div>
      <div class="slider-row">
        <label class="slider-label" for="draw-weight">
          <span>Товщина</span>
          <span data-ctl="draw-weight-readout">3 px</span>
        </label>
        <input id="draw-weight" type="range" min="1" max="10" step="0.5" value="3" data-ctl="draw-weight">
      </div>
      <div class="slider-row">
        <label class="slider-label" for="draw-opacity">
          <span>Прозорість</span>
          <span data-ctl="draw-opacity-readout">95 %</span>
        </label>
        <input id="draw-opacity" type="range" min="0.1" max="1" step="0.05" value="0.95" data-ctl="draw-opacity">
      </div>
    </div>

    <div class="panel-group draw-stats" data-ctl="draw-stats">
      <div class="draw-stat">
        <span class="draw-stat-label">Мітки</span>
        <span class="draw-stat-value" data-ctl="draw-stat-markers">0</span>
      </div>
      <div class="draw-stat">
        <span class="draw-stat-label">Маршрут</span>
        <span class="draw-stat-value" data-ctl="draw-stat-distance">—</span>
      </div>
      <div class="draw-stat">
        <span class="draw-stat-label">Об'єкти</span>
        <span class="draw-stat-value" data-ctl="draw-stat-features">0</span>
      </div>
    </div>

    <div class="panel-group draw-actions">
      <div class="draw-action-row">
        <button type="button" class="draw-action" data-ctl="draw-undo"   title="Скасувати (Ctrl+Z)" aria-label="Скасувати">${I.undo}</button>
        <button type="button" class="draw-action" data-ctl="draw-redo"   title="Повернути (Ctrl+Shift+Z)" aria-label="Повернути">${I.redo}</button>
        <button type="button" class="draw-action" data-ctl="draw-delete" title="Видалити обраний (Del)" aria-label="Видалити обраний">${I.trash}</button>
        <button type="button" class="draw-action draw-danger" data-ctl="draw-clear" title="Очистити все" aria-label="Очистити все">${I.broom}</button>
      </div>
      <div class="draw-action-row">
        <button type="button" class="draw-action draw-io" data-ctl="draw-export" title="Експорт GeoJSON" aria-label="Експорт GeoJSON">${I.download}<span>Експорт</span></button>
        <label class="draw-action draw-io" title="Імпорт GeoJSON" aria-label="Імпорт GeoJSON">${I.upload}<span>Імпорт</span>
          <input type="file" accept=".json,.geojson,application/json,application/geo+json" data-ctl="draw-import-file" hidden>
        </label>
      </div>
    </div>
  `;
}

/**
 * Wire the panel body to the engine. Returns an unmount function.
 *
 * @param {object} opts
 * @param {object} opts.engine    Handle from `createDrawEngine`.
 * @param {HTMLElement} opts.host Element produced by `renderDrawPanelBody`.
 */
export function mountDrawPanel({ engine, host }) {
  if (!host || !engine) return () => {};

  const $ = (sel) => host.querySelector(sel);
  const $$ = (sel) => Array.from(host.querySelectorAll(sel));

  // -------------------------------------------------------------------
  // Helper to manage radio-group selection state via aria-checked.
  // -------------------------------------------------------------------
  const setRadioGroup = (selector, value, attrKey) => {
    for (const btn of $$(selector)) {
      const on = btn.dataset[attrKey] === value;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.dataset.active = on ? '1' : '0';
    }
  };

  // -------------------------------------------------------------------
  // Tool palette
  // -------------------------------------------------------------------
  for (const btn of $$('[data-ctl="draw-tools"] [data-tool]')) {
    btn.addEventListener('click', () => engine.setTool(btn.dataset.tool));
  }

  const refreshShapeGroup = (tool) => {
    const group = $('[data-ctl="draw-shape-group"]');
    if (!group) return;
    group.hidden = tool !== 'shape';
  };

  // -------------------------------------------------------------------
  // Shape sub-selector
  // -------------------------------------------------------------------
  for (const btn of $$('[data-ctl="draw-shapes"] [data-shape]')) {
    btn.addEventListener('click', () => {
      engine.setShape(btn.dataset.shape);
      refreshShapeSidesVisibility();
    });
  }
  const refreshShapeSidesVisibility = () => {
    const row = $('[data-ctl="draw-shape-sides-row"]');
    if (!row) return;
    row.hidden = engine.getPrefs().shapeType !== 'regular';
  };
  const sidesSlider = $('[data-ctl="draw-shape-sides"]');
  const sidesReadout = $('[data-ctl="draw-shape-sides-readout"]');
  if (sidesSlider) {
    const apply = () => {
      const n = Number(sidesSlider.value) || 6;
      if (sidesReadout) sidesReadout.textContent = String(n);
      engine.setPrefs({ shapeSides: n });
      updateSliderFill(sidesSlider);
    };
    sidesSlider.addEventListener('input', apply);
  }

  // Unified shape-size slider — one knob, every shape.
  const sizeSlider = $('[data-ctl="draw-shape-size"]');
  const sizeReadout = $('[data-ctl="draw-shape-size-readout"]');
  if (sizeSlider) {
    const apply = () => {
      const n = Number(sizeSlider.value) || 100;
      if (sizeReadout) sizeReadout.textContent = `${n} px`;
      engine.setPrefs({ shapeSize: n });
      updateSliderFill(sizeSlider);
    };
    sizeSlider.addEventListener('input', apply);
  }

  // -------------------------------------------------------------------
  // Connection mode
  // -------------------------------------------------------------------
  for (const btn of $$('[data-ctl="draw-connections"] [data-conn]')) {
    btn.addEventListener('click', () => engine.setConnectionMode(btn.dataset.conn));
  }

  // -------------------------------------------------------------------
  // Optimise-route action — separate from the mode radio group. Runs
  // the TSP solver over the current markers and replaces all auto-gen
  // connections with the optimal tour in a single undoable step. The
  // connection mode is intentionally left alone so the user can keep
  // placing markers with the same behaviour afterwards.
  // -------------------------------------------------------------------
  const optimizeBtn = $('[data-ctl="draw-optimize"]');
  optimizeBtn?.addEventListener('click', () => {
    if (optimizeBtn.disabled) return;
    engine.optimizeRoute();
  });
  const refreshOptimizeAvailability = () => {
    if (!optimizeBtn) return;
    // Need at least two markers to produce a tour leg. The markerCount
    // from getState is the authoritative source; metrics events also
    // carry it but fire less often (rerender-coupled).
    optimizeBtn.disabled = engine.getState().markerCount < 2;
  };

  // -------------------------------------------------------------------
  // Toggles
  // -------------------------------------------------------------------
  const geodesic = $('[data-ctl="draw-geodesic"]');
  geodesic?.addEventListener('change', () => engine.setPrefs({ geodesic: geodesic.checked }));
  const labels = $('[data-ctl="draw-labels"]');
  labels?.addEventListener('change', () => {
    engine.setPrefs({ labels: labels.checked });
    // Toggling labels swaps the layer paint expression — easiest path
    // is to drive label visibility off the engine paint composition.
    document.documentElement.dataset.drawLabels = labels.checked ? '1' : '0';
  });

  // -------------------------------------------------------------------
  // Style
  // -------------------------------------------------------------------
  const color = $('[data-ctl="draw-color"]');
  color?.addEventListener('input', () => engine.setPrefs({ color: color.value }));
  const fill = $('[data-ctl="draw-fill"]');
  fill?.addEventListener('input', () => engine.setPrefs({ fill: fill.value }));

  const weight = $('[data-ctl="draw-weight"]');
  const weightOut = $('[data-ctl="draw-weight-readout"]');
  if (weight) {
    const apply = () => {
      const v = Number(weight.value) || 3;
      if (weightOut) weightOut.textContent = `${v} px`;
      engine.setPrefs({ weight: v });
      updateSliderFill(weight);
    };
    weight.addEventListener('input', apply);
  }

  const opacity = $('[data-ctl="draw-opacity"]');
  const opacityOut = $('[data-ctl="draw-opacity-readout"]');
  if (opacity) {
    const apply = () => {
      const v = Number(opacity.value) || 1;
      if (opacityOut) opacityOut.textContent = `${Math.round(v * 100)} %`;
      engine.setPrefs({ opacity: v });
      updateSliderFill(opacity);
    };
    opacity.addEventListener('input', apply);
  }

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------
  $('[data-ctl="draw-undo"]')?.addEventListener('click', () => engine.undo());
  $('[data-ctl="draw-redo"]')?.addEventListener('click', () => engine.redo());
  $('[data-ctl="draw-delete"]')?.addEventListener('click', () => engine.deleteSelected());
  $('[data-ctl="draw-clear"]')?.addEventListener('click', () => {
    if (window.confirm('Очистити всі намальовані об\'єкти? Цю дію неможливо скасувати після перезавантаження.')) {
      engine.clearAll();
    }
  });

  // Export
  $('[data-ctl="draw-export"]')?.addEventListener('click', () => {
    const data = engine.exportGeoJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cart-draw-${new Date().toISOString().slice(0, 10)}.geojson`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // Import
  const importInput = $('[data-ctl="draw-import-file"]');
  importInput?.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const n = engine.importGeoJSON(parsed);
      if (n === 0) {
        window.alert('У файлі не знайдено валідних об\'єктів GeoJSON.');
      }
    } catch (err) {
      window.alert(`Неможливо прочитати файл: ${err?.message ?? err}`);
    } finally {
      importInput.value = '';
    }
  });

  // -------------------------------------------------------------------
  // Sync initial control state from the engine prefs / state.
  // -------------------------------------------------------------------
  const prefs = engine.getPrefs();
  setRadioGroup('[data-ctl="draw-tools"] [data-tool]', prefs.tool, 'tool');
  setRadioGroup('[data-ctl="draw-shapes"] [data-shape]', prefs.shapeType, 'shape');
  setRadioGroup('[data-ctl="draw-connections"] [data-conn]', prefs.connectionMode, 'conn');
  refreshShapeGroup(prefs.tool);
  refreshShapeSidesVisibility();
  if (geodesic) geodesic.checked = !!prefs.geodesic;
  if (labels) labels.checked = !!prefs.labels;
  if (color) color.value = prefs.color;
  if (fill) fill.value = prefs.fill;
  if (weight) {
    weight.value = String(prefs.weight);
    if (weightOut) weightOut.textContent = `${prefs.weight} px`;
    updateSliderFill(weight);
  }
  if (opacity) {
    opacity.value = String(prefs.opacity);
    if (opacityOut) opacityOut.textContent = `${Math.round(prefs.opacity * 100)} %`;
    updateSliderFill(opacity);
  }
  if (sidesSlider) {
    sidesSlider.value = String(prefs.shapeSides ?? 6);
    if (sidesReadout) sidesReadout.textContent = String(prefs.shapeSides ?? 6);
    updateSliderFill(sidesSlider);
  }
  if (sizeSlider) {
    const initSize = prefs.shapeSize ?? 100;
    sizeSlider.value = String(initSize);
    if (sizeReadout) sizeReadout.textContent = `${initSize} px`;
    updateSliderFill(sizeSlider);
  }

  // -------------------------------------------------------------------
  // Live engine subscriptions
  // -------------------------------------------------------------------
  const offTool = engine.on('tool', (t) => {
    setRadioGroup('[data-ctl="draw-tools"] [data-tool]', t, 'tool');
    refreshShapeGroup(t);
  });
  const offShape = engine.on('shape', (s) => {
    setRadioGroup('[data-ctl="draw-shapes"] [data-shape]', s, 'shape');
    refreshShapeSidesVisibility();
  });
  const offConn = engine.on('connectionMode', (m) => {
    setRadioGroup('[data-ctl="draw-connections"] [data-conn]', m, 'conn');
  });

  const statMarkers = $('[data-ctl="draw-stat-markers"]');
  const statDistance = $('[data-ctl="draw-stat-distance"]');
  const statFeatures = $('[data-ctl="draw-stat-features"]');

  const offMetrics = engine.on('metrics', (m) => {
    if (statMarkers) statMarkers.textContent = String(m.markers);
    if (statDistance) statDistance.textContent = m.markers >= 2 ? m.formatted : '—';
  });

  const refreshCounts = () => {
    if (statFeatures) statFeatures.textContent = String(engine.getState().featureCount);
    // The optimise button's availability depends on the marker count;
    // `change` is the single event that fires on every add/remove/undo,
    // so it's the right hook to refresh the disabled state.
    refreshOptimizeAvailability();
  };
  refreshCounts();
  const offChange = engine.on('change', refreshCounts);

  const undoBtn = $('[data-ctl="draw-undo"]');
  const redoBtn = $('[data-ctl="draw-redo"]');
  const offHistory = engine.on('history', (h) => {
    if (undoBtn) undoBtn.disabled = !h.canUndo;
    if (redoBtn) redoBtn.disabled = !h.canRedo;
  });
  // Initial state
  const st0 = engine.getState();
  if (undoBtn) undoBtn.disabled = st0.historyDepth === 0;
  if (redoBtn) redoBtn.disabled = st0.redoDepth === 0;

  // -------------------------------------------------------------------
  // Unmount
  // -------------------------------------------------------------------
  return () => {
    offTool();
    offShape();
    offConn();
    offMetrics();
    offChange();
    offHistory();
  };
}

/** Set the `--fill` CSS var so the slider track gradient fills correctly. */
function updateSliderFill(slider) {
  if (!slider) return;
  const min = Number(slider.min);
  const max = Number(slider.max);
  const v = Number(slider.value);
  const pct = ((v - min) / (max - min)) * 100;
  slider.style.setProperty('--fill', `${pct}%`);
}
