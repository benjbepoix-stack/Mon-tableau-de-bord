/* Accueil « Horizon » (séance du jour, retards, radar des 14 jours, aujourd'hui, bientôt, notes),
   Agenda (calendrier du mois, tâches) et bouton + (saisie express). */
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
import { datedAlerts, lateAlerts, GARAGE_URL, MAISON_URL } from '../features/linked-apps.js';

export const ALLURE_URL = 'https://benjbepoix-stack.github.io/Allure/';
/** Accueil : radar et « Bientôt » sur 14 jours (aujourd'hui compris) ; au-delà, l'Agenda. */
const RADAR_DAYS = 14;
const SOON_MAX = 6;
/** Échéance proche : carte encadrée en couleur (rouge aujourd'hui / demain, ambre jusqu'à 10 jours). */
const SOON_DAYS = 10;
const URGENT_DAYS = 1;
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
const sessionFacts = x => [x.distance ? `${String(x.distance).replace('.', ',')} km` : '', x.time ? x.time.replace(/^0(\d)/, '$1').replace(':', ' h ') : '', x.elevation ? `${x.elevation} m D+` : ''].filter(Boolean).join(' · ');
function renderToday() {
  const key = todayKey();
  const families = state.families || [];
  const sessions = (Array.isArray(state.plans?.[key]) ? state.plans[key] : []).filter(x => x.training);
  const phase = phaseOn(key);
  const races = racesOn(key);
  // Course d'abord, puis séances : le sport en gros, la séance et ses chiffres en dessous.
  const items = [
    ...races.map(r => ({ big: r.name, small: ['Course', r.time ? `départ ${r.time}` : ''].filter(Boolean).join(' · ') })),
    ...sessions.map(x => {
      if (isRestTraining(x.training)) return { big: REST_TRAINING.replace(' - ', '\u00a0– '), small: '', rest: true };
      const f = families.find(a => a.id === x.family);
      return { big: f ? f.name : x.training, small: [f ? x.training : '', sessionFacts(x)].filter(Boolean).join(' · ') };
    })
  ];
  const [main, ...more] = items;
  const phaseTag = phase ? ` · ${esc(PHASE_TYPES[phase.type].short)}` : '';
  const week = label => `<button type="button" class="today-card__link" data-goto="trainingView">${label} ${icon('chevronRight', 14)}</button>`;
  $('#todaySession').innerHTML = main
    ? `<div class="today-card__kicker">${races.length ? 'Course du jour' : items.every(i => i.rest) ? 'Aujourd’hui' : 'Séance du jour'}${phaseTag}</div>
    <h2 class="today-card__title">${esc(main.big)}<span class="today-card__pill" aria-hidden="true"></span></h2>
    ${main.small ? `<p class="today-card__facts">${esc(main.small)}</p>` : ''}
    ${more.map(m => `<p class="today-card__more">${esc(m.big)}${m.small ? ` · ${esc(m.small)}` : ''}</p>`).join('')}
    ${week('Voir la semaine')}`
    : `<div class="today-card__kicker">Aujourd’hui${phaseTag}</div>
    <h2 class="today-card__title">Journée libre<span class="today-card__pill" aria-hidden="true"></span></h2>
    ${week('Planifier une séance')}`;
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

/* ---------- Calendrier du mois ---------- */
const monthBounds = month => {
  const [y, m] = month.split('-').map(Number);
  return [`${month}-01`, dateKey(new Date(y, m, 0, 12))];
};
const shiftMonth = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  return dateKey(new Date(y, m - 1 + n, 1, 12)).slice(0, 7);
};

/** Tout ce qui tombe entre deux jours inclus, par jour : { 'AAAA-MM-JJ': [{ kind, …élément, date }] }. */
function itemsBetween(from, to) {
  const byDay = {};
  const add = (date, item) => (byDay[date] ||= []).push({ ...item, date });
  ['appointments', 'events'].forEach(kind => state.dashboard[kind].forEach(x => occurrencesBetween(x, from, to).forEach(d => add(d, { ...x, kind }))));
  (state.races || []).filter(r => r.date >= from && r.date <= to).forEach(r => add(r.date, { ...r, kind: 'races' }));
  state.dashboard.tasks.filter(t => t.date && !t.done).forEach(t => occurrencesBetween(t, from, to).forEach(d => add(d, { ...t, kind: 'tasks' })));
  datedAlerts().filter(a => a.due >= from && a.due <= to).forEach(a => add(a.due, { ...a, kind: a.source }));
  Object.values(byDay).forEach(list => list.sort((a, b) => (a.time || '99').localeCompare(b.time || '99')));
  return byDay;
}
const monthItems = month => itemsBetween(...monthBounds(month));

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

