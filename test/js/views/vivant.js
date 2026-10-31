/*
 * « Les trois espaces » : un accueil calme et un écran par univers.
 *  - Accueil : prochain rendez-vous (anneau de proximité), puis trois cartes (Ensuite, À faire,
 *    Sport) qui ouvrent chacune leur écran, et la note ;
 *  - Ma semaine : tout ce qui est prévu jour par jour (rendez-vous, événements, séances, tâches), la météo
 *    en petit, et des propositions quand une séance tombe sur un créneau pris ou une mauvaise météo ;
 *    le dimanche soir, elle s'ouvre sur la semaine suivante (état des lieux) ;
 *  - Mois : calendrier du mois et ce qui est prévu, mois par mois, sur les deux mois suivants ;
 *  - Tâches : tâches groupées par échéance (glisser à droite = faite, à gauche = demain), et celles
 *    de Garage, Maison et Allure au même format, avec le nom de l'app ;
 *  - Sport : le planning détaillé. Phase de saison (Cadence) jusqu'à la prochaine course, « Programmer
 *    ma semaine » (séances placées sur les meilleurs créneaux météo), puis les 7 jours : météo par
 *    créneau, séances modifiables sur place. À l'arrivée, l'écran se place sur le jour en cours.
 * Le bouton + ouvre une saisie en questions (tâche, rendez-vous, événement, séance).
 * La fiche tâche / RDV reste celle de dashboard.js ; la liste des sports, celle de training.js.
 */
import { $, esc, uid } from '../core/utils.js';
import { state, commit } from '../core/store.js';
import { todayKey, dateKey, addDays, fromKey, combine, formatKey, formatDate, isRepeat, nextOccurrenceKey, occurrencesBetween, REPEATS, mondayOf } from '../core/dates.js';
import { isRestTraining } from '../core/schema.js';
import { parseEntry } from '../core/parse.js';
import { getPhases, phaseOn, PHASE_TYPES } from '../core/season.js';
import { readJSON, write } from '../services/storage.js';
import { fetchSlots, SLOT_HOURS, getPlace, setPlace, searchPlaces, wxAt } from '../services/weather.js';
import { toast, toastError } from '../ui/toast.js';
import { burst, buzz } from '../ui/feedback.js';
import { linkedItems, GARAGE_URL, MAISON_URL } from '../features/linked-apps.js';
import { sportTasks } from '../features/sport-tasks.js';
import { openEditor, ALLURE_URL } from './dashboard.js';
import { openSportManager } from './training.js';

const DONE_KEY = 'carnet_sessions_done';
const WD = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const WD_FULL = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const SLOTS = { matin: 'Matin', aprem: 'Après-midi', soir: 'Soir' };
const SLOT_IDS = Object.keys(SLOTS);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const pad = n => String(n).padStart(2, '0');

let goto = () => {};
let current = 'todayView';
let entering = true;
let wx = {};
const wxAsked = new Set();
let daySel = null; // jour choisi dans le mini-calendrier
let monthOff = 0;
let weekStart = '';
let openDay = null; // jour dont la météo est dépliée
let flash = null; // élément ajouté, mis en évidence au prochain rendu
let landed = null;
let editId = null; // séance dépliée pour modification dans Sport
let focusDay = null; // jour sur lequel se placer en arrivant sur Sport
let planStart = ''; // lundi de la semaine affichée dans « Ma semaine »
let assign = false; // Tâches : mode « Répartir sur la semaine »
let assignStart = '';
let assignKeep = false;
let monthsShown = 3; // Mois : ce mois-ci et les deux suivants
let showPast = false; // Accueil : jours passés de la semaine dépliés

/* ---------- Séances ---------- */
const familyOf = s => (state.families || []).find(f => f.id === s.family);
/** Genre de sport : la météo ne compte pas pareil à vélo, à pied ou en salle. */
function kindOfFamily(name = '') {
  const n = name.toLowerCase();
  if (/cycl|vélo|velo|vtt|gravel|route|ski-roue|roller/.test(n)) return 'bike';
  if (/natation|nage|piscine|muscu|renfo|gainage|yoga|escalade|salle|pilates/.test(n)) return 'indoor';
  return 'run';
}
const kindOf = s => kindOfFamily(familyOf(s)?.name);
const TILE = { run: 'run', bike: 'bike', indoor: 'gym' };
const ABBR = { 'course à pied': 'RUN', trail: 'TRAIL', cyclisme: 'VÉLO', vtt: 'VTT', gravel: 'GRAV', musculation: 'MUSC', escalade: 'GRIMP', 'ski de fond': 'SKI', 'ski-roue': 'S-R' };
const abbrOf = name => ABBR[(name || '').toLowerCase()] || (name || '').slice(0, 4).toUpperCase() || '—';
const abbr = s => abbrOf(familyOf(s)?.name);
const num = v => parseFloat(String(v || '').replace(',', '.')) || 0;
const durMin = t => { if (!t) return 0; const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const durLabel = m => (!m ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${pad(m % 60)}` : ''}`);
const km = v => `${String(Math.round(num(v) * 10) / 10).replace('.', ',')} km`;
/** Intensité, déduite du type de séance : sert au récap « ce que demande la phase ». */
function effort(s) {
  const t = (s.training || '').toLowerCase();
  if (kindOf(s) === 'indoor' && /force|renfo|gainage|mobilit/.test(t + (familyOf(s)?.name || '').toLowerCase())) return 'renfo';
  if (/longue/.test(t)) return 'longue';
  if (/fraction|seuil|tempo|vo|intensit|côte|cote|dénivel|sweet|force/.test(t)) return 'qualité';
  return 'facile';
}

const plansOn = k => (Array.isArray(state.plans?.[k]) ? state.plans[k] : []);
/** Séances réelles d'un jour (le repos et les séances vides sont écartés). */
const sessionsOn = k => plansOn(k).filter(s => s.family && !isRestTraining(s.training));
const isRestDay = k => plansOn(k).some(s => isRestTraining(s.training));

const doneMap = () => readJSON(DONE_KEY, {}) || {};
/** Ancien format : une date cochée = toutes les séances de ce jour faites. */
const isDone = (k, s, all = doneMap()) => Boolean(all[k] === true || all[`${k}|${s.id}`]);
function toggleDone(k, id) {
  const all = doneMap();
  if (all[k] === true) {
    delete all[k];
    sessionsOn(k).forEach(s => (all[`${k}|${s.id}`] = true));
  }
  const key = `${k}|${id}`;
  if (all[key]) delete all[key];
  else all[key] = true;
  const limit = dateKey(addDays(new Date(), -120));
  Object.keys(all).forEach(x => x.slice(0, 10) < limit && delete all[x]);
  write(DONE_KEY, all);
  return Boolean(all[key]);
}

/* ---------- Météo par créneau ---------- */
function loadWx(force = false) {
  [...new Set([todayKey(), weekStart, planStart].filter(Boolean))].forEach(k => {
    if (wxAsked.has(k)) return;
    wxAsked.add(k);
    fetchSlots(k, 8, { force })
      .then(data => {
        wx = { ...wx, ...data };
        if (!Object.keys(data).length) return;
        renderCurrent();
        if (DW) renderDayWx();
        // Pop-up « Programmer ma semaine » ouvert avant la météo : on refait la proposition.
        replanIfUntouched();
      })
      .catch(err => {
        console.warn('[météo]', err);
        wxAsked.delete(k);
      });
  });
}
const slotsOn = k => wx[k]?.slots || null;
function score(kind, w) {
  if (kind === 'indoor' || !w) return 100;
  let v = 100;
  if (kind === 'bike') {
    if (w.t < 3) v -= 30;
    else if (w.t < 8) v -= 12;
    v -= w.rain * 0.7 + (w.mm > 0.5 ? 25 : 0);
    if (w.wind > 15) v -= (w.wind - 15) * 1.6;
    if (w.gust > 50) v -= 15;
  } else {
    if (w.t < 2) v -= (2 - w.t) * 5;
    if (w.t > 22) v -= (w.t - 22) * 4;
    v -= w.rain * 0.55 + (w.mm > 0.5 ? 15 : 0);
    if (w.wind > 28) v -= 15;
    if (w.gust > 55) v -= 10;
  }
  if (w.sky === 'storm') v -= 40;
  if (w.sky === 'snow') v -= 20;
  return Math.max(0, Math.round(v));
}
const level = v => (v >= 72 ? 'good' : v >= 48 ? 'ok' : 'bad');
const slotPast = (k, sl) => k < todayKey() || (k === todayKey() && new Date().getHours() > SLOT_HOURS[sl].at(-1));
function bestSlot(kind, k) {
  const ws = slotsOn(k);
  if (!ws) return null;
  const open = SLOT_IDS.filter(sl => ws[sl] && !slotPast(k, sl));
  if (!open.length) return null;
  return open.reduce((a, b) => (score(kind, ws[b]) > score(kind, ws[a]) ? b : a));
}
/** Créneau d'une séance : celui choisi, sinon le meilleur selon la météo. */
const slotOf = (s, k) => s.slot || bestSlot(kindOf(s), k) || '';
const why = w => [w.rain >= 50 ? `pluie ${w.rain} %` : '', w.wind >= 28 ? `vent ${w.wind} km/h` : '', w.gust >= 55 ? `rafales ${w.gust}` : '', w.sky === 'storm' ? 'orage' : ''].filter(Boolean).join(', ');
/** Créneau nettement meilleur dans les 7 jours qui suivent aujourd'hui. */
function suggestion(s, k) {
  const kind = kindOf(s);
  const sl = slotOf(s, k);
  const ws = slotsOn(k);
  if (kind === 'indoor' || !sl || !ws?.[sl]) return null;
  const cur = score(kind, ws[sl]);
  let best = null;
  for (let i = 0; i < 7; i++) {
    const dk = dateKey(addDays(new Date(), i));
    const w2 = slotsOn(dk);
    if (!w2) continue;
    for (const s2 of SLOT_IDS) {
      if (!w2[s2] || slotPast(dk, s2)) continue;
      const v = score(kind, w2[s2]) - Math.abs((fromKey(dk) - fromKey(k)) / 86400000) * 3;
      if (!best || v > best.v) best = { k: dk, sl: s2, v };
    }
  }
  return best && best.v - cur >= 20 && !(best.k === k && best.sl === sl) ? best : null;
}

/* ---------- Icônes ---------- */
const SKY = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>',
  part: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="9" r="3.3"/><path d="M8 19h9a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.6 1.6A2.7 2.7 0 0 0 8 19z"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 2A3 3 0 0 0 7 18z"/></svg>',
  fog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9h16M3 13h18M5 17h14"/></svg>',
  rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 2A3 3 0 0 0 7 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/></svg>',
  snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 2A3 3 0 0 0 7 14z"/><path d="M8 18h.01M12 20h.01M16 18h.01"/></svg>',
  storm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 2A3 3 0 0 0 7 14z"/><path d="m12 15-2 4h4l-2 4"/></svg>',
  wind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3M3 12h8"/></svg>'
};
const skyOf = w => SKY[w.wind >= 30 && ['cloud', 'part', 'sun'].includes(w.sky) ? 'wind' : w.sky] || SKY.cloud;
const I = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/></svg>',
  run: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="14" cy="4.5" r="1.8"/><path d="m6 20 3.5-5 3 2 1.5-5 3 3h2.5M8 10l3-2.5 3.5.5"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>',
  fwd: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
  x: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  pin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  go: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  out: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>'
};

/* ---------- Agenda et tâches ---------- */
const dayDiff = k => Math.round((fromKey(k) - fromKey(todayKey())) / 86400000);
function dayWord(k) {
  const d = dayDiff(k);
  if (d === 0) return 'aujourd’hui';
  if (d === 1) return 'demain';
  if (d === -1) return 'hier';
  return formatKey(k, { weekday: 'short', day: 'numeric' });
}
const dayTitle = k => (dayDiff(k) === 0 ? 'Aujourd’hui' : dayDiff(k) === 1 ? 'Demain' : cap(formatKey(k, { weekday: 'long', day: 'numeric' })));
const hhmm = t => t.replace(':', ' h ');

/** Nombre de jours après le premier pour un événement sur plusieurs jours (0 sinon). */
const spanDays = x => (x.endDate && x.date && x.endDate > x.date ? Math.round((fromKey(x.endDate) - fromKey(x.date)) / 86400000) : 0);
/** Premier jour de l'occurrence qui couvre le jour k (plusieurs jours et répétitions compris), sinon null. */
function startCovering(x, k) {
  const occ = occurrencesBetween(x, dateKey(addDays(fromKey(k), -spanDays(x))), k);
  return occ.length ? occ[occ.length - 1] : null;
}
const endOf = (x, start) => (spanDays(x) ? dateKey(addDays(fromKey(start), spanDays(x))) : '');
/** Rendez-vous et événements à venir (prochaine occurrence pour ceux qui se répètent ; un événement
 *  sur plusieurs jours déjà commencé reste à venir jusqu'à son dernier jour). */
function upcoming() {
  const today = todayKey();
  const now = Date.now();
  const items = [];
  ['appointments', 'events'].forEach(kind =>
    state.dashboard[kind].forEach(x => {
      const date = (spanDays(x) && startCovering(x, today)) || (isRepeat(x.repeat) ? nextOccurrenceKey(x) : x.date);
      if (!date) return;
      const endDate = endOf(x, date);
      if ((endDate || date) < today) return;
      const end = endDate ? null : combine(date, x.endTime || x.time, '23:59');
      if (end && end.getTime() < now) return;
      items.push({ id: x.id, title: x.title, date, endDate, time: x.time, endTime: x.endTime, place: x.location || '', kind, repeat: x.repeat });
    })
  );
  return items.sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
}
/** Rendez-vous et événements d'un jour donné (répétitions et événements sur plusieurs jours compris). */
function itemsOn(k) {
  const out = [];
  ['appointments', 'events'].forEach(kind =>
    state.dashboard[kind].forEach(x => {
      const date = startCovering(x, k);
      if (date) out.push({ id: x.id, title: x.title, date, endDate: endOf(x, date), on: k, time: x.time, endTime: x.endTime, place: x.location || '', kind });
    })
  );
  // Événements de plusieurs jours et journées entières d'abord, puis par heure.
  return out.sort((a, b) => (a.endDate ? '0' : a.time || '1').localeCompare(b.endDate ? '0' : b.time || '1'));
}
/** Proximité d'un rendez-vous : classe de couleur, remplissage de l'anneau, libellés. */
function prox(x) {
  if (x.endDate && x.date <= todayKey() && x.endDate >= todayKey()) {
    const left = dayDiff(x.endDate) + 1;
    return { cls: 'is-today', fill: 1, big: `${left}`, small: left > 1 ? 'jours' : 'jour', short: 'en cours', label: 'en cours' };
  }
  const at = combine(x.date, x.time, '12:00');
  const h = (at - Date.now()) / 3600000;
  const d = dayDiff(x.date);
  if (h < 0) {
    // Déjà passé (agenda d'un jour écoulé, rendez-vous de ce matin) : pas de « dans 1 min ».
    const short = d < -1 ? `il y a ${-d} j` : d === -1 ? 'hier' : 'passé';
    return { cls: 'is-past', fill: 0, big: '✓', small: '', short, label: 'passé' };
  }
  const cls = h <= 3 ? 'is-imminent' : d === 0 ? 'is-today' : d <= 7 ? 'is-week' : 'is-later';
  const fill = Math.max(0.06, Math.min(1, 1 - h / 168));
  const [big, small] = h < 1 ? [`${Math.max(1, Math.round(h * 60))}`, 'min'] : h < 24 ? [`${Math.floor(h)} h`, pad(Math.floor((h % 1) * 60))] : [`${d}`, d > 1 ? 'jours' : 'jour'];
  const short = h < 1 ? `dans ${Math.max(1, Math.round(h * 60))} min` : h < 24 ? `dans ${Math.floor(h)} h` : d === 1 ? 'demain' : `dans ${d} j`;
  const label = { 'is-imminent': 'imminent', 'is-today': 'aujourd’hui', 'is-week': 'cette semaine', 'is-later': 'plus tard' }[cls];
  return { cls, fill, big, small, short, label };
}
/** Jour proche (« demain », « jeu. 5 ») ou lointain (« jeu. 5 déc. »). */
const dateWord = k => (Math.abs(dayDiff(k)) <= 6 ? dayWord(k) : formatKey(k, { weekday: 'short', day: 'numeric', month: 'short' }));
const span = x => `du ${dateWord(x.date)} au ${dateWord(x.endDate)}`;
const hours = x => (x.time ? `${hhmm(x.time)}${x.endTime ? ` – ${hhmm(x.endTime)}` : ''}` : '');
const whenOf = x => (x.endDate ? span(x) : `${dateWord(x.date)}${x.time ? ` · ${hours(x)}` : ' · journée'}`);
const openTasks = () => state.dashboard.tasks.filter(t => !t.done).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '99').localeCompare(b.time || '99'));
const isLate = t => t.date && t.date < todayKey();
function taskMeta(t) {
  const rep = isRepeat(t.repeat) ? ' ↻' : '';
  if (!t.date) return `sans date${rep}`;
  const d = dayDiff(t.date);
  if (d < 0) return `en retard de ${-d} j${rep}`;
  return `${dayWord(t.date)}${t.time ? ` · ${t.time}` : ''}${rep}`;
}
/** Tâches publiées par les autres apps, au même format que les tâches de Carnet. */
function appTasks() {
  const { garage, maison, season } = linkedItems();
  return [
    ...sportTasks().map(a => ({ title: a.title, src: 'Allure', href: ALLURE_URL, late: a.level === 'late', sub: a.text })),
    ...garage.map(a => ({ title: `${a.owner ? `${a.owner} · ` : ''}${a.title}`, src: 'Garage', href: GARAGE_URL, late: a.level === 'late', sub: a.due ? `${a.level === 'late' ? 'en retard · ' : ''}${formatKey(a.due, { day: 'numeric', month: 'short' })}` : a.text })),
    ...maison.map(a => ({ title: a.title, src: 'Maison', href: `${MAISON_URL}#/entretien`, late: a.level === 'late', sub: a.due ? `${a.level === 'late' ? 'en retard · ' : ''}${formatKey(a.due, { day: 'numeric', month: 'short' })}` : a.text })),
    ...season.map(s => ({ title: s.label, src: 'Maison', href: `${MAISON_URL}#/entretien/saison`, sub: 'ce mois-ci' }))
  ];
}

