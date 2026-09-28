/*
 * Système de modales unifié :
 * - feuille glissante (bottom sheet) sur mobile, boîte centrée sur ordinateur ;
 * - pile de modales (une confirmation peut s'ouvrir au-dessus d'une autre) ;
 * - fermeture par Échap, clic sur le fond ou bouton [data-close] ;
 * - blocage du défilement et restitution du focus.
 * Remplace aussi confirm()/prompt() natifs par des dialogues élégants.
 */
import { esc } from '../core/utils.js';
import { icon } from './icons.js';

const stack = [];
const ANIMATION_MS = 320;

function syncLock() {
  document.documentElement.classList.toggle('is-locked', stack.length > 0);
}

export function openSheet(target, { onClose, focus = true } = {}) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;
  if (stack.some(s => s.el === el)) return;
  stack.push({ el, onClose, returnFocus: document.activeElement });
  el.hidden = false;
  void el.offsetWidth; // force le reflow pour déclencher la transition
  el.classList.add('is-open');
  syncLock();
  if (focus) {
    const first = el.querySelector('[autofocus], input:not([type=hidden]):not([disabled]), select, textarea, button:not([data-close])');
    // Pas d'autofocus sur mobile tactile : le clavier iOS masquerait la feuille.
    const touch = window.matchMedia('(pointer: coarse)').matches;
    setTimeout(() => (touch ? el.querySelector('.sheet')?.focus({ preventScroll: true }) : first?.focus({ preventScroll: true })), 60);
  }
}

export function closeSheet(target) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  const index = stack.findIndex(s => s.el === el);
  if (index === -1) return;
  const [entry] = stack.splice(index, 1);
  el.classList.remove('is-open');
  setTimeout(() => {
    if (!el.classList.contains('is-open')) el.hidden = true;
  }, ANIMATION_MS);
  syncLock();
  entry.returnFocus?.focus?.({ preventScroll: true });
  entry.onClose?.();
}

export const isOpen = id => stack.some(s => s.el.id === id);
export const closeTop = () => stack.length && closeSheet(stack[stack.length - 1].el);

export function initDialogs() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && stack.length) {
      e.preventDefault();
      closeTop();
    }
  });
  document.addEventListener('click', e => {
    const closer = e.target.closest('[data-close]');
    if (closer) {
      closeSheet(closer.closest('.sheet-backdrop'));
      return;
    }
    if (e.target.classList?.contains('sheet-backdrop')) closeSheet(e.target);
  });
}

/* ---------- Dialogues dynamiques ---------- */
function buildDialog(inner) {
  const el = document.createElement('div');
  el.className = 'sheet-backdrop sheet-backdrop--dialog';
  el.hidden = true;
  el.innerHTML = `<div class="sheet sheet--dialog" role="alertdialog" aria-modal="true" tabindex="-1">${inner}</div>`;
  document.body.appendChild(el);
  return el;
}

const dispose = el => setTimeout(() => el.remove(), ANIMATION_MS + 50);

/**
 * Confirmation asynchrone.
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message = '', confirmLabel = 'Confirmer', cancelLabel = 'Annuler', danger = false }) {
  return new Promise(resolve => {
    let result = false;
    const el = buildDialog(`
      <div class="dialog__icon ${danger ? 'dialog__icon--danger' : ''}">${icon(danger ? 'trash' : 'info', 22)}</div>
      <h2 class="dialog__title">${esc(title)}</h2>
      ${message ? `<p class="dialog__message">${esc(message)}</p>` : ''}
      <div class="dialog__actions">
        <button type="button" class="btn btn--ghost" data-close>${esc(cancelLabel)}</button>
        <button type="button" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-confirm>${esc(confirmLabel)}</button>
      </div>`);
    el.querySelector('[data-confirm]').addEventListener('click', () => {
      result = true;
      closeSheet(el);
    });
    openSheet(el, {
      focus: false,
      onClose: () => {
        dispose(el);
        resolve(result);
      }
    });
    setTimeout(() => el.querySelector('[data-confirm]').focus(), 60);
  });
}

/**
 * Saisie de texte asynchrone (remplace prompt()).
 * @returns {Promise<string|null>}
 */
export function promptDialog({ title, label = '', value = '', placeholder = '', maxLength = 80, confirmLabel = 'Enregistrer' }) {
  return new Promise(resolve => {
    let result = null;
    const el = buildDialog(`
      <form class="dialog__form" novalidate>
        <h2 class="dialog__title">${esc(title)}</h2>
        <div class="field">
          ${label ? `<label class="field__label" for="prompt-input">${esc(label)}</label>` : ''}
          <input id="prompt-input" class="input" name="value" maxlength="${maxLength}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" required>
        </div>
        <div class="dialog__actions">
          <button type="button" class="btn btn--ghost" data-close>Annuler</button>
          <button type="submit" class="btn btn--primary">${esc(confirmLabel)}</button>
        </div>
      </form>`);
    const form = el.querySelector('form');
    const input = form.querySelector('input');
    form.addEventListener('submit', e => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      result = v;
      closeSheet(el);
    });
    openSheet(el, {
      focus: false,
      onClose: () => {
        dispose(el);
        resolve(result);
      }
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 80);
  });
}
