/*
 * Saison (dans la vue Entraînement) : phase en cours, calendrier macro sur
 * six mois (phases + courses) et gestion des phases.
 */
import { $, esc, uid, plural } from '../core/utils.js';
import { addDays, dateKey, formatDate, formatKey, fromKey, relativeDay, todayKey } from '../core/dates.js';
import { state, commit } from '../core/store.js';
import { rules, validate, showErrors, clearErrors, formValues } from '../core/validation.js';
import { PHASE_TYPES, PHASES_KEY, isPhaseType, getPhases, phaseOn, overlapping } from '../core/season.js';
import { openSheet, closeSheet, confirmDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';
import { icon } from '../ui/icons.js';

const MONTHS_SHOWN = 6;
let monthOffset = 0;
let listOpen = false;
let onGotoDay = () => {};

const daysBetween = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86400000);
const shortDate = key => formatKey(key, { day: 'numeric', month: 'short' });
const upcomingRaces = () => {
  const today = todayKey();
  return state.races.filter(r => r.date >= today).sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
};

/* ---------- Rendu ---------- */
function currentHTML(phases) {
  const today = todayKey();
  const current = phaseOn(today, phases);
  const next = phases.find(p => p.start > today);
  const race = upcomingRaces()[0];
  let phaseBlock;
  if (current) {
    const t = PHASE_TYPES[current.type];
    const total = Math.max(1, Math.ceil((daysBetween(current.start, current.end) + 1) / 7));
    const week = Math.min(total, Math.floor(daysBetween(current.start, today) / 7) + 1);
    const left = daysBetween(today, current.end);
    phaseBlock = `<div class="phase-now phase--${current.type}">
      <div class="phase-now__kicker">Phase en cours · semaine ${week}/${total}</div>
      <div class="phase-now__name">${esc(t.name)}</div>
      <div class="phase-now__dates">${shortDate(current.start)} → ${shortDate(current.end)} · ${left === 0 ? 'dernier jour' : `encore ${left} ${plural(left, 'jour')}`}</div>
      <p class="phase-now__advice">${esc(t.advice)}</p>
      ${current.note ? `<p class="phase-now__note">${esc(current.note)}</p>` : ''}
    </div>`;
  } else {
    phaseBlock = `<div class="phase-now phase-now--empty">
      <div class="phase-now__kicker">Phase en cours</div>
      <div class="phase-now__name">Aucune phase planifiée</div>
      <p class="phase-now__advice">${next ? `Prochaine : <strong>${esc(PHASE_TYPES[next.type].name)}</strong> à partir du ${shortDate(next.start)}.` : 'Ajoutez vos phases avec le bouton + pour orienter le choix de vos séances.'}</p>
    </div>`;
  }
  const raceLine = race
    ? `<div class="season-race">${icon('flag', 16)}<span>Prochaine course : <strong>${esc(race.name)}</strong> · ${formatKey(race.date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${relativeDay(race.date)}</span></div>`
    : '';
  const nextLine = current && next ? `<div class="season-next">Ensuite : <span class="phase-dot phase--${next.type}"></span>${esc(PHASE_TYPES[next.type].name)} dès le ${shortDate(next.start)}</div>` : '';
  return phaseBlock + nextLine + raceLine;
}

