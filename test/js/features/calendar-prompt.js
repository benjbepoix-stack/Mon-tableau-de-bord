/*
 * Modale de confirmation « Ajouter au calendrier ».
 * Affichée après l'enregistrement d'un rendez-vous : le clic sur le bouton
 * fournit le geste utilisateur exigé par Safari iOS pour ouvrir le .ics.
 */
import { $, esc } from '../core/utils.js';
import { formatKey, isTime, isRepeat, REPEATS } from '../core/dates.js';
import { buildICS, openInCalendar, shareICS, isIOS, isStandalone } from './ics.js';
import { openSheet, closeSheet } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { toast, toastError } from '../ui/toast.js';

let currentEvent = null;

function timeRange(e) {
  if (!isTime(e.time)) return 'Toute la journée';
  return isTime(e.endTime) ? `${e.time} – ${e.endTime}` : e.time;
}

/**
 * @param {object} event  { id, title, date, time, endTime, location, description, alarmMinutes, durationMinutes }
 * @param {{ heading?:string, synced?:boolean|null }} options
 */
export function offerCalendar(event, { heading = 'Ajouter au calendrier ?', synced = null } = {}) {
  currentEvent = event;
  const canShare = typeof navigator.canShare === 'function' && isIOS();
  const syncLine =
    synced === true
      ? `<p class="cal-card__sync is-ok">${icon('cloud', 14)} Enregistré et synchronisé</p>`
      : synced === false
        ? `<p class="cal-card__sync">${icon('cloudOff', 14)} Enregistré sur cet appareil — synchronisation à la reconnexion</p>`
        : '';
  $('#calendarContent').innerHTML = `
    <div class="cal-hero">${icon('calendarPlus', 30)}</div>
    <h2 class="dialog__title" id="calendarTitle">${esc(heading)}</h2>
    ${syncLine}
    <div class="cal-card">
      <div class="cal-card__title">${esc(event.title)}</div>
      <div class="cal-card__row">${icon('calendar', 16)}<span>${esc(formatKey(event.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</span></div>
      <div class="cal-card__row">${icon('clock', 16)}<span>${esc(timeRange(event))}</span></div>
      ${isRepeat(event.repeat) ? `<div class="cal-card__row">${icon('repeat', 16)}<span>${REPEATS[event.repeat].label}</span></div>` : ''}
      ${event.location ? `<div class="cal-card__row">${icon('pin', 16)}<span>${esc(event.location)}</span></div>` : ''}
    </div>
    <div class="dialog__actions dialog__actions--stack">
      <button type="button" class="btn btn--primary btn--lg" data-cal="open">${icon('calendarPlus', 18)}<span>${isIOS() ? 'Ajouter au Calendrier' : 'Télécharger l’événement (.ics)'}</span></button>
      ${canShare ? `<button type="button" class="btn btn--soft" data-cal="share">${icon('share', 18)}<span>Partager le fichier .ics</span></button>` : ''}
      <button type="button" class="btn btn--ghost" data-close>Plus tard</button>
    </div>
    ${isIOS() && isStandalone() ? '<p class="cal-hint">Astuce : si la fiche Calendrier ne s’affiche pas depuis l’écran d’accueil, utilisez « Partager » puis « Calendrier ».</p>' : ''}`;
  openSheet('calendarSheet', { focus: false });
}

export function initCalendarPrompt() {
  $('#calendarSheet').addEventListener('click', async e => {
    const btn = e.target.closest('[data-cal]');
    if (!btn || !currentEvent) return;
    let ics;
    try {
      ics = buildICS(currentEvent);
    } catch (error) {
      toastError(error.message);
      return;
    }
    if (btn.dataset.cal === 'open') {
      const mode = openInCalendar(ics, currentEvent.title);
      closeSheet('calendarSheet');
      if (mode === 'download') toast('Fichier .ics téléchargé — ouvrez-le pour l’ajouter à votre agenda', { type: 'info', duration: 3500 });
    } else if (btn.dataset.cal === 'share') {
      try {
        const shared = await shareICS(ics, currentEvent.title);
        if (!shared) toastError('Le partage de fichiers n’est pas pris en charge ici.');
        else closeSheet('calendarSheet');
      } catch (error) {
        if (error?.name !== 'AbortError') toastError('Partage impossible.');
      }
    }
  });
}