/* ---------- Les lignes : un seul format partout ---------- */
function nextCard(x, small) {
  if (!x) return '';
  const p = prox(x);
  const C = 2 * Math.PI * 27;
  return `<button type="button" class="card e-next ${p.cls} ${small ? 'is-small' : ''}" data-v="edit" data-type="${x.kind}" data-id="${esc(x.id)}">
    <span class="e-ring"><svg viewBox="0 0 64 64" aria-hidden="true"><circle class="bg" cx="32" cy="32" r="27"/><circle class="fg" cx="32" cy="32" r="27" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-off="${C * (1 - p.fill)}"/></svg><span>${p.big}<small>${p.small}</small></span></span>
    <span class="e-row__b"><span class="e-next__k">${x.kind === 'events' ? 'Prochain événement' : 'Prochain rendez-vous'} · ${p.label}</span><span class="e-next__t">${esc(x.title)}</span><span class="e-row__s">${esc(whenOf(x))}${x.place ? ` · ${esc(x.place)}` : ''}</span></span></button>`;
}
function rdvRow(x, showDay = true) {
  const p = prox(x);
  return `<button type="button" class="e-row ${p.cls} ${flash === x.id ? 'e-flash' : ''}" data-v="edit" data-type="${x.kind}" data-id="${esc(x.id)}"><span class="e-tile t-rdv">${x.kind === 'events' ? I.star : I.clock}</span>
    <span class="e-row__b"><span class="e-row__t">${esc(x.title)}</span><span class="e-row__s">${esc(showDay || x.endDate ? whenOf(x) : x.time ? hours(x) : 'toute la journée')}${x.place ? ` · ${esc(x.place)}` : ''}${x.kind === 'events' ? ' · événement' : ''}</span></span>
    <span class="e-dist"><span>${p.short}</span><span class="e-dist__bar"><i style="width:${Math.round(p.fill * 100)}%"></i></span></span></button>`;
}
function taskRow(t) {
  return `<div class="k-sw" data-dir="done"><div class="k-sw__u"><span class="u-done">${I.check}Fait</span><span class="u-later">Demain →</span></div>
    <div class="e-row k-task ${flash === t.id ? 'e-flash' : ''}" data-task="${esc(t.id)}" tabindex="0" role="button" aria-label="Modifier « ${esc(t.title)} »"><button type="button" class="e-check" data-v="tdone" data-id="${esc(t.id)}" aria-label="Cocher « ${esc(t.title)} »"><i>${I.check}</i></button>
    <span class="e-row__b"><span class="e-row__t">${esc(t.title)}</span><span class="e-row__s ${isLate(t) ? 'is-late' : ''}">${esc(taskMeta(t))}</span></span></div></div>`;
}
const raceRow = x => `<a class="e-row" href="${ALLURE_URL}"><span class="e-tile t-run">🏁</span><span class="e-row__b"><span class="e-row__t">${esc(x.title)}</span><span class="e-row__s">${esc(whenOf(x))}${x.place ? ` · ${esc(x.place)}` : ''} · course</span></span><span class="e-go">${I.out}</span></a>`;
const appRow = a => `<a class="e-row" href="${a.href}"><span class="e-check is-app"><i></i></span><span class="e-row__b"><span class="e-row__t">${esc(a.title)}<span class="e-src">${esc(a.src)}</span></span><span class="e-row__s ${a.late ? 'is-late' : ''}">${esc(a.sub || '')}</span></span><span class="e-go">${I.out}</span></a>`;
function sessRow(s, k, showDay) {
  const sl = slotOf(s, k);
  const w = slotsOn(k)?.[sl];
  const kind = kindOf(s);
  const lv = kind === 'indoor' || !w ? 'good' : level(score(kind, w));
  const done = isDone(k, s);
  const past = k < todayKey();
  const warn = !past && !done && lv === 'bad';
  const sug = !past && !done && lv !== 'good' ? suggestion(s, k) : null;
  const meta = [showDay ? dayWord(k) : '', sl ? SLOTS[sl].toLowerCase() : '', durLabel(durMin(s.time)), s.elevation ? `${s.elevation} m D+` : '', effort(s)].filter(Boolean).join(' · ');
  const right = k <= todayKey()
    ? `<button type="button" class="e-check ${done ? 'is-on' : ''}" data-v="session" data-day="${k}" data-id="${esc(s.id)}" aria-pressed="${done}" aria-label="${done ? 'Séance faite' : 'Marquer la séance faite'}"><i>${I.check}</i></button>`
    : sug ? `<button type="button" class="e-mv" data-v="mvto" data-id="${esc(s.id)}" data-day="${k}" data-to="${sug.k}" data-slot="${sug.sl}">Déplacer</button>`
      : kind !== 'indoor' && w ? `<span class="e-wx q-${lv}">${skyOf(w)}${w.t}° · ${w.wind} km/h</span>` : kind === 'indoor' ? '<span class="e-row__r">intérieur</span>' : '';
  return `<div class="e-row ${done ? 'is-done' : ''} ${landed === s.id || flash === s.id ? 'e-flash' : ''}" role="button" tabindex="0" data-v="sedit" data-day="${k}" data-id="${esc(s.id)}" aria-expanded="${editId === s.id}"><span class="e-tile t-${TILE[kind]}">${esc(abbr(s))}</span>
    <span class="e-row__b"><span class="e-row__t">${esc(s.training || familyOf(s)?.name || 'Séance')}${s.distance ? ` · ${km(s.distance)}` : ''}</span><span class="e-row__s ${warn ? 'is-late' : ''}">${esc(meta)}${past && !done ? ' · manquée' : ''}${warn && why(w) ? ` · ${esc(why(w))}` : ''}${sug ? `<br><span class="e-better">Mieux : ${esc(sug.k === k ? '' : `${dayWord(sug.k)} `)}${SLOTS[sug.sl].toLowerCase()}</span>` : ''}</span></span>${right}</div>`;
}
const head = (kicker, title, tools = '') => `<header class="k-hd"><div><p class="k-kicker">${kicker}</p><h1>${title}</h1></div>${tools}</header>`;

/* ---------- Semaine sportive ---------- */
const keysOf = start => Array.from({ length: 7 }, (_, i) => dateKey(addDays(fromKey(start), i)));
function weekStats(keys) {
  const all = doneMap();
  const list = keys.flatMap(k => sessionsOn(k).map(s => ({ s, k })));
  return {
    list,
    n: list.length,
    done: list.filter(({ s, k }) => isDone(k, s, all)).length,
    km: list.reduce((a, { s }) => a + num(s.distance), 0),
    min: list.reduce((a, { s }) => a + durMin(s.time), 0),
    dp: list.reduce((a, { s }) => a + num(s.elevation), 0)
  };
}
const PHASE_COLOR = { base: 'var(--k-bike)', buildVolume: 'var(--k-swim)', buildIntensity: 'var(--rdv)', buildRace: 'var(--rdv)', build: 'var(--rdv)', taper: 'var(--k-gym)', recovery: 'var(--ok)', transition: 'var(--text-3)' };
/** Ce qu'une phase demande sur une semaine (séances par intensité). */
const PHASE_GOALS = {
  base: [['longue', 1], ['renfo', 1]],
  buildVolume: [['longue', 1], ['qualité', 1], ['renfo', 1]],
  buildIntensity: [['qualité', 2], ['longue', 1], ['renfo', 1]],
  buildRace: [['qualité', 2], ['longue', 1]],
  build: [['qualité', 2], ['longue', 1]],
  taper: [['qualité', 1], ['facile', 2]],
  recovery: [['facile', 2]]
};
const nextRace = () => (state.races || []).filter(r => r.date >= todayKey()).sort((a, b) => a.date.localeCompare(b.date))[0];

