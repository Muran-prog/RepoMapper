/**
 * Settlement-contours panel — the sidebar surface for the manual
 * settlement-contour engine (`src/draw/settlement-contours.js`).
 *
 * Responsibilities:
 *   • An "add contour" button that arms drawing mode (trace a settlement
 *     the automatic detection missed).
 *   • A live list of every saved contour with its info — name, point
 *     count, centre coordinate, and an expandable full vertex list.
 *   • Per-contour actions: edit (node-level), show/hide (without losing
 *     the data), rename, fly-to, delete.
 *   • Contextual help that explains the editing gestures while a contour
 *     is under edit.
 *
 * Pure rendering (`renderContourPanelBody`) is separated from wiring
 * (`mountContourPanel`) so the section shell can be assembled as a
 * static string by `controls.js` and hydrated afterwards, mirroring the
 * drawing panel's split.
 */

// Minimal inline icons — same 1.75-stroke Lucide vocabulary as the rest
// of the UI so the panel reads as a native peer.
const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ICONS = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.6 6.6A13.2 13.2 0 0 0 2 12s3.5 7 10 7a9.1 9.1 0 0 0 5.4-1.6"/><path d="M3 3l18 18"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  target: svg('<circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  marker: svg('<path d="M12 21s7-6.3 7-11a7 7 0 0 0-14 0c0 4.7 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>'),
};

/** Escape a string for safe interpolation into HTML attributes / text. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the panel body. Pure HTML — `controls.js` injects it into the
 * `data-panel-id="contours"` section shell.
 */
export function renderContourPanelBody() {
  return `
    <p class="sc-lede">Обведите вручную поселение, которое не определилось автоматически. Контур сохранится и будет выглядеть точно так же, как «Контуры поселений».</p>

    <div class="sc-actions">
      <button type="button" class="sc-add" data-ctl="sc-add">
        <span class="sc-add-ico">${ICONS.plus}</span>
        <span class="sc-add-text">Обвести поселение</span>
      </button>
    </div>

    <div class="sc-draw-hint" data-ctl="sc-draw-hint" hidden>
      ${ICONS.marker}
      <div>
        <strong>Режим обводки</strong>
        <span data-ctl="sc-draw-hint-text">Кликайте по карте, чтобы поставить точки контура. Двойной клик, Enter или клик по первой точке — завершить. Esc — отмена.</span>
      </div>
    </div>

    <div class="sc-edit-hint" data-ctl="sc-edit-hint" hidden>
      ${ICONS.edit}
      <div>
        <strong>Режим правки</strong>
        <span>Тяните узел, чтобы переместить. Клик по средней точке — добавить узел. Правый клик (или Alt+клик) по узлу — удалить. Esc — выйти.</span>
      </div>
    </div>

    <div class="sc-list" data-ctl="sc-list" role="list"></div>

    <p class="sc-empty" data-ctl="sc-empty">Пока нет ни одного контура. Нажмите «Обвести поселение», чтобы добавить первый.</p>
  `;
}

/**
 * Wire the panel body to the engine. Returns an unmount function.
 *
 * @param {object} opts
 * @param {object} opts.engine  Handle from `createSettlementContourEngine`.
 * @param {HTMLElement} opts.host  Element produced by `renderContourPanelBody`.
 */
