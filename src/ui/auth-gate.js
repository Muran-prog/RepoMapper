/**
 * Authentication gate — a hard, full-screen login / registration overlay.
 *
 * The map cannot be used without an account: `ensureAuthenticated()` blocks
 * the boot sequence until the user is logged in, and the overlay is also
 * re-shown if the session expires mid-session (auth:required event).
 */

import { fetchMe, login, register, onAuthEvent } from '../api/client.js';

let _overlayEl = null;
let _resolveActive = null; // resolver for the currently shown overlay

const LOGO_SVG = `<svg viewBox="0 0 32 32" width="40" height="40" aria-hidden="true">
  <defs><linearGradient id="ag-g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#005bbb"/><stop offset="1" stop-color="#ffd500"/>
  </linearGradient></defs>
  <rect width="32" height="32" rx="7" fill="url(#ag-g)"/>
  <path d="M6 17 L13 23 L26 9" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const TAB_ICON_LOGIN = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
  <polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>`;
const TAB_ICON_REGISTER = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
  <line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>`;

function buildOverlay() {
  const el = document.createElement('div');
  el.className = 'auth-gate';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Вход в аккаунт');
  el.innerHTML = `
    <div class="auth-window">
      <div class="auth-titlebar">
        <span class="auth-traffic" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="auth-titlebar-name">cart://авторизация</span>
        <span class="auth-titlebar-spacer"></span>
        <span class="auth-titlebar-tag">Украина</span>
      </div>

      <div class="auth-body">
        <aside class="auth-aside">
          <div class="auth-brand">
            <span class="auth-logo">${LOGO_SVG}</span>
            <span class="auth-brand-text">
              <h1 class="auth-title">Cart · Украина</h1>
              <span class="auth-kicker">интерактивная карта</span>
            </span>
          </div>
          <p class="auth-sub">Войдите в аккаунт, чтобы открыть карту. Метки, контуры,
            рисунки и настройки привязаны к аккаунту и доступны на любом устройстве.</p>
          <ul class="auth-points">
            <li>Метки, линии, фигуры и измерения</li>
            <li>Ручные контуры поселений</li>
            <li>Рельеф, гипсометрия и слои</li>
            <li>Синхронизация между устройствами</li>
          </ul>
          <p class="auth-aside-foot">Без email. Только имя пользователя и пароль.</p>
        </aside>

        <section class="auth-main">
          <div class="auth-tabs" role="tablist">
            <button class="auth-tab" data-mode="login" role="tab" aria-selected="true">
              ${TAB_ICON_LOGIN}<span>Вход</span>
            </button>
            <button class="auth-tab" data-mode="register" role="tab" aria-selected="false">
              ${TAB_ICON_REGISTER}<span>Регистрация</span>
            </button>
          </div>

          <form class="auth-form" autocomplete="on" novalidate>
            <label class="auth-field">
              <span>Имя пользователя</span>
              <input name="username" type="text" autocomplete="username" autocapitalize="none"
                     spellcheck="false" inputmode="text" maxlength="32"
                     placeholder="например, kartograf" required />
            </label>

            <label class="auth-field">
              <span>Пароль</span>
              <span class="auth-pass-wrap">
                <input name="password" type="password" autocomplete="current-password"
                       maxlength="200" placeholder="минимум 8 символов" required />
                <button type="button" class="auth-pass-toggle" tabindex="-1" aria-label="Показать пароль">👁</button>
              </span>
            </label>

            <label class="auth-field auth-field-confirm" hidden>
              <span>Повторите пароль</span>
              <input name="confirm" type="password" autocomplete="new-password"
                     maxlength="200" placeholder="повторите пароль" />
            </label>

            <div class="auth-error" role="alert" aria-live="assertive"></div>

            <button type="submit" class="auth-submit">Войти</button>
          </form>
        </section>
      </div>

      <div class="auth-statusbar" aria-hidden="true">
        <span class="auth-status-item auth-status-accent">● защищено</span>
        <span class="auth-status-item">scrypt · cookie</span>
        <span class="auth-status-spacer"></span>
        <span class="auth-status-item">UTF-8</span>
        <span class="auth-status-item">UA</span>
      </div>
    </div>
  `;
  return el;
}

function wire(el, resolve) {
  const form = el.querySelector('.auth-form');
  const tabs = [...el.querySelectorAll('.auth-tab')];
  const errEl = el.querySelector('.auth-error');
  const submit = el.querySelector('.auth-submit');
  const confirmField = el.querySelector('.auth-field-confirm');
  const userInput = form.querySelector('input[name="username"]');
  const passInput = form.querySelector('input[name="password"]');
  const confirmInput = form.querySelector('input[name="confirm"]');
  const passToggle = el.querySelector('.auth-pass-toggle');
  let mode = 'login';
  let busy = false;

  function setMode(next) {
    mode = next;
    tabs.forEach((t) => {
      const on = t.dataset.mode === next;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.classList.toggle('is-active', on);
    });
    confirmField.hidden = next !== 'register';
    confirmInput.required = next === 'register';
    passInput.autocomplete = next === 'register' ? 'new-password' : 'current-password';
    submit.textContent = next === 'register' ? 'Создать аккаунт' : 'Войти';
    showError('');
    userInput.focus();
  }

  function showError(msg) {
    errEl.textContent = msg || '';
    errEl.classList.toggle('is-visible', !!msg);
  }

  function setBusy(on) {
    busy = on;
    submit.disabled = on;
    submit.classList.toggle('is-busy', on);
    form.querySelectorAll('input').forEach((i) => (i.disabled = on));
    submit.textContent = on
      ? 'Подождите…'
      : mode === 'register' ? 'Создать аккаунт' : 'Войти';
  }

  tabs.forEach((t) => t.addEventListener('click', () => { if (!busy) setMode(t.dataset.mode); }));

  passToggle.addEventListener('click', () => {
    const showing = passInput.type === 'text';
    passInput.type = showing ? 'password' : 'text';
    passToggle.setAttribute('aria-label', showing ? 'Показать пароль' : 'Скрыть пароль');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const username = userInput.value.trim();
    const password = passInput.value;

    // Client-side validation (mirrors the server, fast feedback).
    if (username.length < 3) return showError('Имя пользователя — минимум 3 символа.');
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) return showError('Допустимы только буквы, цифры и . _ -');
    if (password.length < 8) return showError('Пароль — минимум 8 символов.');
    if (mode === 'register' && password !== confirmInput.value) return showError('Пароли не совпадают.');

    showError('');
    setBusy(true);
    const fn = mode === 'register' ? register : login;
    const result = await fn(username, password);
    setBusy(false);

    if (result.ok) {
      teardown();
      resolve(result.user);
    } else {
      showError(result.error || 'Не удалось выполнить операцию.');
      passInput.focus();
      passInput.select();
    }
  });

  function teardown() {
    if (_overlayEl && _overlayEl.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
    _overlayEl = null;
    // NOTE: do NOT clear `_resolveActive` here. teardown() runs *before*
    // resolve() in the submit handler, and the resolve wrapper reads
    // `_resolveActive` to fire the promise. Nulling it here made the boot
    // promise never resolve → infinite loading after register/login (a
    // reload "fixed" it only because fetchMe() then bypassed the overlay).
    // The resolve wrapper clears `_resolveActive` itself once it has fired.
    const app = document.getElementById('app');
    if (app) app.removeAttribute('data-auth-gate');
  }

  // expose for the resolver path
  el.__teardown = teardown;
  setMode('login');
}

/** Show the overlay and resolve with the user once they authenticate. */
export function showAuthOverlay() {
  if (_overlayEl && _resolveActive) {
    // Already shown — return a promise that resolves with the same flow.
    return new Promise((resolve) => { _resolveActive = resolve; });
  }
  return new Promise((resolve) => {
    _resolveActive = resolve;
    _overlayEl = buildOverlay();
    document.body.appendChild(_overlayEl);
    const app = document.getElementById('app');
    if (app) app.setAttribute('data-auth-gate', '1');
    wire(_overlayEl, (user) => {
      const r = _resolveActive;
      _resolveActive = null;
      if (r) r(user);
    });
    // focus first field
    requestAnimationFrame(() => _overlayEl?.querySelector('input[name="username"]')?.focus());
  });
}

/**
 * Block until authenticated. Resolves with the user object.
 * Used by boot() before the map is ever created.
 */
export async function ensureAuthenticated() {
  const existing = await fetchMe();
  if (existing) return existing;
  return showAuthOverlay();
}

/**
 * Install a global listener so an expired session mid-use re-shows the gate.
 * `onReauth(user)` is called after the user logs back in.
 */
export function installAuthWatcher(onReauth) {
  let showing = false;
  onAuthEvent(async (event) => {
    if (event === 'auth:required' && !showing) {
      showing = true;
      const user = await showAuthOverlay();
      showing = false;
      if (typeof onReauth === 'function') onReauth(user);
    }
  });
}