/* ---------- Accueil « Horizon » : retards, radar des 14 jours, aujourd'hui, bientôt ---------- */
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const shortDay = key => formatKey(key, { weekday: 'short', day: 'numeric' });
const lateLabel = key => `−${Math.max(1, -daysUntil(key))} j`;
const overdueTasks = () => state.dashboard.tasks.filter(t => !t.done && t.date && t.date < todayKey()).sort((a, b) => a.date.localeCompare(b.date));
const RADAR_LETTERS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];

/** Une ligne de l'accueil ou d'un jour : tâche cochable, RDV / événement modifiable, course, séance, échéance Garage / Maison. */
function homeRow(x, when = '', tone = '') {
  const end = when ? `<span class="hrow__when">${esc(when)}</span>` : '';
  const cls = `hrow${tone ? ` is-${tone}` : ''}`;
  const body = (title, sub) => `<div class="hrow__body"><div class="hrow__title">${esc(title)}</div>${sub ? `<div class="hrow__sub">${esc(sub)}</div>` : ''}</div>`;
  if (x.kind === 'tasks') {
    return `<div class="${cls} is-tappable" data-id="${esc(x.id)}" data-type="tasks" tabindex="0" aria-label="Modifier « ${esc(x.title)} »">
      <button type="button" class="hrow__check" data-action="toggle" role="checkbox" aria-checked="false" aria-label="Marquer « ${esc(x.title)} » comme faite">${icon('check', 14)}</button>
      ${body(x.title, isRepeat(x.repeat) ? REPEATS[x.repeat].label : x.note)}${end}</div>`;
  }
  if (x.kind === 'appointments' || x.kind === 'events') {
    return `<div class="${cls} is-tappable" data-id="${esc(x.id)}" data-type="${x.kind}" tabindex="0" aria-label="Modifier « ${esc(x.title)} »">
      <span class="hrow__icon">${icon(x.kind === 'appointments' ? 'clock' : 'sparkle', 18)}</span>
      ${body(x.title, [x.kind === 'appointments' ? 'Rendez-vous' : 'Événement', x.location].filter(Boolean).join(' · '))}${end}</div>`;
  }
  if (x.kind === 'races') {
    return `<a class="${cls}" href="${ALLURE_URL}"><span class="hrow__icon is-accent">${icon('flag', 18)}</span>${body(x.name, ['Course', x.distance ? `${String(x.distance).replace('.', ',')} km` : ''].filter(Boolean).join(' · '))}${end}</a>`;
  }
  if (x.kind === 'session') {
    return `<button type="button" class="${cls}" data-goto="trainingView"><span class="hrow__icon is-accent">${icon('training', 18)}</span>${body(x.title, x.sub)}${end}</button>`;
  }
  // Échéance publiée par Mon Garage ou Ma Maison : un appui ouvre l'app.
  const garage = (x.source || x.kind) === 'garage';
  return `<a class="${cls}" href="${garage ? GARAGE_URL : `${MAISON_URL}#/entretien`}"><span class="hrow__icon">${icon(garage ? 'car' : 'house', 18)}</span>${body(x.title, [garage ? 'Garage' : 'Maison', x.owner].filter(Boolean).join(' · '))}${end}</a>`;
}

function renderRadar(today, byDay) {
  const start = fromKey(today);
  $('#homeRadar').innerHTML = Array.from({ length: RADAR_DAYS }, (_, i) => {
    const d = addDays(start, i);
    const key = dateKey(d);
    const n = (byDay[key] || []).length;
    const label = `${formatKey(key, { weekday: 'long', day: 'numeric', month: 'long' })}${n ? ` · ${n} chose${n > 1 ? 's' : ''} prévue${n > 1 ? 's' : ''}` : ''}`;
    return `<button type="button" class="hz-day${i === 0 ? ' is-today' : ''}${d.getDay() % 6 === 0 ? ' is-weekend' : ''}" data-radar-day="${key}" aria-label="${esc(label)}"><small>${RADAR_LETTERS[d.getDay()]}</small><b>${d.getDate()}</b><span class="hz-pips">${'<i></i>'.repeat(Math.min(n, 3))}</span></button>`;
  }).join('');
  const m1 = formatDate(start, { month: 'long' });
  const m2 = formatDate(addDays(start, RADAR_DAYS - 1), { month: 'long' });
  $('#radarMonth').textContent = m1 === m2 ? cap(m1) : `${cap(m1)} – ${m2}`;
}

