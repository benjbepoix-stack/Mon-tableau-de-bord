/* Accueil (séance du jour, agenda chronologique : RDV, événements, courses d'Allure, notes) et Tâches. */
import { $, $$, esc, uid, debounce } from '../core/utils.js';
import { combine, formatDate, formatKey, fromKey, relativeDay, daysUntil, todayKey, dateKey, addDays, isRepeat, nextOccurrenceKey, nextTaskDate, occurrencesBetween, REPEATS } from '../core/dates.js';
import { state, commit } from '../core/store.js';
import { rules, validate, showErrors, clearErrors, formValues } from '../core/validation.js';
import { openSheet, closeSheet, confirmDialog, isOpen } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';
import { icon } from '../ui/icons.js';
import { canOpenReminders, openReminders } from '../features/reminders.js';
import { offerCalendar } from '../features/calendar-prompt.js';
import { confirmSaved } from '../features/persist.js';
import { isRestTraining, REST_TRAINING } from '../core/schema.js';
import { PHASE_TYPES, phaseOn, racesOn } from '../core/season.js';
import { readText, write } from '../services/storage.js';
import { datedAlerts, GARAGE_URL, MAISON_URL } from '../features/linked-apps.js';

export const ALLURE_URL = 'https://benjbepoix-stack.github.io/Allure/';
/** Accueil : seuls les rendez-vous, événements et courses des 30 prochains jours sont affichés, le reste se déplie. */
const AGENDA_DAYS = 30;
/** Échéance proche : carte encadrée en couleur (rouge aujourd'hui / demain, ambre jusqu'à 10 jours). */
const SOON_DAYS = 10;
const URGENT_DAYS = 1;
const AGENDA_MODE_KEY = 'dashboard_agenda_mode';
let laterOpen = false;
let agendaMode = readText(AGENDA_MODE_KEY, 'list') === 'month' ? 'month' : 'list';
let calMonth = todayKey().slice(0, 7);
let calDay = todayKey();

const TYPES = {
  tasks: { add: 'Nouvelle tâche', edit: 'Modifier la tâche', one: 'Tâche', none: 'Aucune tâche' },
  appointments: { add: 'Nouveau rendez-vous', edit: 'Modifier le rendez-vous', one: 'Rendez-vous', none: 'Aucun rendez-vous à venir' },
  events: { add: 'Nouvel événement', edit: 'Modifier l’événement', one: 'Événement', none: 'Aucun événement à venir' }
};

let archive = { type: 'appointments', tab: 'upcoming' };

/* ---------- Sélecteurs ---------- */
/** Élément tel qu'affiché : un élément répété prend la date de sa prochaine occurrence. */
const view = x => (isRepeat(x.repeat) ? { ...x, date: nextOccurrenceKey(x) } : x);
const startOf = x => combine(x.date, x.time, '23:59')?.getTime() ?? Infinity;
const isPast = x => {
  if (!x.date) return false;
  const end = combine(x.date, x.endTime || x.time, '23:59');
  return end ? end.getTime() < Date.now() : false;
};
const upcoming = type => state.dashboard[type].map(view).filter(x => x.date && !isPast(x)).sort((a, b) => startOf(a) - startOf(b));
const past = type => state.dashboard[type].map(view).filter(x => x.date && isPast(x)).sort((a, b) => startOf(b) - startOf(a));

/** Élément du dashboard -> événement iCalendar. */
export const toCalendarEvent = (item, type) => ({
  id: item.id,
  title: item.title,
  date: item.date,
  time: item.time,
  endTime: item.endTime,
  location: item.location,
  description: item.note,
  alarmMinutes: type === 'appointments' ? 30 : 0,
  repeat: item.repeat
});

/* ---------- Rendu ---------- */
function timeLabel(x) {
  if (!x.time) return '';
  return x.endTime ? `${x.time} – ${x.endTime}` : x.time;
}

/** Urgence d'une échéance : 'urgent' (aujourd'hui, demain), 'soon' (≤ 10 jours) ou ''. */
function urgencyOf(date) {
  const diff = date ? daysUntil(date) : null;
  if (diff === null || diff < 0 || diff > SOON_DAYS) return '';
  return diff <= URGENT_DAYS ? 'urgent' : 'soon';
}