function calendarHTML(phases) {
  const today = todayKey();
  const now = new Date();
  const raceDays = new Map();
  state.races.forEach(r => raceDays.set(r.date, [...(raceDays.get(r.date) || []), r.name]));
  const rows = [];
  for (let m = 0; m < MONTHS_SHOWN; m++) {
    const first = new Date(now.getFullYear(), now.getMonth() + monthOffset + m, 1, 12);
    const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let d = 0; d < count; d++) {
      const key = dateKey(addDays(first, d));
      const p = phaseOn(key, phases);
      const races = raceDays.get(key);
      const label = [formatKey(key, { weekday: 'long', day: 'numeric', month: 'long' }), p ? PHASE_TYPES[p.type].name : '', races ? `Course : ${races.join(', ')}` : ''].filter(Boolean).join(' · ');
      const cls = ['macro__day', p ? `phase--${p.type}` : '', races ? 'is-race' : '', key === today ? 'is-today' : '', fromKey(key).getDay() === 1 ? 'is-monday' : ''].filter(Boolean).join(' ');
      cells.push(`<button type="button" class="${cls}" data-season="goto" data-day="${key}" title="${esc(label)}" aria-label="${esc(label)}"></button>`);
    }
    const month = formatDate(first, { month: 'short' });
    const year = first.getMonth() === 0 || m === 0 ? `<small>${first.getFullYear()}</small>` : '';
    rows.push(`<div class="macro__row"><span class="macro__month">${esc(month)}${year}</span><div class="macro__days">${cells.join('')}</div></div>`);
  }
  const used = [...new Set(phases.map(p => p.type))];
  const legend = Object.keys(PHASE_TYPES)
    .filter(t => used.includes(t))
    .map(t => `<span><i class="phase-dot phase--${t}"></i>${esc(PHASE_TYPES[t].short)}</span>`)
    .concat('<span><i class="phase-dot phase-dot--race"></i>Course</span>', '<span><i class="phase-dot phase-dot--today"></i>Aujourd’hui</span>')
    .join('');
  return `<div class="macro" role="group" aria-label="Calendrier de la saison">${rows.join('')}</div><div class="macro__legend">${legend}</div>`;
}

function listHTML(phases) {
  if (!phases.length) return '';
  const today = todayKey();
  const rows = phases
    .map(p => {
      const days = daysBetween(p.start, p.end) + 1;
      const weeks = Math.round((days / 7) * 10) / 10;
      return `<div class="phase-row ${p.end < today ? 'is-past' : ''}" data-phase="${esc(p.id)}">
        <span class="phase-dot phase--${p.type}"></span>
        <div class="phase-row__body"><strong>${esc(PHASE_TYPES[p.type].name)}</strong><span>${shortDate(p.start)} → ${formatKey(p.end, { day: 'numeric', month: 'short', year: 'numeric' })} · ${weeks.toLocaleString('fr-FR')} sem.${p.note ? ` · ${esc(p.note)}` : ''}</span></div>
        <div class="row-actions">
          <button type="button" class="icon-btn icon-btn--sm" data-season="edit" aria-label="Modifier la phase">${icon('edit', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-season="delete" aria-label="Supprimer la phase">${icon('trash', 16)}</button>
        </div>
      </div>`;
    })
    .join('');
  return `<button type="button" class="link-btn link-btn--center" data-season="toggle-list" aria-expanded="${listOpen}">${listOpen ? 'Masquer les phases' : `Gérer les phases (${phases.length})`}</button>
    ${listOpen ? `<div class="phase-list">${rows}</div>` : ''}`;
}

export function renderSeason() {
  const phases = getPhases();
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + monthOffset + MONTHS_SHOWN - 1, 1);
  $('#seasonRange').textContent = `${formatDate(from, { month: 'short', year: 'numeric' })} – ${formatDate(to, { month: 'short', year: 'numeric' })}`;
  $('#seasonReset').hidden = monthOffset === 0;
  $('#seasonCurrent').innerHTML = currentHTML(phases);
  $('#seasonCalendar').innerHTML = calendarHTML(phases);
  $('#seasonList').innerHTML = listHTML(phases);
}

/* ---------- Éditeur ---------- */
function openEditor(id = null) {
  const phases = getPhases();
  const p = id ? phases.find(x => x.id === id) : null;
  if (id && !p) return toastError('Cette phase n’existe plus.');
  const form = $('#phaseForm');
  form.reset();
  clearErrors(form);
  form.elements.editId.value = p?.id || '';
  $('#phaseSheetTitle').textContent = p ? 'Modifier la phase' : 'Nouvelle phase';
  if (p) ['type', 'start', 'end', 'note'].forEach(k => (form.elements[k].value = p[k] || ''));
  else {
    // Par défaut : enchaîne après la dernière phase (ou aujourd'hui), sur 4 semaines.
    const last = phases[phases.length - 1];
    const start = last && last.end >= todayKey() ? dateKey(addDays(fromKey(last.end), 1)) : todayKey();
    form.elements.type.value = 'base';
    form.elements.start.value = start;
    form.elements.end.value = dateKey(addDays(fromKey(start), 27));
  }
  updateAdvice();
  openSheet('phaseSheet');
}