function renderHome() {
  const today = todayKey();
  // En retard : les tâches de Carnet (cochables ici) et les entretiens publiés par Garage / Maison.
  const late = [...overdueTasks().map(t => ({ ...t, kind: 'tasks' })), ...lateAlerts()];
  const lateEl = $('#homeLate');
  lateEl.hidden = !late.length;
  lateEl.innerHTML = late.length
    ? `<h2 class="hz-cap">En retard · ${late.length}</h2>${late.map(x => homeRow(x, x.kind === 'tasks' ? lateLabel(x.date) : x.due ? lateLabel(x.due) : 'Retard', 'late')).join('')}`
    : '';

  const byDay = itemsBetween(today, dateKey(addDays(fromKey(today), RADAR_DAYS - 1)));
  renderRadar(today, byDay);
  const todays = byDay[today] || [];
  $('#homeToday').innerHTML = todays.length ? todays.map(x => homeRow(x, x.time || '', 'today')).join('') : '<p class="hz-empty">Rien d’autre aujourd’hui.</p>';

  // Bientôt : une tâche répétée n'apparaît qu'à sa prochaine échéance.
  const seen = new Set();
  const soon = Object.keys(byDay)
    .filter(k => k > today)
    .sort()
    .flatMap(k => byDay[k])
    .filter(x => (x.kind === 'tasks' ? !seen.has(x.id) && seen.add(x.id) : true));
  $('#homeSoon').innerHTML = soon.length
    ? soon
        .slice(0, SOON_MAX)
        .map(x => homeRow(x, `${shortDay(x.date)}${x.time ? ` · ${x.time}` : ''}`))
        .join('') + (soon.length > SOON_MAX ? `<button type="button" class="hz-more" data-goto="tasksView">${soon.length - SOON_MAX} de plus dans l’agenda</button>` : '')
    : '<p class="hz-empty">Rien de prévu dans les deux semaines.</p>';
}

/* ---------- Un jour du radar ---------- */
let dayOpen = '';

function openDay(key) {
  dayOpen = key;
  renderDay();
  openSheet('daySheet', { focus: false });
}

