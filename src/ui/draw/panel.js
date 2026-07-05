/**
 * Drawing panel — UI for the drawing engine.
 *
 * Mounts a tool palette + options into the host element (the body of
 * the dock's "Малювання" panel). The panel is intentionally compact:
 *
 *   • Tool palette (select / marker / line / polygon / pencil / shape)
 *   • Shape sub-selector (visible only when the shape tool is active)
 *   • Connection-mode picker (none / sequence / mesh / hub / optimal)
 *   • Geodesic toggle + label toggle
 *   • Style fields — colour pickers, stroke thickness + opacity sliders
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
import { accordionMarkup } from '../accordion.js';

// Tool palette, split into two intent groups so the grid reads as
// "точки и линии" vs "площади и свободные формы" rather than one
// undifferentiated block.
const TOOL_DEFS = [
  { id: 'select',  label: 'Выбор',     tip: 'Выделить объект и редактировать его узлы', icon: I.select,    group: 'base' },
  { id: 'marker',  label: 'Метка',     tip: 'Поставить точку одним кликом',             icon: I.marker,    group: 'base' },
  { id: 'line',    label: 'Ломаная',   tip: 'Линия по последовательности точек',        icon: I.line,      group: 'base' },
  { id: 'segment', label: 'Отрезок',   tip: 'Прямая линия по двум точкам',              icon: I.segment,   group: 'base' },
  { id: 'polygon', label: 'Контур',    tip: 'Замкнутый многоугольник',                  icon: I.polygon,   group: 'area' },
  { id: 'shape',   label: 'Фигура',    tip: 'Готовая геометрическая фигура',            icon: I.shapeHex,  group: 'area' },
  { id: 'pencil',  label: 'От руки',   tip: 'Свободное рисование карандашом',           icon: I.pencil,    group: 'area' },
  { id: 'eraser',  label: 'Ластик',    tip: 'Стирать нарисованное движением',           icon: I.eraser,    group: 'area' },
];

const SHAPE_DEFS = [
  { id: 'circle',     label: 'Круг',          icon: I.shapeCircle },
  { id: 'rectangle',  label: 'Прямоугольник', icon: I.shapeRect },
  { id: 'regular',    label: 'N-угольник',    icon: I.shapeHex },
  { id: 'star',       label: 'Звезда',        icon: I.shapeStar },
  { id: 'arrow',      label: 'Стрелка',       icon: I.shapeArrow },
];

/**
 * Connection mode radio group. `optimal` has subtler semantics than
 * the other four modes: each activation starts a fresh "optimizer
 * epoch", and TSP re-solves only touch markers placed during the
 * current epoch — pre-existing markers and lines are never modified.
 * The tooltip spells this out so users don't mistake it for a
 * global recompute.
 */
const CONN_DEFS = [
  { id: 'none',     label: 'Не соединять',          tip: 'Метки остаются отдельными точками', icon: I.connectionNone },
  { id: 'sequence', label: 'Цепочкой',              tip: 'Каждая новая метка соединяется с предыдущей', icon: I.connectionSequence },
  { id: 'mesh',     label: 'Каждый с каждым',       tip: 'Новая метка соединяется со всеми предыдущими', icon: I.connectionMesh },
  { id: 'hub',      label: 'Лучами от центра',      tip: 'Все метки соединяются с первой поставленной', icon: I.connectionHub },
  { id: 'optimal',  label: 'Кратчайший маршрут',    tip: 'Новые метки выстраиваются в самый короткий путь. Существующие линии не меняются.', icon: I.connectionOptimal },
];

/**
 * Render the panel body. Pure HTML — the caller (controls.js) injects
 * this into the existing `.panel-body` shell.
 */