function updateAdvice() {
  const type = $('#phaseForm').elements.type.value;
  $('#phaseAdvice').textContent = isPhaseType(type) ? PHASE_TYPES[type].advice : '';
}

const phaseSchema = {
  type: [v => (isPhaseType(v) ? null : 'Choisissez un type de phase.')],
  start: [rules.date({ required: true })],
  end: [rules.date({ required: true }), (v, all) => (v && all.start && v < all.start ? 'La fin doit être après le début.' : null)],
  note: [rules.maxLength(200)]
};

function savePhases(phases, message) {
  state.objectives[PHASES_KEY] = phases;
  commit('objectives');
  if (message) toast(message);
}

function onSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const v = formValues(form);
  const { valid, errors } = validate(v, phaseSchema);
  if (!valid) return showErrors(form, errors);
  const clash = overlapping(v.start, v.end, v.editId);
  if (clash) return showErrors(form, { end: `Chevauche « ${PHASE_TYPES[clash.type].name} » (${shortDate(clash.start)} → ${shortDate(clash.end)}).` });
  const phases = getPhases();
  const phase = { id: v.editId || uid(), type: v.type, start: v.start, end: v.end, note: v.note };
  const index = phases.findIndex(x => x.id === v.editId);
  if (index >= 0) phases[index] = phase;
  else phases.push(phase);
  phases.sort((a, b) => a.start.localeCompare(b.start));
  closeSheet('phaseSheet');
  savePhases(phases, index >= 0 ? 'Phase modifiée' : 'Phase ajoutée');
}

async function onClick(e) {
  const btn = e.target.closest('[data-season]');
  if (!btn) return;
  const action = btn.dataset.season;
  switch (action) {
    case 'add':
      return openEditor();
    case 'prev':
    case 'next':
      monthOffset += action === 'prev' ? -3 : 3;
      return renderSeason();
    case 'reset':
      monthOffset = 0;
      return renderSeason();
    case 'toggle-list':
      listOpen = !listOpen;
      return renderSeason();
    case 'goto':
      return onGotoDay(btn.dataset.day);
  }
  const id = btn.closest('[data-phase]')?.dataset.phase;
  const phase = getPhases().find(p => p.id === id);
  if (!phase) return;
  if (action === 'edit') openEditor(id);
  else if (action === 'delete') {
    const ok = await confirmDialog({ title: `Supprimer la phase « ${PHASE_TYPES[phase.type].name} » ?`, message: `${shortDate(phase.start)} → ${shortDate(phase.end)}`, confirmLabel: 'Supprimer', danger: true });
    if (ok) savePhases(getPhases().filter(p => p.id !== id), 'Phase supprimée');
  }
}

export function initSeason({ gotoDay }) {
  onGotoDay = gotoDay;
  $('#seasonCard').addEventListener('click', onClick);
  const form = $('#phaseForm');
  const option = ([k, t]) => `<option value="${k}">${esc(t.name)}</option>`;
  const types = Object.entries(PHASE_TYPES);
  const spec = types.filter(([, t]) => t.group === 'spec');
  form.elements.type.innerHTML = [
    ...types.filter(([k]) => k === 'base').map(option),
    `<optgroup label="Préparation spécifique">${spec.map(option).join('')}</optgroup>`,
    ...types.filter(([k, t]) => k !== 'base' && t.group !== 'spec').map(option)
  ].join('');
  form.elements.type.addEventListener('change', updateAdvice);
  form.addEventListener('submit', onSubmit);
}
