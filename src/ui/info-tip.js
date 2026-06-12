/**
 * Per-parameter explanation system.
 *
 * The redesigned block UI keeps only short labels next to each control.
 * The *detailed* explanation for every parameter lives here, in a single
 * registry, and is surfaced on demand through a small info affordance:
 *
 *   • a compact "?" button injected next to each labelled control, and
 *   • a floating popover that opens on click (and on hover for
 *     hover-capable pointers) with a rich, plain-language description.
 *
 * Why a registry rather than inline `title=`/`data-tip`?
 *   – Native `title` is uncontrollable (delay, styling, no touch).
 *   – Centralising the copy lets the settings search index the SAME
 *     descriptions/keywords (see settings-search.js), so "search by
 *     description" and "show description" never drift apart.
 *
 * Public surface:
 *   PARAM_INFO                       the registry (id → {title, body, keywords})
 *   getParamInfo(id)                 lookup helper (safe, returns null)
 *   mountInfoTips(root, opts)        scan a subtree, inject "?" buttons,
 *                                    wire a single shared popover
 *
 * The popover is a singleton appended to <body>; only one is ever open.
 * It is keyboard-accessible (Esc closes, focus returns to trigger) and
 * positions itself with a viewport-collision clamp so it works on phones.
 */

// ---------------------------------------------------------------------------
// Registry — keyed by the control's `data-ctl` (or `data-info` override).
//
// `title`     short heading shown at the top of the popover
// `body`      one or more plain-language sentences (the real explanation)
// `keywords`  extra search terms (synonyms, indirect phrasings, EN/UK/RU)
//             consumed by settings-search.js for fuzzy matching
// ---------------------------------------------------------------------------

