/*
 * Thème Auto (suit le réglage clair / sombre de l'appareil), Sombre ou Clair, avec
 * transition fluide et barre d'état iOS assortie. `data-theme` vaut toujours
 * « dark » ou « light » (le CSS ne connaît pas « auto »).
 */
import { $$ } from '../core/utils.js';

/* Couleur de la barre d'état iOS : celle du fond de l'app (css/minimal.css). */
const THEME_COLORS = { dark: '#121315', light: '#ffffff' };
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
let choice = 'auto';

/** Thème réellement affiché pour un choix ('auto' → celui de l'appareil). */
export const resolveTheme = theme => (theme === 'light' || theme === 'dark' ? theme : media?.matches ? 'light' : 'dark');

export function applyTheme(theme, { animate = false } = {}) {
  choice = theme;
  const root = document.documentElement;
  const resolved = resolveTheme(theme);
  if (animate && root.dataset.theme !== resolved) {
    root.classList.add('theme-transition');
    setTimeout(() => root.classList.remove('theme-transition'), 450);
  }
  root.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[resolved]);
  // Sélecteur de la feuille Réglages
  $$('[data-theme-pick]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.themePick === theme)));
}

// Choix « Auto » : suit les changements du système (ex. passage automatique en sombre le soir).
media?.addEventListener?.('change', () => choice === 'auto' && applyTheme('auto', { animate: true }));
