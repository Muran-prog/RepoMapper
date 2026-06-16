/**
 * Data management panel — unified hub for:
 *   1. Export / Import all data
 *   2. IP access control (sharing)
 *   3. Draw settings (relocated from the draw panel footer)
 *   4. Sync status indicator
 *
 * Mounts into the dock panel system alongside the existing panels.
 */

import {
  loadFromServer,
  saveToServer,
  exportAllData,
  importFromFile,
  importAllData,
  getMyIP,
  getAccess,
  addSharedIP,
  removeSharedIP,
  onSyncEvent,
  debouncedSave,
} from '../api/client.js';

import { loadPrefs as loadDrawPrefs } from '../draw/store.js';
import { loadUiPrefs } from './store.js';

// ---------------------------------------------------------------------------
// Icons (Lucide-style)
// ---------------------------------------------------------------------------

const ICONS = {
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  cloud: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
};

// ---------------------------------------------------------------------------
// Panel body renderer
// ---------------------------------------------------------------------------

export function renderDataPanelBody() {
  return `
    <div class="data-panel" id="data-panel">
      <!-- Sync status bar -->
      <div class="data-sync-bar" id="data-sync-bar">
        <span class="data-sync-icon">${ICONS.cloud}</span>
        <span class="data-sync-text" id="data-sync-text">Подключение...</span>
        <button class="data-btn-icon" id="data-sync-refresh" title="Обновить данные">
          ${ICONS.refresh}
        </button>
      </div>

      <!-- IP Info -->
      <div class="data-ip-box" id="data-ip-box">
        <span class="data-ip-label">Ваш IP:</span>
        <code class="data-ip-value" id="data-my-ip">—</code>
      </div>

      <!-- Section: Export / Import -->
      <details class="data-section" open>
        <summary class="data-section-title">
          ${ICONS.download} Экспорт / Импорт
        </summary>
        <div class="data-section-body">
          <p class="data-hint">
            Экспортируйте все данные (метки, настройки, контуры) в файл JSON
            или импортируйте ранее сохранённый файл для полного восстановления.
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

      <!-- Section: Access Control -->
      <details class="data-section">
        <summary class="data-section-title">
          ${ICONS.share} Управление доступом
        </summary>
        <div class="data-section-body">
          <p class="data-hint">
            Добавьте IP-адреса для совместного доступа к вашим меткам.
            Данные будут автоматически синхронизироваться между всеми
            добавленными устройствами.
          </p>
          <div class="data-add-ip">
            <input type="text" id="data-ip-input"
              placeholder="Введите IP-адрес..."
              class="data-input" />
            <button class="data-btn-icon data-btn-add" id="data-add-ip-btn"
              title="Добавить IP">
              ${ICONS.plus}
            </button>
          </div>
          <ul class="data-ip-list" id="data-ip-list">
            <li class="data-ip-empty">Нет подключённых IP-адресов</li>
          </ul>
        </div>
      </details>

      <!-- Section: Draw settings (relocated) -->
      <details class="data-section">
        <summary class="data-section-title">
          ${ICONS.settings} Настройки рисования
        </summary>
        <div class="data-section-body" id="data-draw-settings">
          <p class="data-hint">
            Настройки инструментов рисования. Изменения применяются сразу
            и автоматически сохраняются на сервере.
          </p>
          <!-- Draw settings will be populated by mountDataPanel -->
        </div>
      </details>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Panel mount (event wiring)
// ---------------------------------------------------------------------------

export function mountDataPanel(host, drawEngine) {
  if (!host) return;

  const syncBar = host.querySelector('#data-sync-bar');
  const syncText = host.querySelector('#data-sync-text');
  const myIPEl = host.querySelector('#data-my-ip');
  const exportBtn = host.querySelector('#data-export-btn');
  const importBtn = host.querySelector('#data-import-btn');
  const importOptions = host.querySelector('#data-import-options');
  const importFile = host.querySelector('#data-import-file');
  const exportStatus = host.querySelector('#data-export-status');
  const addIPBtn = host.querySelector('#data-add-ip-btn');
  const ipInput = host.querySelector('#data-ip-input');
  const ipList = host.querySelector('#data-ip-list');
  const refreshBtn = host.querySelector('#data-sync-refresh');

  // ---- Sync status ----
  let syncState = 'idle';

  function updateSyncUI(state, detail) {
    syncState = state;
    const bar = syncBar;
    if (!bar) return;

    bar.className = `data-sync-bar data-sync-${state}`;
    switch (state) {
      case 'syncing':
        syncText.textContent = 'Синхронизация...';
        break;
      case 'done':
        syncText.textContent = 'Данные синхронизированы';
        break;
      case 'error':
        syncText.textContent = 'Ошибка синхронизации';
        break;
      case 'offline':
        syncText.textContent = 'Офлайн — изменения будут отправлены позже';
        break;
      default:
        syncText.textContent = 'Подключение...';
    }
  }

  onSyncEvent((event, data) => {
    switch (event) {
      case 'sync:start':
        updateSyncUI('syncing');
        break;
      case 'sync:done':
        updateSyncUI('done');
        break;
      case 'sync:error':
        updateSyncUI('error', data);
        break;
      case 'sync:refresh':
        updateSyncUI('done');
        // Apply refreshed data to the draw engine
        if (data?.data?.features?.features && drawEngine) {
          applyServerData(data, drawEngine);
        }
        break;
    }
  });

  // ---- Load IP ----
  getMyIP().then((ip) => {
    if (myIPEl && ip) myIPEl.textContent = ip;
  });

  // ---- Export ----
  exportBtn?.addEventListener('click', async () => {
    exportBtn.disabled = true;
    showStatus(exportStatus, 'Экспортируем...', 'info');
    const ok = await exportAllData();
    exportBtn.disabled = false;
    showStatus(
      exportStatus,
      ok ? 'Экспорт завершён!' : 'Ошибка экспорта',
      ok ? 'success' : 'error',
    );
  });

  // ---- Import ----
  importBtn?.addEventListener('click', () => {
    importOptions.style.display =
      importOptions.style.display === 'none' ? 'block' : 'none';
    if (importOptions.style.display === 'block') {
      importFile.click();
    }
  });

  importFile?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const mode =
      host.querySelector('input[name="import-mode"]:checked')?.value || 'replace';

    showStatus(exportStatus, 'Импортируем...', 'info');
    try {
      const result = await importFromFile(file, mode);
      if (result?.ok) {
        showStatus(exportStatus, 'Импорт завершён! Обновляем данные...', 'success');
        // Reload data from server and apply
        const fresh = await loadFromServer();
        if (fresh && drawEngine) {
          applyServerData(fresh, drawEngine);
        }
        showStatus(exportStatus, 'Все данные восстановлены!', 'success');
      } else {
        showStatus(
          exportStatus,
          `Ошибка импорта: ${result?.error || 'неизвестная ошибка'}`,
          'error',
        );
      }
    } catch (err) {
      showStatus(exportStatus, `Ошибка: ${err.message}`, 'error');
    }
    // Reset file input
    importFile.value = '';
  });

  // ---- Access control ----
  loadAccessList();

  addIPBtn?.addEventListener('click', () => addIP());
  ipInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addIP();
  });

  async function addIP() {
    const ip = ipInput?.value.trim();
    if (!ip) return;

    addIPBtn.disabled = true;
    const result = await addSharedIP(ip);
    addIPBtn.disabled = false;

    if (result?.ok) {
      ipInput.value = '';
      loadAccessList();
    } else {
      showStatus(exportStatus, `Ошибка: ${result?.error || 'не удалось добавить IP'}`, 'error');
    }
  }

  async function loadAccessList() {
    const result = await getAccess();
    if (!result?.ok) return;

    const ips = result.access?.sharedWith || [];
    if (!ipList) return;

    if (ips.length === 0) {
      ipList.innerHTML = '<li class="data-ip-empty">Нет подключённых IP-адресов</li>';
      return;
    }

    ipList.innerHTML = ips
      .map(
        (ip) => `
        <li class="data-ip-item">
          <code>${ip}</code>
          <button class="data-btn-icon data-btn-remove" data-ip="${ip}" title="Удалить">
            ${ICONS.trash}
          </button>
        </li>
      `,
      )
      .join('');

    // Wire remove buttons
    ipList.querySelectorAll('.data-btn-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const targetIP = btn.dataset.ip;
        btn.disabled = true;
        const result = await removeSharedIP(targetIP);
        if (result?.ok) loadAccessList();
      });
    });
  }

  // ---- Manual refresh ----
  refreshBtn?.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    updateSyncUI('syncing');
    const data = await loadFromServer();
    refreshBtn.disabled = false;
    if (data && drawEngine) {
      applyServerData(data, drawEngine);
      updateSyncUI('done');
    } else {
      updateSyncUI('error');
    }
  });

  // ---- Initial load from server ----
  initialSync(drawEngine);

  return { updateSyncUI, loadAccessList };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showStatus(el, text, type) {
  if (!el) return;
  el.textContent = text;
  el.className = `data-status data-status-${type}`;
  if (type === 'success') {
    setTimeout(() => {
      el.textContent = '';
      el.className = 'data-status';
    }, 5000);
  }
}

/**
 * Apply server data to the local draw engine.
 */
function applyServerData(serverData, drawEngine) {
  if (!serverData?.data) return;

  const { features, prefs, settings, contours } = serverData.data;

  // Apply features
  if (features?.features && drawEngine) {
    try {
      drawEngine.importGeoJSON({
        type: 'FeatureCollection',
        features: features.features,
      });
    } catch (e) {
      console.error('[data-panel] Failed to import features:', e);
    }
  }

  // Apply draw preferences
  if (prefs && drawEngine) {
    try {
      drawEngine.setPrefs(prefs);
    } catch (e) {
      console.error('[data-panel] Failed to apply prefs:', e);
    }
  }

  // Apply settings to localStorage (UI prefs, hypso, map mode)
  if (settings) {
    try {
      if (settings.uiPrefs) {
        localStorage.setItem('cart:ui:prefs:v1', JSON.stringify(settings.uiPrefs));
      }
      if (settings.mapMode) {
        localStorage.setItem('cart:map-mode', settings.mapMode);
      }
      if (settings.hypsoPrefs) {
        localStorage.setItem('cart:hypso:prefs:v1', JSON.stringify(settings.hypsoPrefs));
      }
    } catch (e) {
      console.error('[data-panel] Failed to apply settings:', e);
    }
  }
}

/**
 * Initial sync: load from server, merge with local data.
 */
async function initialSync(drawEngine) {
  try {
    const serverData = await loadFromServer();
    if (!serverData) return;

    // If server has data, apply it
    if (serverData.data) {
      const hasServerFeatures =
        serverData.data.features?.features?.length > 0;

      if (hasServerFeatures && drawEngine) {
        applyServerData(serverData, drawEngine);
      }
    }
  } catch (e) {
    console.error('[data-panel] Initial sync failed:', e);
  }
}

/**
 * Collect all current local state for syncing to server.
 */
export function collectLocalState(drawEngine) {
  const state = {};

  // Features from the draw engine
  if (drawEngine) {
    try {
      const geojson = drawEngine.exportGeoJSON?.();
      if (geojson?.features) {
        state.features = {
          version: 1,
          features: geojson.features,
        };
      }
    } catch {
      // Fallback to localStorage
      try {
        const raw = localStorage.getItem('cart:draw:features:v1');
        if (raw) state.features = JSON.parse(raw);
      } catch {}
    }
  }

  // Draw prefs
  try {
    const raw = localStorage.getItem('cart:draw:prefs:v1');
    if (raw) state.prefs = JSON.parse(raw);
  } catch {}

  // UI settings
  try {
    const settings = {};
    const uiRaw = localStorage.getItem('cart:ui:prefs:v1');
    if (uiRaw) settings.uiPrefs = JSON.parse(uiRaw);
    const modeRaw = localStorage.getItem('cart:map-mode');
    if (modeRaw) settings.mapMode = modeRaw;
    const hypsoRaw = localStorage.getItem('cart:hypso:prefs:v1');
    if (hypsoRaw) settings.hypsoPrefs = JSON.parse(hypsoRaw);
    state.settings = settings;
  } catch {}

  // Contours
  try {
    const raw = localStorage.getItem('cart:settlement-contours:v1');
    if (raw) state.contours = JSON.parse(raw);
  } catch {}

  return state;
}