function itemCard(x, type) {
  const d = fromKey(x.date);
  const urgency = urgencyOf(x.date);
  const chip = d
    ? `<div class="date-chip date-chip--${type} ${urgency ? `is-${urgency}` : ''}"><span class="date-chip__day">${d.getDate()}</span><span class="date-chip__month">${formatDate(d, { month: 'short' })}</span></div>`
    : '';
  const meta = [x.date ? `<span class="tag tag--${type} ${urgency ? `is-${urgency}` : ''}">${urgency ? icon('alert', 12) : ''}${relativeDay(x.date)}</span>` : '', timeLabel(x) ? `<span>${icon('clock', 13)}${timeLabel(x)}</span>` : '', isRepeat(x.repeat) ? `<span>${icon('repeat', 13)}${REPEATS[x.repeat].label}</span>` : '', x.location ? `<span>${icon('pin', 13)}${esc(x.location)}</span>` : '']
    .filter(Boolean)
    .join('');
  // Un appui sur la carte ouvre la modification (suppression dans la feuille) : moins d'icônes à l'écran.
  return `<article class="item-card is-tappable ${urgency ? `item-card--${urgency}` : ''}" data-id="${esc(x.id)}" data-type="${type}" tabindex="0" aria-label="Modifier « ${esc(x.title)} »">
    ${chip}
    <div class="item-card__body">
      <h3 class="item-card__title">${esc(x.title)}</h3>
      ${meta ? `<div class="item-card__meta">${meta}</div>` : ''}
      ${x.note ? `<p class="item-card__note">${esc(x.note)}</p>` : ''}
    </div>
    ${x.date && !isPast(x) ? `<div class="item-card__actions"><button type="button" class="icon-btn" data-action="calendar" aria-label="Ajouter « ${esc(x.title)} » au calendrier">${icon('calendarPlus', 18)}</button></div>` : ''}
  </article>`;
}

/* ---------- Séance du jour ---------- */
function renderToday() {
  const key = todayKey();
  const families = state.families || [];
  const sessions = (Array.isArray(state.plans?.[key]) ? state.plans[key] : []).filter(x => x.training);
  const phase = phaseOn(key);
  const races = racesOn(key);
  const line = x => {
    if (isRestTraining(x.training)) return { title: REST_TRAINING, facts: '' };
    const f = families.find(a => a.id === x.family);
    const facts = [x.distance ? `${String(x.distance).replace('.', ',')} km` : '', x.time ? x.time.replace(/^0(\d)/, '$1').replace(':', 'h') : '', x.elevation ? `${x.elevation} m D+` : ''].filter(Boolean).join(' · ');
    return { title: f ? `${f.name} · ${x.training}` : x.training, facts };
  };
  const rows = [
    ...races.map(r => `<div class="today-card__row is-race">${icon('flag', 18)}<div><strong>${esc(r.name)}</strong>${r.time ? `<span>Départ ${r.time}</span>` : ''}</div></div>`),
    ...sessions.map(line).map(l => `<div class="today-card__row">${icon('training', 18)}<div><strong>${esc(l.title)}</strong>${l.facts ? `<span>${esc(l.facts)}</span>` : ''}</div></div>`)
  ];
  $('#todaySession').innerHTML = `
    <div class="today-card__head"><span class="today-card__kicker">Séance du jour</span>${phase ? `<span class="today-card__phase phase--${phase.type}">${esc(PHASE_TYPES[phase.type].short)}</span>` : ''}</div>
    ${rows.length ? rows.join('') : `<p class="today-card__empty">Rien de prévu aujourd’hui.</p>`}
    <button type="button" class="link-btn" data-goto="trainingView">${rows.length ? 'Voir la semaine' : 'Planifier une séance'}</button>`;
}

/* ---------- Agenda chronologique ---------- */
function raceItem(r) {
  const d = fromKey(r.date);
  const urgency = urgencyOf(r.date);
  const meta = [`<span class="tag tag--races">${icon('flag', 12)}Course · ${relativeDay(r.date)}</span>`, r.time ? `<span>${icon('clock', 13)}${r.time}</span>` : '', r.location ? `<span>${icon('pin', 13)}${esc(r.location)}</span>` : '', r.distance ? `<span>${String(r.distance).replace('.', ',')} km</span>` : '']
    .filter(Boolean)
    .join('');
  return `<a class="item-card item-card--race ${urgency ? `item-card--${urgency}` : ''}" href="${ALLURE_URL}">
    <div class="date-chip date-chip--races"><span class="date-chip__day">${d.getDate()}</span><span class="date-chip__month">${formatDate(d, { month: 'short' })}</span></div>
    <div class="item-card__body"><h3 class="item-card__title">${esc(r.name)}</h3><div class="item-card__meta">${meta}</div></div>
  </a>`;
}

