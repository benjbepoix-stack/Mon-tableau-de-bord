/*
 * Ménage quotidien des tâches cochées :
 *  - une tâche cochée reste visible (barrée) jusqu'à la fin de la journée,
 *    puis disparaît le lendemain ;
 *  - une tâche répétée n'est pas supprimée : le lendemain, elle repart décochée
 *    à sa prochaine échéance (voir nextTaskDate) ;
 *  - une tâche cochée avant cette règle (sans date de coche) est datée
 *    d'aujourd'hui : elle partira demain.
 *
 * À n'appeler qu'une fois les données du cloud reçues (ou en mode local) : un
 * ménage fait sur des données locales pas encore synchronisées écraserait les
 * tâches ajoutées entre-temps sur un autre appareil.
 */
import { state, commit } from '../core/store.js';
import { todayKey, nextTaskDate } from '../core/dates.js';

export function tidyTasks(today = todayKey()) {
  let changed = false;
  const next = [];
  for (const t of state.dashboard.tasks) {
    if (!t.done) next.push(t);
    else if (!t.doneAt) {
      next.push({ ...t, doneAt: today });
      changed = true;
    } else if (t.doneAt >= today) next.push(t);
    else {
      changed = true;
      if (t.repeat && t.date) {
        const { doneAt, ...rest } = t;
        next.push({ ...rest, anchor: t.anchor || t.date, date: nextTaskDate(t), done: false });
      }
      // Sinon : tâche cochée un jour précédent, supprimée.
    }
  }
  if (changed) {
    state.dashboard.tasks = next;
    commit('dashboard');
  }
  return changed;
}
