/**
 * Accordion / disclosure primitive for the block UI.
 *
 * The redesigned panels favour an explicit block architecture: grouped,
 * collapsible categories with a header, a chevron arrow, a connecting
 * rule, and a body that can itself nest further accordions. Rather than
 * hand-roll `aria-expanded` wiring at every call site (as the legacy
 * forest-markup sub-panel did), every collapsible group is produced by
 * `accordionMarkup()` and activated by a single delegated controller
 * installed once per panels root.
 *
 * Markup contract (produced by accordionMarkup, consumed by the CSS in
 * styles/accordion.css):
 *
 *   <section class="acc" data-acc data-open="true|false">
 *     <button class="acc-head" aria-expanded="..." aria-controls="...">
 *       <svg class="acc-chevron">…</svg>
 *       <span class="acc-title">…</span>
 *       <span class="acc-meta">…</span>      (optional count / hint)
 *     </button>
 *     <div class="acc-body" id="..." role="region">…children…</div>
 *   </section>
 *
 * Persistence: open/closed state is saved per accordion id under a single
 * localStorage blob so a user's layout survives reloads. IDs must be
 * stable + unique within the document.
 */

import { kv } from '../state/account-store.js';

const STORE_KEY = 'cart:ui:accordion:v1';

// Persisted through the account store (server-synced, in-memory) rather than
// localStorage — see src/state/account-store.js.
function loadState() {
  try {
    return JSON.parse(kv.getItem(STORE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    kv.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

const CHEVRON =
  '<svg class="acc-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M5 6 L8 9.5 L11 6" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Produce the HTML for one collapsible category.
 *
 * @param {object} opts
 * @param {string} opts.id            stable unique id (used for aria + persistence)
 * @param {string} opts.title         short category heading
 * @param {string} opts.body          inner HTML (rows, nested accordions, …)
 * @param {string} [opts.meta]        optional small right-aligned hint/count
 * @param {boolean} [opts.open=true]  default open state (overridden by saved pref)
 * @param {number} [opts.level=0]     nesting depth (drives the indent rail)
 * @returns {string}
 */
export function accordionMarkup({ id, title, body, meta = '', open = true, level = 0 }) {
  const saved = loadState();
  const isOpen = id in saved ? !!saved[id] : open;
  const bodyId = `acc-body-${id}`;
  return `
    <section class="acc" data-acc data-acc-id="${escapeHtml(id)}" data-open="${isOpen}" data-level="${level}">
      <button type="button" class="acc-head" aria-expanded="${isOpen}" aria-controls="${bodyId}">
        ${CHEVRON}
        <span class="acc-title">${escapeHtml(title)}</span>
        ${meta ? `<span class="acc-meta">${escapeHtml(meta)}</span>` : ''}
      </button>
      <div class="acc-body" id="${bodyId}" role="region" aria-label="${escapeHtml(title)}">
        <div class="acc-body-inner">
          ${body}
        </div>
      </div>
    </section>
  `;
}

/**
 * Install one delegated click handler on `root` that toggles any
 * `.acc-head` inside it. Idempotent per root (guards via a dataset flag).
 *
 * @param {HTMLElement} root
 */
export function installAccordions(root) {
  if (!root || root.dataset.accWired === '1') return;
  root.dataset.accWired = '1';

  root.addEventListener('click', (e) => {
    const head = e.target.closest('.acc-head');
    if (!head || !root.contains(head)) return;
    const section = head.closest('[data-acc]');
    if (!section) return;

    const next = section.dataset.open !== 'true';
    section.dataset.open = next ? 'true' : 'false';
    head.setAttribute('aria-expanded', next ? 'true' : 'false');

    const id = section.dataset.accId;
    if (id) {
      const state = loadState();
      state[id] = next;
      saveState(state);
    }
  });
}

/** Programmatically open an accordion (and its ancestors) by id. Used by
 *  the settings search so revealing a control unfolds its category. */
export function openAccordion(root, id) {
  if (!root || !id) return;
  const section = root.querySelector(`[data-acc-id="${CSS.escape(id)}"]`);
  if (!section) return;
  // Walk up, opening every ancestor accordion so the target is visible.
  let node = section;
  while (node) {
    if (node.matches?.('[data-acc]')) {
      node.dataset.open = 'true';
      const head = node.querySelector(':scope > .acc-head');
      head?.setAttribute('aria-expanded', 'true');
      const aid = node.dataset.accId;
      if (aid) {
        const state = loadState();
        state[aid] = true;
        saveState(state);
      }
    }
    node = node.parentElement?.closest('[data-acc]');
  }
}

/** Reveal the accordion that contains a given row element. */
export function revealRow(root, rowEl) {
  if (!root || !rowEl) return;
  let node = rowEl.closest('[data-acc]');
  while (node) {
    node.dataset.open = 'true';
    node.querySelector(':scope > .acc-head')?.setAttribute('aria-expanded', 'true');
    const aid = node.dataset.accId;
    if (aid) {
      const state = loadState();
      state[aid] = true;
      saveState(state);
    }
    node = node.parentElement?.closest('[data-acc]');
  }
}