function renderDay() {
  const key = dayOpen;
  const diff = daysUntil(key);
  $('#dayKicker').textContent = diff === 0 ? 'Aujourd’hui' : diff === 1 ? 'Demain' : `Dans ${diff} jours`;
  $('#dayTitle').textContent = cap(formatKey(key, { weekday: 'long', day: 'numeric', month: 'long' }));
  const phase = phaseOn(key);
  const sessions = (Array.isArray(state.plans?.[key]) ? state.plans[key] : [])
    .filter(x => x.training && !isRestTraining(x.training))
    .map(x => {
      const f = (state.families || []).find(a => a.id === x.family);
      return { kind: 'session', title: f ? `${f.name} · ${x.training}` : x.training, sub: sessionFacts(x) };
    });
  const rows = [...sessions, ...(itemsBetween(key, key)[key] || [])];
  $('#dayContent').innerHTML = `${phase ? `<p class="day-phase"><b>${esc(PHASE_TYPES[phase.type].short)}</b>${esc(PHASE_TYPES[phase.type].advice || '')}</p>` : ''}${
    rows.length ? `<div class="hz-list">${rows.map(x => homeRow(x, x.time && x.kind !== 'session' ? x.time : '')).join('')}</div>` : '<p class="hz-empty">Rien de prévu ce jour-là.</p>'
  }`;
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
    el.innerHTML = `<div class="empty-state"><p>Aucune tâche.</p></div>`;
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
  renderHome();
  renderMonthCalendar();
  renderTasks();
  if (isOpen('archiveSheet')) renderArchive();
  if (isOpen('daySheet')) renderDay();
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

/* ---------- Bouton + : tâche express avec échéance en un appui, puis les autres saisies ---------- */
let addDate = '';
/** Jour choisi depuis le radar (« Ajouter ce jour-là ») : proposé en premier. */
let addDay = '';

function nextSaturday() {
  const d = new Date();
  return dateKey(addDays(d, (6 - d.getDay() + 7) % 7 || 7));
}

function whenChoices() {
  const sat = nextSaturday();
  const list = [
    { key: '', label: 'Sans date' },
    { key: todayKey(), label: 'Aujourd’hui' },
    { key: dateKey(addDays(new Date(), 1)), label: 'Demain' },
    { key: sat, label: cap(shortDay(sat)) }
  ];
  if (addDay && !list.some(c => c.key === addDay)) list.splice(1, 0, { key: addDay, label: cap(formatKey(addDay, { weekday: 'short', day: 'numeric', month: 'short' })) });
  return list;
}

function renderWhen() {
  $('#addWhen').innerHTML =
    whenChoices()
      .map(c => `<button type="button" class="add-chip" role="radio" aria-checked="${c.key === addDate}" data-when="${c.key}">${c.key === addDate ? icon('check', 14) : ''}${esc(c.label)}</button>`)
      .join('') + '<button type="button" class="add-chip add-chip--more" data-when-more>Autre…</button>';
}

export function openAdd(date = '') {
  addDay = date;
  addDate = date;
  $('#addQuick').reset();
  renderWhen();
  openSheet('addSheet');
}

function onAddSubmit(e) {
  e.preventDefault();
  const input = $('#addTask');
  const title = input.value.trim().slice(0, 100);
  if (!title) return input.focus();
  state.dashboard.tasks.push({ id: uid(), title, date: addDate, time: '', note: '', done: false });
  commit('dashboard');
  input.value = '';
  closeSheet('addSheet');
  toast(addDate ? `Tâche ajoutée · ${relativeDay(addDate).toLowerCase()}` : 'Tâche ajoutée');
}

function onAddClick(e) {
  const when = e.target.closest('[data-when]');
  if (when) {
    addDate = when.dataset.when;
    return renderWhen();
  }
  const date = addDay || addDate;
  if (e.target.closest('[data-when-more]')) {
    // Autre date, heure ou répétition : le formulaire complet, titre déjà saisi.
    const title = $('#addTask').value.trim();
    closeSheet('addSheet');
    openEditor('tasks');
    $('#itemTitleInput').value = title;
    if (date) $('#itemForm').elements.date.value = date;
    return;
  }
  const add = e.target.closest('[data-add]');
  if (!add) return;
  closeSheet('addSheet');
  const kind = add.dataset.add;
  if (kind === 'appointments' || kind === 'events') {
    openEditor(kind);
    if (addDay) $('#itemForm').elements.date.value = addDay;
  } else if (kind === 'session') {
    $('[data-view="trainingView"]').click();
    requestAnimationFrame(() => $('[data-action="week-today"]')?.click());
  } else if (kind === 'note') {
    $('[data-view="dashboardView"]').click();
    setTimeout(() => {
      const notes = $('#notes');
      notes.scrollIntoView({ behavior: 'smooth', block: 'center' });
      notes.focus({ preventScroll: true });
    }, 80);
  }
}

function initAdd() {
  $('#fabAdd').addEventListener('click', () => openAdd());
  $('#addQuick').addEventListener('submit', onAddSubmit);
  $('#addSheet').addEventListener('click', onAddClick);
  $('#dayAdd').addEventListener('click', () => {
    const key = dayOpen;
    closeSheet('daySheet');
    openAdd(key);
  });
  // Une séance touchée dans la feuille d'un jour mène au planning : la feuille se ferme.
  $('#daySheet').addEventListener('click', e => e.target.closest('[data-goto]') && closeSheet('daySheet'));
}

async function onClick(e) {
  const radar = e.target.closest('[data-radar-day]');
  if (radar) return openDay(radar.dataset.radarDay);
  const step = e.target.closest('[data-cal-step]');
  if (step) {
    calMonth = shiftMonth(calMonth, Number(step.dataset.calStep));
    calDay = todayKey().startsWith(calMonth) ? todayKey() : `${calMonth}-01`;
    return renderMonthCalendar();
  }
  const day = e.target.closest('[data-cal-day]');
  if (day) {
    calDay = day.dataset.calDay;
    return renderMonthCalendar();
  }
  const open = e.target.closest('[data-open]');
  if (open) {
    if (isOpen('daySheet')) closeSheet('daySheet');
    return openEditor(open.dataset.open);
  }
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
      if (isOpen('daySheet')) closeSheet('daySheet');
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
  ['#dashboardView', '#tasksView', '#archiveSheet', '#daySheet'].forEach(sel => {
    $(sel).addEventListener('click', onClick);
    $(sel).addEventListener('keydown', onKey);
  });
  $('#itemForm').addEventListener('submit', onSubmit);
  initAdd();
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
