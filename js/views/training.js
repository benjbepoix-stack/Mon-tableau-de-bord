/* Vue Entraînement : planning hebdomadaire, météo, familles de sport. */
import { $, esc, uid, slugify, parseNumber, round, plural } from '../core/utils.js';
import { addDays, dateKey, fromKey, mondayOf, formatDate, parseDuration, minutesLabel, todayKey } from '../core/dates.js';
import { state, commit } from '../core/store.js';
import { defaultSession, normalizeDay, isRestTraining, REST_TRAINING } from '../core/schema.js';
import { openSheet, confirmDialog, promptDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';
import { icon } from '../ui/icons.js';
import { fetchWeek, getPlace, setPlace, searchPlaces } from '../services/weather.js';
import { PHASE_TYPES, getPhases, phaseOn, racesOn } from '../core/season.js';
import { ALLURE_URL } from './dashboard.js';

const DAY_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

let weekStart = mondayOf(new Date());
let weather = null; // { key, data } | { key, error }
let weatherLoading = false;

const familyById = id => state.families.find(f => f.id === id);
/** Séances d'un jour ; le jour est matérialisé dans l'état pour garder des id stables. */
function sessionsOf(key) {
  if (!Array.isArray(state.plans[key]) || !state.plans[key].length) state.plans[key] = normalizeDay(state.plans[key], state.families);
  return state.plans[key];
}
const weekKeys = () => Array.from({ length: 7 }, (_, i) => dateKey(addDays(weekStart, i)));
const num = v => parseNumber(v) ?? 0;

function sessionLabel(s) {
  if (!s.training) return '';
  if (isRestTraining(s.training)) return REST_TRAINING;
  const f = familyById(s.family);
  return f ? `${f.name} · ${s.training}` : s.training;
}

const raceLabel = r => `🏁 ${r.name}${r.time ? ` · ${r.time}` : ''}`;
const raceFacts = r => [r.sport, r.distance ? `${String(r.distance).replace('.', ',')} km` : '', r.elevation ? `${r.elevation} m D+` : '', r.target ? `objectif ${r.target}` : ''].filter(Boolean).join(' · ');

/* ---------- Rendu ---------- */
/** Jour déplié dans la liste (un seul à la fois) ; par défaut aujourd'hui s'il est dans la semaine affichée. */
let openDay = todayKey();

/** Phase(s) de la semaine affichée, avec l'orientation des séances. */
function renderWeekPhase(keys, phases) {
  const inWeek = [...new Map(keys.map(k => phaseOn(k, phases)).filter(Boolean).map(p => [p.id, p])).values()];
  $('#weekPhase').innerHTML = inWeek
    .map(p => {
      const t = PHASE_TYPES[p.type];
      const span = inWeek.length > 1 ? ` <span>(${formatDate(fromKey(p.start < keys[0] ? keys[0] : p.start), { weekday: 'short' })} → ${formatDate(fromKey(p.end > keys[6] ? keys[6] : p.end), { weekday: 'short' })})</span>` : '';
      return `<div class="week-phase phase--${p.type}"><strong>${esc(t.name)}${span}</strong><p>${esc(t.advice)}</p></div>`;
    })
    .join('');
}

/** « 12 – 18 octobre », ou « 29 sept. – 5 oct. » quand la semaine change de mois. */
function weekRange() {
  const end = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === end.getMonth();
  const start = formatDate(weekStart, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
  return `${start} – ${formatDate(end, sameMonth ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short' })}`;
}

function renderSummary(keys) {
  let distance = 0, elevation = 0, time = 0, count = 0;
  keys.forEach(k =>
    sessionsOf(k).forEach(s => {
      distance += num(s.distance);
      elevation += num(s.elevation);
      time += parseDuration(s.time);
      if (s.training && !isRestTraining(s.training)) count++;
    })
  );
  $('#weekSum').textContent = count || distance || time
    ? [`${round(distance, 1).toLocaleString('fr-FR')} km`, minutesLabel(time), elevation ? `${Math.round(elevation).toLocaleString('fr-FR')} m D+` : '', count ? `${count} ${plural(count, 'séance', 'séances')}` : ''].filter(Boolean).join(' · ')
    : 'Aucune séance prévue';
}

function sessionHTML(k, s, idx) {
  const f = s.family ? familyById(s.family) : null;
  const familyOptions = `<option value="">Sport</option>${state.families.map(a => `<option value="${esc(a.id)}"${a.id === s.family ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}`;
  const typeOptions = `<option value="">Séance</option>${(f?.types || []).map(t => `<option value="${esc(t)}"${t === s.training ? ' selected' : ''}>${esc(t)}</option>`).join('')}`;
  const dis = f ? '' : ' disabled';
  return `<div class="session" data-day="${k}" data-session="${esc(s.id)}">
    <div class="session__selects">
      <select class="input select" data-field="family" aria-label="Sport">${familyOptions}</select>
      <select class="input select" data-field="training" aria-label="Type de séance"${dis}>${typeOptions}</select>
      <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-action="remove-session" aria-label="Supprimer la séance ${idx + 1}">${icon('close', 16)}</button>
    </div>
    <div class="session__metrics">
      <label class="mini-field"><span>km</span><input class="input input--center" type="text" inputmode="decimal" data-field="distance" value="${esc(s.distance)}" placeholder="0"${dis}></label>
      <label class="mini-field"><span>durée</span><input class="input input--center input--wheel${s.time && s.time !== '00:00' ? '' : ' is-zero'}" type="time" step="60" data-field="time" value="${esc(s.time || '00:00')}"${dis}></label>
      <label class="mini-field"><span>D+ m</span><input class="input input--center" type="text" inputmode="numeric" data-field="elevation" value="${esc(s.elevation)}" placeholder="0"${dis}></label>
    </div>
  </div>`;
}

/** Météo résumée d'un jour pour la ligne repliée : icône et température maximale. */
function weatherShort(k) {
  const w = weather?.data?.[k];
  return w ? `<span class="plan-day__wx" title="${esc(w.label)}">${w.icon} ${w.max}°</span>` : '';
}

function weatherHTML(k) {
  const refresh = `<button type="button" class="icon-btn icon-btn--sm weather__refresh ${weatherLoading ? 'is-spinning' : ''}" data-action="refresh-weather" aria-label="Actualiser la météo">${icon('refresh', 16)}</button>`;
  const changePlace = `<button type="button" class="icon-btn icon-btn--sm weather__place" data-action="change-weather-place" aria-label="Changer de ville">${icon('pin', 16)}</button>`;
  let body;
  if (weatherLoading && !weather?.data) body = `<span class="skeleton skeleton--icon"></span><div class="weather__text"><span class="skeleton skeleton--line"></span><span class="skeleton skeleton--line skeleton--short"></span></div>`;
  else if (weather?.error) body = `<span class="weather__icon">⚠️</span><div class="weather__text"><strong>Météo indisponible</strong></div>`;
  else {
    const w = weather?.data?.[k];
    body = w
      ? `<span class="weather__icon">${w.icon}</span><div class="weather__text"><strong>${esc(w.label)}</strong><span>${w.min}° / ${w.max}° · vent ${w.wind} km/h · ${esc(getPlace().name)}</span></div>`
      : `<span class="weather__icon">—</span><div class="weather__text"><strong>Pas encore de prévision</strong></div>`;
  }
  return `<div class="weather">${body}${changePlace}${refresh}</div>`;
}

function renderDays(keys, phases = getPhases()) {
  const today = todayKey();
  $('#days').innerHTML = keys
    .map((k, i) => {
      const d = addDays(weekStart, i);
      const phase = phaseOn(k, phases);
      const races = racesOn(k);
      const labels = sessionsOf(k).map(sessionLabel).filter(Boolean);
      const metrics = sessionsOf(k)
        .map(s => [num(s.distance) ? `${String(s.distance).replace('.', ',')} km` : '', parseDuration(s.time) ? minutesLabel(parseDuration(s.time)) : ''].filter(Boolean).join(' · '))
        .filter(Boolean)
        .join(' + ');
      const open = k === openDay;
      const main = races.length
        ? `<span class="plan-day__race">${esc(races.map(r => r.name).join(', '))}</span>`
        : labels.length
          ? esc(labels.join(' + '))
          : '<span class="plan-day__rest">—</span>';
      return `<article class="plan-day ${k === today ? 'is-today' : ''} ${open ? 'is-open' : ''} ${phase ? `has-phase phase--${phase.type}` : ''}" id="day-${k}">
        <button type="button" class="plan-day__row" data-action="toggle-day" data-day="${k}" aria-expanded="${open}">
          <span class="plan-day__date"><span>${DAY_SHORT[i]}</span><strong>${d.getDate()}</strong></span>
          <span class="plan-day__main"><span class="plan-day__label">${main}</span>${metrics ? `<span class="plan-day__meta">${esc(metrics)}</span>` : ''}</span>
          ${weatherShort(k)}
        </button>
        ${open
          ? `<div class="plan-day__body">
          ${races.map(r => `<button type="button" class="race-banner" data-action="open-races" aria-label="Voir la course ${esc(r.name)}"><strong>${esc(raceLabel(r))}</strong>${raceFacts(r) ? `<span>${esc(raceFacts(r))}</span>` : ''}${r.location ? `<span>${icon('pin', 12)} ${esc(r.location)}</span>` : ''}</button>`).join('')}
          ${weatherHTML(k)}
          <div class="day-card__sessions">${sessionsOf(k).map((s, idx) => sessionHTML(k, s, idx)).join('')}</div>
          <button type="button" class="btn btn--dashed" data-action="add-session" data-day="${k}">${icon('plus', 16)}<span>Ajouter une séance</span></button>
        </div>`
          : ''}
      </article>`;
    })
    .join('');
}

export function renderTraining() {
  const keys = weekKeys();
  $('#weekLabel').textContent = weekRange();
  $('#weekTodayBtn').hidden = keys.includes(todayKey());
  const phases = getPhases();
  renderWeekPhase(keys, phases);
  renderSummary(keys);
  renderDays(keys, phases);
  if ($('#sportSheet') && !$('#sportSheet').hidden) renderManager();
}

async function loadWeather(force = false) {
  const key = dateKey(weekStart);
  if (!force && weather?.key === key && weather.data) return;
  weatherLoading = true;
  renderDays(weekKeys());
  try {
    const data = await fetchWeek(weekStart, { force });
    if (key === dateKey(weekStart)) weather = { key, data };
  } catch (error) {
    console.warn('[météo]', error);
    if (key === dateKey(weekStart)) weather = { key, error: true };
    if (force) toastError('Météo indisponible pour le moment.');
  } finally {
    weatherLoading = false;
    if (key === dateKey(weekStart)) renderDays(weekKeys());
  }
}

export function showTraining() {
  renderTraining();
  loadWeather();
}

/* ---------- Mutations ---------- */
function updateSession(k, id, field, value) {
  const sessions = sessionsOf(k);
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  if (field === 'family') {
    s.family = value;
    s.training = '';
    if (!value) Object.assign(s, { distance: '', time: '', elevation: '' });
  } else if (field === 'distance' || field === 'elevation') {
    const n = parseNumber(value);
    const max = field === 'distance' ? 1000 : 20000;
    if (value && (n === null || n < 0 || n > max)) {
      toastError(field === 'distance' ? 'Distance invalide (0 à 1000 km).' : 'Dénivelé invalide (0 à 20 000 m).');
      renderDays(weekKeys());
      return;
    }
    s[field] = value ? String(n) : '';
  } else s[field] = value;
  commit('plans');
}

async function onClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const block = btn.closest('[data-session]');
  switch (btn.dataset.action) {
    case 'week-prev':
    case 'week-next':
      weekStart = addDays(weekStart, btn.dataset.action === 'week-prev' ? -7 : 7);
      openDay = '';
      showTraining();
      break;
    case 'week-today':
      weekStart = mondayOf(new Date());
      openDay = todayKey();
      showTraining();
      break;
    case 'toggle-day':
      openDay = openDay === btn.dataset.day ? '' : btn.dataset.day;
      renderDays(weekKeys());
      break;
    case 'open-races':
      // Les courses se gèrent dans Allure (l'ancien onglet Courses de Carnet n'existe plus).
      location.href = ALLURE_URL;
      break;
    case 'refresh-weather':
      if (!weatherLoading) loadWeather(true);
      break;
    case 'change-weather-place': {
      const query = await promptDialog({
        title: 'Changer de ville',
        label: 'Ville',
        value: getPlace().name,
        placeholder: 'ex. Besançon, Chamonix, Annecy…',
        confirmLabel: 'Rechercher'
      });
      if (!query) break;
      try {
        const results = await searchPlaces(query);
        if (!results.length) {
          toastError(`Aucune ville trouvée pour « ${query} ».`);
          break;
        }
        const best = results[0];
        setPlace({ name: best.admin1 ? `${best.name} (${best.admin1})` : best.name, lat: best.lat, lon: best.lon });
        toast(`Météo réglée sur ${best.name}${best.country ? ' · ' + best.country : ''}.`);
        loadWeather(true);
      } catch (error) {
        console.warn('[météo] géocodage', error);
        toastError('Recherche de ville indisponible pour le moment.');
      }
      break;
    }
    case 'add-session': {
      const k = btn.dataset.day;
      sessionsOf(k).push(defaultSession());
      commit('plans');
      requestAnimationFrame(() => $(`#day-${k} .session:last-child`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      break;
    }
    case 'remove-session': {
      const k = block.dataset.day;
      const rest = sessionsOf(k).filter(x => x.id !== block.dataset.session);
      state.plans[k] = rest.length ? rest : [defaultSession()];
      commit('plans');
      break;
    }
    case 'open-manager':
      renderManager();
      openSheet('sportSheet', { focus: false });
      break;
  }
}

