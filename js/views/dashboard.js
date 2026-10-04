/* Vue Dashboard : prochain rendez-vous / événement, tâches, notes. */
import { $, $$, esc, uid, debounce } from '../core/utils.js';
import { combine, formatDate, formatKey, fromKey, relativeDay, daysUntil, todayKey, isRepeat, nextOccurrenceKey, REPEATS } from '../core/dates.js';
import { state, commit } from '../core/store.js';
import { rules, validate, showErrors, clearErrors, formValues } from '../core/validation.js';
import { openSheet, closeSheet, confirmDialog, isOpen } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';
import { icon } from '../ui/icons.js';
import { canOpenReminders, openReminders } from '../features/reminders.js';
import { offerCalendar } from '../features/calendar-prompt.js';
import { confirmSaved } from '../features/persist.js';

const TYPES = {
  tasks: { add: 'Nouvelle tâche', edit: 'Modifier la tâche', one: 'Tâche', none: 'Aucune tâche' },
  appointments: { add: 'Nouveau rendez-vous', edit: 'Modifier le rendez-vous', one: 'Rendez-vous', none: 'Aucun rendez-vous à venir' },
  events: { add: 'Nouvel événement', edit: 'Modifier l’événement', one: 'Événement', none: 'Aucun événement à venir' }
};

let archive = { type: 'appointments', tab: 'upcoming' };
const SOON_DAYS = 10;

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

function itemCard(x, type, { featured = false } = {}) {
  const d = fromKey(x.date);
  const diff = x.date ? daysUntil(x.date) : null;
  const soon = diff !== null && diff >= 0 && diff <= SOON_DAYS;
  const chip = d
    ? `<div class="date-chip date-chip--${type} ${soon ? 'is-soon' : ''}"><span class="date-chip__day">${d.getDate()}</span><span class="date-chip__month">${formatDate(d, { month: 'short' })}</span></div>`
    : '';
  const meta = [x.date ? `<span class="tag tag--${type} ${soon ? 'is-soon' : ''}">${soon ? icon('alert', 12) : ''}${relativeDay(x.date)}</span>` : '', timeLabel(x) ? `<span>${icon('clock', 13)}${timeLabel(x)}</span>` : '', isRepeat(x.repeat) ? `<span>${icon('repeat', 13)}${REPEATS[x.repeat].label}</span>` : '', x.location ? `<span>${icon('pin', 13)}${esc(x.location)}</span>` : '']
    .filter(Boolean)
    .join('');
  return `<article class="item-card ${featured ? 'item-card--featured' : ''} ${soon ? 'item-card--soon' : ''}" data-id="${esc(x.id)}" data-type="${type}">
    ${chip}
    <div class="item-card__body">
      <h3 class="item-card__title">${esc(x.title)}</h3>
      ${meta ? `<div class="item-card__meta">${meta}</div>` : ''}
      ${x.note ? `<p class="item-card__note">${esc(x.note)}</p>` : ''}
    </div>
    <div class="item-card__actions">
      ${x.date ? `<button type="button" class="icon-btn" data-action="calendar" aria-label="Ajouter « ${esc(x.title)} » au calendrier">${icon('calendarPlus', 18)}</button>` : ''}
      <button type="button" class="icon-btn" data-action="edit" aria-label="Modifier">${icon('edit', 18)}</button>
      <button type="button" class="icon-btn icon-btn--danger" data-action="delete" aria-label="Supprimer">${icon('trash', 18)}</button>
    </div>
  </article>`;
}