/** Rendez-vous, événements et courses à venir, dans l'ordre chronologique. */
function upcomingAgenda() {
  const today = todayKey();
  const races = (state.races || []).filter(r => r.date >= today).map(r => ({ ...r, kind: 'races' }));
  return [...upcoming('appointments').map(x => ({ ...x, kind: 'appointments' })), ...upcoming('events').map(x => ({ ...x, kind: 'events' })), ...races].sort((a, b) => startOf(a) - startOf(b));
}

const agendaHtml = x => (x.kind === 'races' ? raceItem(x) : itemCard(x, x.kind));

function renderAgendaList() {
  const limit = dateKey(addDays(new Date(), AGENDA_DAYS));
  const items = upcomingAgenda();
  const soon = items.filter(x => x.date <= limit);
  const later = items.filter(x => x.date > limit);
  $('#agenda').innerHTML = soon.length
    ? soon.map(agendaHtml).join('')
    : `<div class="empty-state"><p>Rien dans les ${AGENDA_DAYS} prochains jours.</p></div>`;
  const more = $('#agendaMore');
  more.hidden = !later.length;
  more.setAttribute('aria-expanded', String(laterOpen));
  more.innerHTML = `<span>${laterOpen ? 'Masquer' : 'Plus tard'} (${later.length})</span>${icon(laterOpen ? 'chevronUp' : 'chevronDown', 16)}`;
  $('#agendaLater').hidden = !laterOpen || !later.length;
  $('#agendaLater').innerHTML = laterOpen ? later.map(agendaHtml).join('') : '';
}

/* ---------- Calendrier du mois ---------- */
const monthBounds = month => {
  const [y, m] = month.split('-').map(Number);
  return [`${month}-01`, dateKey(new Date(y, m, 0, 12))];
};
const shiftMonth = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  return dateKey(new Date(y, m - 1 + n, 1, 12)).slice(0, 7);
};

/** Tout ce qui tombe dans le mois, par jour : { 'AAAA-MM-JJ': [{ kind, …élément, date }] }. */
function monthItems(month) {
  const [from, to] = monthBounds(month);
  const byDay = {};
  const add = (date, item) => (byDay[date] ||= []).push({ ...item, date });
  ['appointments', 'events'].forEach(kind => state.dashboard[kind].forEach(x => occurrencesBetween(x, from, to).forEach(d => add(d, { ...x, kind }))));
  (state.races || []).filter(r => r.date >= from && r.date <= to).forEach(r => add(r.date, { ...r, kind: 'races' }));
  state.dashboard.tasks.filter(t => t.date && !t.done).forEach(t => occurrencesBetween(t, from, to).forEach(d => add(d, { ...t, kind: 'tasks' })));
  datedAlerts().filter(a => a.due >= from && a.due <= to).forEach(a => add(a.due, { ...a, kind: a.source }));
  Object.values(byDay).forEach(list => list.sort((a, b) => (a.time || '99').localeCompare(b.time || '99')));
  return byDay;
}

function dayItemHtml(x) {
  if (x.kind === 'appointments' || x.kind === 'events') return itemCard(x, x.kind);
  if (x.kind === 'races') return raceItem(x);
  if (x.kind === 'tasks') {
    return `<div class="cal-row is-tappable" data-id="${esc(x.id)}" data-type="tasks" tabindex="0" aria-label="Modifier « ${esc(x.title)} »"><span class="cal-dot cal-dot--tasks"></span><div class="task__body"><div class="task__title">${esc(x.title)}</div><div class="task__sub"><span>Tâche${x.time ? ` · ${x.time}` : ''}${isRepeat(x.repeat) ? ` · ${REPEATS[x.repeat].label.toLowerCase()}` : ''}</span></div></div>${icon('chevronRight', 16)}</div>`;
  }
  const url = x.kind === 'garage' ? GARAGE_URL : `${MAISON_URL}#/entretien`;
  return `<a class="cal-row" href="${url}"><span class="cal-dot cal-dot--${x.kind}"></span><div class="task__body"><div class="task__title">${x.owner ? `${esc(x.owner)} · ` : ''}${esc(x.title)}</div><div class="task__sub"><span>${x.kind === 'garage' ? 'Garage' : 'Maison'} · ${esc(x.text)}</span></div></div></a>`;
}