export const PARAM_INFO = Object.freeze({
  // ---- Layers ----------------------------------------------------------
  labels: {
    title: 'Подписи',
    body: 'Показывает текстовые названия объектов на карте: города, сёла, улицы, реки, вершины. Отключите, чтобы получить чистую карту без надписей.',
    keywords: ['названия', 'надписи', 'текст', 'toponyms', 'labels', 'имена', 'подписи объектов'],
  },
  pois: {
    title: 'Точки интереса',
    body: 'Значки объектов инфраструктуры: магазины, кафе, заправки, достопримечательности, остановки. Полезны для навигации, но могут перегружать карту на низких масштабах.',
    keywords: ['poi', 'значки', 'инфраструктура', 'магазины', 'достопримечательности', 'метки', 'places'],
  },
  b3d: {
    title: '3D-здания',
    body: 'Объёмная экструзия зданий при наклоне карты. Даёт ощущение городской застройки, но повышает нагрузку на GPU на слабых устройствах.',
    keywords: ['3d', 'здания', 'дома', 'экструзия', 'объём', 'застройка', 'buildings'],
  },
  roadsOrangeBold: {
    title: 'Жирные дороги',
    body: 'Усиленное оформление главных дорог: увеличенная толщина, заливка и обводка. Облегчает чтение дорожной сети. При выключении главные дороги вместе с подписями и щитами полностью исчезают с карты.',
    keywords: ['дороги', 'трассы', 'магистрали', 'roads', 'жирные', 'оранжевые', 'highway', 'шоссе'],
  },
  settlementOutline: {
    title: 'Обводка поселений',
    body: 'Жирная рамка вокруг сёл, посёлков и городов. Делает границы населённых пунктов заметными даже без приближения, как у выделенных дорог.',
    keywords: ['поселения', 'города', 'сёла', 'границы', 'обводка', 'рамка', 'settlements', 'outline'],
  },

  // ---- Relief ----------------------------------------------------------
  flatHypso: {
    title: 'Плоская гипсометрия',
    body: 'Быстрый пресет: показывает только цвет высот, без отмывки, уклонов и изолиний. Карта читается как плоская высотная схема. Включает гипсометрический тон и выключает отмывку, 3D и изолинии одним нажатием.',
    keywords: ['пресет', 'высоты', 'плоская', 'гипсо', 'flat', 'elevation', 'схема высот'],
  },
  hillshade: {
    title: 'Отмывка рельефа',
    body: 'Имитация теней от рельефа под виртуальным освещением. Делает горы, долины и склоны объёмными на плоской карте.',
    keywords: ['тени', 'отмывка', 'hillshade', 'рельеф', 'освещение', 'затенение', 'горы'],
  },
  terrain3D: {
    title: '3D-рельеф',
    body: 'Реальная объёмная деформация поверхности по данным высот при наклоне камеры. Горы физически выступают над картой. Заметно нагружает GPU.',
    keywords: ['3d', 'рельеф', 'terrain', 'объём', 'высоты', 'наклон', 'горы'],
  },
  contours: {
    title: 'Изолинии',
    body: 'Линии равной высоты (горизонтали) с подписями высот. Классический топографический способ показать крутизну и форму рельефа.',
    keywords: ['изолинии', 'горизонтали', 'contours', 'высоты', 'топография', 'линии высот'],
  },
  hypsometricTint: {
    title: 'Гипсометрический тон',
    body: 'Заливка карты цветом в зависимости от высоты: от низин к вершинам по выбранной палитре. Помогает мгновенно оценить рельеф региона.',
    keywords: ['гипсо', 'тон', 'цвет высот', 'палитра', 'hypsometric', 'окраска высот'],
  },
  bathymetry: {
    title: 'Батиметрия',
    body: 'Окраска глубин водоёмов: чем глубже, тем темнее синий. Аналог гипсометрии, но под водой.',
    keywords: ['глубины', 'батиметрия', 'bathymetry', 'вода', 'море', 'озёра'],
  },
  textureShading: {
    title: 'Текстурное затенение',
    body: 'Подчёркивает мелкие формы рельефа (овраги, гребни, русла) за счёт текстурного анализа. Делает поверхность детальнее отмывки.',
    keywords: ['текстура', 'затенение', 'texture', 'детали рельефа', 'мелкие формы'],
  },
  skyViewFactor: {
    title: 'Sky-View Factor',
    body: 'Показывает, какая часть неба «видна» из каждой точки. Затемняет узкие долины и ущелья, ярко подсвечивает открытые вершины и плато.',
    keywords: ['svf', 'небо', 'sky view', 'долины', 'ущелья', 'открытость'],
  },
  worldcoverTint: {
    title: 'Land cover',
    body: 'Растровый слой типов земного покрова (лес, поля, вода, застройка) по данным WorldCover. Раскрашивает поверхность по характеру ландшафта.',
    keywords: ['landcover', 'покров', 'worldcover', 'лес', 'поля', 'ландшафт', 'типы поверхности'],
  },
  canopyHeightTint: {
    title: 'Высота полога леса',
    body: 'Высота крон деревьев: тёмные участки — старые высокие еловые леса, светлые — молодые или низкорослые. Полезно для оценки зрелости лесов.',
    keywords: ['canopy', 'полог', 'высота леса', 'кроны', 'деревья', 'лес'],
  },
  forestLeafType: {
    title: 'Типы леса',
    body: 'Различает хвойный, лиственный и смешанный лес по данным OSM (leaf_type). Каждый тип получает свой оттенок зелёного.',
    keywords: ['лес', 'хвойный', 'лиственный', 'смешанный', 'leaf type', 'forest types', 'типы леса'],
  },
  forestCover: {
    title: 'Лесной покров',
    body: 'Сплошная зелёная подсветка всех лесных массивов страны, как в Google Earth. Переключает карту в плоский «лесной» режим: рельеф, 3D и тени скрываются ради чистого вида ландшафта.',
    keywords: ['лес', 'покров', 'forest cover', 'зелёный', 'массивы', 'google earth'],
  },
  forestCities: {
    title: 'Города — жирным',
    body: 'В лесном режиме выделяет города и посёлки жирным контрастным цветом, чтобы они читались на сплошном зелёном фоне.',
    keywords: ['города', 'лесной режим', 'выделение', 'поселения'],
  },
  forestWaterAccent: {
    title: 'Реки и водоёмы',
    body: 'В лесном режиме делает реки и водоёмы более ярким синим для контраста с зелёным фоном.',
    keywords: ['реки', 'вода', 'водоёмы', 'лесной режим', 'синий'],
  },
  forestRoadsBold: {
    title: 'Главные дороги — жирным',
    body: 'В лесном режиме добавляет жирную тёмную обводку магистралям и трассам, чтобы дорожная сеть не терялась на зелёном.',
    keywords: ['дороги', 'трассы', 'лесной режим', 'обводка', 'магистрали'],
  },
  forestRoadsOrange: {
    title: 'Дороги — выделенным',
    body: 'В лесном режиме окрашивает дороги ярким жирным цветом от магистралей к второстепенным для максимальной читаемости.',
    keywords: ['дороги', 'оранжевые', 'лесной режим', 'выделение'],
  },
  slopeWarning: {
    title: 'Крутые склоны',
    body: 'Подсвечивает участки с уклоном 35° и круче — потенциально лавиноопасные или непроходимые. Важно для горного туризма и планирования маршрутов.',
    keywords: ['склоны', 'уклон', 'крутизна', 'лавины', 'slope', 'опасность', '35'],
  },
  hazardousTerrain: {
    title: 'Опасные участки',
    body: 'Маркирует труднодоступные пики (≥1500 м), обрывы и опасные перевалы. Предупреждение для походов в высокогорье.',
    keywords: ['опасность', 'пики', 'обрывы', 'перевалы', 'hazard', 'высокогорье', 'риск'],
  },
  ridgeOverlay: {
    title: 'Хребты',
    body: 'Выделяет линии горных хребтов и водоразделов. Помогает понять орографию региона и направление гряд.',
    keywords: ['хребты', 'гребни', 'водоразделы', 'ridge', 'орография', 'гряды'],
  },
  carpathian: {
    title: 'Карпатская детализация',
    body: 'Включает высокодетальный набор слоёв для Карпат: тропы, приюты, вершины, специализированная стилизация. Имеет смысл при просмотре горного региона.',
    keywords: ['карпаты', 'детализация', 'горы', 'carpathian', 'тропы', 'регион'],
  },
  carpathianTrails: {
    title: 'Горные тропы',
    body: 'Жирные красные линии маркированных горных троп, виа-феррат и ступеней. Видны только при включённой карпатской детализации.',
    keywords: ['тропы', 'маршруты', 'via ferrata', 'походы', 'trails', 'красные линии'],
  },
  exaggeration: {
    title: 'Вертикальное преувеличение',
    body: 'Множитель высоты рельефа от 0.5× до 2×. Значения выше единицы делают горы выразительнее, ниже — сглаживают рельеф. Влияет на 3D и отмывку.',
    keywords: ['преувеличение', 'высота', 'множитель', 'exaggeration', '3d', 'рельеф'],
  },

  // ---- Settings --------------------------------------------------------
  quality: {
    title: 'Качество отрисовки',
    body: '«Авто» подбирает баланс качества и плавности по памяти, процессору и соединению устройства. «Высокое» включает всё оформление, «Эконом» — облегчённый режим для слабых устройств.',
    keywords: ['качество', 'производительность', 'fps', 'auto', 'quality', 'эконом', 'высокое'],
  },
  'theme-toggle': {
    title: 'Тема оформления',
    body: 'Переключает светлую и тёмную тему интерфейса. Палитра монохромная и адаптируется автоматически.',
    keywords: ['тема', 'светлая', 'тёмная', 'theme', 'dark', 'light', 'оформление'],
  },
});