function renderHighlight(type, selector) {
  const next = upcoming(type)[0];
  const count = upcoming(type).length;
  $(selector).innerHTML = next
    ? itemCard(next, type, { featured: true })
    : `<div class="empty-state"><span class="empty-state__icon">${icon(type === 'appointments' ? 'calendar' : 'sparkle', 22)}</span><p>${TYPES[type].none}</p><button type="button" class="btn btn--soft btn--sm" data-open="${type}">${icon('plus', 16)}<span>Ajouter</span></button></div>`;
  const more = $(`[data-view-all="${type}"]`);
  if (more) more.textContent = count > 1 ? `Tout afficher (${count})` : 'Historique';
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
    el.innerHTML = `<div class="empty-state"><span class="empty-state__icon">${icon('check', 22)}</span><p>Aucune tâche. Profitez-en !</p></div>`;
    return;
  }
  const sorted = [...tasks].sort((a, b) => Number(a.done) - Number(b.done) || (a.date || '9999').localeCompare(b.date || '9999'));
  el.innerHTML = sorted
    .map(t => {
      const overdue = !t.done && t.date && t.date < todayKey();
      const when = t.date ? `${formatKey(t.date, { weekday: 'short', day: 'numeric', month: 'short' })}${t.time ? ` · ${t.time}` : ''}` : '';
      const sub = [when ? `<span class="${overdue ? 'is-overdue' : ''}">${when}</span>` : '', t.note ? `<span>${esc(t.note)}</span>` : ''].filter(Boolean).join('');
      return `<div class="task ${t.done ? 'is-done' : ''}" data-id="${esc(t.id)}" data-type="tasks">
        <button type="button" class="task__check" data-action="toggle" role="checkbox" aria-checked="${t.done}" aria-label="${t.done ? 'Marquer comme à faire' : 'Marquer comme terminée'}">${icon('check', 15)}</button>
        <div class="task__body"><div class="task__title">${esc(t.title)}</div>${sub ? `<div class="task__sub">${sub}</div>` : ''}</div>
        <div class="item-card__actions">
          ${canOpenReminders(t) ? `<button type="button" class="icon-btn" data-action="reminder" aria-label="Ouvrir Rappels pour « ${esc(t.title)} »" title="Ouvrir Rappels">${icon('bell', 17)}</button>` : ''}
          <button type="button" class="icon-btn" data-action="edit" aria-label="Modifier">${icon('edit', 17)}</button>
          <button type="button" class="icon-btn icon-btn--danger" data-action="delete" aria-label="Supprimer">${icon('trash', 17)}</button>
        </div>
      </div>`;
    })
    .join('');
}

function renderGreeting() {
  const h = new Date().getHours();
  const hello = h < 5 ? 'Bonne nuit' : h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir';
  $('#greeting').innerHTML = `
    <div class="hero__date">${formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })}</div>
    <div class="hero__title">${hello} 👋</div>`;
}

export function renderNotes() {
  const el = $('#notes');
  if (document.activeElement !== el && el.value !== state.notes) el.value = state.notes;
}

export function renderDashboard() {
  renderGreeting();
  renderHighlight('appointments', '#nextAppointment');
  renderHighlight('events', '#nextEvent');
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
  if (item) ['title', 'date', 'time', 'endTime', 'repeat', 'location', 'note'].forEach(k => (form.elements[k].value = item[k] || ''));
  else if (!isTask) form.elements.date.value = todayKey();
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
    repeat: [v => (!v || isRepeat(v) ? null : 'Périodicité invalide.')],
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
  if (isTask) Object.assign(v, { endTime: '', repeat: '', location: '' });
  if (isTask && v.time && !v.date) return showErrors(form, { time: 'Indiquez aussi une date d’échéance.' });

  const { valid, errors } = validate(v, itemSchema(type));
  if (!valid) return showErrors(form, errors);

  const list = state.dashboard[type];
  const existing = v.editId ? list.find(x => x.id === v.editId) : null;
  const item = { id: existing?.id || uid(), title: v.title, date: v.date, time: v.time, note: v.note };
  if (!isTask) {
    if (v.endTime) item.endTime = v.endTime;
    if (v.location) item.location = v.location;
    if (v.repeat) item.repeat = v.repeat;
  } else item.done = existing?.done ?? false; // corrige : l'état « terminée » n'est plus perdu à l'édition

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
async function onClick(e) {
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
  const host = btn?.closest('[data-id]');
  if (!btn || !host) return;
  const { id, type } = host.dataset;
  const list = state.dashboard[type];
  const item = list?.find(x => x.id === id);
  if (!item) return;

  switch (btn.dataset.action) {
    case 'toggle':
      item.done = !item.done;
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
    case 'delete':
      if (await confirmDialog({ title: `Supprimer « ${item.title} » ?`, message: 'Cette action est définitive.', confirmLabel: 'Supprimer', danger: true })) {
        state.dashboard[type] = list.filter(x => x.id !== id);
        commit('dashboard');
        toast('Élément supprimé');
      }
      break;
  }
}

export function initDashboard() {
  $('#dashboardView').addEventListener('click', onClick);
  $('#archiveSheet').addEventListener('click', onClick);
  $('#itemForm').addEventListener('submit', onSubmit);

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
