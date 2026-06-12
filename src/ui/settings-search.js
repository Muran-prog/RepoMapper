/**
 * Settings search — fuzzy, multi-field matching across every parameter.
 *
 * Requirements addressed:
 *   • search by parameter NAME (short label)
 *   • search by DESCRIPTION text (the rich explanation copy)
 *   • search by KEYWORDS / synonyms / indirect phrasings
 *   • fuzzy / typo-tolerant matching via Levenshtein distance
 *
 * Design:
 *   The index is built from the live DOM (so it always matches what's
 *   rendered) cross-referenced with the PARAM_INFO registry (for the
 *   description + keyword corpus). Each indexed entry knows which panel
 *   it lives in and how to reveal + highlight itself, so a search hit can
 *   open the right panel and flash the control.
 *
 *   Scoring blends:
 *     – substring hits (highest, weighted by which field matched)
 *     – token prefix hits
 *     – Levenshtein-based fuzzy hits on individual tokens (typo tolerance)
 *
 * Public surface:
 *   buildSearchIndex(panelsHost)     → Entry[]
 *   searchSettings(index, query)     → ranked {entry, score}[]
 *   levenshtein(a, b)                → number   (exported for reuse/tests)
 *   mountSettingsSearch(opts)        → controller mounted into the dock
 */

import { getParamInfo } from './info-tip.js';

// ---------------------------------------------------------------------------
// Levenshtein edit distance — classic two-row dynamic-programming variant.
// O(n·m) time, O(min(n,m)) space. Case-insensitive callers should lowercase
// beforehand. Returns the minimum single-character edits (insert / delete /
// substitute) to turn `a` into `b`.
// ---------------------------------------------------------------------------

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Keep the shorter string as the inner loop to minimise the row width.
  if (a.length > b.length) {
    const t = a;
    a = b;
    b = t;
  }

  let prev = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    let prevDiag = prev[0];
    prev[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = prev[i];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[i] = Math.min(
        prev[i] + 1, // deletion
        prev[i - 1] + 1, // insertion
        prevDiag + cost, // substitution
      );
      prevDiag = tmp;
    }
  }
  return prev[a.length];
}

/** Normalised similarity in [0,1] derived from edit distance. */
function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

const norm = (s) => (s || '').toString().toLowerCase().trim();
const tokenize = (s) =>
  norm(s)
    .split(/[\s.,/()|×–—-]+/)
    .filter((t) => t.length > 1);

// ---------------------------------------------------------------------------
// Index building.
//
// We walk every `.panel[data-panel-id]` and collect labelled controls.
// A control is indexable when it carries a `data-ctl` and we can derive a
// human label (its row text). The PARAM_INFO registry contributes the
// description + keyword corpus when present.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SearchEntry
 * @property {string} id          control id (data-ctl)
 * @property {string} panelId     owning panel id
 * @property {string} label       short visible label
 * @property {string} description rich description (may be '')
 * @property {string[]} keywords  synonyms / indirect terms
 * @property {HTMLElement} row    the row element to reveal + flash
 */