const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const KIND_ORDER = ['appointments', 'events', 'races', 'tasks', 'garage', 'maison'];

function renderMonthCalendar() {
  const byDay = monthItems(calMonth);
  const [from, to] = monthBounds(calMonth);
  if (calDay < from || calDay > to) calDay = todayKey().startsWith(calMonth) ? todayKey() : '';
  const first = fromKey(from);
  const lead = (first.getDay() + 6) % 7; // lundi = 0
  const days = Number(to.slice(8, 10));
  const today = todayKey();
  const cells = Array.from({ length: lead }, () => '<span class="mcal__pad"></span>');
  for (let n = 1; n <= days; n++) {
    const key = `${calMonth}-${String(n).padStart(2, '0')}`;
    const kinds = [...new Set((byDay[key] || []).map(x => x.kind))].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
    const urgency = (byDay[key] || []).some(x => x.kind === 'appointments' || x.kind === 'events' || x.kind === 'races') ? urgencyOf(key) : '';
    cells.push(`<button type="button" class="mcal__day ${key === today ? 'is-today' : ''} ${key < today ? 'is-past' : ''} ${urgency ? `is-${urgency}` : ''}" data-cal-day="${key}" aria-pressed="${key === calDay}" aria-label="${esc(formatKey(key, { weekday: 'long', day: 'numeric', month: 'long' }))}${kinds.length ? ` · ${byDay[key].length} élément${byDay[key].length > 1 ? 's' : ''}` : ''}">
      <span class="mcal__num">${n}</span><span class="mcal__dots">${kinds.slice(0, 4).map(k => `<i class="cal-dot cal-dot--${k}"></i>`).join('')}</span></button>`);
  }
  const label = formatKey(from, { month: 'long', year: 'numeric' });
  $('#monthCal').innerHTML = `
    <div class="mcal__nav">
      <button type="button" class="icon-btn" data-cal-step="-1" aria-label="Mois précédent">${icon('chevronLeft', 20)}</button>
      <strong class="mcal__title">${esc(label.charAt(0).toUpperCase() + label.slice(1))}</strong>
      <button type="button" class="icon-btn" data-cal-step="1" aria-label="Mois suivant">${icon('chevronRight', 20)}</button>
    </div>
    <div class="mcal__week">${WEEKDAYS.map(d => `<span>${d}</span>`).join('')}</div>
    <div class="mcal__grid">${cells.join('')}</div>
    <div class="mcal__legend"><span><i class="cal-dot cal-dot--appointments"></i>RDV</span><span><i class="cal-dot cal-dot--events"></i>Événement</span><span><i class="cal-dot cal-dot--races"></i>Course</span><span><i class="cal-dot cal-dot--tasks"></i>Tâche</span><span><i class="cal-dot cal-dot--garage"></i>Garage / maison</span></div>`;
  const list = calDay ? byDay[calDay] || [] : [];
  $('#monthCalDay').innerHTML = calDay
    ? `<h3 class="group-title">${esc(formatKey(calDay, { weekday: 'long', day: 'numeric', month: 'long' }))}</h3>${list.length ? `<div class="stack">${list.map(dayItemHtml).join('')}</div>` : '<div class="empty-state"><p>Rien ce jour-là.</p></div>'}`
    : '';
}

