/*
 * Pop-up au démarrage : tout ce qui est en retard, en une seule liste.
 * - Tâches de Carnet : cochables directement depuis la liste, ou ouvertes d'un appui.
 * - Entretiens en retard publiés par Mon Garage et Ma Maison : un appui ouvre l'app.
 * Un seul passage par session, un seul bouton pour fermer (plus de « Suivant » à
 * répéter pour chaque élément).
 */
import { $, esc } from '../core/utils.js';
import { state, commit } from '../core/store.js';
import { todayKey, formatKey } from '../core/dates.js';
import { openSheet, closeSheet, isOpen } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { icon } from '../ui/icons.js';
import { lateAlerts, GARAGE_URL, MAISON_URL } from './linked-apps.js';

let onView = null;
let checked = false;

const overdueTasks = () =>
  state.dashboard.tasks.filter(t => !t.done && t.date && t.date < todayKey()).sort((a, b) => a.date.localeCompare(b.date));

function taskRow(t) {
  return `<div class="ov-row" data-ov-task="${esc(t.id)}">
    <button type="button" class="task__check" data-ov="done" role="checkbox" aria-checked="false" aria-label="Marquer « ${esc(t.title)} » comme faite">${icon('check', 15)}</button>
    <button type="button" class="ov-row__body" data-ov="view"><strong>${esc(t.title)}</strong><span class="is-overdue">${esc(formatKey(t.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</span></button>
  </div>`;
}

function alertRow(a) {
  const url = a.source === 'garage' ? GARAGE_URL : `${MAISON_URL}#/entretien`;
  return `<a class="ov-row" href="${url}">
    <span class="ov-row__icon">${icon('wrench', 16)}</span>
    <span class="ov-row__body"><strong>${a.owner ? `${esc(a.owner)} · ` : ''}${esc(a.title)}</strong><span>${a.source === 'garage' ? 'Garage' : 'Maison'} · ${esc(a.text)}</span></span>
    ${icon('chevronRight', 16)}
  </a>`;
}

function render() {
  const tasks = overdueTasks();
  const alerts = lateAlerts();
  const n = tasks.length + alerts.length;
  $('#overdueContent').innerHTML = `
    <div class="dialog__icon dialog__icon--danger">${icon('alert', 22)}</div>
    <h2 class="dialog__title" id="overdueTitle">${n} élément${n > 1 ? 's' : ''} en retard</h2>
    <div class="ov-list">${tasks.map(taskRow).join('')}${alerts.map(alertRow).join('')}</div>
    <div class="dialog__actions dialog__actions--stack"><button type="button" class="btn btn--primary" data-close>Fermer</button></div>`;
  return n;
}

/** À appeler une fois les données prêtes (cloud reçu, résumés Garage / Maison lus ou injoignables). */
export function checkOverdue() {
  if (checked) return;
  checked = true;
  if (render()) openSheet('overdueSheet', { focus: false });
}

export function initOverduePrompt({ onView: handler } = {}) {
  onView = handler || null;
  $('#overdueContent').addEventListener('click', e => {
    const btn = e.target.closest('[data-ov]');
    const id = btn?.closest('[data-ov-task]')?.dataset.ovTask;
    const task = id && state.dashboard.tasks.find(t => t.id === id);
    if (!task) return;
    if (btn.dataset.ov === 'view') {
      closeSheet('overdueSheet');
      return onView?.(id);
    }
    task.done = true;
    task.doneAt = todayKey();
    commit('dashboard');
    toast('Tâche faite');
    if (!render() && isOpen('overdueSheet')) closeSheet('overdueSheet');
  });
}
