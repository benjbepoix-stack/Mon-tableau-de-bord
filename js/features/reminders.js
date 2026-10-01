/*
 * Export d'une tâche vers l'app Rappels de l'iPhone.
 *
 * Une page web ne peut pas écrire directement dans Rappels. Deux voies :
 *  1. Raccourci iOS (recommandé) : l'app ouvre
 *     shortcuts://run-shortcut?name=…&input=text&text={JSON}
 *     Le raccourci « Dashboard vers Rappels », créé une fois par l'utilisateur,
 *     lit le JSON et crée le rappel avec sa date, son heure d'alerte et sa note.
 *  2. Feuille de partage (sans configuration) : « Rappels » crée un rappel avec
 *     le titre ; la date et l'alerte se règlent ensuite dans Rappels.
 * Hors iOS : téléchargement d'un fichier .ics (VTODO) avec alerte.
 */
import { $, esc } from '../core/utils.js';
import { formatKey, isTime } from '../core/dates.js';
import { buildTodoICS, downloadFile, isIOS } from './ics.js';
import { readText, write } from '../services/storage.js';
import { openSheet, closeSheet } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { toast, toastError } from '../ui/toast.js';

export const SHORTCUT_NAME = 'Dashboard vers Rappels';
const READY_KEY = 'dashboard_reminders_shortcut';
const DEFAULT_TIME = '09:00';

let current = null;

const isReady = () => readText(READY_KEY) === '1';

/** Données transmises au raccourci (clés en français, lues par « Obtenir la valeur du dictionnaire »). */
export function reminderPayload(task) {
  const date = task.date ? `${task.date} ${isTime(task.time) ? task.time : DEFAULT_TIME}` : '';
  return { titre: task.title, notes: task.note || '', date };
}

export function shortcutURL(task) {
  const params = new URLSearchParams({ name: SHORTCUT_NAME, input: 'text', text: JSON.stringify(reminderPayload(task)) });
  // URLSearchParams encode les espaces en « + » : Raccourcis attend %20.
  return `shortcuts://run-shortcut?${params.toString().replace(/\+/g, '%20')}`;
}

function dueLine(task) {
  if (!task.date) return 'Sans échéance : rappel sans alerte';
  const day = formatKey(task.date, { weekday: 'long', day: 'numeric', month: 'long' });
  return `${day} · alerte à ${isTime(task.time) ? task.time.replace(':', ' h ') : '9 h (par défaut)'}`;
}

const STEPS = `
  <ol class="rem-steps">
    <li>Ouvrez l’app <strong>Raccourcis</strong>, touchez <strong>+</strong> et nommez le raccourci exactement :
      <span class="rem-name"><code>${SHORTCUT_NAME}</code><button type="button" class="chip-btn" data-rem="copy">${icon('copy', 14)} Copier</button></span></li>
    <li>Ajoutez l’action <strong>Obtenir le dictionnaire depuis</strong> et choisissez <strong>Entrée du raccourci</strong>.</li>
    <li>Ajoutez trois actions <strong>Obtenir la valeur du dictionnaire</strong>, pour les clés <code>titre</code>, <code>notes</code> et <code>date</code>.</li>
    <li>Ajoutez l’action <strong>Si</strong> : <em>valeur de « date »</em> <strong>a une valeur</strong>.</li>
    <li>Dans la branche <strong>Si</strong>, ajoutez <strong>Ajouter un nouveau rappel</strong> avec le titre = <em>titre</em> ; touchez la flèche pour afficher plus : <strong>Notes</strong> = <em>notes</em>, <strong>Alerte</strong> = <em>date</em>.</li>
    <li>Dans la branche <strong>Sinon</strong>, ajoutez un second <strong>Ajouter un nouveau rappel</strong> avec le titre et les notes, sans alerte.</li>
  </ol>
  <p class="cal-hint">Au premier lancement, iOS demande l’autorisation d’accéder à Rappels : choisissez « Toujours autoriser ». Ensuite, chaque tâche s’ajoute en un geste, avec sa date et son alerte.</p>`;

