/**
 * Data / account panel — the "Данные" sidebar section.
 *
 *   1. Account info  (who you are) + logout + change password
 *   2. Sync status indicator
 *   3. Export / Import all data
 *
 * Everything is tied to the logged-in account; there is no IP or device
 * binding anywhere.
 */

import {
  loadFromServer,
  exportAllData,
  importFromFile,
  onSyncEvent,
  getCurrentUser,
  logout,
  changePassword,
} from '../api/client.js';
import { applyRemote } from '../state/account-store.js';

// ---------------------------------------------------------------------------
// Icons (Lucide-style)
// ---------------------------------------------------------------------------

const ICONS = {
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  cloud: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  logout: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
  key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
};

// ---------------------------------------------------------------------------
// Panel body renderer
// ---------------------------------------------------------------------------

export function renderDataPanelBody() {
  return `
    <div class="data-panel" id="data-panel">
      <!-- Account -->
      <div class="data-account" id="data-account">
        <div class="data-account-id">
          <span class="data-account-avatar">${ICONS.user}</span>
          <div class="data-account-meta">
            <span class="data-account-label">Вы вошли как</span>
            <strong class="data-account-name" id="data-account-name">—</strong>
          </div>
        </div>
        <div class="data-btn-row">
          <button class="data-btn data-btn-ghost" id="data-logout-btn">
            ${ICONS.logout} Выйти
          </button>
          <button class="data-btn data-btn-ghost" id="data-pw-btn">
            ${ICONS.key} Сменить пароль
          </button>
        </div>
        <form class="data-pw-form" id="data-pw-form" hidden>
          <input type="password" id="data-pw-current" class="data-input"
                 placeholder="Текущий пароль" autocomplete="current-password" />
          <input type="password" id="data-pw-new" class="data-input"
                 placeholder="Новый пароль (мин. 8)" autocomplete="new-password" />
          <input type="password" id="data-pw-confirm" class="data-input"
                 placeholder="Повторите новый пароль" autocomplete="new-password" />
          <div class="data-btn-row">
            <button type="submit" class="data-btn" id="data-pw-save">Сохранить</button>
            <button type="button" class="data-btn data-btn-ghost" id="data-pw-cancel">Отмена</button>
          </div>
          <div class="data-status" id="data-pw-status"></div>
        </form>
      </div>

      <!-- Sync status bar -->
      <div class="data-sync-bar" id="data-sync-bar">
        <span class="data-sync-icon">${ICONS.cloud}</span>
        <span class="data-sync-text" id="data-sync-text">Подключение…</span>
        <button class="data-btn-icon" id="data-sync-refresh" title="Обновить данные">
          ${ICONS.refresh}
        </button>
      </div>

      <!-- Export / Import -->
      <details class="data-section" open>
        <summary class="data-section-title">
          ${ICONS.download} Экспорт / Импорт
        </summary>
        <div class="data-section-body">
          <p class="data-hint">
            Экспортируйте все данные (метки, настройки, контуры, рисунки) в файл
            JSON для резервной копии или импортируйте ранее сохранённый файл.
          </p>
          <div class="data-btn-row">
            <button class="data-btn" id="data-export-btn">
              ${ICONS.download} Экспорт всех данных
            </button>
            <button class="data-btn" id="data-import-btn">
              ${ICONS.upload} Импорт данных
            </button>
          </div>
          <div class="data-import-options" id="data-import-options" style="display:none">
            <label class="data-radio">
              <input type="radio" name="import-mode" value="replace" checked />
              Полная замена (удалить текущие данные)
            </label>
            <label class="data-radio">
              <input type="radio" name="import-mode" value="merge" />
              Объединить с текущими данными
            </label>
            <input type="file" id="data-import-file" accept=".json" style="display:none" />
          </div>
          <div class="data-status" id="data-export-status"></div>
        </div>
      </details>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Panel mount (event wiring)
//
// The account store (src/state/account-store.js) owns all persistence: it
// hydrates the whole account at boot and pushes every change to the server.
// This panel only drives the account UI (login info, password, export/import)
// and the *visible* refresh paths — re-applying authoritative server data to
// the live engines via `applyRemote()` on manual refresh, tab-focus refresh,
// or after an import. There is no local-state collection or echo guard here.
// ---------------------------------------------------------------------------

export function mountDataPanel(host, drawEngine, contourEngine) {
  if (!host) return;

  const syncBar = host.querySelector('#data-sync-bar');
  const syncText = host.querySelector('#data-sync-text');
  const accountName = host.querySelector('#data-account-name');
  const exportBtn = host.querySelector('#data-export-btn');
  const importBtn = host.querySelector('#data-import-btn');
  const importOptions = host.querySelector('#data-import-options');
  const importFile = host.querySelector('#data-import-file');
  const exportStatus = host.querySelector('#data-export-status');
  const refreshBtn = host.querySelector('#data-sync-refresh');
  const logoutBtn = host.querySelector('#data-logout-btn');
  const pwBtn = host.querySelector('#data-pw-btn');
  const pwForm = host.querySelector('#data-pw-form');
  const pwCancel = host.querySelector('#data-pw-cancel');
  const pwStatus = host.querySelector('#data-pw-status');

  // ---- Account info ----
  function refreshAccount() {
    const u = getCurrentUser();
    if (accountName) accountName.textContent = u?.displayName || u?.username || '—';
  }
  refreshAccount();

  // ---- Sync status ----
  function updateSyncUI(state, message) {
    if (!syncBar) return;
    syncBar.className = `data-sync-bar data-sync-${state}`;
    const text = message || {
      syncing: 'Синхронизация…',
      done: 'Данные синхронизированы',
      error: 'Ошибка синхронизации',
      offline: 'Офлайн — изменения отправятся позже',
    }[state] || 'Подключение…';
    if (syncText) syncText.textContent = text;
  }

  onSyncEvent((event, data) => {
    switch (event) {
      case 'sync:start': updateSyncUI('syncing'); break;
      case 'sync:done': updateSyncUI('done'); refreshAccount(); break;
      case 'sync:error':
        // A "too large" rejection is not a transient error — tell the user
        // exactly what didn't save so they can trim it, rather than leaving
        // them thinking everything synced.
        updateSyncUI('error', data?.tooLarge ? tooLargeMessage(data.rejected) : undefined);
        break;
      case 'sync:offline': updateSyncUI('offline'); break;
      case 'sync:refresh':
        updateSyncUI('done');
        if (data?.data) applyRemote(data, { drawEngine, contourEngine });
        break;
    }
  });

  // ---- Logout ----
  logoutBtn?.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    await logout(false);
    window.location.reload();
  });

  // ---- Change password ----
  pwBtn?.addEventListener('click', () => {
    pwForm.hidden = !pwForm.hidden;
    if (!pwForm.hidden) host.querySelector('#data-pw-current')?.focus();
  });
  pwCancel?.addEventListener('click', () => { pwForm.hidden = true; showStatus(pwStatus, '', 'info'); });
  pwForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = host.querySelector('#data-pw-current').value;
    const nw = host.querySelector('#data-pw-new').value;
    const cf = host.querySelector('#data-pw-confirm').value;
    if (nw.length < 8) return showStatus(pwStatus, 'Новый пароль — минимум 8 символов.', 'error');
    if (nw !== cf) return showStatus(pwStatus, 'Пароли не совпадают.', 'error');
    showStatus(pwStatus, 'Сохраняем…', 'info');
    const res = await changePassword(cur, nw);
    if (res.ok) {
      showStatus(pwStatus, 'Пароль изменён.', 'success');
      pwForm.reset();
      setTimeout(() => { pwForm.hidden = true; }, 1500);
    } else {
      showStatus(pwStatus, res.error || 'Не удалось изменить пароль.', 'error');
    }
  });

  // ---- Export ----
  exportBtn?.addEventListener('click', async () => {
    exportBtn.disabled = true;
    showStatus(exportStatus, 'Экспортируем…', 'info');
    const ok = await exportAllData();
    exportBtn.disabled = false;
    showStatus(exportStatus, ok ? 'Экспорт завершён!' : 'Ошибка экспорта', ok ? 'success' : 'error');
  });

  // ---- Import ----
  importBtn?.addEventListener('click', () => {
    importOptions.style.display = importOptions.style.display === 'none' ? 'block' : 'none';
    if (importOptions.style.display === 'block') importFile.click();
  });

  importFile?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const mode = host.querySelector('input[name="import-mode"]:checked')?.value || 'replace';
    showStatus(exportStatus, 'Импортируем…', 'info');
    try {
      const result = await importFromFile(file, mode);
      if (result?.ok) {
        showStatus(exportStatus, 'Импорт завершён! Обновляем данные…', 'success');
        const fresh = await loadFromServer();
        if (fresh) applyRemote(fresh, { drawEngine, contourEngine });
        showStatus(exportStatus, 'Все данные восстановлены!', 'success');
      } else {
        showStatus(exportStatus, `Ошибка импорта: ${result?.error || 'неизвестная ошибка'}`, 'error');
      }
    } catch (err) {
      showStatus(exportStatus, `Ошибка: ${err.message}`, 'error');
    }
    importFile.value = '';
  });

  // ---- Manual refresh ----
  refreshBtn?.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    updateSyncUI('syncing');
    const data = await loadFromServer();
    refreshBtn.disabled = false;
    if (data) { applyRemote(data, { drawEngine, contourEngine }); updateSyncUI('done'); }
    else updateSyncUI('error');
  });

  // Initial load already happened at boot (initAccountState), and the engines
  // hydrated their features / contours from the account store as they were
  // constructed — so there is nothing to pull here.

  return { updateSyncUI, refreshAccount };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIELD_LABELS = {
  features: 'метки и рисунки',
  contours: 'контуры',
  settings: 'настройки',
  prefs: 'настройки рисования',
};

/** Build a human message for a server "payload too large" rejection. */
function tooLargeMessage(rejected) {
  if (!rejected || !rejected.length) {
    // Whole-request 413 — no per-field breakdown available.
    return 'Не сохранено: слишком большой объём данных. Удалите часть меток или контуров.';
  }
  const parts = rejected.map((r) => {
    const mb = (Number(r.bytes) / (1024 * 1024)).toFixed(1);
    const limitMb = Math.round(Number(r.limit) / (1024 * 1024));
    return `${FIELD_LABELS[r.field] || r.field} — ${mb} МБ (лимит ${limitMb} МБ)`;
  });
  return `Не сохранено: слишком много данных: ${parts.join(', ')}. Удалите часть, чтобы сохранить.`;
}

function showStatus(el, text, type) {
  if (!el) return;
  el.textContent = text;
  el.className = `data-status data-status-${type}`;
  if (type === 'success') {
    setTimeout(() => { el.textContent = ''; el.className = 'data-status'; }, 5000);
  }
}