function onChange(e) {
  const field = e.target.dataset.field;
  const block = e.target.closest('[data-session]');
  if (!field || !block) return;
  // Durée : la roulette part de 00:00, qui signifie « non renseignée ».
  const value = field === 'time' && e.target.value === '00:00' ? '' : e.target.value.trim();
  updateSession(block.dataset.day, block.dataset.session, field, value);
}

/* ---------- Gestion des sports ---------- */
function renderManager() {
  const fams = state.families;
  $('#familyList').innerHTML = fams
    .map(
      (f, fi) => `<section class="family" data-family="${esc(f.id)}">
      <header class="family__head">
        <div><h3 class="family__name">${esc(f.name)}</h3><span class="family__count">${f.types.length} ${plural(f.types.length, 'séance type', 'séances types')}</span></div>
        <div class="row-actions">
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="family-up" ${fi === 0 ? 'disabled' : ''} aria-label="Monter">${icon('chevronUp', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="family-down" ${fi === fams.length - 1 ? 'disabled' : ''} aria-label="Descendre">${icon('chevronDown', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="family-edit" aria-label="Renommer">${icon('edit', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-mgr="family-delete" aria-label="Supprimer">${icon('trash', 16)}</button>
        </div>
      </header>
      ${f.types
        .map(
          (t, i) => `<div class="family__type" data-index="${i}"><span>${esc(t)}</span><div class="row-actions">
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="type-up" ${i === 0 ? 'disabled' : ''} aria-label="Monter">${icon('chevronUp', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="type-down" ${i === f.types.length - 1 ? 'disabled' : ''} aria-label="Descendre">${icon('chevronDown', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="type-edit" aria-label="Renommer">${icon('edit', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-mgr="type-delete" aria-label="Supprimer">${icon('trash', 16)}</button>
        </div></div>`
        )
        .join('')}
      <form class="inline-form" data-mgr-form="type"><input class="input" name="name" maxlength="80" placeholder="Nouvelle séance type…" aria-label="Nouvelle séance pour ${esc(f.name)}"><button type="submit" class="btn btn--primary btn--icon" aria-label="Ajouter">${icon('plus', 18)}</button></form>
    </section>`
    )
    .join('');
}

const eachSession = fn => Object.values(state.plans).forEach(day => day.forEach(fn));
const swap = (arr, i, j) => ([arr[i], arr[j]] = [arr[j], arr[i]]);

/*
 * `objectives` n'est plus écrit d'ici : il porte les phases de saison d'Allure, et
 * l'envoyer en bloc depuis un appareil pas à jour les écraserait.
 */
function saveFamilies(message) {
  commit(['families', 'plans']);
  renderManager();
  if (message) toast(message);
}

async function onManagerClick(e) {
  const btn = e.target.closest('[data-mgr]');
  if (!btn) return;
  const famEl = btn.closest('[data-family]');
  const f = familyById(famEl?.dataset.family);
  if (!f) return;
  const fi = state.families.indexOf(f);
  const ti = Number(btn.closest('[data-index]')?.dataset.index);
  switch (btn.dataset.mgr) {
    case 'family-up':
    case 'family-down': {
      const j = fi + (btn.dataset.mgr === 'family-up' ? -1 : 1);
      if (j < 0 || j >= state.families.length) return;
      swap(state.families, fi, j);
      return saveFamilies();
    }
    case 'family-edit': {
      const name = await promptDialog({ title: 'Renommer le sport', label: 'Nom', value: f.name, maxLength: 60 });
      if (!name || name === f.name) return;
      if (state.families.some(x => x !== f && x.name.toLowerCase() === name.toLowerCase())) return toastError('Ce sport existe déjà.');
      f.name = name;
      return saveFamilies('Sport renommé');
    }
    case 'family-delete': {
      if (state.families.length <= 1) return toastError('Conservez au moins un sport.');
      const ok = await confirmDialog({ title: `Supprimer « ${f.name} » ?`, message: 'Ses séances types seront supprimées et les séances planifiées associées seront vidées.', confirmLabel: 'Supprimer', danger: true });
      if (!ok) return;
      eachSession(s => {
        if (s.family === f.id) Object.assign(s, { family: '', training: '', distance: '', time: '', elevation: '' });
      });
      state.families = state.families.filter(x => x !== f);
      return saveFamilies('Sport supprimé');
    }
    case 'type-up':
    case 'type-down': {
      const j = ti + (btn.dataset.mgr === 'type-up' ? -1 : 1);
      if (j < 0 || j >= f.types.length) return;
      swap(f.types, ti, j);
      return saveFamilies();
    }
    case 'type-edit': {
      const old = f.types[ti];
      const name = await promptDialog({ title: 'Renommer la séance', label: 'Nom', value: old });
      if (!name || name === old) return;
      if (f.types.some((x, i) => i !== ti && x.toLowerCase() === name.toLowerCase())) return toastError('Cette séance existe déjà.');
      f.types[ti] = name;
      eachSession(s => {
        if (s.family === f.id && s.training === old) s.training = name;
      });
      return saveFamilies('Séance renommée');
    }
    case 'type-delete': {
      const removed = f.types[ti];
      if (!(await confirmDialog({ title: `Supprimer « ${removed} » ?`, confirmLabel: 'Supprimer', danger: true }))) return;
      f.types.splice(ti, 1);
      eachSession(s => {
        if (s.family === f.id && s.training === removed) s.training = '';
      });
      return saveFamilies('Séance supprimée');
    }
  }
}

function onManagerSubmit(e) {
  const form = e.target.closest('[data-mgr-form]');
  if (!form) return;
  e.preventDefault();
  const input = form.elements.name;
  const name = input.value.trim();
  if (!name) {
    input.setAttribute('aria-invalid', 'true');
    return input.focus();
  }
  input.removeAttribute('aria-invalid');
  if (form.dataset.mgrForm === 'family') {
    if (name.length > 60) return toastError('60 caractères maximum.');
    if (state.families.some(f => f.name.toLowerCase() === name.toLowerCase())) return toastError('Ce sport existe déjà.');
    let id = slugify(name) || uid();
    if (familyById(id)) id = `${id}-${uid().slice(-4)}`;
    state.families.push({ id, name, types: [] });
    saveFamilies('Sport ajouté');
    requestAnimationFrame(() => $(`[data-family="${CSS.escape(id)}"] input`)?.focus());
  } else {
    const f = familyById(form.closest('[data-family]')?.dataset.family);
    if (!f) return;
    if (f.types.some(t => t.toLowerCase() === name.toLowerCase())) return toastError('Cette séance existe déjà.');
    f.types.push(name);
    saveFamilies('Séance ajoutée');
    requestAnimationFrame(() => $(`[data-family="${CSS.escape(f.id)}"] input`)?.focus());
  }
  input.value = '';
}

export function initTraining() {
  const view = $('#trainingView');
  view.addEventListener('input', e => {
    if (e.target.matches('.input--wheel')) e.target.classList.toggle('is-zero', !e.target.value || e.target.value === '00:00');
  });
  view.addEventListener('click', onClick);
  view.addEventListener('change', onChange);
  const sheet = $('#sportSheet');
  sheet.addEventListener('click', onManagerClick);
  sheet.addEventListener('submit', onManagerSubmit);
}