/** Safe lookup. Returns the info object for an id, or null. */
export function getParamInfo(id) {
  if (!id) return null;
  return PARAM_INFO[id] || null;
}

// ---------------------------------------------------------------------------
// Shared popover singleton.
// ---------------------------------------------------------------------------

let popoverEl = null;
let activeTrigger = null;

function ensurePopover() {
  if (popoverEl) return popoverEl;
  popoverEl = document.createElement('div');
  popoverEl.className = 'info-pop';
  popoverEl.setAttribute('role', 'tooltip');
  popoverEl.dataset.open = 'false';
  popoverEl.innerHTML = `
    <div class="info-pop-arrow" aria-hidden="true"></div>
    <h5 class="info-pop-title"></h5>
    <p class="info-pop-body"></p>
  `;
  document.body.appendChild(popoverEl);

  // Dismissal wiring (installed once).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popoverEl.dataset.open === 'true') {
      e.stopPropagation();
      hidePopover({ restoreFocus: true });
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (popoverEl.dataset.open !== 'true') return;
    if (popoverEl.contains(e.target)) return;
    if (activeTrigger && activeTrigger.contains(e.target)) return;
    hidePopover();
  }, true);
  window.addEventListener('resize', () => hidePopover(), { passive: true });

  return popoverEl;
}

