/* Vue Courses : prochaine échéance, calendrier, bilan annuel, historique. */
import { $, esc, uid, parseNumber, round } from '../core/utils.js';
import { combine, countdown, formatDate, parseDuration } from '../core/dates.js';
import { state, commit } from '../core/store.js';
import { RACE_SPORTS } from '../core/schema.js';
import { rules, validate, showErrors, clearErrors, formValues } from '../core/validation.js';
import { openSheet, closeSheet, confirmDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';
import { icon } from '../ui/icons.js';
import { renderDonut } from '../ui/charts.js';
import { offerCalendar } from '../features/calendar-prompt.js';

let viewYear = new Date().getFullYear();
let silentNext = false;
let showAllUpcoming = false;
const UPCOMING_PREVIEW = 3;

const startOf = r => combine(r.date, r.time, '00:00');
const isUpcoming = (r, now = new Date()) => startOf(r) > now;
const yearOf = r => Number(r.date.slice(0, 4));
const sorted = () => [...state.races].sort((a, b) => startOf(a) - startOf(b));

function sportFamily(sport) {
  if (['Cyclisme', 'Gravel', 'VTT'].includes(sport)) return 'Vélo';
  if (['Ski de fond', 'Ski-roue'].includes(sport)) return 'Ski';
  return sport || 'Autre';
}

const fmtDist = r => (r.distance !== '' ? `${String(r.distance).replace('.', ',')} km` : '—');
const fmtElev = r => (r.elevation !== '' ? `${r.elevation} m` : '—');
const fmtWhen = r => {
  const d = startOf(r);
  const date = formatDate(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return r.time ? `${date} · ${r.time}` : date;
};

function yearBounds() {
  const current = new Date().getFullYear();
  const years = state.races.map(yearOf).filter(Number.isFinite);
  return { min: Math.min(current, ...years), max: Math.max(current, ...years) };
}

/** Course -> événement iCalendar. */
const toCalendarEvent = r => ({
  id: r.id,
  title: `🏁 ${r.name}`,
  date: r.date,
  time: r.time,
  durationMinutes: parseDuration(r.target) || 120,
  location: r.location,
  description: [
    `Sport : ${r.sport}`,
    r.distance ? `Distance : ${r.distance} km` : '',
    r.elevation ? `Dénivelé : ${r.elevation} m` : '',
    r.target ? `Objectif : ${r.target}` : '',
    r.notes
  ]
    .filter(Boolean)
    .join('\n'),
  alarmMinutes: r.time ? 60 : 0
});

/* ---------- Rendu ---------- */
function renderHero(next) {
  const host = $('#nextRace');
  if (!next) {
    host.innerHTML = `<div class="race-hero__kicker">Prochaine course</div><h2 class="race-hero__name">Aucune course programmée</h2><p class="race-hero__place">Ajoutez votre prochain objectif avec le bouton +.</p>`;
    return;
  }
  host.innerHTML = `
    <div class="race-hero__top"><div class="race-hero__kicker">Prochaine course</div><span class="badge badge--glass">${esc(next.sport)}</span></div>
    <h2 class="race-hero__name">${esc(next.name)}</h2>
    <p class="race-hero__place">${icon('pin', 14)} ${esc(next.location || 'Lieu non renseigné')}</p>
    <p class="race-hero__place">${icon('calendar', 14)} ${fmtWhen(next)}</p>
    <div class="race-hero__countdown"><span>Départ dans</span><strong data-countdown="${esc(next.id)}">${countdown(startOf(next)) || 'Maintenant'}</strong></div>
    <div class="race-hero__meta">
      <div><strong>${fmtDist(next)}</strong><span>Distance</span></div>
      <div><strong>${fmtElev(next)}</strong><span>Dénivelé</span></div>
      <div><strong>${next.target ? esc(next.target) : '—'}</strong><span>Objectif</span></div>
    </div>
    <div class="race-hero__actions" data-id="${esc(next.id)}">
      <button type="button" class="btn btn--glass btn--sm" data-action="calendar">${icon('calendarPlus', 16)}<span>Ajouter au calendrier</span></button>
      <div class="row-actions">
        <button type="button" class="icon-btn race-hero__icon" data-action="edit" aria-label="Modifier ${esc(next.name)}">${icon('edit', 18)}</button>
        <button type="button" class="icon-btn race-hero__icon" data-action="delete" aria-label="Supprimer ${esc(next.name)}">${icon('trash', 18)}</button>
      </div>
    </div>`;
}

function raceCard(r, now) {
  const past = !isUpcoming(r, now);
  return `<article class="race-card ${past ? 'is-past' : ''}" data-id="${esc(r.id)}">
    <header class="race-card__head">
      <div><h3 class="race-card__name">${esc(r.name)}</h3><p class="race-card__when">${fmtWhen(r)}</p>${r.location ? `<p class="race-card__place">${icon('pin', 13)} ${esc(r.location)}</p>` : ''}</div>
      <span class="badge">${esc(r.sport)}</span>
    </header>
    <div class="race-card__stats">
      <div><strong>${fmtDist(r)}</strong><span>Distance</span></div>
      <div><strong>${fmtElev(r)}</strong><span>Dénivelé</span></div>
      <div><strong>${r.target ? esc(r.target) : '—'}</strong><span>Objectif</span></div>
    </div>
    ${r.notes ? `<p class="race-card__notes">${esc(r.notes)}</p>` : ''}
    ${
      past
        ? `<div class="race-result"><div class="race-result__title">Résultat</div><div class="race-result__grid">
        <label class="mini-field"><span>Temps réalisé</span><input class="input input--center" data-result="resultTime" maxlength="40" value="${esc(r.resultTime)}" placeholder="7h30"></label>
        <label class="mini-field"><span>Classement</span><input class="input input--center" data-result="resultRank" maxlength="40" value="${esc(r.resultRank)}" placeholder="25e"></label>
        <label class="mini-field"><span>Distance réelle</span><input class="input input--center" data-result="resultDistance" maxlength="40" inputmode="decimal" value="${esc(r.resultDistance)}" placeholder="160"></label>
      </div></div>`
        : ''
    }
    <footer class="race-card__foot">
      <span class="race-card__countdown">${past ? 'Course terminée' : `Départ dans <strong data-countdown="${esc(r.id)}">${countdown(startOf(r), now)}</strong>`}</span>
      <div class="row-actions">
        ${past ? '' : `<button type="button" class="icon-btn" data-action="calendar" aria-label="Ajouter au calendrier">${icon('calendarPlus', 18)}</button>`}
        <button type="button" class="icon-btn" data-action="edit" aria-label="Modifier">${icon('edit', 18)}</button>
        <button type="button" class="icon-btn icon-btn--danger" data-action="delete" aria-label="Supprimer">${icon('trash', 18)}</button>
      </div>
    </footer>
  </article>`;
}

function renderStats(now) {
  const { min, max } = yearBounds();
  viewYear = Math.min(max, Math.max(min, viewYear));
  const yearRaces = state.races.filter(r => yearOf(r) === viewYear);
  const upcoming = yearRaces.filter(r => isUpcoming(r, now)).length;
  const cost = yearRaces.reduce((s, r) => s + (parseNumber(r.price) || 0), 0);
  const km = yearRaces.reduce((s, r) => s + (parseNumber(r.distance) || 0), 0);
  $('#raceYear').textContent = String(viewYear);
  $('#raceYearPrev').disabled = viewYear <= min;
  $('#raceYearNext').disabled = viewYear >= max;
  $('#raceYearReset').hidden = viewYear === new Date().getFullYear();
  $('#raceStatsGrid').innerHTML = [
    [yearRaces.length, 'courses'],
    [upcoming, 'à venir'],
    [yearRaces.length - upcoming, 'terminées'],
    [`${round(km, 0).toLocaleString('fr-FR')} km`, 'distance'],
    [`${round(cost, 2).toLocaleString('fr-FR')} €`, 'inscriptions']
  ]
    .map(([v, l]) => `<div class="stat"><strong>${esc(v)}</strong><span>${l}</span></div>`)
    .join('');
  const counts = {};
  yearRaces.forEach(r => {
    const f = sportFamily(r.sport);
    counts[f] = (counts[f] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr'));
  renderDonut({ donut: $('#raceDonut'), legend: $('#raceLegend'), total: $('#raceDonutTotal') }, entries, 'Aucune course cette année.');

  const pastYear = sorted()
    .filter(r => !isUpcoming(r, now) && yearOf(r) === viewYear)
    .reverse();
  $('#raceHistoryYear').textContent = String(viewYear);
  $('#raceHistoryList').innerHTML = pastYear.length ? pastYear.map(r => raceCard(r, now)).join('') : '<div class="empty-state"><p>Aucune course passée pour cette année.</p></div>';
}

export function renderRaces() {
  if (silentNext) {
    silentNext = false;
    return;
  }
  const now = new Date();
  const list = sorted();
  const upcoming = list.filter(r => isUpcoming(r, now));
  // La prochaine course n'apparaît que dans l'encadré du haut : la liste commence à la suivante.
  const [next, ...later] = upcoming;
  renderHero(next);
  const shown = showAllUpcoming ? later : later.slice(0, UPCOMING_PREVIEW);
  $('#raceUpcomingList').innerHTML = later.length ? shown.map(r => raceCard(r, now)).join('') : `<div class="empty-state"><p>${next ? 'Aucune autre course à venir.' : 'Aucune course à venir.'}</p></div>`;
  const more = $('#raceMore');
  more.hidden = later.length <= UPCOMING_PREVIEW;
  more.setAttribute('aria-expanded', String(showAllUpcoming));
  more.innerHTML = showAllUpcoming
    ? `${icon('chevronUp', 18)}<span>Réduire</span>`
    : `${icon('chevronDown', 18)}<span>Développer (${later.length - UPCOMING_PREVIEW} de plus)</span>`;
  renderStats(now);
}

/** Met à jour uniquement les comptes à rebours (pas de re-rendu : les saisies restent intactes). */
export function tickCountdowns() {
  const now = new Date();
  let crossed = false;
  document.querySelectorAll('#raceView [data-countdown]').forEach(el => {
    const r = state.races.find(x => x.id === el.dataset.countdown);
    if (!r) return;
    const text = countdown(startOf(r), now);
    if (!text) crossed = true;
    else el.textContent = text;
  });
  if (crossed && !document.activeElement?.closest('#raceView')) renderRaces();
}

/* ---------- Formulaire ---------- */
function openEditor(id = null) {
  const r = id ? state.races.find(x => x.id === id) : null;
  if (id && !r) return toastError('Cette course n’existe plus.');
  const form = $('#raceForm');
  form.reset();
  clearErrors(form);
  form.elements.editId.value = r?.id || '';
  $('#raceSheetTitle').textContent = r ? 'Modifier la course' : 'Nouvelle course';
  if (r) ['name', 'sport', 'date', 'time', 'location', 'distance', 'elevation', 'price', 'target', 'notes'].forEach(k => (form.elements[k].value = r[k] ?? ''));
  openSheet('raceSheet');
}

const raceSchema = {
  name: [rules.required('Le nom'), rules.maxLength(100)],
  sport: [rules.required('Le sport'), v => (RACE_SPORTS.includes(v) ? null : 'Sport invalide.')],
  date: [rules.date({ required: true })],
  time: [rules.time()],
  location: [rules.maxLength(100)],
  distance: [rules.number({ min: 0, max: 1000 })],
  elevation: [rules.number({ min: 0, max: 20000, integer: true })],
  price: [rules.number({ min: 0, max: 10000 })],
  target: [rules.maxLength(40)],
  notes: [rules.maxLength(2000)]
};

function onSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const v = formValues(form);
  const { valid, errors } = validate(v, raceSchema);
  if (!valid) return showErrors(form, errors);
  const numStr = x => (x === '' ? '' : String(parseNumber(x)));
  const existing = v.editId ? state.races.find(x => x.id === v.editId) : null;
  const race = {
    ...(existing || {}),
    id: existing?.id || uid(),
    name: v.name,
    sport: v.sport,
    date: v.date,
    time: v.time,
    location: v.location,
    distance: numStr(v.distance),
    elevation: numStr(v.elevation),
    price: numStr(v.price),
    target: v.target,
    notes: v.notes
  };
  if (existing) state.races[state.races.indexOf(existing)] = race;
  else state.races.push(race);
  viewYear = yearOf(race);
  commit('races');
  closeSheet('raceSheet');
  toast(existing ? 'Course modifiée' : 'Course ajoutée');
}

async function onClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'add') return openEditor();
  if (action === 'toggle-upcoming') {
    showAllUpcoming = !showAllUpcoming;
    renderRaces();
    if (!showAllUpcoming) $('#raceUpcomingList').closest('.section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (action === 'year-prev' || action === 'year-next') {
    viewYear += action === 'year-prev' ? -1 : 1;
    return renderStats(new Date());
  }
  if (action === 'year-reset') {
    viewYear = new Date().getFullYear();
    return renderStats(new Date());
  }
  const id = btn.dataset.id || btn.closest('[data-id]')?.dataset.id;
  const r = state.races.find(x => x.id === id);
  if (!r) return;
  if (action === 'edit') openEditor(id);
  else if (action === 'calendar') offerCalendar(toCalendarEvent(r), { heading: 'Ajouter la course au calendrier ?' });
  else if (action === 'delete') {
    if (await confirmDialog({ title: `Supprimer « ${r.name} » ?`, message: 'Cette action est définitive.', confirmLabel: 'Supprimer', danger: true })) {
      state.races = state.races.filter(x => x.id !== id);
      commit('races');
      toast('Course supprimée');
    }
  }
}

function onResultChange(e) {
  const field = e.target.dataset.result;
  const r = state.races.find(x => x.id === e.target.closest('[data-id]')?.dataset.id);
  if (!field || !r) return;
  r[field] = e.target.value.trim().slice(0, 40);
  silentNext = true; // pas de re-rendu : on garde le focus dans la saisie
  commit('races');
  toast('Résultat enregistré');
}

export function initRaces() {
  const view = $('#raceView');
  view.addEventListener('click', onClick);
  view.addEventListener('change', onResultChange);
  $('#raceForm').addEventListener('submit', onSubmit);
  $('#raceSport').innerHTML = `<option value="" disabled selected>Choisir un sport</option>${RACE_SPORTS.map(s => `<option>${esc(s)}</option>`).join('')}`;
}