export function mountContourPanel({ engine, host }) {
  if (!host || !engine) return () => {};

  const $ = (sel) => host.querySelector(sel);
  const addBtn = $('[data-ctl="sc-add"]');
  const listEl = $('[data-ctl="sc-list"]');
  const emptyEl = $('[data-ctl="sc-empty"]');
  const drawHint = $('[data-ctl="sc-draw-hint"]');
  const drawHintText = $('[data-ctl="sc-draw-hint-text"]');
  const editHint = $('[data-ctl="sc-edit-hint"]');

  // -------------------------------------------------------------------
  // Add / draw-mode button.
  // -------------------------------------------------------------------
  addBtn?.addEventListener('click', () => {
    const st = engine.getState();
    if (st.mode === 'draw') engine.cancelDrawing();
    else engine.startDrawing();
  });

  // -------------------------------------------------------------------
  // List rendering.
  // -------------------------------------------------------------------
  const renderRow = (c) => {
    const coordsList = c.coordinates
      .map((ll, i) => `<li>${i + 1}. ${esc(ll[1].toFixed(5))}, ${esc(ll[0].toFixed(5))}</li>`)
      .join('');
    return `
      <div class="sc-item${c.editing ? ' is-editing' : ''}${c.hidden ? ' is-hidden' : ''}" data-id="${esc(c.id)}" role="listitem">
        <div class="sc-item-head">
          <input class="sc-item-name" type="text" value="${esc(c.name)}" data-ctl="sc-name" aria-label="Название контура" maxlength="80">
          <div class="sc-item-tools">
            <button type="button" class="sc-icon-btn" data-ctl="sc-flyto" title="Перелететь к контуру" aria-label="Перелететь к контуру">${ICONS.target}</button>
            <button type="button" class="sc-icon-btn" data-ctl="sc-visibility" title="${c.hidden ? 'Показать' : 'Скрыть'}" aria-label="${c.hidden ? 'Показать контур' : 'Скрыть контур'}" aria-pressed="${c.hidden ? 'true' : 'false'}">${c.hidden ? ICONS.eyeOff : ICONS.eye}</button>
            <button type="button" class="sc-icon-btn${c.editing ? ' is-active' : ''}" data-ctl="sc-edit" title="${c.editing ? 'Завершить правку' : 'Редактировать узлы'}" aria-label="Редактировать узлы" aria-pressed="${c.editing ? 'true' : 'false'}">${c.editing ? ICONS.check : ICONS.edit}</button>
            <button type="button" class="sc-icon-btn sc-danger" data-ctl="sc-delete" title="Удалить контур" aria-label="Удалить контур">${ICONS.trash}</button>
          </div>
        </div>
        <div class="sc-item-meta">
          <span class="sc-chip">${c.pointCount} точек</span>
          <span class="sc-chip sc-chip-muted">центр: ${esc(c.centroidLabel)}</span>
          ${c.hidden ? '<span class="sc-chip sc-chip-warn">скрыт</span>' : ''}
        </div>
        <details class="sc-coords">
          <summary>Координаты узлов</summary>
          <ol class="sc-coords-list">${coordsList}</ol>
        </details>
      </div>
    `;
  };

  const renderList = () => {
    const contours = engine.getContours();
    if (!contours.length) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.hidden = false;
    } else {
      if (emptyEl) emptyEl.hidden = true;
      listEl.innerHTML = contours.map(renderRow).join('');
    }
  };

  // -------------------------------------------------------------------
  // Mode reflection (button label + contextual hints).
  // -------------------------------------------------------------------
  const reflectMode = () => {
    const st = engine.getState();
    const drawing = st.mode === 'draw';
    const editing = st.mode === 'edit';
    if (addBtn) {
      addBtn.classList.toggle('is-active', drawing);
      const text = addBtn.querySelector('.sc-add-text');
      if (text) text.textContent = drawing ? 'Отменить обводку' : 'Обвести поселение';
    }
    if (drawHint) drawHint.hidden = !drawing;
    if (editHint) editHint.hidden = !editing;
    if (drawing && drawHintText) {
      drawHintText.textContent =
        st.draftPoints > 0
          ? `Поставлено точек: ${st.draftPoints}. Двойной клик / Enter / клик по первой точке — завершить. Esc — отмена.`
          : 'Кликайте по карте, чтобы поставить точки контура. Двойной клик, Enter или клик по первой точке — завершить. Esc — отмена.';
    }
  };

  // -------------------------------------------------------------------
  // Delegated list interactions.
  // -------------------------------------------------------------------
  const itemId = (el) => el.closest('.sc-item')?.dataset.id;

  listEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ctl]');
    if (!btn) return;
    const id = itemId(btn);
    if (!id) return;
    switch (btn.dataset.ctl) {
      case 'sc-flyto':
        engine.flyTo(id);
        break;
      case 'sc-visibility':
        engine.toggleVisibility(id);
        break;
      case 'sc-edit': {
        const st = engine.getState();
        if (st.mode === 'edit' && st.editingId === id) engine.stopEditing();
        else engine.startEditing(id);
        break;
      }
      case 'sc-delete':
        if (window.confirm('Удалить этот контур? Действие нельзя отменить после перезагрузки.')) {
          engine.deleteContour(id);
        }
        break;
      default:
        break;
    }
  });

  // Rename — commit on change / Enter / blur.
  listEl?.addEventListener('change', (e) => {
    const input = e.target.closest('[data-ctl="sc-name"]');
    if (!input) return;
    const id = itemId(input);
    if (id) engine.renameContour(id, input.value);
  });
  listEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('[data-ctl="sc-name"]');
    if (!input) return;
    input.blur();
  });

  // -------------------------------------------------------------------
  // Engine subscriptions.
  // -------------------------------------------------------------------
  const offChange = engine.on('change', () => {
    renderList();
    reflectMode();
  });
  const offMode = engine.on('mode', reflectMode);
  const offCreated = engine.on('created', () => {
    // After committing a contour, immediately re-arm drawing so the user
    // can outline several settlements in a row without re-clicking the
    // button. Cancel (Esc / button) breaks the loop.
    engine.startDrawing();
  });
  const offVertexFloor = engine.on('vertexFloor', () => {
    window.alert('У контура должно остаться не меньше трёх точек.');
  });

  // Initial paint.
  renderList();
  reflectMode();

  return () => {
    offChange();
    offMode();
    offCreated();
    offVertexFloor();
  };
}