export function renderDrawPanelBody() {
  const toolBtn = (t) => `
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
    </button>`;

  const baseTools = TOOL_DEFS.filter((t) => t.group === 'base').map(toolBtn).join('');
  const areaTools = TOOL_DEFS.filter((t) => t.group === 'area').map(toolBtn).join('');

  return `
    <p class="draw-lede">Чертите метки, линии и фигуры прямо на карте. Выберите инструмент, настройте стиль — всё сохраняется автоматически.</p>

    <div class="panel-group draw-tools-group">
      <div class="draw-tools-host" data-ctl="draw-tools" role="radiogroup" aria-label="Инструмент рисования">
        <div class="draw-tool-subhead">Точки и линии</div>
        <div class="draw-tool-grid">${baseTools}</div>
        <div class="draw-tool-subhead">Площади и формы</div>
        <div class="draw-tool-grid">${areaTools}</div>
      </div>
    </div>

    ${accordionMarkup({
      id: 'draw-shape',
      title: 'Параметры фигуры',
      open: true,
      body: `
        <div class="draw-shape-group" data-ctl="draw-shape-group" hidden>
          <div class="draw-shape-grid" data-ctl="draw-shapes" role="radiogroup" aria-label="Тип фигуры">
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
                <span>Размер фигуры</span>
                <span data-ctl="draw-shape-size-readout">100 px</span>
              </label>
              <input id="draw-shape-size" type="range" min="20" max="220" step="5" value="100" data-ctl="draw-shape-size">
            </div>
          </div>
          <div class="draw-shape-sides" data-ctl="draw-shape-sides-row" hidden>
            <div class="slider-row">
              <label class="slider-label" for="draw-shape-sides">
                <span>Число сторон</span>
                <span data-ctl="draw-shape-sides-readout">6</span>
              </label>
              <input id="draw-shape-sides" type="range" min="3" max="12" step="1" value="6" data-ctl="draw-shape-sides">
            </div>
          </div>
        </div>
        <div class="draw-eraser-group" data-ctl="draw-eraser-group" hidden>
          <div class="slider-row">
            <label class="slider-label" for="draw-eraser-size">
              <span>Диаметр ластика</span>
              <span data-ctl="draw-eraser-size-readout">30 px</span>
            </label>
            <input id="draw-eraser-size" type="range" min="5" max="120" step="5" value="30" data-ctl="draw-eraser-size">
          </div>
        </div>
        <p class="draw-hint" data-ctl="draw-shape-hint">Выберите инструмент «Фигура» или «Ластик», чтобы настроить их параметры.</p>
      `,
    })}

    ${accordionMarkup({
      id: 'draw-connections',
      title: 'Соединение меток',
      open: false,
      body: `
        <div class="draw-conn-list" data-ctl="draw-connections" role="radiogroup" aria-label="Режим соединения меток">
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
        <div class="rows">
          <label class="row row-rich">
            <span class="row-ico" aria-hidden="true">${I.geodesic}</span>
            <span class="row-main">
              <span class="row-title">Учитывать кривизну Земли</span>
              <span class="row-desc">Геодезические линии по дуге большого круга</span>
            </span>
            <input type="checkbox" data-ctl="draw-geodesic" checked>
          </label>
          <label class="row row-rich">
            <span class="row-ico" aria-hidden="true">${I.label}</span>
            <span class="row-main">
              <span class="row-title">Нумеровать метки</span>
              <span class="row-desc">Порядковые номера на каждой точке</span>
            </span>
            <input type="checkbox" data-ctl="draw-labels" checked>
          </label>
          <label class="row row-rich">
            <span class="row-ico" aria-hidden="true">${I.ruler}</span>
            <span class="row-main">
              <span class="row-title">Показывать расстояния</span>
              <span class="row-desc">Подписи длины при наведении на линию</span>
            </span>
            <input type="checkbox" data-ctl="draw-measure">
          </label>
        </div>
      `,
    })}

    ${accordionMarkup({
      id: 'draw-style',
      title: 'Внешний вид',
      open: true,
      body: `
        <div class="draw-style-row">
          <label class="draw-color">
            <span>Цвет линий</span>
            <input type="color" data-ctl="draw-color" value="#c66809">
          </label>
          <label class="draw-color">
            <span>Цвет заливки</span>
            <input type="color" data-ctl="draw-fill" value="#c66809">
          </label>
        </div>
        <div class="slider-row">
          <label class="slider-label" for="draw-weight">
            <span>Толщина обводки</span>
            <span data-ctl="draw-weight-readout">3 px</span>
          </label>
          <input id="draw-weight" type="range" min="1" max="20" step="0.5" value="3" data-ctl="draw-weight">
        </div>
        <div class="slider-row">
          <label class="slider-label" for="draw-opacity">
            <span>Непрозрачность</span>
            <span data-ctl="draw-opacity-readout">95 %</span>
          </label>
          <input id="draw-opacity" type="range" min="0.1" max="1" step="0.05" value="0.95" data-ctl="draw-opacity">
        </div>
      `,
    })}

    ${accordionMarkup({
      id: 'draw-summary',
      title: 'Сводка',
      open: true,
      body: `
        <div class="draw-stats" data-ctl="draw-stats">
          <div class="draw-stat">
            <span class="draw-stat-label">Метки</span>
            <span class="draw-stat-value" data-ctl="draw-stat-markers">0</span>
          </div>
          <div class="draw-stat">
            <span class="draw-stat-label">Длина пути</span>
            <span class="draw-stat-value" data-ctl="draw-stat-distance">—</span>
          </div>
          <div class="draw-stat">
            <span class="draw-stat-label">Объекты</span>
            <span class="draw-stat-value" data-ctl="draw-stat-features">0</span>
          </div>
        </div>
      `,
    })}

    <div class="panel-group draw-actions">
      <div class="draw-action-row">
        <button type="button" class="draw-action" data-ctl="draw-undo"   title="Отменить (Ctrl+Z)" aria-label="Отменить">${I.undo}<span>Отменить</span></button>
        <button type="button" class="draw-action" data-ctl="draw-redo"   title="Вернуть (Ctrl+Shift+Z)" aria-label="Вернуть">${I.redo}<span>Вернуть</span></button>
      </div>
      <div class="draw-action-row">
        <button type="button" class="draw-action" data-ctl="draw-delete" title="Удалить выбранный объект (Del)" aria-label="Удалить выбранный">${I.trash}<span>Удалить</span></button>
        <button type="button" class="draw-action draw-danger" data-ctl="draw-clear" title="Удалить все объекты" aria-label="Очистить всё">${I.broom}<span>Очистить всё</span></button>
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

  const refreshShapeHint = () => {
    const hint = $('[data-ctl="draw-shape-hint"]');
    if (!hint) return;
    const shapeOn = !$('[data-ctl="draw-shape-group"]')?.hidden;
    const eraserOn = !$('[data-ctl="draw-eraser-group"]')?.hidden;
    hint.hidden = shapeOn || eraserOn;
  };

  const refreshShapeGroup = (tool) => {
    const group = $('[data-ctl="draw-shape-group"]');
    if (group) group.hidden = tool !== 'shape';
    refreshShapeHint();
  };

  const refreshEraserGroup = (tool) => {
    const group = $('[data-ctl="draw-eraser-group"]');
    if (group) group.hidden = tool !== 'eraser';
    refreshShapeHint();
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

  // Eraser size slider — px radius for the eraser hit-test + cursor preview.
  const eraserSlider = $('[data-ctl="draw-eraser-size"]');
  const eraserReadout = $('[data-ctl="draw-eraser-size-readout"]');
  if (eraserSlider) {
    const apply = () => {
      const n = Number(eraserSlider.value) || 30;
      if (eraserReadout) eraserReadout.textContent = `${n} px`;
      engine.setPrefs({ eraserSize: n });
      updateSliderFill(eraserSlider);
    };
    eraserSlider.addEventListener('input', apply);
  }

  // -------------------------------------------------------------------
  // Connection mode
  // -------------------------------------------------------------------
  for (const btn of $$('[data-ctl="draw-connections"] [data-conn]')) {
    btn.addEventListener('click', () => engine.setConnectionMode(btn.dataset.conn));
  }

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

  const measure = $('[data-ctl="draw-measure"]');
  measure?.addEventListener('change', () => {
    engine.setPrefs({ measure: measure.checked });
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
    if (window.confirm('Очистить все нарисованные объекты? Это действие нельзя отменить после перезагрузки.')) {
      engine.clearAll();
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
  refreshEraserGroup(prefs.tool);
  if (geodesic) geodesic.checked = !!prefs.geodesic;
  if (labels) labels.checked = !!prefs.labels;
  if (measure) measure.checked = !!prefs.measure;
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
  if (eraserSlider) {
    const initEraser = prefs.eraserSize ?? 30;
    eraserSlider.value = String(initEraser);
    if (eraserReadout) eraserReadout.textContent = `${initEraser} px`;
    updateSliderFill(eraserSlider);
  }

  // -------------------------------------------------------------------
  // Live engine subscriptions
  // -------------------------------------------------------------------
  const offTool = engine.on('tool', (t) => {
    setRadioGroup('[data-ctl="draw-tools"] [data-tool]', t, 'tool');
    refreshShapeGroup(t);
    refreshEraserGroup(t);
  });
  const offShape = engine.on('shape', (s) => {
    setRadioGroup('[data-ctl="draw-shapes"] [data-shape]', s, 'shape');
    refreshShapeSidesVisibility();
  });
  const offConn = engine.on('connectionMode', (m) => {
    setRadioGroup('[data-ctl="draw-connections"] [data-conn]', m, 'conn');
  });

  // Selecting a feature loads ITS style into the controls so the user
  // edits what they picked; changing a swatch then recolours that
  // feature (engine.setPrefs → restyleSelected). Clearing the
  // selection restores the controls to the current authoring prefs.
  const syncStyleControls = (style) => {
    if (!style) return;
    if (color && style.color != null) color.value = style.color;
    if (fill && style.fill != null) fill.value = style.fill;
    if (weight && style.weight != null) {
      weight.value = String(style.weight);
      if (weightOut) weightOut.textContent = `${style.weight} px`;
      updateSliderFill(weight);
    }
    if (opacity && style.opacity != null) {
      opacity.value = String(style.opacity);
      if (opacityOut) opacityOut.textContent = `${Math.round(style.opacity * 100)} %`;
      updateSliderFill(opacity);
    }
  };
  const offSelection = engine.on('selection', ({ id }) => {
    syncStyleControls(id ? engine.getFeatureStyle(id) : engine.getPrefs());
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
    offSelection();
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
