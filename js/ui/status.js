/* Pastille d'état de synchronisation affichée dans l'en-tête. */
import { $ } from '../core/utils.js';
import { icon } from './icons.js';

const LABELS = {
  connecting: { text: 'Connexion…', icon: null, title: 'Connexion au cloud en cours' },
  online: { text: 'Synchronisé', icon: 'cloud', title: 'Données synchronisées sur tous vos appareils' },
  syncing: { text: 'Envoi…', icon: null, title: 'Enregistrement dans le cloud' },
  offline: { text: 'Hors ligne', icon: 'cloudOff', title: 'Hors ligne : vos modifications seront envoyées à la reconnexion' },
  local: { text: 'Local', icon: 'cloudOff', title: 'Synchronisation indisponible : données enregistrées sur cet appareil' }
};

let current = null;

export function renderStatus(status, detail) {
  const el = $('#syncStatus');
  if (!el || status === current) return;
  current = status;
  const cfg = LABELS[status] || LABELS.local;
  el.dataset.status = status;
  el.title = detail ? `${cfg.title} — ${detail}` : cfg.title;
  el.setAttribute('aria-label', el.title);
  el.innerHTML = `${cfg.icon ? icon(cfg.icon, 14) : '<span class="spinner spinner--xs"></span>'}<span>${cfg.text}</span>`;
}