function hidePopover({ restoreFocus = false } = {}) {
  if (!popoverEl) return;
  popoverEl.dataset.open = 'false';
  if (restoreFocus && activeTrigger) {
    try { activeTrigger.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  activeTrigger = null;
}

function showPopover(trigger, info) {
  const pop = ensurePopover();
  pop.querySelector('.info-pop-title').textContent = info.title || '';
  pop.querySelector('.info-pop-body').textContent = info.body || '';
  activeTrigger = trigger;
  pop.dataset.open = 'true';

  // Position after a frame so the popover has measurable dimensions.
  requestAnimationFrame(() => position(pop, trigger));
}

/**
 * Place the popover next to its trigger with a viewport-collision clamp.
 * Prefers above the trigger; flips below if there isn't room. Always
 * clamps horizontally so it never overflows on narrow phones.
 */
function position(pop, trigger) {
  const margin = 8;
  const tr = trigger.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Vertical: prefer above, else below.
  let placeBelow = tr.top - pr.height - margin < margin;
  let top = placeBelow ? tr.bottom + margin : tr.top - pr.height - margin;

  // Horizontal: centre on the trigger, then clamp into the viewport.
  let left = tr.left + tr.width / 2 - pr.width / 2;
  left = Math.max(margin, Math.min(left, vw - pr.width - margin));
  top = Math.max(margin, Math.min(top, vh - pr.height - margin));

  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  pop.dataset.placement = placeBelow ? 'below' : 'above';

  // Arrow points at the trigger centre, clamped to the popover body.
  const arrowX = tr.left + tr.width / 2 - left;
  const arrow = pop.querySelector('.info-pop-arrow');
  if (arrow) {
    arrow.style.left = `${Math.max(12, Math.min(arrowX, pr.width - 12))}px`;
  }
}

const INFO_GLYPH =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<rect x="1" y="1" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
  '<line x1="8" y1="6.6" x2="8" y2="11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
  '<circle cx="8" cy="4.3" r="0.95" fill="currentColor"/></svg>';

/**
 * Scan `root` for controls that have a registered explanation and inject
 * a "?" info button next to each. Wires the shared popover.
 *
 * A control opts in by carrying `data-ctl="<id>"` (or an explicit
 * `data-info="<id>"`). The button is injected into the closest `.row`,
 * `.slider-row`, `.field`, or `.panel-group-title`'s row so it sits
 * beside the short label.
 *
 * Idempotent: controls already augmented (marked `data-info-wired`) are
 * skipped, so it's safe to call after each panel re-render.
 *
 * @param {HTMLElement} root
 * @param {object} [opts]
 * @param {boolean} [opts.hover=true]  open on hover for fine pointers too
 */
export function mountInfoTips(root, { hover = true } = {}) {
  if (!root) return;
  ensurePopover();

  const controls = root.querySelectorAll('[data-ctl], [data-info]');
  controls.forEach((ctl) => {
    const id = ctl.dataset.info || ctl.dataset.ctl;
    const info = getParamInfo(id);
    if (!info) return;

    // Anchor: the labelled container holding this control.
    const host =
      ctl.closest('.row, .slider-row, .field, .preset-row') ||
      ctl.parentElement;
    if (!host || host.dataset.infoWired === '1') return;
    host.dataset.infoWired = '1';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'info-btn';
    btn.setAttribute('aria-label', `Подробнее: ${info.title}`);
    btn.setAttribute('title', '');
    btn.dataset.infoId = id;
    btn.innerHTML = INFO_GLYPH;

    // Insert the info button just before the control (so the toggle/knob
    // stays at the far edge) or at the end of a label-only row.
    if (ctl.tagName === 'INPUT' || ctl.tagName === 'SELECT') {
      host.insertBefore(btn, ctl);
    } else {
      host.appendChild(btn);
    }

    const toggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (activeTrigger === btn && popoverEl.dataset.open === 'true') {
        hidePopover({ restoreFocus: true });
      } else {
        showPopover(btn, info);
      }
    };
    btn.addEventListener('click', toggle);

    if (hover && window.matchMedia('(hover: hover)').matches) {
      let hoverTimer = null;
      btn.addEventListener('pointerenter', () => {
        if (popoverEl.dataset.open === 'true' && activeTrigger !== btn) return;
        hoverTimer = setTimeout(() => showPopover(btn, info), 220);
      });
      btn.addEventListener('pointerleave', () => {
        clearTimeout(hoverTimer);
      });
    }
  });
}
