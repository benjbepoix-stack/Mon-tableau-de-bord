/* Thème clair / sombre avec transition fluide et barre d'état iOS assortie. */
import { $ } from '../core/utils.js';
import { icon } from './icons.js';

/* Couleur de la barre d'état iOS : celle du fond de l'app (css/minimal.css). */
const THEME_COLORS = { dark: '#16171c', light: '#f4f4f7' };

export function applyTheme(theme, { animate = false } = {}) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-transition');
    setTimeout(() => root.classList.remove('theme-transition'), 450);
  }
  root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
  const btn = $('#themeToggle');
  if (btn) {
    const light = theme === 'light';
    btn.innerHTML = icon(light ? 'moon' : 'sun', 20);
    btn.setAttribute('aria-label', light ? 'Activer le mode sombre' : 'Activer le mode clair');
  }
}