export function buildSearchIndex(panelsHost) {
  /** @type {SearchEntry[]} */
  const entries = [];
  if (!panelsHost) return entries;

  const seen = new Set();
  // The docked shell renders sections as `.section[data-panel-id]`; the
  // older popover shell used `.panel[data-panel-id]`. Match both so the
  // index is populated regardless of which shell mounted the controls.
  const panels = panelsHost.querySelectorAll(
    '.section[data-panel-id], .panel[data-panel-id]',
  );

  panels.forEach((panel) => {
    const panelId = panel.dataset.panelId;
    const ctls = panel.querySelectorAll('[data-ctl]');
    ctls.forEach((ctl) => {
      const id = ctl.dataset.ctl;
      if (!id) return;
      // Skip pure structural / action controls that aren't "settings".
      if (['close-panel'].includes(id)) return;

      const row =
        ctl.closest('.row, .slider-row, .field, .preset-row, .panel-group') ||
        ctl.parentElement;
      if (!row) return;

      // De-dupe mirrored controls (same id in two panels) — keep the first.
      const key = `${panelId}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);

      const info = getParamInfo(id);
      // Visible label: prefer the registry title, else the row's text.
      const labelText =
        info?.title ||
        row.querySelector('.row-title, .preset-row-text strong, span:not(.dot):not(.row-ico):not(.preset-row-ico)')?.textContent?.trim() ||
        row.textContent?.trim() ||
        id;

      entries.push({
        id,
        panelId,
        label: labelText,
        description: info?.body || '',
        keywords: info?.keywords || [],
        row,
      });
    });
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Scoring.
//
// Field weights (higher = stronger signal):
//   label       1.00
//   keywords    0.85
//   description 0.55
//
// For each query token we take the best per-field signal, multiply by the
// field weight, and sum across tokens. A query only matches an entry if
// EVERY token finds at least a weak hit somewhere (AND semantics), which
// keeps multi-word queries precise.
// ---------------------------------------------------------------------------

const FUZZY_THRESHOLD = 0.72; // min token similarity to count as a fuzzy hit

function fieldScore(queryToken, fieldText, fieldTokens) {
  const n = norm(fieldText);
  if (!n) return 0;

  // Exact substring of the whole field — strongest.
  if (n.includes(queryToken)) {
    // Prefix bonus: matching the start of the field is more relevant.
    return n.startsWith(queryToken) ? 1 : 0.9;
  }

  let best = 0;
  for (const tok of fieldTokens) {
    if (tok.startsWith(queryToken) || queryToken.startsWith(tok)) {
      best = Math.max(best, 0.8);
      continue;
    }
    // Fuzzy: tolerate typos via normalised edit-distance similarity.
    const sim = similarity(queryToken, tok);
    if (sim >= FUZZY_THRESHOLD) {
      best = Math.max(best, 0.55 * sim);
    }
  }
  return best;
}

const WEIGHTS = { label: 1.0, keywords: 0.85, description: 0.55 };

function scoreEntry(entry, queryTokens) {
  const labelTokens = tokenize(entry.label);
  const kwText = entry.keywords.join(' ');
  const kwTokens = tokenize(kwText);
  const descTokens = tokenize(entry.description);

  let total = 0;
  for (const qt of queryTokens) {
    const sLabel = fieldScore(qt, entry.label, labelTokens) * WEIGHTS.label;
    const sKw = fieldScore(qt, kwText, kwTokens) * WEIGHTS.keywords;
    const sDesc = fieldScore(qt, entry.description, descTokens) * WEIGHTS.description;
    const best = Math.max(sLabel, sKw, sDesc);
    // AND semantics: a token that matches nothing disqualifies the entry.
    if (best <= 0) return 0;
    total += best;
  }
  return total;
}

/** Rank index entries against a query. Returns sorted {entry, score}[]. */
export function searchSettings(index, query) {
  const q = norm(query);
  if (!q) return [];
  const queryTokens = tokenize(q);
  if (!queryTokens.length) return [];

  const results = [];
  for (const entry of index) {
    const score = scoreEntry(entry, queryTokens);
    if (score > 0) results.push({ entry, score });
  }
  results.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
  return results;
}

// ---------------------------------------------------------------------------
// Mount — a search box + results list driven by the index.
//
// The controller is intentionally decoupled from the dock controller via
// an `onReveal(panelId, row)` callback: the caller decides how to open the
// owning panel and we just flash the row. This keeps the module testable
// without a live DockController.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host        container to render the search UI into
 * @param {HTMLElement} opts.panelsHost  root used to (re)build the index
 * @param {(panelId: string, row: HTMLElement) => void} opts.onReveal
 *        called when the user activates a result; should open the panel
 *        and scroll the row into view (this module then flashes it)
 * @returns {{ refresh: () => void, destroy: () => void }}
 */
export function mountSettingsSearch({ host, panelsHost, onReveal }) {
  if (!host) return { refresh() {}, destroy() {} };

  host.classList.add('settings-search');
  host.innerHTML = `
    <div class="settings-search-box">
      <svg class="settings-search-icon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.4"/>
        <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      <input type="search" class="settings-search-input"
             placeholder="Поиск настроек…"
             aria-label="Поиск по настройкам"
             autocomplete="off" spellcheck="false" />
      <button type="button" class="settings-search-clear" aria-label="Очистить" hidden>×</button>
    </div>
    <ul class="settings-search-results" role="listbox" aria-label="Результаты поиска"></ul>
    <p class="settings-search-empty" hidden>Ничего не найдено</p>
  `;

  const input = host.querySelector('.settings-search-input');
  const clearBtn = host.querySelector('.settings-search-clear');
  const list = host.querySelector('.settings-search-results');
  const empty = host.querySelector('.settings-search-empty');

  // Panel id → short human title for the result subtitle.
  const PANEL_TITLES = {
    layers: 'Слои',
    relief: 'Рельеф',
    hypso: 'Гипсометрия',
    places: 'Места',
    draw: 'Рисование',
    settings: 'Настройки',
  };

  let index = buildSearchIndex(panelsHost);
  let activeIndex = -1;
  let current = [];

  const render = (results) => {
    current = results;
    activeIndex = -1;
    list.innerHTML = '';
    const has = results.length > 0;
    empty.hidden = has || !input.value.trim();
    if (!has) return;

    results.slice(0, 24).forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'settings-search-item';
      li.setAttribute('role', 'option');
      li.dataset.idx = String(i);
      li.innerHTML = `
        <span class="ssi-main">${escapeHtml(r.entry.label)}</span>
        <span class="ssi-sub">${escapeHtml(PANEL_TITLES[r.entry.panelId] || r.entry.panelId)}</span>
        ${r.entry.description ? `<span class="ssi-desc">${escapeHtml(r.entry.description)}</span>` : ''}
      `;
      li.addEventListener('click', () => reveal(r.entry));
      list.appendChild(li);
    });
  };

  const reveal = (entry) => {
    onReveal?.(entry.panelId, entry.row);
    // Flash the row so the user sees exactly what matched.
    requestAnimationFrame(() => {
      try {
        entry.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch { /* ignore */ }
      entry.row.dataset.searchFlash = '1';
      setTimeout(() => { delete entry.row.dataset.searchFlash; }, 1600);
    });
  };

  const onInput = () => {
    const q = input.value;
    clearBtn.hidden = !q;
    if (!q.trim()) {
      render([]);
      empty.hidden = true;
      return;
    }
    render(searchSettings(index, q));
  };

  const setActive = (next) => {
    const items = [...list.querySelectorAll('.settings-search-item')];
    if (!items.length) return;
    activeIndex = (next + items.length) % items.length;
    items.forEach((el, i) => {
      const on = i === activeIndex;
      el.dataset.active = on ? '1' : '0';
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = current[activeIndex] || current[0];
      if (pick) reveal(pick.entry);
    } else if (e.key === 'Escape') {
      if (input.value) { input.value = ''; onInput(); }
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    onInput();
    input.focus();
  });

  return {
    refresh() { index = buildSearchIndex(panelsHost); onInput(); },
    destroy() { host.innerHTML = ''; },
  };
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
