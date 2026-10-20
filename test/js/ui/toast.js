/* Notifications d'état (succès, erreur, info) empilables et accessibles. */
import { icon } from './icons.js';
import { esc } from '../core/utils.js';

const ICONS = { success: 'check', error: 'alert', info: 'info', loading: null };
let host = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'toast-stack';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

/**
 * Affiche un toast.
 * @param {string} message
 * @param {{type?:'success'|'error'|'info'|'loading', duration?:number}} options
 * @returns {{close:Function, update:Function}}
 */
export function toast(message, { type = 'success', duration } = {}) {
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  const render = (msg, t) => {
    el.className = `toast toast--${t}`;
    el.innerHTML = `<span class="toast__icon">${ICONS[t] ? icon(ICONS[t], 18) : '<span class="spinner spinner--sm"></span>'}</span><span class="toast__text">${esc(msg)}</span>`;
  };
  render(message, type);
  ensureHost().appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-visible'));

  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.classList.remove('is-visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  const schedule = t => {
    clearTimeout(timer);
    const ms = duration ?? (t === 'error' ? 4500 : 2200);
    if (t !== 'loading') timer = setTimeout(close, ms);
  };
  schedule(type);
  el.addEventListener('click', close);
  return {
    close,
    update(msg, t = 'success') {
      render(msg, t);
      schedule(t);
    }
  };
}

export const toastError = message => toast(message, { type: 'error' });