function renderAgenda() {
  $$('#agendaMode [data-agenda-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.agendaMode === agendaMode)));
  $('#agendaListPanel').hidden = agendaMode !== 'list';
  $('#agendaMonthPanel').hidden = agendaMode !== 'month';
  if (agendaMode === 'month') renderMonthCalendar();
  else renderAgendaList();
}

/** Sous-titre d'une tâche : échéance, périodicité, devenir une fois cochée. */
function taskSub(t) {
  const overdue = !t.done && t.date && t.date < todayKey();
  const when = t.date ? `${formatKey(t.date, { weekday: 'short', day: 'numeric', month: 'short' })}${t.time ? ` · ${t.time}` : ''}` : '';
  const parts = [when ? `<span class="${overdue ? 'is-overdue' : ''}">${when}</span>` : ''];
  if (isRepeat(t.repeat)) parts.push(`<span class="task__repeat">${icon('repeat', 12)}${REPEATS[t.repeat].label}</span>`);
  if (t.done) parts.push(`<span>${isRepeat(t.repeat) && t.date ? `Revient le ${formatKey(nextTaskDate(t), { day: 'numeric', month: 'short' })}` : 'Disparaît demain'}</span>`);
  else if (t.note) parts.push(`<span>${esc(t.note)}</span>`);
  return parts.filter(Boolean).join('');
}

function renderTasks() {
  const tasks = state.dashboard.tasks;
  const done = tasks.filter(t => t.done).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  $('#taskProgress').innerHTML = tasks.length
    ? `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Progression des tâches"><div class="progress__bar" style="--value:${pct}%"></div></div><span class="progress__label">${done}/${tasks.length}</span>`
    : '';
  const el = $('#tasks');
  if (!tasks.length) {
    el.innerHTML = `<div class="empty-state"><p>Aucune tâche. Écrivez-en une ci-dessus.</p></div>`;
    return;
  }
  const sorted = [...tasks].sort((a, b) => Number(a.done) - Number(b.done) || (a.date || '9999').localeCompare(b.date || '9999'));
  el.innerHTML = sorted
    .map(t => {
      const sub = taskSub(t);
      // Cocher : le rond ; modifier ou supprimer : un appui sur la ligne.
      return `<div class="task is-tappable ${t.done ? 'is-done' : ''}" data-id="${esc(t.id)}" data-type="tasks" tabindex="0" aria-label="Modifier « ${esc(t.title)} »">
        <button type="button" class="task__check" data-action="toggle" role="checkbox" aria-checked="${t.done}" aria-label="${t.done ? 'Marquer comme à faire' : 'Marquer comme terminée'}">${icon('check', 15)}</button>
        <div class="task__body"><div class="task__title">${esc(t.title)}</div>${sub ? `<div class="task__sub">${sub}</div>` : ''}</div>
        ${canOpenReminders(t) ? `<div class="item-card__actions"><button type="button" class="icon-btn" data-action="reminder" aria-label="Ouvrir Rappels pour « ${esc(t.title)} »" title="Ouvrir Rappels">${icon('bell', 17)}</button></div>` : ''}
      </div>`;
    })
    .join('');
}

export function renderNotes() {
  const el = $('#notes');
  if (document.activeElement !== el && el.value !== state.notes) el.value = state.notes;
}

export function renderDashboard() {
  renderToday();
  renderAgenda();
  renderTasks();
  if (isOpen('archiveSheet')) renderArchive();
}

/* ---------- Archive ---------- */
function renderArchive() {
  const { type, tab } = archive;
  $('#archiveTitle').textContent = type === 'appointments' ? 'Rendez-vous' : 'Événements';
  $$('#archiveSheet [data-archive-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.archiveTab === tab)));
  const items = tab === 'upcoming' ? upcoming(type) : past(type);
  const host = $('#archiveContent');
  if (!items.length) {
    host.innerHTML = `<div class="empty-state"><p>Aucun élément ${tab === 'upcoming' ? 'à venir' : 'passé'}.</p></div>`;
    return;
  }
  const groups = new Map();
  items.forEach(x => {
    const y = x.date.slice(0, 4);
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push(x);
  });
  host.innerHTML = [...groups]
    .map(([year, list]) => `<h3 class="group-title">${year}</h3><div class="stack">${list.map(x => itemCard(x, type)).join('')}</div>`)
    .join('');
}

/* ---------- Formulaire ---------- */
function openEditor(type, id = null) {
  const item = id ? state.dashboard[type].find(x => x.id === id) : null;
  if (id && !item) return toastError('Cet élément n’existe plus.');
  const form = $('#itemForm');
  form.reset();
  clearErrors(form);
  form.elements.type.value = type;
  form.elements.editId.value = id || '';
  $('#itemTitle').textContent = item ? TYPES[type].edit : TYPES[type].add;
  const isTask = type === 'tasks';
  form.dataset.kind = type;
  $('#itemDateLabel').textContent = isTask ? 'Échéance (facultatif)' : 'Date';
  $('#itemTimeLabel').innerHTML = isTask ? 'Heure <span class="field__opt">(facultatif)</span>' : 'Début';
  form.elements.date.required = !isTask;
  $('#itemTitleInput').placeholder = isTask ? 'Ex. Appeler le garage' : type === 'appointments' ? 'Ex. Dentiste' : 'Ex. Dîner entre amis';
  $('#itemRepeatHelp').hidden = !isTask;
  if (item) ['title', 'date', 'time', 'endTime', 'repeat', 'location', 'note'].forEach(k => (form.elements[k].value = item[k] || ''));
  else if (!isTask) form.elements.date.value = todayKey();
  // Une répétition déjà choisie reste visible : le volet « Plus de détails » s'ouvre.
  $('#itemMore').open = Boolean(item && (item.repeat || item.note || item.endTime || item.location));
  $('#itemDelete').hidden = !item;
  openSheet('itemSheet');
}

const itemSchema = type => {
  const isTask = type === 'tasks';
  return {
    title: [rules.required('Le titre'), rules.maxLength(100)],
    date: [rules.date({ required: !isTask })],
    time: [rules.time()],
    endTime: [
      rules.time(),
      (v, all) => (v && !all.time ? 'Indiquez d’abord l’heure de début.' : null),
      (v, all) => (v && all.time && v <= all.time ? 'L’heure de fin doit être après le début.' : null)
    ],
    repeat: [v => (!v || isRepeat(v) ? null : 'Périodicité invalide.'), (v, all) => (v && isTask && !all.date ? 'Indiquez une échéance pour répéter la tâche.' : null)],
    location: [rules.maxLength(120)],
    note: [rules.maxLength(500)]
  };
};

async function onSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const v = formValues(form);
  const type = v.type;
  if (!TYPES[type]) return;
  const isTask = type === 'tasks';
  if (isTask) Object.assign(v, { endTime: '', location: '' });
  if (isTask && v.time && !v.date) return showErrors(form, { time: 'Indiquez aussi une date d’échéance.' });

  const { valid, errors } = validate(v, itemSchema(type));
  if (!valid) return showErrors(form, errors);

  const list = state.dashboard[type];
  const existing = v.editId ? list.find(x => x.id === v.editId) : null;
  const item = { id: existing?.id || uid(), title: v.title, date: v.date, time: v.time, note: v.note };
  if (v.repeat) item.repeat = v.repeat;
  if (!isTask) {
    if (v.endTime) item.endTime = v.endTime;
    if (v.location) item.location = v.location;
  } else {
    item.done = existing?.done ?? false; // l'état « terminée » n'est pas perdu à l'édition
    if (item.done && existing?.doneAt) item.doneAt = existing.doneAt;
    // Première échéance d'une tâche répétée : conservée tant que la date et la périodicité ne changent pas.
    if (item.repeat) item.anchor = existing?.repeat === item.repeat && existing?.date === item.date ? existing.anchor || item.date : item.date;
  }

  if (existing) list[list.indexOf(existing)] = item;
  else list.push(item);

  const submit = form.querySelector('[type=submit]');
  submit.classList.add('is-loading');
  submit.disabled = true;
  commit('dashboard');
  // Rendez-vous : on attend la confirmation Firebase avant de proposer l'export calendrier.
  const synced = type === 'appointments' ? await confirmSaved() : null;
  submit.classList.remove('is-loading');
  submit.disabled = false;
  closeSheet('itemSheet');

  if (type === 'appointments' && item.date) {
    offerCalendar(toCalendarEvent(item, type), { heading: existing ? 'Rendez-vous modifié' : 'Rendez-vous enregistré', synced });
  } else {
    toast(existing ? 'Modifications enregistrées' : `${TYPES[type].one} ajouté${type === 'events' ? '' : type === 'tasks' ? 'e' : ''}`);
  }
}

/* ---------- Actions ---------- */
async function removeItem(type, id) {
  const list = state.dashboard[type];
  const item = list?.find(x => x.id === id);
  if (!item) return false;
  if (!(await confirmDialog({ title: `Supprimer « ${item.title} » ?`, message: 'Cette action est définitive.', confirmLabel: 'Supprimer', danger: true }))) return false;
  state.dashboard[type] = list.filter(x => x.id !== id);
  commit('dashboard');
  toast('Élément supprimé');
  return true;
}

/** Saisie express : titre + Entrée. Champ vide : formulaire complet (date, répétition…). */
function onQuickTask(e) {
  e.preventDefault();
  const input = e.currentTarget.elements.title;
  const title = input.value.trim().slice(0, 100);
  if (!title) return openEditor('tasks');
  state.dashboard.tasks.push({ id: uid(), title, date: '', time: '', note: '', done: false });
  commit('dashboard');
  input.value = '';
}

async function onClick(e) {
  if (e.target.closest('#agendaMore')) {
    laterOpen = !laterOpen;
    return renderAgenda();
  }
  const mode = e.target.closest('[data-agenda-mode]');
  if (mode) {
    agendaMode = mode.dataset.agendaMode;
    write(AGENDA_MODE_KEY, agendaMode);
    return renderAgenda();
  }
  const step = e.target.closest('[data-cal-step]');
  if (step) {
    calMonth = shiftMonth(calMonth, Number(step.dataset.calStep));
    calDay = todayKey().startsWith(calMonth) ? todayKey() : `${calMonth}-01`;
    return renderAgenda();
  }
  const day = e.target.closest('[data-cal-day]');
  if (day) {
    calDay = day.dataset.calDay;
    return renderAgenda();
  }
  const open = e.target.closest('[data-open]');
  if (open) return openEditor(open.dataset.open);
  const viewAll = e.target.closest('[data-view-all]');
  if (viewAll) {
    archive = { type: viewAll.dataset.viewAll, tab: upcoming(viewAll.dataset.viewAll).length ? 'upcoming' : 'past' };
    renderArchive();
    return openSheet('archiveSheet', { focus: false });
  }
  const tab = e.target.closest('[data-archive-tab]');
  if (tab) {
    archive.tab = tab.dataset.archiveTab;
    return renderArchive();
  }
  const btn = e.target.closest('[data-action]');
  // Sans bouton : un appui sur une carte ou une ligne ouvre sa modification.
  const host = btn ? btn.closest('[data-id]') : e.target.closest('.is-tappable[data-id]');
  if (!host) return;
  const { id, type } = host.dataset;
  const list = state.dashboard[type];
  const item = list?.find(x => x.id === id);
  if (!item) return;

  switch (btn ? btn.dataset.action : 'edit') {
    case 'toggle':
      item.done = !item.done;
      // Cochée : reste visible (barrée) aujourd'hui, puis disparaît — ou repart si elle est répétée (features/task-tidy.js).
      if (item.done) item.doneAt = todayKey();
      else delete item.doneAt;
      commit('dashboard');
      break;
    case 'edit':
      if (isOpen('archiveSheet')) closeSheet('archiveSheet');
      openEditor(type, id);
      break;
    case 'reminder':
      openReminders(item);
      break;
    case 'calendar':
      offerCalendar(toCalendarEvent(item, type), { heading: 'Ajouter au calendrier ?' });
      break;
  }
}

/** Clavier : Entrée sur une carte ou une ligne = modifier. */
function onKey(e) {
  if (e.key !== 'Enter' || !e.target.matches?.('.is-tappable[data-id]')) return;
  e.preventDefault();
  e.target.click();
}

export function initDashboard() {
  ['#dashboardView', '#tasksView', '#archiveSheet'].forEach(sel => {
    $(sel).addEventListener('click', onClick);
    $(sel).addEventListener('keydown', onKey);
  });
  $('#itemForm').addEventListener('submit', onSubmit);
  $('#taskQuick').addEventListener('submit', onQuickTask);
  $('#itemDelete').addEventListener('click', async () => {
    const form = $('#itemForm');
    if (await removeItem(form.elements.type.value, form.elements.editId.value)) closeSheet('itemSheet');
  });

  const notes = $('#notes');
  const status = $('#notesStatus');
  const markSaved = debounce(() => {
    status.textContent = 'Enregistré';
    status.classList.remove('is-saving');
  }, 900);
  notes.addEventListener('input', () => {
    status.textContent = 'Enregistrement…';
    status.classList.add('is-saving');
    state.notes = notes.value.slice(0, 20000);
    commit('notes');
    markSaved();
  });
}
