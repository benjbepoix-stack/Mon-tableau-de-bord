/*
 * Pop-up au démarrage : tâches en retard (Carnet) et entretiens en retard
 * (résumé publié par l'app Mon Garage), à la suite les uns des autres.
 * Un seul passage par session ; défilement par « Suivant » puis « Terminé »
 * quand plusieurs rappels sont en retard. S'inspire du même pop-up côté
 * Mon Garage (js/features/overdue-prompt.js).
 */
import { $, esc } from '../core/utils.js';
import { state } from '../core/store.js';
import { todayKey, formatKey } from '../core/dates.js';
import { openSheet, closeSheet } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';

let items = [];
let index = 0;
let onView = null;
let checked = false;

function collectOverdueTasks() {
  return state.dashboard.tasks
    .filter(t => !t.done && t.date && t.date < todayKey())
    .map(t => ({
      kind: 'task',
      id: t.id,
      title: t.title,
      text: `Échéance : ${formatKey(t.date, { weekday: 'long', day: 'numeric', month: 'long' })}`
    }));
}

/** `digest` : données brutes du nœud Firebase `garage_alerts` (cf. features/garage-widget.js). */
function collectOverdueGarage(digest) {
  const out = [];
  const vehicles = digest && typeof digest === 'object' ? Object.values(digest).filter(Boolean) : [];
  vehicles.forEach(v =>
    (Array.isArray(v.alerts) ? v.alerts : [])
      .filter(a => a.level === 'late')
      .forEach(a => out.push({ kind: 'garage', vehicleName: v.vehicleName, title: a.title, text: a.text }))
  );
  return out;
}

function render() {
  const n = items.length;
  const item = items[index];
  const last = index === n - 1;
  const isTask = item.kind === 'task';
  $('#overdueContent').innerHTML = `
    <div class="dialog__icon dialog__icon--danger">${icon(isTask ? 'alert' : 'wrench', 22)}</div>
    <h2 class="dialog__title" id="overdueTitle">${isTask ? 'Tâche en retard' : 'Entretien en retard'}</h2>
    ${n > 1 ? `<p class="dialog__message">Rappel ${index + 1} sur ${n}</p>` : ''}
    <div class="cal-card">
      ${item.vehicleName ? `<div class="cal-card__title">${esc(item.vehicleName)}</div>` : ''}
      <div class="cal-card__row">${icon(isTask ? 'check' : 'wrench', 16)}<span>${esc(item.title)}</span></div>
      <div class="cal-card__row">${icon('clock', 16)}<span>${esc(item.text)}</span></div>
    </div>
    <div class="dialog__actions dialog__actions--stack">
      ${isTask ? `<button type="button" class="btn btn--soft" data-overdue="view">${icon('chevronRight', 18)}<span>Voir cette tâche</span></button>` : ''}
      <button type="button" class="btn btn--primary" data-overdue="${last ? 'done' : 'next'}">${last ? 'Terminé' : 'Suivant'}</button>
    </div>`;
}

/**
 * À appeler une fois les données prêtes. `garageDigest` peut être `null`
 * (Garage hors ligne ou pas encore répondu) : seules les tâches sont alors
 * proposées. Un seul passage par session, quel que soit l'appelant.
 */
export function checkOverdue(garageDigest = null) {
  if (checked) return;
  checked = true;
  items = [...collectOverdueTasks(), ...collectOverdueGarage(garageDigest)];
  if (!items.length) return;
  index = 0;
  render();
  openSheet('overdueSheet', { focus: false });
}

export function initOverduePrompt({ onView: handler } = {}) {
  onView = handler || null;
  $('#overdueContent').addEventListener('click', e => {
    const btn = e.target.closest('[data-overdue]');
    if (!btn) return;
    const action = btn.dataset.overdue;
    if (action === 'next') {
      index = Math.min(index + 1, items.length - 1);
      render();
    } else if (action === 'done') {
      closeSheet('overdueSheet');
    } else if (action === 'view') {
      const item = items[index];
      closeSheet('overdueSheet');
      onView?.(item.id);
    }
  });
}
