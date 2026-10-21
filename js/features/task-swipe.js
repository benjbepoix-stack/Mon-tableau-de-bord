/*
 * Gestes sur les tâches à faire : glisser une ligne vers la droite la coche,
 * vers la gauche la reporte à demain. Le défilement vertical reste prioritaire
 * (le geste ne s'engage qu'après 10 px nettement horizontaux).
 */
import { $ } from '../core/utils.js';
import { state, commit } from '../core/store.js';
import { todayKey, dateKey, addDays } from '../core/dates.js';
import { toast } from '../ui/toast.js';
import { burst, buzz } from '../ui/feedback.js';

const THRESHOLD = 96;
let drag = null;
let swallowClick = false;

function onDown(e) {
  const row = e.target.closest('.task:not(.is-done)');
  if (!row || e.target.closest('button') || e.button > 0) return;
  drag = { row, x: e.clientX, y: e.clientY, dx: 0, lock: null, id: e.pointerId };
}

function onMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.lock) {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      drag.lock = 'x';
      drag.row.setPointerCapture(e.pointerId);
      drag.row.classList.add('is-swiping');
    } else if (Math.abs(dy) > 10) {
      drag = null;
      return;
    } else return;
  }
  drag.dx = dx;
  const { row } = drag;
  row.style.transform = `translateX(${dx}px)`;
  row.style.setProperty('--swipe', Math.min(1, Math.abs(dx) / THRESHOLD).toFixed(3));
  row.dataset.swipe = dx > 0 ? 'done' : 'later';
}

function onUp() {
  if (!drag) return;
  const { row, dx, lock } = drag;
  drag = null;
  if (lock !== 'x') return;
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 50);
  row.classList.remove('is-swiping');
  const task = state.dashboard.tasks.find(t => t.id === row.dataset.id);
  if (!task || Math.abs(dx) < THRESHOLD) {
    row.style.transform = '';
    row.style.removeProperty('--swipe');
    return;
  }
  const prev = { done: task.done, doneAt: task.doneAt, date: task.date };
  const undo = () => {
    Object.assign(task, prev);
    if (!prev.doneAt) delete task.doneAt;
    commit('dashboard');
  };
  if (dx > 0) {
    const r = row.getBoundingClientRect();
    row.style.transform = 'translateX(110%)';
    burst(r.left + 48, r.top + r.height / 2, 16);
    buzz(12);
    setTimeout(() => {
      task.done = true;
      task.doneAt = todayKey();
      commit('dashboard');
      toast('Fait.', { action: { label: 'Annuler', onClick: undo } });
    }, 220);
  } else {
    buzz(8);
    row.style.transform = 'translateX(-110%)';
    setTimeout(() => {
      task.date = dateKey(addDays(new Date(), 1));
      commit('dashboard');
      toast('Pour demain.', { action: { label: 'Annuler', onClick: undo } });
    }, 220);
  }
}

export function initTaskSwipe() {
  const host = $('#tasks');
  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onUp);
  // Un glissé ne doit pas ouvrir la fiche de la tâche au relâcher.
  host.addEventListener('click', e => swallowClick && (e.stopPropagation(), e.preventDefault()), true);
}
