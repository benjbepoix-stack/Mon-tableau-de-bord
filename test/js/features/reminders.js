/*
 * Tâches datées → app Rappels de l'iPhone.
 * Une page web ne peut pas créer de rappel elle-même : le bouton copie le titre et
 * l'échéance de la tâche, puis ouvre l'app Rappels où il suffit de coller.
 */
import { formatKey, isTime } from '../core/dates.js';
import { isIOS } from './ics.js';
import { toast } from '../ui/toast.js';

const REMINDERS_URL = 'x-apple-reminderkit://';

/** Le bouton n'a de sens que sur iPhone / iPad, pour une tâche datée non terminée. */
export const canOpenReminders = task => isIOS() && !!task.date && !task.done;

export function reminderText(task) {
  const day = formatKey(task.date, { weekday: 'long', day: 'numeric', month: 'long' });
  return `${task.title} — ${day}${isTime(task.time) ? ` à ${task.time}` : ''}`;
}

/** À appeler depuis un clic (copie et ouverture d'app exigent un geste utilisateur). */
export async function openReminders(task) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(reminderText(task));
    copied = true;
  } catch {
    /* presse-papiers refusé : on ouvre quand même Rappels */
  }
  window.location.href = REMINDERS_URL;
  toast(copied ? 'Tâche copiée : collez-la dans Rappels' : 'Ouverture de Rappels…', { type: 'info', duration: 3000 });
}
