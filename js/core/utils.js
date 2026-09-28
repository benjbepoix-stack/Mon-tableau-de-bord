/* Utilitaires génériques : DOM, échappement HTML, identifiants, nombres. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => HTML_ESCAPES[c]);

/** Convertit une saisie (virgule ou point) en nombre fini, sinon null. */
export function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/\s/g, '').replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Arrondi d'affichage sans zéros inutiles (12.50 -> 12.5). */
export const round = (n, digits = 1) => Number(Number(n).toFixed(digits));

export function debounce(fn, wait) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Comparaison profonde bon marché pour des données JSON. */
export const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const slugify = value =>
  String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

export const plural = (n, singular, pluralForm = singular + 's') => (n > 1 ? pluralForm : singular);
