/*
 * Tâches « Sport » (onglet Tâches), déduites des courses d'Allure (même base) :
 * - course dans les 14 prochains jours : préparation ;
 * - course terminée depuis moins de 45 jours sans temps saisi : résultat à noter.
 * Lecture seule : un appui ouvre Allure.
 */
import { $, esc } from '../core/utils.js';
import { formatKey, fromKey, todayKey } from '../core/dates.js';
import { state } from '../core/store.js';
import { ALLURE_URL } from '../views/dashboard.js';

const daysBetween = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86400000);

export function sportTasks(today = todayKey()) {
  const list = [];
  for (const r of state.races || []) {
    const d = daysBetween(today, r.date);
    if (d >= 0 && d <= 14) list.push({ level: d <= 3 ? 'late' : 'soon', title: `${r.name} · ${d === 0 ? 'aujourd’hui' : d === 1 ? 'demain' : `dans ${d} jours`}`, text: `${formatKey(r.date, { weekday: 'long', day: 'numeric', month: 'long' })} · préparer matériel, ravitaillement et trajet`, order: d });
    else if (d < 0 && d >= -45 && !r.resultTime) list.push({ level: 'info', title: `Noter le résultat · ${r.name}`, text: `Course du ${formatKey(r.date, { day: 'numeric', month: 'long' })}`, order: 100 - d });
  }
  return list.sort((a, b) => a.order - b.order);
}

export function renderSportTasks() {
  const items = sportTasks();
  $('#sportSection').hidden = !items.length;
  $('#sportTasks').innerHTML = items
    .map(a => `<a class="task" href="${ALLURE_URL}"><span class="garage-dot is-${a.level}"></span><div class="task__body"><div class="task__title">${esc(a.title)}</div><div class="task__sub">${esc(a.text)}</div></div></a>`)
    .join('');
}