/* ---------- Accueil : la semaine en liste, puis les 30 prochains jours ---------- */
/** Couleur d'un jour selon le ciel : beau (jaune), pluie (bleu), gris. */
function toneOf(k) {
  const s = wx[k]?.sky;
  return s === 'sun' || s === 'part' ? 'sun' : ['rain', 'storm', 'snow'].includes(s) ? 'rain' : 'grey';
}
/* ---------- Style « doux » : illustrations et courbes de vent ---------- */
const ILL = Object.fromEntries(['cal', 'clip', 'watch', 'flag', 'sun', 'sunc', 'rain', 'cloud'].map(n => [n, `<svg class="d-ill" viewBox="0 0 64 64" aria-hidden="true"><use href="#d-${n}"/></svg>`]));
const ILL_OF = cls => (cls.startsWith('c-ses') ? ILL.watch : cls === 'c-task' ? ILL.clip : cls === 'c-race' ? ILL.flag : ILL.cal);
/** Illustration du ciel d'un jour. */
const illOfSky = s => (s === 'sun' ? ILL.sun : s === 'part' ? ILL.sunc : ['rain', 'storm', 'snow'].includes(s) ? ILL.rain : ILL.cloud);
const skyIll = k => illOfSky(wx[k]?.sky);
/** Une courbe douce et fermée (surface) à travers des valeurs, dans une boîte w × h. */
function curve(vals, w, h, max) {
  if (vals.length < 2) return '';
  const pts = vals.map((v, i) => [i * w / (vals.length - 1), h - Math.min(v, max) / max * h * .9]);
  let d = `M0,${h} L${pts[0][0]},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [xa, ya] = pts[i - 1];
    const [xb, yb] = pts[i];
    const mx = ((xa + xb) / 2).toFixed(1);
    d += ` C${mx},${ya.toFixed(1)} ${mx},${yb.toFixed(1)} ${xb.toFixed(1)},${yb.toFixed(1)}`;
  }
  return `${d} L${w},${h} Z`;
}
const windWord = v => (v < 15 ? 'léger' : v < 30 ? 'modéré' : 'fort');
/** Un jour de la semaine, en frise : la date dans un rond, puis une carte par chose prévue. */
function dayRow(k, all) {
  const d = fromKey(k);
  const today = todayKey();
  const list = entriesOn(k, all);
  const w = k >= today ? dayWx(k) : null;
  const sport = list.some(x => x.cls.startsWith('c-ses') || x.cls === 'c-race');
  const label = `${WD_FULL[d.getDay()]} ${d.getDate()}`;
  const rest = w
    ? `<button type="button" class="d-rest" data-dwx="${k}"><span class="d-rest__i">${skyIll(k)}</span><span class="d-rest__b"><b>Repos · ${esc(w.label)}</b><small>${w.min}° / ${w.max}° · vent moyen ${w.windAvg} km/h · rafales max ${w.gust} km/h${w.mm ? ` · pluie ${String(w.mm).replace('.', ',')} mm` : ''}</small></span><span class="d-rest__go" aria-hidden="true">${I.fwd}</span></button>`
    : '<p class="d-rest">Repos</p>';
  return `<div class="d-tl ${k === today ? 'is-today' : ''} ${k < today ? 'is-past' : ''}" ${k === today ? 'aria-current="date"' : ''}>
    <div class="d-tl__l"><button type="button" class="d-tl__add" data-v="wadd" data-day="${k}" aria-label="Ajouter quelque chose ${esc(label)}"><small>${cap(WD[d.getDay()])}.</small><b>${d.getDate()}</b><i aria-hidden="true">+</i></button></div>
    <div class="d-tl__c">${list.map(x => `<button type="button" class="d-it ${x.cls} ${x.done ? 'is-done' : ''} ${flash === x.id || landed === x.id ? 'e-flash' : ''}" ${x.act}><span class="d-th">${ILL_OF(x.cls)}</span><span class="d-it__b"><b>${esc(x.title)}</b><small>${esc([x.tag, x.sub].filter(Boolean).join(' · '))}</small></span>${x.warn ? `<em title="${esc(x.warn)}">!</em>` : ''}</button>`).join('')}${sport || k < today ? '' : rest}${sport && w ? `<button type="button" class="d-wxl" data-dwx="${k}">${SKY[wx[k].sky] || SKY.cloud}${w.min}° / ${w.max}° · vent moy. ${w.windAvg} · rafales ${w.gust} km/h<span aria-hidden="true">${I.fwd}</span></button>` : ''}</div>
  </div>`;
}
/** La grande carte « Aujourd'hui » : météo en courbe, puis ce qui est prévu. */
function todayCard(all) {
  const k = todayKey();
  const d = fromKey(k);
  const w = dayWx(k);
  const sl = slotsOn(k) || {};
  const ws = SLOT_IDS.map(s => sl[s]).filter(Boolean);
  const list = entriesOn(k, all);
  const what = list.length ? list.slice(0, 3).map(x => x.title).join(' · ') + (list.length > 3 ? ` · +${list.length - 3}` : '') : 'Rien de prévu';
  return `<article class="d-today">
    <button type="button" class="d-hero" data-dwx="${k}" aria-label="Météo heure par heure">${ws.length > 1 ? `<svg class="d-hero__c" viewBox="0 0 300 70" preserveAspectRatio="none" aria-hidden="true"><path d="${curve(ws.map(x => x.gust), 300, 70, 70)}" fill="#1C5B6B"/><path d="${curve(ws.map(x => x.wind), 300, 70, 70)}" fill="#BFD3D8" opacity=".9"/></svg>` : ''}
      <span class="d-hero__i">${skyIll(k)}</span><span class="d-badge">Aujourd’hui</span><span class="d-hero__t">${w ? `${w.max}°` : '—'}</span><span class="d-hero__more">Heure par heure ${I.fwd}</span></button>
    <div class="d-today__b"><h2>${cap(WD_FULL[d.getDay()])} ${d.getDate()} ${MONTHS[d.getMonth()]}</h2><p>${esc(what)}</p>
      <div class="d-today__r"><span>${w ? `Vent ${windWord(w.wind)}, rafales ${w.gust} km/h` : 'Météo pas encore chargée'}</span><button type="button" data-v="dweek">Voir la semaine</button></div></div>
  </article>`;
}
/** Les illustrations, une seule fois dans la page. */
function injectIllustrations() {
  if ($('#dIll')) return;
  document.body.insertAdjacentHTML('afterbegin', `<svg id="dIll" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<linearGradient id="dgR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF7A85"/><stop offset="1" stop-color="#E0315B"/></linearGradient>
<linearGradient id="dgW" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E8E2D8"/></linearGradient>
<linearGradient id="dgB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C98B5B"/><stop offset="1" stop-color="#8E5634"/></linearGradient>
<linearGradient id="dgS" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F4F5F7"/><stop offset=".5" stop-color="#A9AFB8"/><stop offset="1" stop-color="#6C727C"/></linearGradient>
<linearGradient id="dgY" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE27A"/><stop offset="1" stop-color="#F5A623"/></linearGradient>
<linearGradient id="dgC" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#C9D8DD"/></linearGradient>
<symbol id="d-cal" viewBox="0 0 64 64"><ellipse cx="32" cy="59" rx="22" ry="3" fill="#000" opacity=".12"/><rect x="8" y="11" width="48" height="45" rx="9" fill="url(#dgW)" stroke="#D9D1C4"/><path d="M8 20a9 9 0 0 1 9-9h30a9 9 0 0 1 9 9v5H8z" fill="url(#dgR)"/><rect x="18" y="5" width="6" height="13" rx="3" fill="#4A4A4A"/><rect x="40" y="5" width="6" height="13" rx="3" fill="#4A4A4A"/><g fill="#CFC6B8"><rect x="15" y="31" width="7" height="6" rx="2"/><rect x="25" y="31" width="7" height="6" rx="2"/><rect x="35" y="31" width="7" height="6" rx="2"/><rect x="45" y="31" width="5" height="6" rx="2"/><rect x="15" y="41" width="7" height="6" rx="2"/><rect x="35" y="41" width="7" height="6" rx="2"/></g><rect x="25" y="41" width="7" height="6" rx="2" fill="#E0315B"/></symbol>
<symbol id="d-clip" viewBox="0 0 64 64"><ellipse cx="32" cy="60" rx="19" ry="3" fill="#000" opacity=".12"/><rect x="12" y="8" width="40" height="50" rx="7" fill="url(#dgB)"/><rect x="17" y="15" width="30" height="38" rx="3" fill="url(#dgW)"/><rect x="23" y="4" width="18" height="10" rx="4" fill="url(#dgS)" stroke="#8A9099"/><g stroke="#B9B1A4" stroke-width="2.6" stroke-linecap="round"><path d="M28 25h13M28 33h13M28 41h9"/></g><path d="M20.5 25l2 2 3-3.5M20.5 33l2 2 3-3.5" stroke="#E0315B" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="23" cy="41" r="2.4" fill="none" stroke="#B9B1A4" stroke-width="1.8"/></symbol>
<symbol id="d-watch" viewBox="0 0 64 64"><ellipse cx="32" cy="60" rx="18" ry="3" fill="#000" opacity=".12"/><rect x="28" y="4" width="8" height="8" rx="2" fill="url(#dgS)"/><rect x="44" y="10" width="7" height="6" rx="2" fill="url(#dgS)" transform="rotate(40 47 13)"/><circle cx="32" cy="35" r="22" fill="url(#dgS)"/><circle cx="32" cy="35" r="17.5" fill="url(#dgW)"/><path d="M32 35V22" stroke="#222" stroke-width="2.6" stroke-linecap="round"/><path d="M32 35l8 5" stroke="#E0315B" stroke-width="2.6" stroke-linecap="round"/><circle cx="32" cy="35" r="2.6" fill="#222"/></symbol>
<symbol id="d-flag" viewBox="0 0 64 64"><ellipse cx="24" cy="59" rx="14" ry="3" fill="#000" opacity=".12"/><rect x="18" y="6" width="4" height="52" rx="2" fill="url(#dgS)"/><path d="M22 9h28l-6 9 6 9H22z" fill="url(#dgR)"/><path d="M28 13h4v4h-4zM36 17h4v4h-4zM28 21h4v4h-4z" fill="#fff" opacity=".85"/></symbol>
<symbol id="d-sun" viewBox="0 0 64 64"><circle cx="32" cy="32" r="15" fill="url(#dgY)"/><g stroke="#F5B531" stroke-width="3.4" stroke-linecap="round"><path d="M32 6v6M32 52v6M6 32h6M52 32h6M13.6 13.6l4.2 4.2M46.2 46.2l4.2 4.2M13.6 50.4l4.2-4.2M46.2 17.8l4.2-4.2"/></g></symbol>
<symbol id="d-sunc" viewBox="0 0 64 64"><circle cx="40" cy="22" r="13" fill="url(#dgY)"/><path d="M18 50a11 11 0 0 1-1-21.9A15 15 0 0 1 45 30a10 10 0 0 1 1 20z" fill="url(#dgC)"/></symbol>
<symbol id="d-cloud" viewBox="0 0 64 64"><path d="M18 48a12 12 0 0 1-1-23.9A16 16 0 0 1 47 27a10.5 10.5 0 0 1 1 21z" fill="url(#dgC)"/></symbol>
<symbol id="d-rain" viewBox="0 0 64 64"><path d="M16 40a11 11 0 0 1-1-21.9A15 15 0 0 1 43 20a10 10 0 0 1 1 20z" fill="url(#dgC)"/><g fill="#5E9BB0"><rect x="20" y="45" width="4" height="9" rx="2" transform="rotate(15 22 49)"/><rect x="30" y="45" width="4" height="9" rx="2" transform="rotate(15 32 49)"/><rect x="40" y="45" width="4" height="9" rx="2" transform="rotate(15 42 49)"/></g></symbol>
</defs></svg>`);
}
export function renderTodayView() {
  const host = $('#todayView');
  if (!planStart) planStart = defaultPlanStart();
  const keys = keysOf(planStart);
  const today = todayKey();
  const wi = Math.round((fromKey(planStart) - mondayOf(new Date())) / 6048e5);
  const all = doneMap();
  // Dans les 30 jours : rendez-vous, événements et courses de Cadence, en liste.
  const limit = dateKey(addDays(new Date(), 30));
  const races = (state.races || []).filter(r => r.date >= today && r.date <= limit).map(r => ({ id: r.id, title: r.name, date: r.date, time: r.time, place: r.location || '', kind: 'race' }));
  const soon = [...upcoming().filter(x => x.date <= limit), ...races].sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
  const soonRow = x => `<button type="button" class="d-it d-soon ${x.kind === 'race' ? 'is-race' : ''}" ${x.kind === 'race' ? 'data-v="race"' : `data-v="edit" data-type="${x.kind}" data-id="${esc(x.id)}"`}>
    <span class="d-th">${x.kind === 'race' ? ILL.flag : ILL.cal}</span>
    <span class="d-it__b"><b>${esc(x.title)}</b><small>${esc([x.date <= today ? 'aujourd’hui' : formatKey(x.date, { weekday: 'short', day: 'numeric', month: 'short' }), x.endDate ? span(x) : x.time ? hours(x) : '', x.kind === 'race' ? 'Cadence' : x.kind === 'events' ? 'événement' : '', x.place].filter(Boolean).join(' · '))}</small></span>
    <span class="d-j">${dayDiff(x.date) <= 0 ? 'auj.' : `J-${dayDiff(x.date)}`}</span></button>`;
  const title = wi === 0 ? 'Cette semaine' : wi === 1 ? 'Semaine prochaine' : esc(weekLabel(planStart).split(' · ')[0]);
  const hidden = keys.filter(k => k < today);

  host.innerHTML = `
    <button type="button" class="d-pill" data-v="planify"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>Planifier ${wi ? 'cette semaine-là' : 'ma semaine'}</button>
    ${wi === 0 ? todayCard(all) : ''}
    <div class="d-sec" id="dWeek"><h2>${title}<small>${esc(weekRange(planStart))}</small></h2><span><button type="button" class="d-arr" data-v="pweek" data-step="-1" aria-label="Semaine d’avant">${I.back}</button><button type="button" class="d-arr" data-v="pweek" data-step="1" aria-label="Semaine d’après">${I.fwd}</button></span></div>
    <section class="d-week">${hidden.length ? `<button type="button" class="d-past" data-v="past" aria-expanded="${showPast}">${showPast ? 'Masquer le début de la semaine' : `Voir le début de la semaine <small>${cap(WD[fromKey(hidden[0]).getDay()])}. ${fromKey(hidden[0]).getDate()} – ${WD[fromKey(hidden.at(-1)).getDay()]}. ${fromKey(hidden.at(-1)).getDate()}</small>`}</button>` : ''}${keys.filter(k => showPast || !hidden.includes(k)).map(k => dayRow(k, all)).join('')}</section>
    <div class="d-sec"><h2>Dans les 30 jours<small>${soon.length ? `${soon.length} date${soon.length > 1 ? 's' : ''}` : ''}</small></h2></div>
    <section class="d-list">${soon.map(soonRow).join('') || '<p class="j-none">Rien de prévu dans les 30 jours.</p>'}</section>`;
  done(host);
}

/* ---------- Mois : calendrier + le jour choisi + la liste du mois ---------- */
/** Une ligne de la frise / d'une liste (même format que l'accueil). */
const itRow = x => `<button type="button" class="d-it ${x.cls} ${x.done ? 'is-done' : ''}" ${x.act}><span class="d-th">${ILL_OF(x.cls)}</span><span class="d-it__b"><b>${esc(x.title)}</b><small>${esc([x.tag, x.sub].filter(Boolean).join(' · '))}</small></span>${x.warn ? `<em title="${esc(x.warn)}">!</em>` : ''}</button>`;
export function renderAgendaView() {
  const host = $('#agendaView');
  const now = new Date();
  const today = todayKey();
  const base = new Date(now.getFullYear(), now.getMonth() + monthOff, 1);
  const first = dateKey(base);
  const last = dateKey(new Date(base.getFullYear(), base.getMonth() + 1, 0));
  if (!daySel || daySel < first || daySel > last) daySel = today >= first && today <= last ? today : first;
  const all = doneMap();
  // Calendrier : du lundi avant le 1er au dimanche après le dernier jour.
  let cells = '';
  const end = dateKey(addDays(mondayOf(fromKey(last)), 6));
  for (let k = dateKey(mondayOf(base)); k <= end; k = dateKey(addDays(fromKey(k), 1))) {
    const out = k < first || k > last;
    const ev = itemsOn(k);
    const races = (state.races || []).filter(r => r.date === k);
    const ses = sessionsOn(k).length;
    const tasks = state.dashboard.tasks.filter(t => !t.done && t.date === k).length;
    const labels = [...races.map(r => `<span class="d-cal__l is-race">${esc(r.name)}</span>`), ...ev.map(x => `<span class="d-cal__l ${x.kind === 'events' ? 'is-ev' : 'is-rdv'} ${x.endDate ? 'is-span' : ''}">${x.time && !x.endDate ? `${hhmm(x.time).replace(' h 00', ' h')} ` : ''}${esc(x.title)}</span>`)];
    const d = fromKey(k);
    cells += `<button type="button" class="d-cal__c ${out ? 'is-out' : ''} ${k === today ? 'is-today' : ''} ${k === daySel ? 'is-sel' : ''} ${k < today ? 'is-past' : ''}" data-v="mday" data-day="${k}" aria-label="${esc(`${WD_FULL[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`)}" aria-pressed="${k === daySel}">
      <b>${d.getDate()}</b>${labels.slice(0, 2).join('')}${labels.length > 2 ? `<span class="d-cal__m">+${labels.length - 2}</span>` : ''}
      ${ses || tasks ? `<span class="d-cal__dots">${'<i class="is-ses"></i>'.repeat(Math.min(ses, 3))}${'<i class="is-task"></i>'.repeat(Math.min(tasks, 3))}</span>` : ''}</button>`;
  }
  // Le jour choisi : tout ce qui est prévu, comme sur l'accueil.
  const sd = fromKey(daySel);
  const dayList = entriesOn(daySel, all);
  // Tout le mois : rendez-vous, événements et courses.
  const month = [];
  for (let k = first; k <= last; k = dateKey(addDays(fromKey(k), 1))) {
    itemsOn(k).filter(x => x.date === k || (k === first && x.date < k)).forEach(x => month.push({ k, x }));
    (state.races || []).filter(r => r.date === k).forEach(r => month.push({ k, x: { id: r.id, title: r.name, kind: 'race', distance: r.distance } }));
  }
  const monthRow = ({ k, x }) => `<button type="button" class="d-it d-soon ${x.kind === 'race' ? 'is-race' : ''} ${k < today && !(x.endDate >= today) ? 'is-past' : ''}" ${x.kind === 'race' ? 'data-v="race"' : `data-v="edit" data-type="${x.kind}" data-id="${esc(x.id)}"`}>
    <span class="d-th">${x.kind === 'race' ? ILL.flag : ILL.cal}</span>
    <span class="d-it__b"><b>${esc(x.title)}</b><small>${esc([x.endDate ? span(x) : x.time ? hours(x) : '', x.kind === 'race' ? `Course${x.distance ? ` · ${x.distance} km` : ''} · Cadence` : x.kind === 'events' ? 'Événement' : 'Rendez-vous', x.place].filter(Boolean).join(' · '))}</small></span>
    <span class="d-j d-j--d"><small>${WD[fromKey(k).getDay()]}.</small>${fromKey(k).getDate()}</span></button>`;
  host.innerHTML = `
    <div class="d-sec d-sec--top"><h2>${cap(MONTHS[base.getMonth()])}<small>${base.getFullYear()} · ${month.length ? `${month.length} date${month.length > 1 ? 's' : ''}` : 'rien de prévu'}</small></h2><span><button type="button" class="d-arr" data-v="mstep" data-step="-1" aria-label="Mois d’avant" ${monthOff <= -2 ? 'disabled' : ''}>${I.back}</button><button type="button" class="d-arr" data-v="mstep" data-step="1" aria-label="Mois d’après" ${monthOff >= 12 ? 'disabled' : ''}>${I.fwd}</button></span></div>
    ${monthOff ? '<button type="button" class="d-today-btn" data-v="mstep" data-step="0">Revenir à ce mois-ci</button>' : ''}
    <section class="d-cal" aria-label="Calendrier"><div class="d-cal__h">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(x => `<span>${x}</span>`).join('')}</div><div class="d-cal__g">${cells}</div>
      <p class="d-cal__leg"><span><i class="is-rdv"></i>Rendez-vous</span><span><i class="is-ev"></i>Événement</span><span><i class="is-race"></i>Course</span><span><i class="is-ses"></i>Sport</span><span><i class="is-task"></i>Tâche</span></p></section>
    <div class="d-sec"><h2>${cap(WD_FULL[sd.getDay()])} ${sd.getDate()} ${MONTHS[sd.getMonth()]}<small>${dayList.length ? `${dayList.length} chose${dayList.length > 1 ? 's' : ''} prévue${dayList.length > 1 ? 's' : ''}` : 'Rien de prévu'}</small></h2><button type="button" class="d-add" data-v="wadd" data-day="${daySel}">+ Ajouter</button></div>
    <section class="d-list">${dayList.map(itRow).join('')}${daySel >= today && wx[daySel] ? `<button type="button" class="d-wxl" data-dwx="${daySel}">${SKY[wx[daySel].sky] || SKY.cloud}${esc(wx[daySel].label)} · ${wx[daySel].min}° / ${wx[daySel].max}° · heure par heure<span aria-hidden="true">${I.fwd}</span></button>` : ''}</section>
    <div class="d-sec"><h2>Tout le mois<small>Rendez-vous, événements et courses</small></h2></div>
    <section class="d-list">${month.map(monthRow).join('') || '<p class="j-none">Rien de prévu ce mois-ci.</p>'}</section>`;
  done(host);
}

/* ---------- Tâches ---------- */
export function renderTodoView() {
  if (assign) return renderAssign();
  const host = $('#todoView');
  const tasks = openTasks();
  const today = todayKey();
  const tomorrow = dateKey(addDays(new Date(), 1));
  const doneToday = state.dashboard.tasks.filter(t => t.done && (!t.doneAt || t.doneAt === today));
  const apps = appTasks();
  const note = document.activeElement?.id === 'vNote' ? document.activeElement : null;
  const keep = note ? { value: note.value, a: note.selectionStart, b: note.selectionEnd } : null;
  const groups = [
    ['En retard', tasks.filter(isLate), 'is-late'],
    ['Aujourd’hui', tasks.filter(t => t.date === today)],
    ['Demain', tasks.filter(t => t.date === tomorrow)],
    ['Cette semaine', tasks.filter(t => t.date && dayDiff(t.date) > 1 && dayDiff(t.date) <= 7)],
    ['Plus tard', tasks.filter(t => t.date && dayDiff(t.date) > 7)],
    ['Sans date', tasks.filter(t => !t.date)]
  ].filter(g => g[1].length);
  host.innerHTML = `
    <header class="j-hd"><p class="k-kicker">${tasks.length} à faire${apps.length ? ` · ${apps.length} de tes apps` : ''}</p><h1>Tâches</h1></header>
    ${groups.map(([label, list, cls]) => `<div class="e-sec ${cls || ''}"><h2>${label}</h2><small>${list.length}</small></div><div class="card e-list">${list.map(taskRow).join('')}</div>`).join('') || '<div class="card e-empty">Rien à faire. Belle journée.</div>'}
    ${apps.length ? `<div class="e-sec"><h2>Depuis tes apps</h2><small>${apps.length}</small></div><div class="card e-list">${apps.map(appRow).join('')}</div>` : ''}
    ${doneToday.length ? `<div class="e-sec"><h2>Faites aujourd’hui</h2><small>${doneToday.length}</small></div><div class="card e-list">${doneToday.map(t => `<button type="button" class="e-row is-done" data-v="undo" data-id="${esc(t.id)}"><span class="e-check is-on"><i>${I.check}</i></span><span class="e-row__b"><span class="e-row__t">${esc(t.title)}</span><span class="e-row__s">${isRepeat(t.repeat) ? esc(REPEATS[t.repeat].label.toLowerCase()) : 'disparaît demain · touche pour annuler'}</span></span></button>`).join('')}</div>` : ''}
    ${tasks.length ? '<p class="k-hint">→ fait · ← demain · touche pour modifier</p>' : ''}
    <section class="k-blk"><div class="k-blk-h"><h2><label for="vNote">Note</label></h2><span class="k-save" id="vNoteState" aria-live="polite"></span></div>
      <div class="k-card k-note"><textarea id="vNote" placeholder="Écrire…" maxlength="20000">${esc(keep ? keep.value : state.notes)}</textarea></div></section>`;
  if (keep) {
    const t = $('#vNote');
    t.focus({ preventScroll: true });
    t.setSelectionRange(keep.a, keep.b);
  }
  bindRows(host);
  done(host);
}

/* ---------- Tâches : répartir sur la semaine ---------- */
/** Chaque tâche à faire, avec les 7 jours de la semaine choisie : un appui l'attribue à ce jour. */
function renderAssign() {
  const host = $('#todoView');
  const thisMon = dateKey(mondayOf(new Date()));
  if (!assignStart) assignStart = thisMon;
  const keys = keysOf(assignStart);
  const today = todayKey();
  const off = Math.round((fromKey(assignStart) - fromKey(thisMon)) / 6048e5);
  const tasks = openTasks().filter(t => !isRepeat(t.repeat)).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const free = tasks.filter(t => !t.date).length;
  const row = t => {
    const out = t.date && !keys.includes(t.date);
    return `<div class="w-as ${flash === t.id ? 'e-flash' : ''}"><button type="button" class="w-as__t" data-v="tedit" data-id="${esc(t.id)}"><b>${esc(t.title)}</b><small class="${isLate(t) ? 'is-late' : ''}">${esc(t.date ? (out ? `${isLate(t) ? 'en retard · ' : ''}${dateWord(t.date)}` : cap(formatKey(t.date, { weekday: 'long', day: 'numeric' }))) : 'pas encore de jour')}</small></button>
      <div class="w-as__d">${keys.map(k => { const d = fromKey(k); return `<button type="button" data-v="aday" data-id="${esc(t.id)}" data-day="${k}" aria-pressed="${t.date === k}" class="${k < today ? 'is-past' : ''} ${k === today ? 'is-today' : ''}" aria-label="${esc(formatKey(k, { weekday: 'long', day: 'numeric' }))}"><small>${WD[d.getDay()].slice(0, 1).toUpperCase()}</small>${d.getDate()}</button>`; }).join('')}</div></div>`;
  };
  host.innerHTML = `
    ${head(`${free} sans jour · ${tasks.length - free} placée${tasks.length - free > 1 ? 's' : ''}`, 'Répartir', '<button type="button" class="k-lnk" data-v="assign">Terminé</button>')}
    <div class="w-seg" role="group" aria-label="Semaine">${[[0, 'Cette semaine'], [1, 'Semaine prochaine']].map(([o, l]) => `<button type="button" data-v="aweek" data-off="${o}" aria-pressed="${off === o}">${l}</button>`).join('')}</div>
    <p class="k-hint w-hint">Touche un jour pour y mettre la tâche, touche-le encore pour l’enlever.</p>
    <div class="card w-aslist">${tasks.map(row).join('') || '<p class="e-empty">Aucune tâche à répartir. Le + en ajoute une.</p>'}</div>`;
  done(host);
}
function assignDay(id, k) {
  const t = state.dashboard.tasks.find(x => x.id === id);
  if (!t) return;
  const prev = t.date;
  t.date = t.date === k ? '' : k;
  if (!t.date) t.time = '';
  buzz(8);
  commit('dashboard');
  toast(t.date ? `${t.title} · ${dayWord(t.date)}` : `${t.title} · sans jour`, { action: { label: 'Annuler', onClick: () => { t.date = prev; commit('dashboard'); } } });
}

/* ---------- Ma semaine : tout ce qui est prévu, et ce qu'on peut réorganiser ---------- */
/** Plages horaires des créneaux, en minutes (mêmes heures que la météo par créneau). */
const SLOT_RANGE = { matin: [7 * 60, 12 * 60], aprem: [12 * 60, 18 * 60], soir: [18 * 60, 22 * 60] };
const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Heures prises un jour donné : rendez-vous et événements avec une heure (1 h si pas de fin). */
function busyOn(k) {
  return itemsOn(k)
    .filter(x => x.time && (!x.endDate || x.date === k))
    .map(x => ({ x, a: toMin(x.time), b: x.endTime && x.endTime > x.time ? toMin(x.endTime) : toMin(x.time) + 60 }));
}
/** Plus longue plage libre d'un créneau (en minutes) et ce qui l'occupe. */
function freeIn(k, sl) {
  let [a, b] = SLOT_RANGE[sl];
  if (k === todayKey()) a = Math.max(a, new Date().getHours() * 60 + new Date().getMinutes());
  const busy = busyOn(k).filter(r => r.b > a && r.a < b).sort((p, q) => p.a - q.a);
  let gap = 0;
  let cur = a;
  busy.forEach(r => {
    gap = Math.max(gap, r.a - cur);
    cur = Math.max(cur, r.b);
  });
  gap = Math.max(gap, b - cur);
  return { gap: Math.max(0, gap), by: busy[0]?.x || null };
}
const needOf = s => durMin(s.time) || 60;
const okSlot = (s, k, sl) => !slotPast(k, sl) && freeIn(k, sl).gap >= needOf(s);
const wxScore = (s, k, sl) => score(kindOf(s), slotsOn(k)?.[sl]);
/** Créneau d'une séance dans « Ma semaine » : celui choisi, sinon le meilleur créneau libre selon la météo. */
function planSlot(s, k) {
  if (s.slot) return s.slot;
  const open = SLOT_IDS.filter(sl => okSlot(s, k, sl));
  if (!open.length) return slotOf(s, k);
  return open.reduce((a, b) => (wxScore(s, k, b) > wxScore(s, k, a) ? b : a));
}
/** Séance à faire à la maison : un sport d'intérieur (renfo de préférence). */
function homeFamily() {
  const fams = (state.families || []).filter(f => kindOfFamily(f.name) === 'indoor');
  const f = fams.find(x => /muscu|renfo/i.test(x.name)) || fams[0];
  if (!f) return null;
  const types = f.types.filter(t => !isRestTraining(t));
  return { f, type: types.find(t => /renfo/i.test(t)) || types[0] || '' };
}
/** Ce qui ne va pas pour une séance (créneau pris, météo à éviter) et ce que Carnet propose à la place. */
function issueOf(s, k) {
  if (k < todayKey() || isDone(k, s)) return null;
  const sl = planSlot(s, k);
  if (!sl) return null;
  const kind = kindOf(s);
  const w = slotsOn(k)?.[sl];
  const f = freeIn(k, sl);
  const busy = !slotPast(k, sl) && f.gap < needOf(s) ? f.by || { title: 'la journée' } : null;
  const bad = kind !== 'indoor' && w && level(score(kind, w)) === 'bad';
  const past = slotPast(k, sl);
  if (!busy && !bad && !past) return null;
  const fine = (k2, sl2) => okSlot(s, k2, sl2) && (kind === 'indoor' || !slotsOn(k2)?.[sl2] || level(wxScore(s, k2, sl2)) !== 'bad');
  const same = SLOT_IDS.filter(x => x !== sl && fine(k, x)).sort((p, q) => wxScore(s, k, q) - wxScore(s, k, p))[0];
  let other = null;
  if (!same) {
    keysOf(planStart).filter(k2 => k2 !== k && k2 >= todayKey()).forEach(k2 => {
      SLOT_IDS.filter(x => fine(k2, x) && slotsOn(k2)?.[x]).forEach(x => {
        const v = wxScore(s, k2, x) - Math.abs(dayDiff(k2) - dayDiff(k)) * 4 + (sessionsOn(k2).length ? 0 : 12);
        if (!other || v > other.v) other = { k: k2, sl: x, v };
      });
    });
  }
  const home = kind !== 'indoor' && (bad || (busy && !same)) ? homeFamily() : null;
  const reason = busy
    ? `« ${busy.title} »${busy.time ? ` à ${hhmm(busy.time)}` : ''} : pas ${durLabel(needOf(s))} de libre le ${SLOTS[sl].toLowerCase()}`
    : past ? `le ${SLOTS[sl].toLowerCase()} est passé` : `${why(w) || 'météo à éviter'} le ${SLOTS[sl].toLowerCase()}`;
  return { sl, reason, same, other, home };
}
/** Tout ce qui est prévu un jour donné, dans l'ordre de la journée : rendez-vous et événements, courses,
 *  séances, tâches (celles en retard passent sur aujourd'hui). Sert à la semaine condensée et à « Planifier ». */
function entriesOn(k, all = doneMap()) {
  const today = todayKey();
  const out = [];
  itemsOn(k).forEach(x => {
    const n = spanDays(x);
    const ev = x.kind === 'events';
    const at = x.time && (!x.endDate || x.date === k) ? x.time : '';
    out.push({ id: x.id, at: at || '00:00', cls: ev ? 'c-ev' : 'c-rdv', tag: at ? hhmm(at) : ev ? 'Événement' : 'RDV', title: x.title, sub: n ? `jour ${dayDiff(k) - dayDiff(x.date) + 1}/${n + 1}` : '', act: `data-v="edit" data-type="${x.kind}" data-id="${esc(x.id)}"` });
  });
  (state.races || []).filter(r => r.date === k).forEach(r => out.push({ id: r.id, at: r.time || '00:01', cls: 'c-race', tag: 'Course', title: r.name, act: 'data-v="race"' }));
  sessionsOn(k).forEach(s => {
    const sl = planSlot(s, k);
    const done = isDone(k, s, all);
    out.push({ id: s.id, at: sl ? `${pad(SLOT_RANGE[sl][0] / 60)}:30` : '12:30', cls: `c-ses k-${TILE[kindOf(s)]}`, tag: s.training || '', sub: [s.distance ? km(s.distance) : '', durLabel(durMin(s.time)), sl ? SLOT_WHEN[sl] : ''].filter(Boolean).join(' · '), title: familyOf(s)?.name || s.training || 'Séance', done, warn: !done && issueOf(s, k)?.reason, act: `data-v="pedit" data-day="${k}" data-id="${esc(s.id)}"` });
  });
  state.dashboard.tasks
    .filter(t => (t.date === k && (t.done ? !t.doneAt || t.doneAt >= today : k >= today)) || (k === today && !t.done && isLate(t)))
    .forEach(t => out.push({ id: t.id, at: t.time || '99:99', cls: 'c-task', tag: 'Tâche', title: t.title, done: t.done, sub: isLate(t) ? 'en retard' : '', act: `data-v="tedit" data-id="${esc(t.id)}"` }));
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
const SLOT_WHEN = { matin: 'matin', aprem: 'ap.-midi', soir: 'soir' };
/** Météo d'un jour en une ligne courte, couleur selon une sortie à pied (idéal / moyen / à éviter). */
function dayWx(k) {
  const w = wx[k];
  if (!w) return null;
  const ss = Object.values(w.slots || {});
  const best = bestSlot('run', k);
  return {
    sky: SKY[w.sky] || SKY.cloud,
    min: w.min,
    max: w.max,
    rain: ss.length ? Math.max(...ss.map(x => x.rain)) : 0,
    wind: ss.length ? Math.max(...ss.map(x => x.wind)) : 0,
    gust: ss.length ? Math.max(...ss.map(x => x.gust)) : 0,
    windAvg: w.hours?.length ? Math.round(w.hours.reduce((a, x) => a + x.wind, 0) / w.hours.length) : ss.length ? Math.round(ss.reduce((a, x) => a + x.wind, 0) / ss.length) : 0,
    mm: Math.round(ss.reduce((a, x) => a + (x.mm || 0), 0) * 10) / 10,
    q: best ? level(score('run', w.slots[best])) : ss.length ? level(Math.max(...ss.map(x => score('run', x)))) : 'ok',
    label: w.label
  };
}
const isSundayEve = () => new Date().getDay() === 0 && new Date().getHours() >= 15;
const defaultPlanStart = () => dateKey(addDays(mondayOf(new Date()), isSundayEve() ? 7 : 0));
const weekRange = start => {
  const a = fromKey(start);
  const b = addDays(a, 6);
  return `${a.getDate()}${a.getMonth() !== b.getMonth() ? ` ${MONTHS[a.getMonth()]}` : ''} – ${b.getDate()} ${MONTHS[b.getMonth()]}`;
};
const weekLabel = start => {
  const wi = Math.round((fromKey(start) - mondayOf(new Date())) / 6048e5);
  const end = addDays(fromKey(start), 6);
  const s = fromKey(start);
  return `${wi === 0 ? 'Cette semaine' : wi === 1 ? 'Semaine prochaine' : wi === -1 ? 'Semaine dernière' : wi > 0 ? `Dans ${wi} semaines` : `Il y a ${-wi} semaines`} · ${s.getDate()}${s.getMonth() !== end.getMonth() ? ` ${formatDate(s, { month: 'short' })}` : ''} – ${end.getDate()} ${formatDate(end, { month: 'short' })}`;
};

/* ---------- « Planifier » : un jour après l'autre, les tâches puis la séance ---------- */
let W = null; // { part: 'w' météo | 't' tâches | 's' sport }
const wEl = () => $('#wPlan');
function openPlanner() {
  planStart = defaultPlanStart();
  W = { part: 'c' };
  loadWx();
  const el = wEl();
  el.hidden = false;
  document.body.classList.add('e-flow-on');
  renderPlanner();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
}
function closePlanner() {
  const el = wEl();
  el.classList.remove('is-open');
  document.body.classList.remove('e-flow-on');
  W = null;
  setTimeout(() => (el.hidden = true), reduced() ? 0 : 320);
  renderCurrent();
}
const box = (title, body) => `<section class="j-box"><h3>${title}</h3>${body}</section>`;
/* Météo : actualisation à la main, heure de mise à jour et lieu. */
let placeOpen = false;
let placeHits = [];
function wxBar() {
  const at = wxAt();
  return `<div class="j-wxbar"><span>${I.pin}<b>${esc(getPlace().name)}</b> · ${at ? `mise à jour à ${pad(at.getHours())} h ${pad(at.getMinutes())}` : 'pas encore chargée'}</span>
    <span class="j-wxbar__a"><button type="button" data-wx="refresh">Actualiser</button><button type="button" data-wx="place" aria-expanded="${placeOpen}">Lieu</button></span></div>
    ${placeOpen ? `<form class="j-add j-place" data-wx="search" autocomplete="off"><input placeholder="Ville (ex. Pontarlier)" aria-label="Chercher une ville" maxlength="80"><button type="submit" aria-label="Chercher">${I.go}</button></form>
      ${placeHits.length ? `<div class="j-hits">${placeHits.map((p, i) => `<button type="button" data-wx="pick" data-i="${i}"><b>${esc(p.name)}</b> <small>${esc([p.admin1, p.country].filter(Boolean).join(', '))}</small></button>`).join('')}</div>` : ''}` : ''}`;
}
function refreshWx() {
  wx = {};
  wxAsked.clear();
  loadWx(true);
  toast('Météo en cours d’actualisation…');
}
function onWxClick(e) {
  const b = e.target.closest('[data-wx]');
  if (!b || b.tagName === 'FORM') return;
  const a = b.dataset.wx;
  if (a === 'refresh') return refreshWx();
  if (a === 'place') { placeOpen = !placeOpen; placeHits = []; renderCurrent(); return setTimeout(() => $('.j-place input')?.focus(), 30); }
  if (a === 'pick') {
    const p = placeHits[Number(b.dataset.i)];
    if (!p) return;
    setPlace({ name: p.name, lat: p.lat, lon: p.lon });
    placeOpen = false;
    placeHits = [];
    toast(`Météo : ${p.name}`);
    return refreshWx();
  }
}
function onWxSubmit(e) {
  if (e.target.dataset?.wx !== 'search') return;
  e.preventDefault();
  e.stopPropagation();
  const q = e.target.querySelector('input').value;
  searchPlaces(q).then(list => {
    placeHits = list;
    if (!list.length) toast('Aucune ville trouvée');
    renderCurrent();
  }).catch(() => toastError('Recherche de ville impossible (hors ligne ?)'));
}
/** Petite bande des 7 jours : beau, gris ou pluie (pour placer les tâches). */
const wxHead = keys => `<div class="j-th"><span></span>${keys.map(k => { const d = fromKey(k); const w = wx[k]; return `<span class="t-${toneOf(k)} ${k < todayKey() ? 'is-past' : ''}"><small>${cap(WD[d.getDay()]).slice(0, 3)}</small><b>${d.getDate()}</b>${w ? SKY[w.sky] || SKY.cloud : ''}</span>`; }).join('')}</div>`;
function jTasks(keys) {
  const today = todayKey();
  const tasks = openTasks().filter(t => !isRepeat(t.repeat) && (!t.date || t.date <= keys[6]));
  const row = t => `<div class="j-tr ${flash === t.id ? 'e-flash' : ''}"><span class="j-tr__t"><b>${esc(t.title)}</b>${isLate(t) ? '<small class="is-late">en retard</small>' : !t.date ? '<small>pas de jour</small>' : ''}</span>
    ${keys.map(k => `<button type="button" data-w="tday" data-id="${esc(t.id)}" data-day="${k}" aria-pressed="${t.date === k}" ${k < today ? 'disabled' : ''} aria-label="${esc(formatKey(k, { weekday: 'long', day: 'numeric' }))}"></button>`).join('')}</div>`;
  return `${wxHead(keys)}<div class="j-tl">${tasks.map(row).join('') || '<p class="j-none">Aucune tâche à placer.</p>'}</div>
    <form class="j-add" data-w="addtask" autocomplete="off"><input placeholder="Nouvelle tâche" aria-label="Nouvelle tâche" maxlength="100"><button type="submit" aria-label="Ajouter">+</button></form>
    <p class="j-sub">Touche la case d’un jour pour y mettre la tâche, encore une fois pour l’enlever.</p>`;
}
function jSport(keys) {
  const today = todayKey();
  const ph = phaseOn(keys[3], getPhases()) || phaseOn(keys[0], getPhases());
  const race = nextRace();
  const nWeek = keys.reduce((n, x) => n + sessionsOn(x).length, 0);
  const opt = (v, l, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(l)}</option>`;
  const phase = `<p class="j-phase">${ph ? `Cadence : <b>${esc(PHASE_TYPES[ph.type].short)}</b>. ` : ''}${race ? `🏁 ${esc(race.name)} dans ${dayDiff(race.date)} jours. ` : ''}${nWeek} séance${nWeek > 1 ? 's' : ''} cette semaine.</p>`;
  const days = keys.filter(k => k >= today).map(k => {
    const d = fromKey(k);
    const ss = sessionsOn(k);
    const busy = itemsOn(k).map(x => `${x.title}${x.time && (!x.endDate || x.date === k) ? ` ${hours(x)}` : ''}`);
    const cells = SLOT_IDS.map(sl => {
      const w = slotsOn(k)?.[sl];
      const past = slotPast(k, sl);
      const f = freeIn(k, sl);
      const by = !past && f.gap < 60 ? f.by : null;
      return `<span class="j-wc ${past ? 'is-past' : by ? 'is-busy' : w ? `q-${level(score('run', w))}` : ''}"><small>${SLOT_WHEN[sl]}</small>${past ? '—' : by ? `<b class="j-wc__by">${esc(by.title)}</b>` : w ? `${skyOf(w)}<b>${w.wind}</b><small>raf. ${w.gust} · ${w.t}°</small>` : '·'}</span>`;
    }).join('');
    const rows = ss.map(s => {
      const is = issueOf(s, k);
      return `<div class="j-sp ${landed === s.id || flash === s.id ? 'e-flash' : ''}"><button type="button" class="j-sp__t" data-w="sedit" data-day="${k}" data-id="${esc(s.id)}"><b>${esc(s.training || familyOf(s)?.name || 'Séance')}</b><small>${esc([familyOf(s)?.name, s.distance ? km(s.distance) : '', durLabel(durMin(s.time))].filter(Boolean).join(' · '))}</small>${is ? `<em>${esc(is.reason)}</em>` : ''}</button>
        <div class="j-sp__s"><select data-w="sday" data-day="${k}" data-id="${esc(s.id)}" aria-label="Jour">${keys.filter(x => x >= today).map(x => opt(x, cap(formatKey(x, { weekday: 'short', day: 'numeric' })), x === k)).join('')}</select>
        <select data-w="sslot" data-day="${k}" data-id="${esc(s.id)}" aria-label="Moment">${SLOT_IDS.map(sl => opt(sl, SLOTS[sl], planSlot(s, k) === sl)).join('')}</select></div></div>`;
    }).join('');
    return `<section class="j-sd"><header><b>${k === today ? 'Aujourd’hui' : cap(WD_FULL[d.getDay()])} ${d.getDate()}</b>${busy.length ? `<small>${esc(busy.join(' · '))}</small>` : ''}</header>
      <div class="j-sd__w">${cells}</div>${rows || '<p class="j-rest-s">Repos</p>'}<button type="button" class="j-plus" data-w="add" data-day="${k}">+ Séance</button></section>`;
  }).join('');
  return `${phase}${days}`;
}
/** La météo de toute la semaine sur une page : ciel, températures, puis vent et rafales matin / ap.-midi / soir. */
function jWeek(keys) {
  const today = todayKey();
  const cell = (k, sl) => {
    const w = slotsOn(k)?.[sl];
    if (k < today || slotPast(k, sl)) return '<span class="j-wc is-past">—</span>';
    if (!w) return '<span class="j-wc">·</span>';
    return `<span class="j-wc q-${level(score('run', w))}">${skyOf(w)}<b>${w.wind}</b><small>raf. ${w.gust}</small>${w.rain >= 40 ? `<em>${w.rain} %</em>` : ''}</span>`;
  };
  const rows = keys.filter(k => k >= today).map(k => {
    const d = fromKey(k);
    const w = dayWx(k);
    return `<div class="j-wr t-${k < today ? 'grey' : toneOf(k)} ${k === today ? 'is-today' : ''} ${k < today ? 'is-past' : ''}">
      <button type="button" class="j-wr__d" data-dwx="${k}" aria-label="Météo heure par heure, ${WD_FULL[d.getDay()]} ${d.getDate()}"><b>${cap(WD[d.getDay()])} ${d.getDate()}</b>${w ? `<small>${w.sky}${w.min}°/${w.max}°</small>` : '<small>—</small>'}<small class="j-wr__more">heure par heure ›</small></button>
      ${SLOT_IDS.map(sl => cell(k, sl)).join('')}</div>`;
  }).join('');
  return `${wxChart(keys)}${wxBar()}<div class="j-wgrid"><span></span><small>Matin</small><small>Ap.-midi</small><small>Soir</small></div>${rows}
    <p class="j-sub">Vent et rafales en km/h. Vert : bon pour sortir, orange : moyen, rouge : à éviter.</p>`;
}
const PL_STEPS = [['w', 'Météo'], ['t', 'Tâches'], ['s', 'Sport']];
/** La semaine en courbes (vent, rafales) sur fond bleu canard, comme une appli météo. */
function wxChart(keys) {
  const today = todayKey();
  const days = keys.filter(k => k >= today);
  const pts = days.flatMap(k => SLOT_IDS.map(sl => slotsOn(k)?.[sl]).filter(Boolean));
  if (pts.length < 3) return '';
  const gusty = days.filter(k => (dayWx(k)?.gust || 0) >= 45);
  const name = k => WD_FULL[fromKey(k).getDay()];
  const head = !gusty.length ? 'Une semaine <b>plutôt calme</b>.' : gusty.length >= days.length / 2 ? 'Une semaine <b>venteuse</b>.' : `Une semaine <b>plutôt calme</b>, sauf ${gusty.slice(0, 2).map(name).join(' et ')}.`;
  const max = Math.max(40, ...pts.map(x => x.gust)) * 1.2;
  const peak = pts.reduce((a, x) => (x.gust > a.gust ? x : a), pts[0]);
  return `<section class="d-wx"><p class="d-wx__h">${head}</p>
    <div class="d-wx__c"><svg viewBox="0 0 350 150" preserveAspectRatio="none" aria-hidden="true"><path d="${curve(pts.map(x => x.gust), 350, 150, max)}" fill="#1C5B6B"/><path d="${curve(pts.map(x => x.wind), 350, 150, max)}" fill="#BFD3D8"/></svg>
      <span class="d-wx__pk">${peak.gust}<small> km/h en rafales au plus fort</small></span>
      <div class="d-wx__d">${days.map(k => `<span class="${gusty.includes(k) ? 'is-bad' : ''}">${cap(WD[fromKey(k).getDay()])}</span>`).join('')}</div></div>
    <p class="d-wx__l"><i></i>vent moyen <i class="g"></i>rafales</p></section>`;
}
/** Planifier, l'écran de départ : trois grandes cartes. */
function jChoice(keys) {
  const n = openTasks().filter(t => !isRepeat(t.repeat) && (!t.date || t.date <= keys[6])).length;
  const ph = phaseOn(keys[3], getPhases()) || phaseOn(keys[0], getPhases());
  const ns = keys.reduce((a, x) => a + sessionsOn(x).length, 0);
  const card = (p, i, ill, t, s) => `<button type="button" class="d-choice" data-w="go" data-p="${p}"><span><i>${i}</i><b>${t}</b><small>${esc(s)}</small></span>${ill}</button>`;
  return `<div class="d-choices">${card('w', 1, ILL.sunc, 'La météo', 'Un coup d’œil sur la semaine')}${card('t', 2, ILL.clip, 'Les tâches', `${n} à placer`)}${card('s', 3, ILL.watch, 'Le sport', `${ph ? `Cadence · ${PHASE_TYPES[ph.type].short} · ` : ''}${ns} séance${ns > 1 ? 's' : ''}`)}</div>`;
}
function renderPlanner() {
  if (!W) return;
  const el = wEl();
  const keys = keysOf(planStart);
  const thisMon = dateKey(mondayOf(new Date()));
  const i = PL_STEPS.findIndex(x => x[0] === W.part);
  const y = el.querySelector('.pl-b')?.scrollTop || 0;
  el.dataset.tone = 'grey';
  const title = { c: 'Que voulez-vous planifier ?', w: 'La météo', t: 'Quel jour pour chaque tâche ?', s: 'Et maintenant, vos séances' }[W.part];
  const body = { c: jChoice, w: jWeek, t: jTasks, s: jSport }[W.part](keys);
  const prog = PL_STEPS.map((_, j) => `<i class="${j < i ? 'is-f' : j === i ? 'is-h' : ''}"></i>`).join('');
  const foot = W.part === 'c'
    ? '<span class="d-ft__t">Tout, dans l’ordre</span><button type="button" class="d-next is-rose" data-w="go" data-p="w">Commencer</button>'
    : `<button type="button" class="d-back" data-w="go" data-p="${i ? PL_STEPS[i - 1][0] : 'c'}">Retour</button><button type="button" class="d-next ${i === 2 ? 'is-rose' : ''}" data-w="${i < 2 ? 'go' : 'end'}" data-p="${i < 2 ? PL_STEPS[i + 1][0] : ''}">${i === 0 ? 'Suivant' : i === 1 ? 'Suivant' : 'Valider la semaine'}</button>`;
  el.innerHTML = `<div class="pl-h d-ph">${W.part === 'c' ? '<span></span>' : `<div class="d-steps">${PL_STEPS.map(([p, l]) => `<button type="button" data-w="go" data-p="${p}" aria-pressed="${p === W.part}">${l}</button>`).join('')}</div>`}<button type="button" class="k-round" data-w="close" aria-label="Fermer">${I.x}</button></div>
    <div class="pl-b"><p class="j-k">Semaine du ${esc(weekRange(planStart))}<button type="button" class="j-wk-sw" data-w="wk" data-off="${planStart === thisMon ? 1 : 0}">${planStart === thisMon ? 'Semaine prochaine →' : '← Cette semaine'}</button></p>
      <h2 class="j-h">${title}</h2>${body}</div>
    <div class="pl-f d-ft">${W.part === 'c' ? '' : `<div class="d-prog" aria-label="Étape ${i + 1} sur 3">${prog}</div>`}<div class="d-ft__r">${foot}</div></div>`;
  if (W.keepScroll) el.querySelector('.pl-b').scrollTop = y;
  W.keepScroll = false;
}
function onPlannerClick(e) {
  const b = e.target.closest('[data-w]');
  if (!b || b.disabled || b.tagName === 'FORM' || b.tagName === 'SELECT') return;
  const a = b.dataset.w;
  const { id, day } = b.dataset;
  if (a === 'close') return closePlanner();
  if (a === 'end') { closePlanner(); return goto('todayView'); }
  if (a === 'go') { W.part = b.dataset.p; return renderPlanner(); }
  if (a === 'wk') {
    planStart = dateKey(addDays(mondayOf(new Date()), Number(b.dataset.off) * 7));
    loadWx();
    return renderPlanner();
  }
  W.keepScroll = true;
  if (a === 'tday') return assignDay(id, day);
  if (a === 'add') { loadWx(); return newSession(day); }
  if (a === 'sedit') return openEdit(day, id);
}
function onPlannerChange(e) {
  const t = e.target;
  const { w, day, id } = t.dataset;
  if (!W || !id) return;
  W.keepScroll = true;
  if (w === 'sslot') return setSessionSlot(day, id, t.value);
  if (w === 'sday') {
    const s = plansOn(day).find(x => x.id === id);
    const open = s ? SLOT_IDS.filter(sl => okSlot(s, t.value, sl)) : [];
    return moveSession(id, day, t.value, (s?.slot && open.includes(s.slot) ? s.slot : open.sort((p, q) => wxScore(s, t.value, q) - wxScore(s, t.value, p))[0]) || 'aprem');
  }
}
function onPlannerSubmit(e) {
  e.preventDefault();
  if (e.target.dataset.w !== 'addtask') return;
  const inp = e.target.querySelector('input');
  const title = inp.value.trim().slice(0, 100);
  if (!title) return;
  const id = uid();
  state.dashboard.tasks.push({ id, title, date: '', time: '', note: '', done: false });
  flash = id;
  W.keepScroll = true;
  commit('dashboard');
  setTimeout(() => { flash = null; wEl().querySelector('.j-add input')?.focus(); }, 60);
}
function setSessionSlot(k, id, sl) {
  const s = plansOn(k).find(x => x.id === id);
  if (!s) return;
  const prev = s.slot;
  s.slot = sl;
  landed = id;
  commit('plans');
  setTimeout(() => (landed = null), 1300);
  buzz(10);
  toast(`${s.training || 'Séance'} · ${SLOTS[sl].toLowerCase()}`, { action: { label: 'Annuler', onClick: () => { s.slot = prev; commit('plans'); } } });
}
function sessionAtHome(k, id) {
  const s = plansOn(k).find(x => x.id === id);
  const h = homeFamily();
  if (!s || !h) return;
  const prev = { family: s.family, training: s.training, distance: s.distance, elevation: s.elevation };
  Object.assign(s, { family: h.f.id, training: h.type, distance: '', elevation: '' });
  landed = id;
  commit('plans');
  setTimeout(() => (landed = null), 1300);
  buzz(10);
  toast(`${h.type || h.f.name} à la maison`, { action: { label: 'Annuler', onClick: () => { Object.assign(s, prev); commit('plans'); } } });
}
function toggleTask(id) {
  const t = state.dashboard.tasks.find(x => x.id === id);
  if (!t) return;
  if (t.done) {
    t.done = false;
    delete t.doneAt;
  } else {
    t.done = true;
    t.doneAt = todayKey();
    buzz(12);
  }
  commit('dashboard');
  return t.done;
}