function render(task, heading) {
  const ios = isIOS();
  const ready = isReady();
  let actions;
  if (!ios) {
    actions = `
      <button type="button" class="btn btn--primary btn--lg" data-rem="ics">${icon('bell', 18)}<span>Télécharger la tâche (.ics)</span></button>
      <button type="button" class="btn btn--ghost" data-close>Plus tard</button>`;
  } else if (ready) {
    actions = `
      <button type="button" class="btn btn--primary btn--lg" data-rem="shortcut">${icon('bell', 18)}<span>Ajouter aux Rappels</span></button>
      <button type="button" class="btn btn--soft" data-rem="share">${icon('share', 18)}<span>Partager vers Rappels</span></button>
      <button type="button" class="btn btn--ghost" data-close>Plus tard</button>`;
  } else {
    actions = `
      <button type="button" class="btn btn--soft" data-rem="share">${icon('share', 18)}<span>Partager vers Rappels (titre seul)</span></button>
      <button type="button" class="btn btn--ghost" data-close>Plus tard</button>`;
  }
  $('#reminderContent').innerHTML = `
    <div class="cal-hero cal-hero--reminder">${icon('bell', 30)}</div>
    <h2 class="dialog__title" id="reminderTitle">${esc(heading)}</h2>
    <div class="cal-card">
      <div class="cal-card__title">${esc(task.title)}</div>
      <div class="cal-card__row">${icon('clock', 16)}<span>${esc(dueLine(task))}</span></div>
      ${task.note ? `<div class="cal-card__row">${icon('note', 16)}<span>${esc(task.note)}</span></div>` : ''}
    </div>
    ${
      ios && !ready
        ? `<details class="rem-setup" open>
            <summary>Ajout automatique avec date et alerte : à configurer une fois</summary>
            ${STEPS}
            <button type="button" class="btn btn--primary btn--block" data-rem="ready">${icon('check', 18)}<span>Raccourci créé : ajouter aux Rappels</span></button>
          </details>`
        : ''
    }
    <div class="dialog__actions dialog__actions--stack">${actions}</div>
    ${ios && ready ? `<button type="button" class="link-btn link-btn--center" data-rem="setup">Revoir la configuration du raccourci</button>` : ''}
    <div class="rem-setup-again" hidden>${STEPS}</div>`;
}

/**
 * Ouvre la fenêtre d'export d'une tâche vers Rappels.
 * @param {{id:string,title:string,date?:string,time?:string,note?:string}} task
 */
export function offerReminder(task, { heading = 'Ajouter aux Rappels ?' } = {}) {
  current = task;
  render(task, heading);
  openSheet('reminderSheet', { focus: false });
}

async function share(task) {
  const text = task.date ? `${task.title} (${dueLine(task)})` : task.title;
  if (!navigator.share) {
    toastError('Partage indisponible sur cet appareil.');
    return;
  }
  try {
    await navigator.share({ title: task.title, text });
    closeSheet('reminderSheet');
  } catch (error) {
    if (error?.name !== 'AbortError') toastError('Partage impossible.');
  }
}

function runShortcut(task) {
  // Navigation directe : doit rester dans le geste utilisateur (clic).
  window.location.href = shortcutURL(task);
  closeSheet('reminderSheet');
}

export function initReminders() {
  $('#reminderSheet').addEventListener('click', async e => {
    const btn = e.target.closest('[data-rem]');
    if (!btn || !current) return;
    switch (btn.dataset.rem) {
      case 'shortcut':
        return runShortcut(current);
      case 'ready':
        write(READY_KEY, '1');
        return runShortcut(current);
      case 'share':
        return share(current);
      case 'ics':
        downloadFile(buildTodoICS(current), `${current.title.slice(0, 40).replace(/[^\w\- ]+/g, '').trim() || 'tache'}.ics`, 'text/calendar;charset=utf-8');
        closeSheet('reminderSheet');
        return toast('Tâche téléchargée : ouvrez le fichier pour l’ajouter à votre gestionnaire de tâches', { type: 'info', duration: 3500 });
      case 'setup': {
        const box = $('#reminderContent .rem-setup-again');
        box.hidden = !box.hidden;
        return;
      }
      case 'copy':
        try {
          await navigator.clipboard.writeText(SHORTCUT_NAME);
          toast('Nom copié');
        } catch {
          toastError('Copie impossible : recopiez le nom à la main.');
        }
    }
  });
}