/* ---------- Sport : le planning détaillé ---------- */
/** Fiche d'une séance, dépliée sous sa ligne : sport, type, km, durée, D+, moment. */
function editorHTML(s, k) {
  const f = familyOf(s);
  const opt = (v, l, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(l)}</option>`;
  const types = (f?.types || []).filter(t => !isRestTraining(t));
  const days = Array.from({ length: 21 }, (_, i) => dateKey(addDays(new Date(), i)));
  if (!days.includes(k)) days.unshift(k);
  return `<div class="e-ed" data-day="${k}" data-sid="${esc(s.id)}">
    <div class="e-ed__g">
      <label class="e-ed__f is-wide"><span>Jour</span><select data-ed="day">${days.map(x => opt(x, cap(formatKey(x, { weekday: 'long', day: 'numeric', month: 'long' })), x === k)).join('')}</select></label>
      <label class="e-ed__f is-wide"><span>Sport</span><select data-ed="family">${(state.families || []).map(x => opt(x.id, x.name, x.id === s.family)).join('')}</select></label>
      <label class="e-ed__f is-wide"><span>Séance</span><select data-ed="training">${opt('', '— Choisir —', !s.training)}${types.map(t => opt(t, t, t === s.training)).join('')}${s.training && !types.includes(s.training) ? opt(s.training, s.training, true) : ''}</select></label>
      <label class="e-ed__f"><span>km</span><input data-ed="distance" type="text" inputmode="decimal" value="${esc(s.distance || '')}" placeholder="0" autocomplete="off"></label>
      <label class="e-ed__f"><span>Durée</span><input data-ed="time" type="time" step="60" value="${esc(s.time || '00:00')}"></label>
      <label class="e-ed__f"><span>D+ m</span><input data-ed="elevation" type="text" inputmode="numeric" value="${esc(s.elevation || '')}" placeholder="0" autocomplete="off"></label>
      <label class="e-ed__f"><span>Moment</span><select data-ed="slot">${opt('', 'Au mieux', !s.slot)}${SLOT_IDS.map(sl => opt(sl, SLOTS[sl], s.slot === sl)).join('')}</select></label>
    </div>
    <div class="e-ed__a"><button type="button" class="k-lnk is-danger" data-v="sdel" data-day="${k}" data-id="${esc(s.id)}">${edit?.isNew ? 'Annuler' : 'Supprimer'}</button><button type="button" class="k-lnk" data-v="sports">Gérer les sports</button><button type="button" class="e-ed__ok" data-v="sclose">OK</button></div>
  </div>`;
}

/** Une séance dans la liste de la semaine : titre, puis sport · km · durée · moment. La météo n'apparaît
 *  ici que si elle est mauvaise (elle est déjà donnée une fois pour la journée). */
function sesLine(s, k, all) {
  const today = todayKey();
  const done = isDone(k, s, all);
  const kind = kindOf(s);
  const sl = slotOf(s, k);
  const w = slotsOn(k)?.[sl];
  const bad = k >= today && !done && kind !== 'indoor' && w && level(score(kind, w)) === 'bad';
  const sub = [familyOf(s)?.name, s.distance ? km(s.distance) : '', durLabel(durMin(s.time)), sl ? SLOTS[sl].toLowerCase() : ''].filter(Boolean).join(' · ');
  const check = k <= today ? `<button type="button" class="e-check ${done ? 'is-on' : ''}" data-v="session" data-day="${k}" data-id="${esc(s.id)}" aria-pressed="${done}" aria-label="${done ? 'Séance faite' : 'Marquer la séance faite'}"><i>${I.check}</i></button>` : '';
  return `<div class="s-ses k-${TILE[kind]} ${done ? 'is-done' : ''} ${k < today && !done ? 'is-miss' : ''} ${landed === s.id || flash === s.id ? 'e-flash' : ''}"><button type="button" class="s-ses__m" data-v="sedit" data-day="${k}" data-id="${esc(s.id)}"><b>${esc(s.training || familyOf(s)?.name || 'Séance')}</b><span>${esc(sub)}${bad ? ` · <em>${esc(why(w) || 'météo à éviter')}</em>` : ''}</span></button>${check}</div>`;
}

let phaseOpen = false;
export function renderWeekView() {
  const host = $('#weekView');
  if (!weekStart) weekStart = dateKey(mondayOf(new Date()));
  const keys = keysOf(weekStart);
  const start = fromKey(weekStart);
  const end = addDays(start, 6);
  const today = todayKey();
  const st = weekStats(keys);
  const all = doneMap();
  const phases = getPhases();
  const ph = phaseOn(keys[3], phases) || phaseOn(keys[0], phases);
  const race = nextRace();
  const wi = Math.round((start - mondayOf(new Date())) / 6048e5);
  const label = wi === 0 ? 'Cette semaine' : wi === 1 ? 'Semaine prochaine' : wi === -1 ? 'Semaine dernière' : wi > 0 ? `Dans ${wi} semaines` : `Il y a ${-wi} semaines`;
  const range = `${start.getDate()}${start.getMonth() !== end.getMonth() ? ` ${formatDate(start, { month: 'short' })}` : ''} – ${end.getDate()} ${formatDate(end, { month: 'short' })}`;
  let season = '';
  if (ph) {
    // Saison arrêtée à la prochaine course ; le conseil et les objectifs se déplient au toucher.
    const a = phases[0].start;
    const last = phases[phases.length - 1].end;
    const b = race && race.date >= keys[0] && race.date >= a && race.date < last ? race.date : last;
    const shown = phases.filter(p => p.start <= b).map(p => ({ ...p, end: p.end > b ? b : p.end }));
    const span = (fromKey(b) - fromKey(a)) / 86400000 + 1;
    const pos = k => `${Math.min(100, Math.max(0, ((fromKey(k) - fromKey(a)) / 86400000 / span) * 100))}%`;
    const len = p => (fromKey(p.end) - fromKey(p.start)) / 86400000 + 1;
    const pn = Math.ceil(len(ph) / 7);
    const pw = Math.min(pn, Math.max(1, Math.floor((fromKey(keys[0] < ph.start ? ph.start : keys[0]) - fromKey(ph.start)) / 6048e5) + 1));
    const goals = PHASE_GOALS[ph.type] || [];
    season = `<details class="card s-phase" style="--ph:${PHASE_COLOR[ph.type] || 'var(--accent)'}" ${phaseOpen ? 'open' : ''}>
      <summary><span class="s-phase__l"><b>${esc(PHASE_TYPES[ph.type].short)}</b> · sem. ${pw}/${pn}</span>${race ? `<span class="s-phase__r">🏁 ${esc(race.name)} · J-${dayDiff(race.date)}</span>` : ''}
        <span class="e-season">${shown.map(p => `<i class="${p.id === ph.id ? 'is-on' : ''}" style="flex:${len(p)};background:${PHASE_COLOR[p.type] || 'var(--text-3)'}"></i>`).join('')}<span class="e-season__me" style="left:${pos(weekStart)}"></span></span></summary>
      <p class="s-phase__adv">${esc(PHASE_TYPES[ph.type].advice)}</p>
      ${goals.length ? `<div class="e-goals">${goals.map(([g, n]) => { const c = st.list.filter(({ s }) => effort(s) === g).length; return `<span class="${c >= n ? 'is-ok' : ''}">${c >= n ? I.check : ''}${n} ${g}${n > 1 && g !== 'renfo' ? 's' : ''} · ${c}/${n}</span>`; }).join('')}</div>` : ''}
    </details>`;
  } else if (race) season = `<div class="card s-phase"><span class="s-phase__r">🏁 ${esc(race.name)} · J-${dayDiff(race.date)}</span></div>`;
  const recap = [`${st.done}/${st.n} séance${st.n > 1 ? 's' : ''} faite${st.n > 1 ? 's' : ''}`, st.km ? km(st.km) : '', durLabel(st.min), st.dp ? `${Math.round(st.dp)} m D+` : ''].filter(Boolean).join(' · ');

  host.innerHTML = `
    ${head(`${label} · ${esc(range)}`, 'Sport', `<div class="k-nav">${wi ? `<button type="button" class="k-lnk e-today-lnk" data-v="wtoday">Aujourd’hui</button>` : ''}<button type="button" class="k-round" data-v="week" data-step="-1" aria-label="Semaine précédente">${I.back}</button><button type="button" class="k-round" data-v="week" data-step="1" aria-label="Semaine suivante">${I.fwd}</button></div>`)}
    ${season}
    ${wxBar()}
    ${keys[6] >= today ? '<button type="button" class="j-cta" data-v="planify">Planifier ma semaine</button>' : ''}
    <section class="card s-week">${keys.map(k => {
      const d = fromKey(k);
      const ss = sessionsOn(k);
      const past = k < today;
      const races = (state.races || []).filter(r => r.date === k);
      const kind = ss.find(s => kindOf(s) !== 'indoor') ? kindOf(ss.find(s => kindOf(s) !== 'indoor')) : 'run';
      const best = bestSlot(kind, k);
      const w = wx[k];
      const lines = [
        ...races.map(r => `<a class="s-ses k-rdv" href="${ALLURE_URL}"><span class="s-ses__m"><b>🏁 ${esc(r.name)}</b><span>course${r.time ? ` · départ ${r.time}` : ''}${r.distance ? ` · ${r.distance} km` : ''}</span></span></a>`),
        ...ss.map(s => sesLine(s, k, all))
      ];
      const body = lines.length ? lines.join('') : past || isRestDay(k) ? `<span class="s-free">${isRestDay(k) ? 'Repos' : '—'}</span>` : `<button type="button" class="s-free" data-v="addsess" data-day="${k}" aria-label="Ajouter une séance ${esc(dayWord(k))}">—</button>`;
      return `<div class="s-day ${k === today ? 'is-today' : ''} ${past ? 'is-past' : ''}" id="pday-${k}" ${k === today ? 'aria-current="date"' : ''}>
        <div class="s-day__d"><small>${k === today ? 'auj.' : WD[d.getDay()]}</small><b>${d.getDate()}</b></div>
        <div class="s-day__b">${body}</div>
        <div class="s-day__w ${!past && best && w?.slots?.[best] ? `q-${level(score(kind, w.slots[best]))}` : ''}">${!past && w ? `${SKY[w.sky] || SKY.cloud}<span>${w.max}°</span>` : ''}</div>
      </div>`;
    }).join('')}</section>
    <p class="e-wkline">${esc(recap)}</p>`;
  done(host);
}

/* ---------- Fiche séance (feuille) ---------- */
let edit = null; // { k, id }
let pendingEdit = null;
const editEl = () => $('#eEdit');
function renderEdit() {
  const s = edit && plansOn(edit.k).find(x => x.id === edit.id);
  if (!s) return closeEdit();
  const ws = slotsOn(edit.k);
  const kind = kindOf(s);
  const best = kind !== 'indoor' ? bestSlot(kind, edit.k) : null;
  editEl().querySelector('h2').textContent = edit.isNew ? 'Nouvelle séance' : `${s.training || familyOf(s)?.name || 'Séance'} · ${dayTitle(edit.k).toLowerCase()}`;
  editEl().querySelector('.e-pm__b').innerHTML = `${ws && kind !== 'indoor' ? `<div class="e-slots s-slots">${SLOT_IDS.map(sl => { const w = ws[sl]; if (!w) return '<div class="e-slot is-past"></div>'; const p = slotPast(edit.k, sl); return `<div class="e-slot ${p ? 'is-past' : `q-${level(score(kind, w))}`}"><small>${SLOTS[sl]}${sl === best ? ' ★' : ''}</small><b>${skyOf(w)}${w.t}°</b><span>pluie ${w.rain} % · vent ${w.wind}</span></div>`; }).join('')}</div>` : ''}${editorHTML(s, edit.k)}`;
}
/** Nouvelle séance : créée sur le jour choisi, puis réglée dans la fiche à listes déroulantes. */
function newSession(k) {
  const recent = Object.keys(state.plans || {}).sort().reverse().flatMap(x => sessionsOn(x))[0];
  const fam = (recent && familyOf(recent)) || (state.families || [])[0];
  const s = { id: uid(), family: fam?.id || '', training: '', distance: '', time: '', elevation: '', slot: '' };
  state.plans[k] = [...plansOn(k).filter(x => x.family || x.training || x.distance || x.time || x.elevation), s];
  commit('plans');
  openEdit(k, s.id, true);
}
function openEdit(k, id, isNew = false) {
  edit = { k, id, isNew };
  const el = editEl();
  el.hidden = false;
  document.body.classList.add('e-flow-on');
  renderEdit();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
}
function closeEdit() {
  const el = editEl();
  if (el.hidden) return;
  el.classList.remove('is-open');
  document.body.classList.remove('e-flow-on');
  edit = null;
  setTimeout(() => (el.hidden = true), reduced() ? 0 : 320);
}
function onEditClick(e) {
  if (e.target === editEl()) return closeEdit();
  const b = e.target.closest('[data-v], [data-pm]');
  if (!b) return;
  const v = b.dataset.v || b.dataset.pm;
  if (v === 'close' || v === 'sclose') return closeEdit();
  if (v === 'sdel') {
    const { k, id } = edit;
    closeEdit();
    return deleteSession(k, id);
  }
  if (v === 'sports') {
    closeEdit();
    return openSportManager();
  }
}

/** Enregistre un champ de la fiche séance (la feuille reste ouverte ; elle est redessinée si le sport change). */
function onEditChange(e) {
  const f = e.target.dataset.ed;
  const box = e.target.closest('.e-ed');
  if (!f || !box) return;
  const s = plansOn(box.dataset.day).find(x => x.id === box.dataset.sid);
  if (!s) return;
  let v = e.target.value.trim();
  if (f === 'time' && v === '00:00') v = '';
  if ((f === 'distance' || f === 'elevation') && v) {
    const n = Number(v.replace(',', '.'));
    const max = f === 'distance' ? 1000 : 20000;
    if (!Number.isFinite(n) || n < 0 || n > max) {
      toastError(f === 'distance' ? 'Distance invalide (0 à 1000 km).' : 'Dénivelé invalide (0 à 20 000 m).');
      e.target.value = s[f] || '';
      return;
    }
    v = String(Math.round(n * 10) / 10);
  }
  if (f === 'day') {
    // Changer de jour : la séance passe sur ce jour (créneau gardé).
    state.plans[box.dataset.day] = plansOn(box.dataset.day).filter(x => x.id !== s.id);
    state.plans[v] = [...plansOn(v).filter(x => x.family || x.training || x.distance || x.time || x.elevation), s];
    edit.k = v;
    commit('plans');
    return renderEdit();
  }
  if (f === 'family') {
    s.family = v;
    s.training = '';
  } else s[f] = v;
  commit('plans');
  if (f === 'family') renderEdit();
}

function deleteSession(k, id) {
  const before = plansOn(k).slice();
  const s = before.find(x => x.id === id);
  if (!s) return;
  state.plans[k] = before.filter(x => x.id !== id);
  editId = null;
  commit('plans');
  toast(`${s.training || 'Séance'} supprimée`, { action: { label: 'Annuler', onClick: () => { state.plans[k] = before; commit('plans'); } } });
}

/** Se place sur un jour de Sport (en haut de l'écran, sous l'en-tête). */
const scrollToDay = k => scrollToId(`pday-${k}`);
function scrollToId(domId) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.getElementById(domId);
    if (!el) return;
    // offsetTop (et non getBoundingClientRect) : l'animation d'entrée décale encore les cartes.
    let y = 0;
    for (let n = el; n; n = n.offsetParent) y += n.offsetTop;
    window.scrollTo({ top: Math.max(0, y - 14), behavior: 'auto' });
  }));
}

/* ---------- Programmer ma semaine : un jour après l'autre ---------- */
// P = { days, i (index du jour, days.length = récap), items: [{ s, from, slot0, k, sl, pk, psl }], sel: { jour: id }, seen: { jour: 'ok'|'skip'|'edit' }, touched, dir }
let P = null;
const planEl = () => $('#ePlan');
const isHard = s => ['qualité', 'longue'].includes(effort(s));
/** Jours encore à venir de la semaine affichée, avec leurs créneaux encore possibles. */
const planCells = () => keysOf(weekStart).filter(k => k >= todayKey()).flatMap(k => SLOT_IDS.filter(sl => !slotPast(k, sl)).map(sl => ({ k, sl })));
/** Intérêt d'un créneau pour une séance : la météo dehors ; en salle, plutôt les jours où il fait mauvais. */
function cellScore(s, k, sl) {
  const kind = kindOf(s);
  const ws = slotsOn(k);
  if (kind === 'indoor') {
    const out = ws ? Math.max(...SLOT_IDS.filter(x => ws[x]).map(x => score('run', ws[x])), 0) : 60;
    return 70 + (100 - out) * 0.3 + (sl === (s.slot || 'soir') ? 4 : 0);
  }
  return ws?.[sl] ? score(kind, ws[sl]) : 55;
}
/** Proposition : chaque séance à venir sur le meilleur créneau, sans trop s'éloigner du jour prévu,
 *  une séance par jour quand c'est possible et pas deux séances dures d'affilée. */
function proposeWeek() {
  const cells = planCells();
  const days = [...new Set(cells.map(c => c.k))];
  const all = doneMap();
  const items = days.flatMap(k => sessionsOn(k).filter(s => !isDone(k, s, all)).map(s => ({ s, from: k, slot0: s.slot || '', k, sl: s.slot || '' })));
  const load = {};
  const hard = {};
  days.forEach(k => (load[k] = sessionsOn(k).filter(s => isDone(k, s, all)).length));
  const near = (k, n) => dateKey(addDays(fromKey(k), n));
  const prio = x => ({ bike: 0, run: 1, indoor: 3 }[kindOf(x.s)] + (isHard(x.s) ? 0 : 0.5));
  [...items].sort((a, b) => prio(a) - prio(b)).forEach(x => {
    let best = null;
    cells.forEach(({ k, sl }) => {
      const gap = Math.abs(fromKey(k) - fromKey(x.from)) / 86400000;
      const v = cellScore(x.s, k, sl) - gap * 4 - (load[k] || 0) * 35 - (isHard(x.s) && (hard[near(k, -1)] || hard[near(k, 1)]) ? 15 : 0) + (k === x.from && sl === x.sl ? 3 : 0);
      if (!best || v > best.v) best = { k, sl, v };
    });
    if (!best) return;
    x.k = best.k;
    x.sl = best.sl;
    load[best.k] = (load[best.k] || 0) + 1;
    if (isHard(x.s)) hard[best.k] = true;
  });
  items.forEach(x => ((x.pk = x.k), (x.psl = x.sl)));
  return items;
}
const changedItems = () => P.items.filter(x => x.k !== x.from || x.sl !== x.slot0);
const onDay = k => P.items.filter(x => x.k === k);
/** Séance « active » d'un jour : celle que l'on place en touchant un créneau. */
function selOn(k) {
  const here = onDay(k);
  return here.find(x => x.s.id === P.sel[k]) || here[0] || null;
}
/** Une séance est-elle à sa place proposée ? Sert au bandeau « Carnet propose ». */
const atProposal = x => x.k === x.pk && x.sl === x.psl;
const wxLine = w => (w ? `${w.t}° · vent ${w.wind} · raf. ${w.gust} · pluie ${w.rain} %` : 'météo pas encore connue');
const placeLine = x => {
  if (kindOf(x.s) === 'indoor') return 'intérieur';
  return wxLine(slotsOn(x.k)?.[x.sl]);
};
const WIND_MAX = 70;
/** Carte d'un créneau : tout ce qu'il faut pour choisir, sans faire défiler. */
function slotCardHTML(k, sl, cur, best) {
  const w = slotsOn(k)?.[sl];
  const past = slotPast(k, sl);
  const kind = cur ? kindOf(cur.s) : 'run';
  const q = w && !past && kind !== 'indoor' ? `q-${level(score(kind, w))}` : '';
  const here = onDay(k).filter(x => x.sl === sl);
  const on = cur && cur.sl === sl;
  const wind = w ? Math.min(100, (w.wind / WIND_MAX) * 100) : 0;
  const gust = w ? Math.min(100, (w.gust / WIND_MAX) * 100) : 0;
  return `<button type="button" class="p-slot ${q} ${on ? 'is-on' : ''} ${past ? 'is-past' : ''}" data-pm="slot" data-slot="${sl}" ${past || !cur ? (past ? 'disabled' : 'aria-disabled="true"') : ''} aria-pressed="${on}">
    <span class="p-slot__h">${SLOTS[sl]}${sl === best && !past ? `<i class="p-star" title="Meilleur moment">${I.star}</i>` : ''}</span>
    ${w ? `<span class="p-slot__t">${skyOf(w)}<b>${w.t}°</b></span>
    <span class="p-slot__r">${w.label ? esc(w.label) : ''}</span>
    <span class="p-slot__m"><span>Pluie</span><b>${w.rain} %${w.mm ? ` · ${String(w.mm).replace('.', ',')} mm` : ''}</b></span>
    <span class="p-slot__m"><span>Vent</span><b><i class="p-arrow" style="--deg:${(w.deg + 180) % 360}deg" title="Vent de ${esc(w.dir)}">${I.fwd}</i>${w.wind} km/h ${esc(w.dir)}</b></span>
    <span class="p-slot__m"><span>Rafales</span><b class="${w.gust >= 55 ? 'is-warn' : ''}">${w.gust} km/h</b></span>
    <span class="p-gauge" aria-hidden="true"><i style="width:${gust}%" class="p-gauge__g"></i><i style="width:${wind}%"></i></span>` : `<span class="p-slot__t"><b>—</b></span><span class="p-slot__r">${past ? 'passé' : 'météo à venir'}</span>`}
    ${here.length ? `<span class="p-slot__s">${here.map(x => `<em class="t-${TILE[kindOf(x.s)]} ${cur && x.s.id === cur.s.id ? 'is-sel' : ''}">${esc(abbr(x.s))}</em>`).join('')}</span>` : ''}
  </button>`;
}
function dayStepHTML(k) {
  const cur = selOn(k);
  const here = onDay(k);
  const away = P.items.filter(x => x.from === k && x.k !== k);
  const kind = cur ? kindOf(cur.s) : 'run';
  const best = bestSlot(kind === 'indoor' ? 'run' : kind, k);
  const prop = here.filter(x => x.pk === k);
  const fromElse = here.filter(x => x.from !== k);
  const anyProposal = P.items.some(x => (x.pk === k || x.from === k) && (x.pk !== x.from || x.psl !== x.slot0));
  const sug = !here.length && !away.length ? '' : `<div class="p-sug ${P.seen[k] === 'ok' ? 'is-ok' : ''}">
      <span class="p-sug__i">${I.star}</span>
      <span class="p-sug__t">${anyProposal ? `<b>Carnet propose</b> ${esc(prop.map(x => `${x.s.training || familyOf(x.s)?.name || 'Séance'} ${x.psl ? SLOTS[x.psl].toLowerCase() : ''}`).join(', ') || 'de libérer ce jour')}${fromElse.length ? ` <small>(${esc(fromElse.map(x => `venue de ${dayWord(x.from)}`).join(', '))})</small>` : ''}` : '<b>Ton planning tient la route</b> rien de mieux à proposer ce jour.'}</span>
      ${anyProposal ? `<span class="p-sug__a"><button type="button" class="p-mini p-mini--go" data-pm="accept">${I.check}Accepter</button><button type="button" class="p-mini" data-pm="skip">Garder le mien</button></span>` : ''}
    </div>`;
  return `<div class="p-step ${reduced() ? '' : P.dir || ''}">
    <div class="p-day"><h3>${esc(dayTitle(k))}</h3><span>${esc(cap(formatKey(k, { day: 'numeric', month: 'long' })))}</span></div>
    ${sug}
    <div class="p-slots">${SLOT_IDS.map(sl => slotCardHTML(k, sl, cur, best)).join('')}</div>
    <div class="p-ses">
      ${here.map(x => `<div class="p-se ${cur && x.s.id === cur.s.id ? 'is-sel' : ''}">
        <button type="button" class="p-se__m" data-pm="pick" data-id="${esc(x.s.id)}"><span class="e-tile t-${TILE[kindOf(x.s)]}">${esc(abbr(x.s))}</span><span><b>${esc(x.s.training || familyOf(x.s)?.name || 'Séance')}</b><small>${esc(x.sl ? SLOTS[x.sl] : 'Moment à choisir')} · ${esc(placeLine(x))}</small></span></button>
        <button type="button" class="p-mini" data-pm="moveday" data-id="${esc(x.s.id)}" aria-expanded="${P.mv === x.s.id}">Autre jour</button>
        ${P.mv === x.s.id ? `<div class="p-days">${P.days.filter(d => d !== k).map(d => `<button type="button" data-pm="todays" data-id="${esc(x.s.id)}" data-day="${d}">${esc(cap(WD[fromKey(d).getDay()]))} ${fromKey(d).getDate()}</button>`).join('')}</div>` : ''}
      </div>`).join('')}
      ${away.map(x => `<div class="p-se is-away"><span class="p-se__m"><span class="e-tile t-${TILE[kindOf(x.s)]}">${esc(abbr(x.s))}</span><span><b>${esc(x.s.training || 'Séance')}</b><small>part ${esc(dayWord(x.k))}${x.sl ? ` ${SLOTS[x.sl].toLowerCase()}` : ''}, meilleure météo</small></span></span><button type="button" class="p-mini" data-pm="keephere" data-id="${esc(x.s.id)}">La garder ici</button></div>`).join('')}
      ${!here.length ? `<p class="p-empty">${away.length ? 'Plus rien ce jour.' : 'Rien de prévu ce jour.'} Les créneaux montrent le temps qu’il fera.</p>` : ''}
      <button type="button" class="p-add" data-pm="add">+ Séance ${esc(dayWord(k))}</button>
    </div>
  </div>`;
}
function recapHTML() {
  const n = changedItems().length;
  return `<div class="p-step ${reduced() ? '' : P.dir || ''}">
    <div class="p-day"><h3>Ta semaine</h3><span>${n ? `${n} changement${n > 1 ? 's' : ''} à valider` : 'Rien n’a changé'}</span></div>
    <div class="card e-list p-recap">${P.days.map(k => {
      const here = onDay(k).sort((a, b) => SLOT_IDS.indexOf(a.sl) - SLOT_IDS.indexOf(b.sl));
      return `<button type="button" class="p-rc" data-pm="goto" data-i="${P.days.indexOf(k)}"><span class="p-rc__d"><small>${esc(WD[fromKey(k).getDay()])}</small><b>${fromKey(k).getDate()}</b></span><span class="p-rc__b">${here.length ? here.map(x => `<span class="p-rc__s"><b>${esc(x.s.training || familyOf(x.s)?.name || 'Séance')}</b><small>${esc(`${x.sl ? `${SLOTS[x.sl]} · ` : ''}${placeLine(x)}`)}</small>${x.k !== x.from ? `<em>depuis ${esc(dayWord(x.from))}</em>` : x.sl !== x.slot0 ? '<em>nouveau moment</em>' : ''}</span>`).join('') : '<span class="p-rc__none">Repos</span>'}</span>${I.fwd}</button>`;
    }).join('')}</div>
  </div>`;
}
function renderPlan() {
  const el = planEl();
  const last = P.days.length;
  const k = P.days[P.i];
  el.querySelector('.p-strip').innerHTML = `${P.days.map((d, i) => {
    const c = onDay(d).length;
    return `<button type="button" class="${i === P.i ? 'is-on' : ''} ${P.seen[d] ? 'is-seen' : ''}" data-pm="goto" data-i="${i}" aria-current="${i === P.i}"><small>${esc(dayDiff(d) === 0 ? 'auj' : WD[fromKey(d).getDay()])}</small><b>${fromKey(d).getDate()}</b><i>${c ? '•'.repeat(Math.min(c, 3)) : ''}</i></button>`;
  }).join('')}<button type="button" class="p-strip__r ${P.i === last ? 'is-on' : ''}" data-pm="goto" data-i="${last}" aria-label="Récap">${I.check}</button>`;
  el.querySelector('.p-bar i').style.width = `${(P.i / last) * 100}%`;
  el.querySelector('.e-pm__b').innerHTML = !last ? '<p class="p-empty">La semaine est terminée : plus aucun jour à programmer.</p>' : P.i === last ? recapHTML() : dayStepHTML(k);
  const back = el.querySelector('[data-pm="prev"]');
  const next = el.querySelector('[data-pm="next"]');
  back.textContent = P.i ? 'Précédent' : 'Annuler';
  if (P.i >= last) {
    const n = changedItems().length;
    next.dataset.pm = 'apply';
    next.innerHTML = n ? `${I.check}Valider la semaine` : 'Fermer';
  } else {
    next.dataset.pm = 'next';
    next.innerHTML = `${P.i === last - 1 ? 'Voir le récap' : `Suivant · ${esc(cap(WD_FULL[fromKey(P.days[P.i + 1]).getDay()]))}`}${I.fwd}`;
  }
  P.dir = '';
}
function stepTo(i) {
  const last = P.days.length;
  i = Math.max(0, Math.min(last, i));
  if (i === P.i) return;
  if (P.i < last && !P.seen[P.days[P.i]]) P.seen[P.days[P.i]] = 'edit';
  P.dir = i > P.i ? 'in' : 'back';
  P.i = i;
  P.mv = null;
  buzz(6);
  renderPlan();
}
function openPlan() {
  loadWx();
  const days = [...new Set(planCells().map(c => c.k))];
  P = { days, i: 0, items: proposeWeek(), sel: {}, seen: {}, dir: 'in' };
  const el = planEl();
  el.hidden = false;
  document.body.classList.add('e-flow-on');
  renderPlan();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
}
/** Météo arrivée après l'ouverture : on refait la proposition si rien n'a encore été touché. */
function replanIfUntouched() {
  if (!P || P.touched) return;
  P.items = proposeWeek();
  renderPlan();
}
/** Séance ajoutée depuis l'assistant : elle rejoint le jour en cours. */
function addToPlan(k, id) {
  if (!P) return;
  const s = plansOn(k).find(x => x.id === id);
  if (!s || P.items.some(x => x.s.id === id)) return;
  P.items.push({ s, from: k, slot0: s.slot || '', k, sl: s.slot || '', pk: k, psl: s.slot || '' });
  P.sel[k] = id;
  P.touched = true;
  renderPlan();
}
function closePlan() {
  const el = planEl();
  el.classList.remove('is-open');
  document.body.classList.remove('e-flow-on');
  P = null;
  setTimeout(() => (el.hidden = true), reduced() ? 0 : 320);
}
function applyPlan() {
  const list = changedItems();
  if (!list.length) return closePlan();
  const touched = [...new Set(list.flatMap(x => [x.from, x.k]))];
  const before = Object.fromEntries(touched.map(k => [k, plansOn(k).map(s => ({ ...s }))]));
  list.forEach(x => {
    state.plans[x.from] = plansOn(x.from).filter(y => y.id !== x.s.id);
    x.s.slot = x.sl;
    state.plans[x.k] = [...plansOn(x.k).filter(y => y.family || y.training || y.distance || y.time || y.elevation), x.s];
  });
  commit('plans');
  const r = planEl().querySelector('[data-pm="apply"]')?.getBoundingClientRect();
  if (r) burst(r.left + r.width / 2, r.top, 22);
  closePlan();
  buzz([10, 40, 14]);
  toast(`Semaine programmée · ${list.length} séance${list.length > 1 ? 's' : ''} placée${list.length > 1 ? 's' : ''}`, { action: { label: 'Annuler', onClick: () => { Object.assign(state.plans, before); commit('plans'); } } });
}
function onPlanClick(e) {
  if (e.target === planEl()) return closePlan();
  const b = e.target.closest('[data-pm]');
  if (!b || b.disabled) return;
  const a = b.dataset.pm;
  const k = P?.days[P.i];
  const item = id => P.items.find(y => y.s.id === id);
  if (a === 'close') return closePlan();
  if (a === 'apply') return applyPlan();
  if (a === 'next') return stepTo(P.i + 1);
  if (a === 'prev') return P.i ? stepTo(P.i - 1) : closePlan();
  if (a === 'goto') return stepTo(Number(b.dataset.i));
  if (a === 'add') return openFlow({ type: 'sess', i: 1, d: { day: k, fixedDay: true } });
  if (a === 'accept') {
    // On garde la proposition pour toutes les séances qui touchent ce jour, puis jour suivant.
    P.items.filter(x => x.pk === k || x.from === k || x.k === k).forEach(x => ((x.k = x.pk), (x.sl = x.psl)));
    P.seen[k] = 'ok';
    buzz(10);
    return stepTo(P.i + 1);
  }
  if (a === 'skip') {
    P.items.filter(x => x.from === k || x.k === k).forEach(x => ((x.k = x.from), (x.sl = x.slot0)));
    P.seen[k] = 'skip';
    P.touched = true;
    return stepTo(P.i + 1);
  }
  if (a === 'pick') {
    P.sel[k] = b.dataset.id;
    return renderPlan();
  }
  if (a === 'slot') {
    const x = selOn(k);
    if (!x) return toast('Ajoute d’abord une séance à ce jour');
    x.sl = b.dataset.slot;
    P.touched = true;
    P.seen[k] = 'edit';
    buzz(8);
    renderPlan();
    planEl().querySelector(`.p-slot[data-slot="${x.sl}"]`)?.classList.add('is-landed');
    return;
  }
  if (a === 'moveday') {
    P.mv = P.mv === b.dataset.id ? null : b.dataset.id;
    return renderPlan();
  }
  if (a === 'todays') {
    const x = item(b.dataset.id);
    if (!x) return;
    x.k = b.dataset.day;
    if (x.sl && slotPast(x.k, x.sl)) x.sl = '';
    if (!x.sl) x.sl = bestSlot(kindOf(x.s) === 'indoor' ? 'run' : kindOf(x.s), x.k) || 'soir';
    P.touched = true;
    P.mv = null;
    buzz(8);
    toast(`${x.s.training || 'Séance'} → ${dayWord(x.k)}`);
    return renderPlan();
  }
  if (a === 'keephere') {
    const x = item(b.dataset.id);
    if (!x) return;
    x.k = k;
    x.sl = x.slot0 && !slotPast(k, x.slot0) ? x.slot0 : bestSlot(kindOf(x.s) === 'indoor' ? 'run' : kindOf(x.s), k) || 'soir';
    P.sel[k] = x.s.id;
    P.touched = true;
    return renderPlan();
  }
}
/** Glisser à gauche / à droite : jour suivant / précédent. */
function initPlanSwipe(el) {
  let x0 = null;
  let y0 = 0;
  const body = el.querySelector('.e-pm__b');
  body.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  body.addEventListener('touchend', e => {
    if (x0 === null || !P) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepTo(P.i + (dx < 0 ? 1 : -1));
  });
  document.addEventListener('keydown', e => {
    if (!P || el.hidden || !$('#eFlow')?.hidden) return;
    if (e.key === 'ArrowRight') stepTo(P.i + 1);
    if (e.key === 'ArrowLeft') stepTo(P.i - 1);
  });
}

function moveSession(id, from, to, slot) {
  const s = plansOn(from).find(x => x.id === id);
  if (!s) return;
  const prev = { slot: s.slot };
  const put = (src, dst, sl) => {
    state.plans[src] = plansOn(src).filter(x => x.id !== id);
    s.slot = sl;
    // Un jour vide peut contenir une séance vierge (affichage du planning) : on la remplace.
    state.plans[dst] = [...plansOn(dst).filter(x => x.family || x.training || x.distance || x.time || x.elevation), s];
  };
  put(from, to, slot);
  landed = id;
  commit('plans');
  setTimeout(() => (landed = null), 1300);
  buzz(10);
  toast(`${s.training || 'Séance'} · ${dayWord(to)} ${SLOTS[slot].toLowerCase()}`, { action: { label: 'Annuler', onClick: () => { put(to, from, prev.slot); commit('plans'); } } });
}

/* ---------- Tâches : cocher, glisser ---------- */
function finishTask(t, el, dir) {
  const wrap = el.closest('.k-sw') || el;
  const prev = { done: t.done, doneAt: t.doneAt, date: t.date };
  const undo = () => {
    Object.assign(t, prev);
    if (!prev.doneAt) delete t.doneAt;
    commit('dashboard');
  };
  if (dir === 'done') {
    const r = el.getBoundingClientRect();
    burst(r.left + 30, r.top + r.height / 2, 14);
    buzz(12);
  } else buzz(8);
  wrap.classList.add('is-leaving');
  wrap.style.transform = `translateX(${dir === 'done' ? 110 : -110}%)`;
  wrap.style.opacity = '0';
  setTimeout(() => {
    if (dir === 'done') {
      t.done = true;
      t.doneAt = todayKey();
    } else t.date = dateKey(addDays(new Date(), 1));
    commit('dashboard');
    toast(dir === 'done' ? 'Fait.' : 'Pour demain.', { action: { label: 'Annuler', onClick: undo } });
  }, 240);
}
/** Tâches glissables : à droite = faite, à gauche = demain ; un appui ouvre la fiche. */
function bindRows(host) {
  host.querySelectorAll('.k-sw .k-task').forEach(row => {
    if (row.dataset.bound) return;
    row.dataset.bound = '1';
    const wrap = row.parentElement;
    let st = null;
    row.addEventListener('pointerdown', e => {
      if (e.button > 0 || e.target.closest('.e-check')) return;
      st = { x: e.clientX, y: e.clientY, dx: 0, lock: null };
    });
    row.addEventListener('pointermove', e => {
      if (!st) return;
      const dx = e.clientX - st.x;
      const dy = e.clientY - st.y;
      if (!st.lock) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          st.lock = 'x';
          row.setPointerCapture(e.pointerId);
        } else if (Math.abs(dy) > 10) return (st = null);
        else return;
      }
      st.dx = dx;
      row.style.transition = 'none';
      row.style.transform = `translateX(${dx}px)`;
      wrap.dataset.dir = dx > 0 ? 'done' : 'later';
      wrap.style.setProperty('--p', Math.min(1, Math.abs(dx) / 110).toFixed(3));
    });
    row.addEventListener('pointerup', () => {
      if (!st) return;
      const { dx, lock } = st;
      st = null;
      row.style.transition = '';
      if (lock !== 'x') return openEditor('tasks', row.dataset.task);
      const t = state.dashboard.tasks.find(x => x.id === row.dataset.task);
      if (!t || Math.abs(dx) < 110) {
        row.style.transform = '';
        wrap.style.setProperty('--p', 0);
        return;
      }
      finishTask(t, row, dx > 0 ? 'done' : 'later');
    });
    row.addEventListener('pointercancel', () => {
      st = null;
      row.style.transform = '';
    });
    row.addEventListener('keydown', e => e.key === 'Enter' && e.target === row && openEditor('tasks', row.dataset.task));
  });
}

/* ---------- Le + : une question par écran ---------- */
const STEPS = { task: ['kind', 'title', 'day', 'done'], appointments: ['kind', 'title', 'day', 'time', 'done'], events: ['kind', 'title', 'day', 'end', 'done'], sess: ['kind', 'family', 'type', 'day', 'slot', 'done'] };
let F = null;
const flowEl = () => $('#eFlow');
function openFlow(preset) {
  F = { type: null, i: 0, d: {}, from: current, ...(preset || {}) };
  const el = flowEl();
  el.hidden = false;
  document.body.classList.add('e-flow-on');
  showStep('in');
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
}
function closeFlow() {
  const el = flowEl();
  el.classList.remove('is-open');
  // L'assistant « Programmer ma semaine » peut rester ouvert dessous.
  if (!P && !W) document.body.classList.remove('e-flow-on');
  setTimeout(() => (el.hidden = true), reduced() ? 0 : 500);
}
const steps = () => (F.type ? STEPS[F.type].filter(s => !(s === 'day' && F.d.fixedDay)) : ['kind', '', '', '']);
function showStep(dir) {
  const st = steps();
  const el = flowEl();
  const body = el.querySelector('.e-flow__b');
  body.innerHTML = `<div class="e-step ${reduced() ? '' : dir}">${stepHTML(st[F.i])}</div>`;
  el.querySelector('.e-fdots').innerHTML = st.slice(0, -1).map((_, j) => `<i class="${j === F.i ? 'is-on' : j < F.i ? 'is-past' : ''}"></i>`).join('');
  el.querySelector('[data-fl="back"]').style.visibility = st[F.i] === 'done' || !F.i ? 'hidden' : 'visible';
  const inp = body.querySelector('input');
  if (inp) setTimeout(() => inp.focus({ preventScroll: true }), 380);
  if (st[F.i] === 'done') saveFlow();
}
const nextStep = () => {
  F.i++;
  showStep('in');
};
function stepHTML(st) {
  const d = F.d;
  const fam = (state.families || []).find(f => f.id === d.family);
  const kind = fam ? kindOfFamily(fam.name) : 'run';
  const days = Array.from({ length: 14 }, (_, i) => dateKey(addDays(new Date(), i)));
  switch (st) {
    case 'kind':
      return `<h2 class="e-q">Qu’est-ce que tu ajoutes${d.fixedDay ? `, ${dateWord(d.day)}` : ''} ?</h2><div class="e-kinds">${[['task', 'Tâche', 'Avec ou sans date', 't-task', I.list], ['appointments', 'Rendez-vous', 'Un jour, une heure', 't-rdv', I.clock], ['events', 'Événement', 'Un ou plusieurs jours', 't-rdv', I.star], ['sess', 'Séance', 'Placée avec la météo', 't-run', I.run]].map(([k, b, s, t, ic], i) => `<button type="button" class="e-kind" data-fl="kind" data-val="${k}" style="animation-delay:${i * 50}ms"><span class="e-tile ${t}">${ic}</span><b>${b}</b><span>${s}</span></button>`).join('')}</div>
        <p class="e-lab">Ou écris tout d’un coup</p><form class="e-big" data-fl="quick" autocomplete="off"><input id="eQuick" placeholder="dentiste jeudi 17h30" aria-label="Écrire en une phrase" maxlength="120"><button type="submit" aria-label="Valider">${I.go}</button></form><div id="eQuickChip"></div>`;
    case 'title':
      return `<h2 class="e-q">${F.type === 'task' ? 'Qu’y a-t-il à faire ?' : F.type === 'appointments' ? 'Quel rendez-vous ?' : 'Quel événement ?'}</h2><form class="e-big" data-fl="title" autocomplete="off"><input value="${esc(d.title || '')}" placeholder="${F.type === 'task' ? 'Payer la cantine' : F.type === 'appointments' ? 'Dentiste' : 'Anniversaire'}" aria-label="Titre" maxlength="100"><button type="submit" aria-label="Continuer">${I.go}</button></form>`;
    case 'family':
      return `<h2 class="e-q">Quel sport ?${d.fixedDay ? `<small>Pour ${dayWord(d.day)}.</small>` : ''}</h2><div class="e-kinds">${(state.families || []).map((f, i) => `<button type="button" class="e-kind" data-fl="family" data-val="${esc(f.id)}" style="animation-delay:${i * 40}ms"><span class="e-tile t-${TILE[kindOfFamily(f.name)]}">${esc(abbrOf(f.name))}</span><b>${esc(f.name)}</b><span>${kindOfFamily(f.name) === 'indoor' ? 'intérieur' : 'dehors'}</span></button>`).join('')}</div>`;
    case 'type':
      return `<h2 class="e-q">Quelle séance ?</h2><div class="e-opts e-opts--2">${(fam?.types || []).filter(t => !isRestTraining(t)).map((t, i) => `<button type="button" data-fl="type" data-val="${esc(t)}" style="animation-delay:${i * 30}ms">${esc(t)}</button>`).join('')}</div>`;
    case 'day':
      return `<h2 class="e-q">${F.type === 'events' ? 'Quel jour commence-t-il ?' : 'Quel jour ?'}${F.type === 'sess' && kind !== 'indoor' ? '<small>La pastille donne la météo du meilleur moment.</small>' : ''}</h2>
        ${F.type === 'task' ? `<div class="e-opts e-opts--2" style="margin-bottom:14px"><button type="button" data-fl="day" data-val="">Sans date</button><button type="button" data-fl="day" data-val="${todayKey()}">Aujourd’hui</button></div>` : ''}
        <div class="e-days">${days.map((k, i) => { const x = fromKey(k); const b = F.type === 'sess' && kind !== 'indoor' ? bestSlot(kind, k) : null; return `<button type="button" data-fl="day" data-val="${k}" style="animation-delay:${i * 18}ms"><small>${i ? WD[x.getDay()] : 'auj'}</small><b>${x.getDate()}</b><i class="${b ? `q-${level(score(kind, slotsOn(k)[b]))}` : ''}"></i></button>`; }).join('')}</div>
        <p class="e-lab">Ou n’importe quelle date</p><form class="e-big" data-fl="date" autocomplete="off"><input type="date" min="${todayKey()}" value="${esc(d.day || '')}" aria-label="Choisir une date"><button type="submit" aria-label="Valider la date">${I.go}</button></form>`;
    case 'end': {
      const next = Array.from({ length: 7 }, (_, i) => dateKey(addDays(fromKey(d.day), i + 1)));
      return `<h2 class="e-q">Jusqu’à quand ?<small>Il commence ${esc(dateWord(d.day))}.</small></h2>
        <div class="e-opts" style="margin-bottom:14px"><button type="button" data-fl="end" data-val="">Seulement ce jour-là</button></div>
        <p class="e-lab">Dernier jour</p><div class="e-days">${next.map((k, i) => { const x = fromKey(k); return `<button type="button" data-fl="end" data-val="${k}" style="animation-delay:${i * 18}ms"><small>${WD[x.getDay()]}</small><b>${x.getDate()}</b><i></i></button>`; }).join('')}</div>
        <p class="e-lab">Ou une autre date de fin</p><form class="e-big" data-fl="enddate" autocomplete="off"><input type="date" min="${dateKey(addDays(fromKey(d.day), 1))}" value="${esc(d.end || '')}" aria-label="Date de fin"><button type="submit" aria-label="Valider la date de fin">${I.go}</button></form>`;
    }
    case 'time':
      return `<h2 class="e-q">À quelle heure, ${dayWord(d.day)} ?</h2><div class="e-opts e-opts--5">${Array.from({ length: 16 }, (_, i) => i + 7).map((h, i) => `<button type="button" data-fl="hour" data-val="${h}" aria-pressed="${d.h === h}" style="animation-delay:${i * 15}ms">${h} h</button>`).join('')}</div>
        <p class="e-lab">Minutes</p><div class="e-opts e-opts--4">${['00', '15', '30', '45'].map(m => `<button type="button" data-fl="min" data-val="${m}" aria-pressed="${(d.m || '00') === m}">${m}</button>`).join('')}</div>
        <p class="e-lab">Durée</p><div class="e-opts e-opts--4">${[[30, '30 min'], [60, '1 h'], [120, '2 h'], [180, '3 h']].map(([m, l]) => `<button type="button" data-fl="dur" data-val="${m}" aria-pressed="${(d.dur || 60) === m}">${l}</button>`).join('')}</div><button type="button" class="e-btn" data-fl="timeok" ${d.h ? '' : 'disabled'}>Ajouter</button>`;
    case 'slot': {
      const ws = slotsOn(d.day);
      const b = kind !== 'indoor' ? bestSlot(kind, d.day) : null;
      return `<h2 class="e-q">À quel moment, ${dayWord(d.day)} ?${b ? `<small>Carnet conseille ${SLOTS[b].toLowerCase()}.</small>` : ''}</h2><div class="e-slotpick">${SLOT_IDS.map((sl, i) => { const w = ws?.[sl]; const p = slotPast(d.day, sl); return `<button type="button" class="${p || !w || kind === 'indoor' ? '' : `q-${level(score(kind, w))}`}" data-fl="slot" data-val="${sl}" ${p ? 'disabled' : ''} style="animation-delay:${i * 60}ms">${w ? skyOf(w) : ''}<b>${SLOTS[sl]}${sl === b ? ' · conseillé' : ''}</b><span>${w ? `${w.t}° · pluie ${w.rain} % · vent ${w.wind}` : ''}</span></button>`; }).join('')}</div>`;
    }
    case 'done':
      return `<div class="e-stamp"><i>${I.check}</i><b>Ajouté</b><span class="e-row__s">${esc(F.type === 'sess' ? `${d.type}, ${dateWord(d.day)} ${SLOTS[d.slot].toLowerCase()}` : `${d.title}${d.end ? `, ${span({ date: d.day, endDate: d.end })}` : d.day ? `, ${dateWord(d.day)}` : ''}`)}</span></div>`;
  }
  return '';
}
function saveFlow() {
  const d = F.d;
  const id = uid();
  let target = 'todoView';
  if (F.type === 'task') {
    state.dashboard.tasks.push({ id, title: d.title, date: d.day || '', time: '', note: '', done: false });
    commit('dashboard');
  } else if (F.type === 'sess') {
    state.plans[d.day] = [...plansOn(d.day).filter(x => x.family || x.training || x.distance || x.time || x.elevation), { id, family: d.family, training: d.type, distance: '', time: '', elevation: '', slot: d.slot }];
    commit('plans');
    addToPlan(d.day, id);
    weekStart = dateKey(mondayOf(fromKey(d.day)));
    focusDay = d.day;
    target = 'weekView';
  } else {
    const item = { id, title: d.title, date: d.day, time: '', note: '' };
    if (F.type === 'appointments') {
      const a = d.h * 60 + Number(d.m || 0);
      const b = a + (d.dur || 60);
      item.time = `${pad(d.h)}:${d.m || '00'}`;
      if (b < 24 * 60) item.endTime = `${pad(Math.floor(b / 60))}:${pad(b % 60)}`;
    }
    if (F.type === 'events' && d.end > d.day) item.endDate = d.end;
    state.dashboard[F.type].push(item);
    commit('dashboard');
    // Le mois de l'élément ajouté est affiché dans « Mois ».
    const now = new Date();
    const m = fromKey(d.day);
    monthsShown = Math.max(monthsShown, (m.getFullYear() - now.getFullYear()) * 12 + m.getMonth() - now.getMonth() + 1);
    daySel = null;
    target = 'agendaView';
  }
  flash = id;
  buzz(12);
  const r = flowEl().getBoundingClientRect();
  setTimeout(() => burst(r.left + r.width / 2, r.top + r.height / 2 - 40, 20), 250);
  setTimeout(() => {
    closeFlow();
    // Séance ajoutée depuis « Planifier » : on reste dans l'assistant.
    if (W && F.from === 'planner') {
      W.keepScroll = true;
      renderPlanner();
      return setTimeout(() => (flash = null), 1300);
    }
    goto(target);
    setTimeout(() => {
      document.querySelector('.e-flash')?.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
      flash = null;
    }, 120);
  }, reduced() ? 300 : 1100);
}
function onFlowClick(e) {
  const b = e.target.closest('[data-fl]');
  if (!b || b.disabled || b.tagName === 'FORM') return;
  const a = b.dataset.fl;
  const d = F.d;
  const v = b.dataset.val;
  if (a === 'close') return closeFlow();
  if (a === 'back') {
    if (!F.i) return closeFlow();
    F.i--;
    if (!F.i) {
      F.type = null;
      F.d = F.d.fixedDay ? { day: F.d.day, fixedDay: true } : {};
    }
    return showStep('back');
  }
  if (a === 'kind') {
    F.type = v;
    F.d = F.d.fixedDay ? { day: F.d.day, fixedDay: true } : {};
    if (v === 'sess') {
      // Séance : une fiche à listes déroulantes plutôt que des questions.
      const day = F.d.day || todayKey();
      closeFlow();
      loadWx();
      return setTimeout(() => newSession(day), reduced() ? 0 : 200);
    }
    return nextStep();
  }
  if (a === 'family') {
    d.family = v;
    return nextStep();
  }
  if (a === 'type' || a === 'day' || a === 'end') {
    d[a] = v;
    b.classList.add('is-picked');
    return setTimeout(nextStep, 160);
  }
  if (a === 'hour' || a === 'min' || a === 'dur') {
    if (a === 'hour') d.h = Number(v);
    else if (a === 'dur') d.dur = Number(v);
    else d.m = v;
    b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
    flowEl().querySelector('[data-fl="timeok"]').disabled = !d.h;
    return;
  }
  if (a === 'timeok') return nextStep();
  if (a === 'slot') {
    d.slot = v;
    return nextStep();
  }
}
function onFlowSubmit(e) {
  e.preventDefault();
  const f = e.target.dataset.fl;
  if (f === 'title') {
    const v = e.target.querySelector('input').value.trim();
    if (!v) return;
    F.d.title = v;
    return nextStep();
  }
  if (f === 'date' || f === 'enddate') {
    const v = e.target.querySelector('input').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    if (f === 'enddate' && v <= F.d.day) return toastError('La fin doit être après le début.');
    F.d[f === 'date' ? 'day' : 'end'] = v;
    return nextStep();
  }
  if (f === 'quick') {
    const raw = $('#eQuick').value.trim();
    if (!raw) return;
    const { title, date, time } = parseEntry(raw);
    if (!title) return;
    F.type = date && time ? 'appointments' : 'task';
    F.d = { title, day: date, h: time ? Number(time.slice(0, 2)) : null, m: time ? time.slice(3) : null };
    F.i = STEPS[F.type].length - 1;
    showStep('in');
  }
}
function onFlowInput(e) {
  if (e.target.id !== 'eQuick') return;
  const raw = e.target.value.trim();
  const box = $('#eQuickChip');
  if (!raw) return (box.innerHTML = '');
  const { date, time } = parseEntry(raw);
  box.innerHTML = `<span class="k-chip">${date && time ? 'Rendez-vous' : 'Tâche'} · ${esc(date ? `${dayWord(date)}${time ? ` · ${hhmm(time)}` : ''}` : 'sans date')}</span>`;
}

/* ---------- Rendu, entrées animées ---------- */
function done(host) {
  host.classList.toggle('k-in', entering && !reduced());
  entering = false;
  requestAnimationFrame(() => requestAnimationFrame(() => host.querySelectorAll('[data-off]').forEach(c => (c.style.strokeDashoffset = c.dataset.off))));
  bindRows(host);
  loadWx();
}
function renderCurrent() {
  if (current === 'todayView') renderTodayView();
  else if (current === 'agendaView') renderAgendaView();
  else if (current === 'todoView') renderTodoView();
  else if (current === 'weekView') renderWeekView();
  if (W) renderPlanner();
}
export function showVivant(id) {
  const arriving = id !== current;
  if (arriving) entering = true;
  current = id;
  // Sport s'ouvre toujours sur la semaine en cours, placé sur aujourd'hui (sauf arrivée sur un jour précis).
  let land = null;
  if (arriving && id === 'weekView') {
    if (!focusDay) {
      weekStart = dateKey(mondayOf(new Date()));
      openDay = null;
      editId = null;
    }
    land = focusDay || todayKey();
    focusDay = null;
  }
  // Accueil : la semaine en cours (le dimanche soir, la suivante).
  if (arriving && id === 'todayView') planStart = defaultPlanStart();
  if (arriving && id === 'todoView') {
    if (!assignKeep) assign = false;
    assignKeep = false;
  }
  renderCurrent();
  if (land && !flash) scrollToDay(land);
  if (pendingEdit && id === 'weekView') {
    const pe = pendingEdit;
    pendingEdit = null;
    openEdit(pe.k, pe.id);
  }
}

function onClick(e) {
  const go = e.target.closest('[data-go]');
  if (go) return goto(go.dataset.go);
  const b = e.target.closest('[data-v]');
  if (!b || b.disabled) return;
  const { v, type, id, day } = b.dataset;
  switch (v) {
    case 'session': {
      e.stopPropagation();
      const on = toggleDone(day, id);
      if (on) {
        const r = b.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2, 18);
        buzz(12);
      }
      return renderCurrent();
    }
    case 'tdone': {
      const t = state.dashboard.tasks.find(x => x.id === id);
      if (t) finishTask(t, b.closest('.k-task'), 'done');
      return;
    }
    case 'edit':
      return openEditor(type, id);
    case 'undo': {
      const t = state.dashboard.tasks.find(x => x.id === id);
      if (!t) return;
      t.done = false;
      delete t.doneAt;
      return commit('dashboard');
    }
    case 'mmore':
      monthsShown += 1;
      return renderAgendaView();
    case 'pweek':
      planStart = dateKey(addDays(fromKey(planStart), Number(b.dataset.step) * 7));
      return renderTodayView();
    case 'planify':
      return openPlanner();
    case 'past':
      showPast = !showPast;
      return renderTodayView();
    case 'dweek':
      return $('#dWeek')?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
    case 'pedit':
      return openEdit(day, id);
    case 'pslot':
      return setSessionSlot(day, id, b.dataset.slot);
    case 'phome':
      return sessionAtHome(day, id);
    case 'wadd':
      loadWx();
      return openFlow({ d: { day, fixedDay: true } });
    case 'wtdone': {
      if (toggleTask(id)) {
        const r = b.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2, 14);
      }
      return;
    }
    case 'tedit':
      return openEditor('tasks', id);
    case 'race':
      return window.open(ALLURE_URL, '_self');
    case 'assign':
      assign = !assign;
      if (assign) assignStart = defaultPlanStart();
      entering = true;
      renderTodoView();
      return window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
    case 'aweek':
      assignStart = dateKey(addDays(mondayOf(new Date()), Number(b.dataset.off) * 7));
      return renderTodoView();
    case 'aday':
      return assignDay(id, day);
    case 'mo':
      monthOff = Number(b.dataset.to);
      return renderAgendaView();
    case 'mstep':
      monthOff = Number(b.dataset.step) ? monthOff + Number(b.dataset.step) : 0;
      daySel = null;
      return renderAgendaView();
    case 'mday':
      daySel = day;
      return renderAgendaView();
    case 'week':
      weekStart = dateKey(addDays(fromKey(weekStart), Number(b.dataset.step) * 7));
      openDay = null;
      editId = null;
      entering = true;
      renderWeekView();
      return window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
    case 'wtoday':
      weekStart = dateKey(mondayOf(new Date()));
      openDay = null;
      editId = null;
      entering = true;
      renderWeekView();
      return scrollToDay(todayKey());
    case 'open':
      openDay = openDay === day ? null : day;
      return renderWeekView();
    case 'mvto':
      e.stopPropagation();
      return moveSession(id, day, b.dataset.to, b.dataset.slot);
    case 'addsess':
      loadWx();
      return newSession(day);
    case 'sedit':
      if (current !== 'weekView') {
        // Depuis l'accueil : Sport s'ouvre sur le jour de la séance, puis sa fiche.
        weekStart = dateKey(mondayOf(fromKey(day)));
        focusDay = day;
        pendingEdit = { k: day, id };
        return goto('weekView');
      }
      return openEdit(day, id);
    case 'sdel':
      return deleteSession(day, id);
    case 'program':
      return openPlan();
    case 'sports':
      return openSportManager();
  }
}

/* ---------- Météo d'un jour, heure par heure (curseur à glisser) ---------- */
let DW = null; // { k, i } : jour affiché et heure choisie (index dans hours)
const dwEl = () => $('#dWx');
const fr = v => String(v).replace('.', ',');
function openDayWx(k) {
  loadWx();
  const hrs = wx[k]?.hours || [];
  const now = new Date().getHours();
  const at = k === todayKey() ? Math.max(0, hrs.findIndex(x => x.h >= now)) : Math.max(0, hrs.findIndex(x => x.h >= 12));
  DW = { k, i: at };
  const el = dwEl();
  el.hidden = false;
  document.body.classList.add('e-flow-on');
  renderDayWx();
  requestAnimationFrame(() => el.classList.add('is-open'));
}
function closeDayWx() {
  const el = dwEl();
  el.classList.remove('is-open');
  DW = null;
  if (!W && !P && $('#eFlow')?.hidden) document.body.classList.remove('e-flow-on');
  setTimeout(() => (el.hidden = true), reduced() ? 0 : 300);
}
/** Ligne lisse (non fermée) à travers des points. */
function line(pts) {
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [xa, ya] = pts[i - 1];
    const [xb, yb] = pts[i];
    const mx = ((xa + xb) / 2).toFixed(1);
    d += ` C${mx},${ya.toFixed(1)} ${mx},${yb.toFixed(1)} ${xb.toFixed(1)},${yb.toFixed(1)}`;
  }
  return d;
}
// Géométrie du graphique : 3 bandes (température, pluie, vent) sur une même échelle d'heures.
const DWG = { w: 340, pad: 14, t: [34, 96], r: [124, 156], v: [184, 254], h: 278 };
const dwX = (i, n) => DWG.pad + (n > 1 ? (i * (DWG.w - 2 * DWG.pad)) / (n - 1) : 0);
function dayWxChart(hrs) {
  const n = hrs.length;
  const tMin = Math.min(...hrs.map(x => x.t));
  const tMax = Math.max(...hrs.map(x => x.t));
  const ty = v => DWG.t[1] - ((v - tMin) / Math.max(1, tMax - tMin)) * (DWG.t[1] - DWG.t[0]);
  const tPts = hrs.map((x, i) => [dwX(i, n), ty(x.t)]);
  const mmMax = Math.max(2, ...hrs.map(x => x.mm));
  const bw = Math.max(4, (DWG.w - 2 * DWG.pad) / n - 5);
  const bars = hrs.map((x, i) => { const hh = (x.mm / mmMax) * (DWG.r[1] - DWG.r[0]); return x.mm ? `<rect x="${(dwX(i, n) - bw / 2).toFixed(1)}" y="${(DWG.r[1] - hh).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2, hh).toFixed(1)}" rx="2" fill="#7FB8D6"/>` : `<rect x="${(dwX(i, n) - 1.5).toFixed(1)}" y="${DWG.r[1] - 2}" width="3" height="2" rx="1" fill="#3A6A78"/>`; }).join('');
  const vMax = Math.max(30, ...hrs.map(x => x.gust)) * 1.1;
  const vy = v => DWG.v[1] - (v / vMax) * (DWG.v[1] - DWG.v[0]);
  const area = key => `${line(hrs.map((x, i) => [dwX(i, n), vy(x[key])]))} L${dwX(n - 1, n)},${DWG.v[1]} L${dwX(0, n)},${DWG.v[1]} Z`;
  const iMax = hrs.reduce((a, x, i) => (x.t > hrs[a].t ? i : a), 0);
  const iMin = hrs.reduce((a, x, i) => (x.t < hrs[a].t ? i : a), 0);
  const ticks = hrs.map((x, i) => (x.h % 3 === 0 ? `<text x="${dwX(i, n).toFixed(1)}" y="${DWG.h - 4}" text-anchor="middle">${x.h} h</text>` : '')).join('');
  return `<svg class="dw-svg" viewBox="0 0 ${DWG.w} ${DWG.h}" aria-hidden="true">
    <text class="dw-lab" x="${DWG.pad}" y="12">Température</text>
    <path d="${line(tPts)}" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
    <text class="dw-val" x="${dwX(iMax, n).toFixed(1)}" y="${(ty(hrs[iMax].t) - 7).toFixed(1)}" text-anchor="middle">${hrs[iMax].t}°</text>
    ${iMin !== iMax ? `<text class="dw-val is-dim" x="${dwX(iMin, n).toFixed(1)}" y="${(ty(hrs[iMin].t) - 7).toFixed(1)}" text-anchor="middle">${hrs[iMin].t}°</text>` : ''}
    <text class="dw-lab" x="${DWG.pad}" y="${DWG.r[0] - 6}">Pluie (mm)</text>
    ${bars}
    <text class="dw-lab" x="${DWG.pad}" y="${DWG.v[0] - 6}">Vent et rafales (km/h)</text>
    <path d="${area('gust')}" fill="#2B7182"/><path d="${area('wind')}" fill="#BFD3D8"/>
    <g class="dw-tk">${ticks}</g>
  </svg>`;
}
function renderDayWx() {
  if (!DW) return;
  const el = dwEl();
  const { k } = DW;
  const days = Object.keys(wx).filter(x => x >= todayKey() && wx[x]?.hours?.length).sort().slice(0, 10);
  const w = wx[k];
  const hrs = w?.hours || [];
  const d = fromKey(k);
  const dw = dayWx(k);
  const chips = days.map(x => { const dd = fromKey(x); return `<button type="button" class="dw-day ${x === k ? 'is-on' : ''}" data-dwx="${x}" aria-pressed="${x === k}"><small>${x === todayKey() ? 'Auj.' : cap(WD[dd.getDay()])}</small><b>${dd.getDate()}</b></button>`; }).join('');
  el.innerHTML = `<div class="dw-top"><div class="dw-days" role="group" aria-label="Jour">${chips}</div><button type="button" class="dw-x" data-dwc="close" aria-label="Fermer">${I.x}</button></div>
    ${hrs.length ? `<div class="dw-hero"><span class="dw-ic"></span><p class="dw-t"></p><p class="dw-d">${esc(`${WD_FULL[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`.toUpperCase())} · <span class="dw-h"></span></p><p class="dw-s"></p></div>
    <div class="dw-ch" role="slider" tabindex="0" aria-label="Heure" aria-valuemin="${hrs[0].h}" aria-valuemax="${hrs.at(-1).h}">${dayWxChart(hrs)}<div class="dw-sc"><i></i></div><b class="dw-dot"></b></div>
    <p class="dw-hint">Glisse le doigt sur le graphique pour changer d’heure.</p>
    <div class="dw-sum">
      <div><small>Températures</small><b>${w.min}° / ${w.max}°</b></div>
      <div><small>Vent moyen</small><b>${dw.windAvg} km/h</b></div>
      <div><small>Rafales max</small><b>${dw.gust} km/h</b></div>
      <div><small>Pluie</small><b>${fr(Math.round(hrs.reduce((a, x) => a + x.mm, 0) * 10) / 10)} mm</b></div>
      ${w.sunrise ? `<div><small>Soleil</small><b>${hhmm(w.sunrise)} – ${hhmm(w.sunset)}</b></div>` : ''}
      <div><small>Ciel</small><b>${esc(w.label)}</b></div>
    </div>` : `<p class="dw-none">Pas encore de prévisions heure par heure pour ce jour (elles vont jusqu’à 15 jours).</p>`}`;
  el.querySelector('.dw-day.is-on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  if (hrs.length) setDwHour(DW.i);
}
function setDwHour(i) {
  const hrs = wx[DW.k]?.hours || [];
  if (!hrs.length) return;
  DW.i = Math.max(0, Math.min(hrs.length - 1, i));
  const x = hrs[DW.i];
  const el = dwEl();
  el.querySelector('.dw-ic').innerHTML = illOfSky(x.sky);
  el.querySelector('.dw-t').textContent = `${x.t}°`;
  el.querySelector('.dw-h').textContent = `${x.h} H`;
  el.querySelector('.dw-s').innerHTML = `${esc(x.label)}<br><b>Vent ${x.wind} km/h ${x.dir}</b> · rafales ${x.gust} km/h · pluie ${fr(x.mm)} mm${x.rain ? ` (${x.rain} %)` : ''}`;
  const ch = el.querySelector('.dw-ch');
  ch.setAttribute('aria-valuenow', x.h);
  ch.setAttribute('aria-valuetext', `${x.h} heures`);
  const sc = el.querySelector('.dw-sc');
  sc.style.left = `${(dwX(DW.i, hrs.length) / DWG.w) * 100}%`;
  // Le rond du curseur suit la courbe des températures.
  const tMin = Math.min(...hrs.map(y => y.t));
  const tMax = Math.max(...hrs.map(y => y.t));
  const dot = el.querySelector('.dw-dot');
  dot.style.left = sc.style.left;
  dot.style.top = `${((DWG.t[1] - ((x.t - tMin) / Math.max(1, tMax - tMin)) * (DWG.t[1] - DWG.t[0])) / DWG.h) * 100}%`;
  sc.querySelector('i').textContent = `${x.h} h`;
}
function dwFromPointer(e) {
  const ch = dwEl().querySelector('.dw-ch');
  const r = ch.getBoundingClientRect();
  const n = wx[DW.k]?.hours?.length || 1;
  const fx = ((e.clientX - r.left) / r.width) * DWG.w;
  setDwHour(Math.round(((fx - DWG.pad) / (DWG.w - 2 * DWG.pad)) * (n - 1)));
}
function initDayWx() {
  const el = document.createElement('section');
  el.id = 'dWx';
  el.className = 'dw';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Météo heure par heure');
  document.body.appendChild(el);
  el.addEventListener('click', e => e.target.closest('[data-dwc="close"]') && closeDayWx());
  let drag = false;
  el.addEventListener('pointerdown', e => {
    if (!e.target.closest('.dw-ch')) return;
    drag = true;
    e.target.closest('.dw-ch').setPointerCapture(e.pointerId);
    dwFromPointer(e);
  });
  el.addEventListener('pointermove', e => drag && dwFromPointer(e));
  ['pointerup', 'pointercancel'].forEach(t => el.addEventListener(t, () => (drag = false)));
  el.addEventListener('keydown', e => {
    if (!DW || !e.target.closest('.dw-ch')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setDwHour(DW.i + (e.key === 'ArrowRight' ? 1 : -1));
    }
  });
  // N'importe quel élément [data-dwx] ouvre (ou change) le jour affiché.
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-dwx]');
    if (!b) return;
    e.stopPropagation();
    if (DW) { DW.k = b.dataset.dwx; const hrs = wx[DW.k]?.hours || []; DW.i = Math.max(0, Math.min(DW.i, hrs.length - 1)); return renderDayWx(); }
    openDayWx(b.dataset.dwx);
  }, true);
  document.addEventListener('keydown', e => e.key === 'Escape' && DW && closeDayWx());
}

export function initVivant({ go }) {
  goto = go;
  injectIllustrations();
  initDayWx();
  ['#todayView', '#agendaView', '#todoView', '#weekView'].forEach(sel => $(sel).addEventListener('click', onClick));
  // Une ligne de séance est un bouton (role) : Entrée l'ouvre aussi.
  ['#todayView', '#weekView'].forEach(sel => $(sel).addEventListener('keydown', e => e.key === 'Enter' && e.target.matches('.e-row[role="button"][data-v]') && e.target.click()));
  // Phase Cadence : dépliée ou non, gardé d'un rendu à l'autre.
  $('#weekView').addEventListener('toggle', e => e.target.matches?.('.s-phase') && (phaseOpen = e.target.open), true);
  // Note : on enregistre sans jamais réécrire le champ (le curseur reste où on tape).
  let noteTimer;
  $('#todoView').addEventListener('input', e => {
    if (e.target.id !== 'vNote') return;
    state.notes = e.target.value.slice(0, 20000);
    commit('notes');
    const st = $('#vNoteState');
    if (!st) return;
    st.textContent = 'Enregistrement…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (st.textContent = 'Enregistrée'), 700);
  });
  // Bouton + : saisie en questions.
  const el = document.createElement('section');
  el.id = 'eFlow';
  el.className = 'e-flow';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Ajouter');
  el.innerHTML = `<div class="e-flow__h"><button type="button" class="k-round" data-fl="back" aria-label="Retour">${I.back}</button><div class="e-fdots"></div><button type="button" class="k-round" data-fl="close" aria-label="Fermer">${I.x}</button></div><div class="e-flow__b"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', onFlowClick);
  el.addEventListener('submit', onFlowSubmit);
  el.addEventListener('input', onFlowInput);
  document.addEventListener('keydown', e => e.key === 'Escape' && !el.hidden && closeFlow());
  $('#kFab')?.addEventListener('click', () => (el.hidden ? openFlow() : closeFlow()));
  // « Programmer ma semaine » : feuille par-dessus Sport.
  const pm = document.createElement('section');
  pm.id = 'ePlan';
  pm.hidden = true;
  pm.className = 'e-pm p-plan';
  pm.innerHTML = `<div class="e-pm__card" role="dialog" aria-modal="true" aria-labelledby="ePlanTitle"><div class="e-pm__h"><h2 id="ePlanTitle">Programmer ma semaine</h2><button type="button" class="k-round" data-pm="close" aria-label="Fermer">${I.x}</button></div><div class="p-strip"></div><div class="p-bar"><i></i></div><div class="e-pm__b"></div><div class="e-pm__f"><button type="button" class="e-btn e-btn--ghost" data-pm="prev">Annuler</button><button type="button" class="e-btn p-next" data-pm="next">Suivant</button></div></div>`;
  document.body.appendChild(pm);
  pm.addEventListener('click', onPlanClick);
  initPlanSwipe(pm);
  document.addEventListener('keydown', e => e.key === 'Escape' && !pm.hidden && $('#eFlow')?.hidden && closePlan());
  // « Planifier » : plein écran, par-dessus tout (sauf le + et la fiche séance).
  const wp = document.createElement('section');
  wp.id = 'wPlan';
  wp.className = 'pl';
  wp.hidden = true;
  wp.setAttribute('role', 'dialog');
  wp.setAttribute('aria-modal', 'true');
  wp.setAttribute('aria-label', 'Planifier ma semaine');
  document.body.appendChild(wp);
  wp.addEventListener('click', onPlannerClick);
  wp.addEventListener('submit', onPlannerSubmit);
  wp.addEventListener('change', onPlannerChange);
  // Météo : Actualiser / Lieu, dans Planifier comme dans Sport.
  document.addEventListener('click', onWxClick);
  document.addEventListener('submit', onWxSubmit, true);
  document.addEventListener('keydown', e => e.key === 'Escape' && !wp.hidden && $('#eFlow')?.hidden && $('#eEdit')?.hidden && closePlanner());
  // Fiche d'une séance : feuille par-dessus Sport.
  const ed = document.createElement('section');
  ed.id = 'eEdit';
  ed.className = 'e-pm s-edit';
  ed.hidden = true;
  ed.innerHTML = `<div class="e-pm__card" role="dialog" aria-modal="true" aria-labelledby="eEditTitle"><div class="e-pm__h"><h2 id="eEditTitle">Séance</h2><button type="button" class="k-round" data-pm="close" aria-label="Fermer">${I.x}</button></div><div class="e-pm__b"></div></div>`;
  document.body.appendChild(ed);
  ed.addEventListener('click', onEditClick);
  ed.addEventListener('change', onEditChange);
  document.addEventListener('keydown', e => e.key === 'Escape' && !ed.hidden && closeEdit());
  // L'anneau du prochain rendez-vous reste juste si l'app reste ouverte.
  setInterval(() => current === 'todayView' && !document.hidden && renderTodayView(), 60000);
}
