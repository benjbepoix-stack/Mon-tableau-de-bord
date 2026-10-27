/*
 * « Les trois espaces » : un accueil calme et un écran par univers.
 *  - Accueil : prochain rendez-vous (anneau de proximité), puis trois cartes (Ensuite, À faire,
 *    Sport) qui ouvrent chacune leur écran, et la note ;
 *  - Agenda : mini-calendrier du mois et rendez-vous / événements à venir, comptés en nombre ;
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
import { todayKey, dateKey, addDays, fromKey, combine, formatKey, formatDate, isRepeat, nextOccurrenceKey, REPEATS, mondayOf } from '../core/dates.js';
import { isRestTraining } from '../core/schema.js';
import { parseEntry } from '../core/parse.js';
import { getPhases, phaseOn, PHASE_TYPES } from '../core/season.js';
import { readJSON, write } from '../services/storage.js';
import { fetchSlots, SLOT_HOURS } from '../services/weather.js';
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
let more = 8; // rendez-vous affichés dans l'agenda
let daySel = null; // jour choisi dans le mini-calendrier
let monthOff = 0;
let weekStart = '';
let openDay = null; // jour dont la météo est dépliée
let flash = null; // élément ajouté, mis en évidence au prochain rendu
let landed = null;
let editId = null; // séance dépliée pour modification dans Sport
let focusDay = null; // jour sur lequel se placer en arrivant sur Sport
let quietWeek = false; // vrai pendant l'enregistrement d'un champ : la fiche ouverte n'est pas redessinée

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
function loadWx() {
  [todayKey(), weekStart].filter(Boolean).forEach(k => {
    if (wxAsked.has(k)) return;
    wxAsked.add(k);
    fetchSlots(k, 8)
      .then(data => {
        wx = { ...wx, ...data };
        if (!Object.keys(data).length) return;
        renderCurrent();
        // Pop-up « Programmer ma semaine » ouvert avant la météo : on refait la proposition.
        if (P && !P.touched) {
          P.items = proposeWeek();
          renderPlan();
        }
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

/** Rendez-vous et événements à venir (prochaine occurrence pour ceux qui se répètent). */
function upcoming() {
  const today = todayKey();
  const now = Date.now();
  const items = [];
  ['appointments', 'events'].forEach(kind =>
    state.dashboard[kind].forEach(x => {
      const date = isRepeat(x.repeat) ? nextOccurrenceKey(x) : x.date;
      if (!date || date < today) return;
      const end = combine(date, x.endTime || x.time, '23:59');
      if (end && end.getTime() < now) return;
      items.push({ id: x.id, title: x.title, date, time: x.time, place: x.location || '', kind, repeat: x.repeat });
    })
  );
  return items.sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
}
/** Rendez-vous et événements d'un jour donné (répétitions comprises). */
function itemsOn(k) {
  const out = [];
  ['appointments', 'events'].forEach(kind =>
    state.dashboard[kind].forEach(x => {
      const date = isRepeat(x.repeat) ? (x.date <= k ? nextOccurrenceKey(x, fromKey(k)) : x.date) : x.date;
      if (date === k) out.push({ id: x.id, title: x.title, date: k, time: x.time, place: x.location || '', kind });
    })
  );
  return out.sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
}
/** Proximité d'un rendez-vous : classe de couleur, remplissage de l'anneau, libellés. */
function prox(x) {
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
const whenOf = x => `${dayWord(x.date)}${x.time ? ` · ${hhmm(x.time)}` : ' · journée'}`;
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
    <span class="e-row__b"><span class="e-row__t">${esc(x.title)}</span><span class="e-row__s">${esc(showDay ? whenOf(x) : x.time ? hhmm(x.time) : 'toute la journée')}${x.place ? ` · ${esc(x.place)}` : ''}${x.kind === 'events' ? ' · événement' : ''}</span></span>
    <span class="e-dist"><span>${p.short}</span><span class="e-dist__bar"><i style="width:${Math.round(p.fill * 100)}%"></i></span></span></button>`;
}
function taskRow(t) {
  return `<div class="k-sw" data-dir="done"><div class="k-sw__u"><span class="u-done">${I.check}Fait</span><span class="u-later">Demain →</span></div>
    <div class="e-row k-task ${flash === t.id ? 'e-flash' : ''}" data-task="${esc(t.id)}" tabindex="0" role="button" aria-label="Modifier « ${esc(t.title)} »"><button type="button" class="e-check" data-v="tdone" data-id="${esc(t.id)}" aria-label="Cocher « ${esc(t.title)} »"><i>${I.check}</i></button>
    <span class="e-row__b"><span class="e-row__t">${esc(t.title)}</span><span class="e-row__s ${isLate(t) ? 'is-late' : ''}">${esc(taskMeta(t))}</span></span></div></div>`;
}
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

/* ---------- Accueil ---------- */
export function renderTodayView() {
  const host = $('#todayView');
  const k = todayKey();
  const up = upcoming();
  const tasks = openTasks();
  const nowTasks = tasks.filter(t => t.date && t.date <= k);
  const late = tasks.filter(isLate).length;
  const keys = keysOf(dateKey(mondayOf(new Date())));
  const st = weekStats(keys);
  const all = doneMap();
  const ph = phaseOn(k);
  const race = nextRace();
  let nx = null;
  for (let i = 0; i < 14 && !nx; i++) {
    const dk = dateKey(addDays(new Date(), i));
    const s = sessionsOn(dk).find(x => !isDone(dk, x, all) && !(dk === k && slotOf(x, dk) && slotPast(dk, slotOf(x, dk))));
    if (s) nx = { s, k: dk };
  }
  const note = document.activeElement?.id === 'vNote' ? document.activeElement : null;
  const keep = note ? { value: note.value, a: note.selectionStart, b: note.selectionEnd } : null;
  const hour = new Date().getHours();
  const cur = slotsOn(k)?.[hour < 12 ? 'matin' : hour < 18 ? 'aprem' : 'soir'];

  host.innerHTML = `
    ${head(`${esc(cap(formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })))}${cur ? ` · <span class="e-today-wx">${skyOf(cur)}${cur.t}°</span>` : ''}`, hour >= 18 ? 'Bonsoir' : 'Bonjour')}
    ${nextCard(up[0]) || '<div class="card e-empty">Aucun rendez-vous à venir. Le + en ajoute un.</div>'}
    <section class="card e-space">
      <div class="e-space__h"><span class="e-tile t-rdv">${I.clock}</span><h2>Ensuite</h2><span class="e-row__s">${Math.max(0, up.length - 1)} à venir</span></div>
      <div class="e-list">${up.slice(1, 4).map(x => rdvRow(x)).join('') || '<p class="e-empty">Rien d’autre de prévu.</p>'}</div>
      <button type="button" class="e-space__f" data-go="agendaView">Tout l’agenda</button>
    </section>
    <section class="card e-space">
      <div class="e-space__h"><span class="e-tile t-task">${I.list}</span><h2>À faire</h2><span class="e-row__s ${late ? 'is-late' : ''}">${nowTasks.length} aujourd’hui${late ? ` · ${late} en retard` : ''}</span></div>
      <div class="e-list">${nowTasks.slice(0, 4).map(taskRow).join('') || '<p class="e-empty">Rien pour aujourd’hui.</p>'}</div>
      <button type="button" class="e-space__f" data-go="todoView">Toutes les tâches · ${tasks.length}</button>
    </section>
    <section class="card e-space">
      <div class="e-space__h"><span class="e-tile t-run">${I.run}</span><h2>Sport</h2>${ph ? `<span class="e-pill" style="--ph:${PHASE_COLOR[ph.type] || 'var(--accent)'}">${esc(PHASE_TYPES[ph.type].short)}</span>` : ''}</div>
      <div class="e-wkdots">${keys.map(dk => { const l = sessionsOn(dk); const d = fromKey(dk); const allDone = l.length && l.every(s => isDone(dk, s, all)); return `<span class="e-wkdot ${dk === k ? 'is-today' : ''}"><i class="${!l.length ? '' : allDone ? 'is-done' : dk < k ? 'is-miss' : 'is-plan'}">${l.length > 1 ? l.length : ''}</i>${WD[d.getDay()]}</span>`; }).join('')}</div>
      ${nx ? `<div class="e-list">${sessRow(nx.s, nx.k, true)}</div>` : ''}
      <button type="button" class="e-space__f" data-go="weekView">${st.done} sur ${st.n} séance${st.n > 1 ? 's' : ''} cette semaine${race ? ` · ${esc(race.name)} J-${dayDiff(race.date)}` : ''}</button>
    </section>
    <section class="k-blk"><div class="k-blk-h"><h2><label for="vNote">Note</label></h2><span class="k-save" id="vNoteState" aria-live="polite"></span></div>
      <div class="k-card k-note"><textarea id="vNote" placeholder="Écrire…" maxlength="20000">${esc(keep ? keep.value : state.notes)}</textarea></div></section>`;
  if (keep) {
    const t = $('#vNote');
    t.focus({ preventScroll: true });
    t.setSelectionRange(keep.a, keep.b);
  }
  done(host);
}

/* ---------- Agenda ---------- */
export function renderAgendaView() {
  const host = $('#agendaView');
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth() + monthOff, 1);
  const first = mondayOf(base);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i)).filter((d, i) => i < 35 || d.getMonth() === base.getMonth());
  const up = upcoming();
  const today = todayKey();
  let body = '';
  if (daySel) {
    const list = itemsOn(daySel);
    body = `<div class="e-sec"><h2>${esc(dayTitle(daySel))}</h2><button type="button" class="k-lnk" data-v="mday" data-day="${daySel}">Tout voir</button></div><div class="card e-list">${list.map(x => rdvRow(x, false)).join('') || '<p class="e-empty">Rien ce jour-là. Le + en ajoute un.</p>'}</div>`;
  } else {
    body = `<div style="margin-top:12px">${nextCard(up[0])}</div>`;
    let grp = '';
    up.slice(1, more).forEach(x => {
      const d = dayDiff(x.date);
      const g = d <= 6 ? 'Cette semaine' : d <= 13 ? 'La semaine prochaine' : `En ${MONTHS[fromKey(x.date).getMonth()]}`;
      if (g !== grp) {
        body += `${grp ? '</div>' : ''}<div class="e-sec"><h2>${g}</h2></div><div class="card e-list">`;
        grp = g;
      }
      body += rdvRow(x);
    });
    if (grp) body += '</div>';
    if (!up.length) body += '<div class="card e-empty">Aucun rendez-vous à venir. Le + en ajoute un.</div>';
    if (up.length > more) body += `<button type="button" class="e-more" data-v="more">Voir plus · ${up.length - more} autre${up.length - more > 1 ? 's' : ''}</button>`;
  }
  host.innerHTML = `
    ${head(`${up.length} rendez-vous et événement${up.length > 1 ? 's' : ''} à venir`, 'Agenda')}
    <div class="card e-month">
      <div class="e-month__h"><button type="button" class="k-round" data-v="mo" data-step="-1" aria-label="Mois précédent" ${monthOff <= 0 ? 'disabled' : ''}>${I.back}</button><b>${cap(MONTHS[base.getMonth()])} ${base.getFullYear()}</b><button type="button" class="k-round" data-v="mo" data-step="1" aria-label="Mois suivant">${I.fwd}</button></div>
      <div class="e-month__g">${['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'].map(d => `<small>${d}</small>`).join('')}${cells
        .map(d => {
          const dk = dateKey(d);
          const items = itemsOn(dk);
          return `<button type="button" class="e-md ${d.getMonth() !== base.getMonth() ? 'is-out' : ''} ${dk === today ? 'is-today' : ''}" data-v="mday" data-day="${dk}" aria-pressed="${daySel === dk}" aria-label="${esc(formatKey(dk, { weekday: 'long', day: 'numeric', month: 'long' }))}${items.length ? `, ${items.length} élément${items.length > 1 ? 's' : ''}` : ''}">${d.getDate()}<span class="e-dots">${items.slice(0, 3).map(x => `<i class="${x.kind === 'events' ? 'is-ev' : ''}"></i>`).join('')}</span></button>`;
        })
        .join('')}</div>
    </div>
    ${body}`;
  done(host);
}

/* ---------- Tâches ---------- */
export function renderTodoView() {
  const host = $('#todoView');
  const tasks = openTasks();
  const today = todayKey();
  const tomorrow = dateKey(addDays(new Date(), 1));
  const doneToday = state.dashboard.tasks.filter(t => t.done && (!t.doneAt || t.doneAt === today));
  const apps = appTasks();
  const groups = [
    ['En retard', tasks.filter(isLate), 'is-late'],
    ['Aujourd’hui', tasks.filter(t => t.date === today)],
    ['Demain', tasks.filter(t => t.date === tomorrow)],
    ['Cette semaine', tasks.filter(t => t.date && dayDiff(t.date) > 1 && dayDiff(t.date) <= 7)],
    ['Plus tard', tasks.filter(t => t.date && dayDiff(t.date) > 7)],
    ['Sans date', tasks.filter(t => !t.date)]
  ].filter(g => g[1].length);
  host.innerHTML = `
    ${head(`${tasks.length} tâche${tasks.length > 1 ? 's' : ''}${apps.length ? ` · ${apps.length} de tes apps` : ''}`, 'Tâches')}
    ${groups.map(([label, list, cls]) => `<div class="e-sec ${cls || ''}"><h2>${label}</h2><small>${list.length}</small></div><div class="card e-list">${list.map(taskRow).join('')}</div>`).join('') || '<div class="card e-empty">Rien à faire. Belle journée.</div>'}
    ${apps.length ? `<div class="e-sec"><h2>Depuis tes apps</h2><small>${apps.length}</small></div><div class="card e-list">${apps.map(appRow).join('')}</div>` : ''}
    ${doneToday.length ? `<div class="e-sec"><h2>Faites aujourd’hui</h2><small>${doneToday.length}</small></div><div class="card e-list">${doneToday.map(t => `<button type="button" class="e-row is-done" data-v="undo" data-id="${esc(t.id)}"><span class="e-check is-on"><i>${I.check}</i></span><span class="e-row__b"><span class="e-row__t">${esc(t.title)}</span><span class="e-row__s">${isRepeat(t.repeat) ? esc(REPEATS[t.repeat].label.toLowerCase()) : 'disparaît demain · touche pour annuler'}</span></span></button>`).join('')}</div>` : ''}
    ${tasks.length ? '<p class="k-hint">→ fait · ← demain · touche pour modifier</p>' : ''}`;
  bindRows(host);
  done(host);
}

/* ---------- Sport : le planning détaillé ---------- */
/** Fiche d'une séance, dépliée sous sa ligne : sport, type, km, durée, D+, moment. */
function editorHTML(s, k) {
  const f = familyOf(s);
  const opt = (v, l, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(l)}</option>`;
  const types = (f?.types || []).filter(t => !isRestTraining(t));
  return `<div class="e-ed" data-day="${k}" data-sid="${esc(s.id)}">
    <div class="e-ed__g">
      <label class="e-ed__f is-wide"><span>Sport</span><select data-ed="family">${(state.families || []).map(x => opt(x.id, x.name, x.id === s.family)).join('')}</select></label>
      <label class="e-ed__f is-wide"><span>Séance</span><select data-ed="training">${opt('', '— Choisir —', !s.training)}${types.map(t => opt(t, t, t === s.training)).join('')}${s.training && !types.includes(s.training) ? opt(s.training, s.training, true) : ''}</select></label>
      <label class="e-ed__f"><span>km</span><input data-ed="distance" type="text" inputmode="decimal" value="${esc(s.distance || '')}" placeholder="0" autocomplete="off"></label>
      <label class="e-ed__f"><span>Durée</span><input data-ed="time" type="time" step="60" value="${esc(s.time || '00:00')}"></label>
      <label class="e-ed__f"><span>D+ m</span><input data-ed="elevation" type="text" inputmode="numeric" value="${esc(s.elevation || '')}" placeholder="0" autocomplete="off"></label>
      <label class="e-ed__f"><span>Moment</span><select data-ed="slot">${opt('', 'Au mieux', !s.slot)}${SLOT_IDS.map(sl => opt(sl, SLOTS[sl], s.slot === sl)).join('')}</select></label>
    </div>
    <div class="e-ed__a"><button type="button" class="k-lnk is-danger" data-v="sdel" data-day="${k}" data-id="${esc(s.id)}">Supprimer</button><button type="button" class="e-ed__ok" data-v="sedit" data-day="${k}" data-id="${esc(s.id)}">OK</button></div>
  </div>`;
}

export function renderWeekView() {
  if (quietWeek) return;
  const host = $('#weekView');
  if (!weekStart) weekStart = dateKey(mondayOf(new Date()));
  const keys = keysOf(weekStart);
  const start = fromKey(weekStart);
  const end = addDays(start, 6);
  const today = todayKey();
  const st = weekStats(keys);
  const phases = getPhases();
  const ph = phaseOn(keys[3], phases) || phaseOn(keys[0], phases);
  const race = nextRace();
  const wi = Math.round((start - mondayOf(new Date())) / 6048e5);
  const label = wi === 0 ? 'Cette semaine' : wi === 1 ? 'Semaine prochaine' : wi === -1 ? 'Semaine dernière' : wi > 0 ? `Dans ${wi} semaines` : `Il y a ${-wi} semaines`;
  const range = `${start.getDate()}${start.getMonth() !== end.getMonth() ? ` ${formatDate(start, { month: 'short' })}` : ''} – ${end.getDate()} ${formatDate(end, { month: 'short' })}`;
  let season = '';
  if (ph) {
    // La saison s'arrête à la prochaine course : les phases d'après ne sont pas montrées.
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
    season = `<section class="card e-phase" style="--ph:${PHASE_COLOR[ph.type] || 'var(--accent)'}">
      <div class="e-phase__top"><span class="e-next__k">Phase Cadence · semaine ${pw} sur ${pn}</span>${race ? `<span class="e-row__s">🏁 ${esc(race.name)} · J-${dayDiff(race.date)}</span>` : ''}</div>
      <b class="e-phase__t">${esc(PHASE_TYPES[ph.type].name)}</b><p class="e-row__s">${esc(PHASE_TYPES[ph.type].advice)}</p>
      <div class="e-season">${shown.map(p => `<i class="${p.id === ph.id ? 'is-on' : ''}" style="flex:${len(p)};background:${PHASE_COLOR[p.type] || 'var(--text-3)'}" title="${esc(PHASE_TYPES[p.type].short)}"></i>`).join('')}<span class="e-season__me" style="left:${pos(weekStart)}"></span>${b !== last || (race && race.date === last) ? `<span class="e-season__flag" style="left:100%">🏁</span>` : ''}</div>
      ${goals.length ? `<div class="e-goals">${goals.map(([g, n]) => { const c = st.list.filter(({ s }) => effort(s) === g).length; return `<span class="${c >= n ? 'is-ok' : ''}">${c >= n ? I.check : ''}${n} ${g}${n > 1 && g !== 'renfo' ? 's' : ''} · ${c}/${n}</span>`; }).join('')}</div>` : ''}
    </section>`;
  } else if (race) season = `<div class="card e-phase"><span class="e-row__s">🏁 ${esc(race.name)} · J-${dayDiff(race.date)} · aucune phase définie dans Cadence</span></div>`;
  const canPlan = keys[6] >= today;
  const recap = [`${st.done}/${st.n} séance${st.n > 1 ? 's' : ''}`, st.km ? km(st.km) : '', durLabel(st.min), st.dp ? `${Math.round(st.dp)} m D+` : ''].filter(Boolean).join(' · ');

  host.innerHTML = `
    ${head(`${label} · ${esc(range)}`, 'Sport', `<div class="k-nav">${wi ? `<button type="button" class="k-lnk e-today-lnk" data-v="wtoday">Aujourd’hui</button>` : ''}<button type="button" class="k-round" data-v="week" data-step="-1" aria-label="Semaine précédente">${I.back}</button><button type="button" class="k-round" data-v="week" data-step="1" aria-label="Semaine suivante">${I.fwd}</button></div>`)}
    ${season}
    ${canPlan ? `<button type="button" class="e-plan-btn" data-v="program"><span>${I.star}</span><b>Programmer ma semaine</b><small>selon la météo</small></button>` : ''}
    <p class="e-wkline">${esc(recap)}</p>
    ${keys.map(k => {
      const ss = sessionsOn(k);
      const past = k < today;
      const ws = slotsOn(k);
      const kind = ss.find(s => kindOf(s) !== 'indoor') ? kindOf(ss.find(s => kindOf(s) !== 'indoor')) : 'run';
      const best = bestSlot(kind, k);
      const bw = best && ws[best];
      const races = (state.races || []).filter(r => r.date === k);
      return `<section class="card e-day ${k === today ? 'is-today' : ''} ${past ? 'is-past' : ''}" id="pday-${k}" ${k === today ? 'aria-current="date"' : ''}>
        <div class="e-day__h"><h2>${esc(cap(formatKey(k, { weekday: 'long', day: 'numeric' })))}${k === today ? '<span class="e-day__badge">Aujourd’hui</span>' : ''}</h2>${!past && bw ? `<button type="button" class="e-wx q-${level(score(kind, bw))}" data-v="open" data-day="${k}" aria-expanded="${openDay === k}">${skyOf(bw)}${wx[k].min}° / ${wx[k].max}° ${openDay === k ? '▴' : '▾'}</button>` : ''}${past ? '' : `<button type="button" class="e-day__add" data-v="addsess" data-day="${k}" aria-label="Ajouter une séance ${esc(dayWord(k))}">+</button>`}</div>
        <div class="e-list">
          ${openDay === k && ws ? `<div class="e-slots">${SLOT_IDS.map(sl => { const w = ws[sl]; if (!w) return '<div class="e-slot is-past"></div>'; const p = slotPast(k, sl); return `<div class="e-slot ${p ? 'is-past' : `q-${level(score(kind, w))}`}"><small>${SLOTS[sl]}${sl === best ? ' ★' : ''}</small><b>${skyOf(w)}${w.t}°</b><span>pluie ${w.rain} %${w.mm ? ` · ${String(w.mm).replace('.', ',')} mm` : ''}</span><span>vent ${w.dir} ${w.wind}</span><span>rafales ${w.gust}</span></div>`; }).join('')}</div>${wx[k]?.sunrise ? `<p class="e-sun">Lever ${hhmm(wx[k].sunrise)} · coucher ${hhmm(wx[k].sunset)}</p>` : ''}` : ''}
          ${races.map(r => `<a class="e-row" href="${ALLURE_URL}"><span class="e-tile t-rdv">🏁</span><span class="e-row__b"><span class="e-row__t">${esc(r.name)}</span><span class="e-row__s">course${r.time ? ` · départ ${r.time}` : ''}${r.distance ? ` · ${r.distance} km` : ''}</span></span><span class="e-go">${I.out}</span></a>`).join('')}
          ${ss.map(s => sessRow(s, k, false) + (editId === s.id ? editorHTML(s, k) : '')).join('')}
          ${!ss.length && !races.length ? `<div class="e-row is-quiet"><span class="e-row__b"><span class="e-row__s">${isRestDay(k) ? 'Repos' : past ? 'Rien' : 'Rien de prévu'}</span></span></div>` : ''}
        </div>
      </section>`;
    }).join('')}
    <button type="button" class="k-btn-soft" data-v="sports">Sports et types de séance</button>`;
  done(host);
}

/** Enregistre un champ de la fiche séance. Le sport et le type redessinent la ligne, les chiffres non
 *  (la roue de durée et le clavier restent ouverts). */
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
  if (f === 'family') {
    s.family = v;
    s.training = '';
  } else s[f] = v;
  quietWeek = f === 'distance' || f === 'time' || f === 'elevation';
  try {
    commit('plans');
  } finally {
    quietWeek = false;
  }
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
function scrollToDay(k) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.getElementById(`pday-${k}`);
    if (!el) return;
    // offsetTop (et non getBoundingClientRect) : l'animation d'entrée décale encore les cartes.
    let y = 0;
    for (let n = el; n; n = n.offsetParent) y += n.offsetTop;
    window.scrollTo({ top: Math.max(0, y - 14), behavior: 'auto' });
  }));
}

/* ---------- Programmer ma semaine ---------- */
let P = null; // { items: [{ s, from, k, sl }], sel }
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
  const items = days.flatMap(k => sessionsOn(k).filter(s => !isDone(k, s, all)).map(s => ({ s, from: k, k, sl: s.slot || '' })));
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
  return items;
}
const changedItems = () => P.items.filter(x => x.k !== x.from || x.sl !== (x.s.slot || ''));
function renderPlan() {
  const el = planEl();
  const cells = planCells();
  const days = [...new Set(cells.map(c => c.k))];
  const sel = P.items.find(x => x.s.id === P.sel);
  const kind = sel ? kindOf(sel.s) : 'run';
  const chip = x => `<span class="e-pm__chip t-${TILE[kindOf(x.s)]} ${P.sel === x.s.id ? 'is-sel' : ''}" data-pm="pick" data-id="${esc(x.s.id)}">${esc(abbr(x.s))}</span>`;
  const n = changedItems().length;
  el.querySelector('.e-pm__b').innerHTML = `
    <p class="e-row__s e-pm__lead">${P.items.length ? 'Carnet a placé tes séances sur les meilleurs moments de la semaine. Touche une séance, puis un créneau pour la déplacer.' : 'Aucune séance à placer d’ici la fin de la semaine. Ajoute-les avec « + Séance », puis reviens ici : la grille montre déjà où il fera beau.'}</p>
    <div class="e-pm__grid" role="grid">
      <span></span>${SLOT_IDS.map(sl => `<small>${SLOTS[sl]}</small>`).join('')}
      ${days.map(k => {
        const ws = slotsOn(k);
        return `<span class="e-pm__d ${k === todayKey() ? 'is-today' : ''}"><b>${esc(dayDiff(k) === 0 ? 'Auj.' : cap(WD[fromKey(k).getDay()]))}</b><small>${fromKey(k).getDate()}</small></span>${SLOT_IDS.map(sl => {
          const w = ws?.[sl];
          const open = cells.some(c => c.k === k && c.sl === sl);
          const here = P.items.filter(x => x.k === k && x.sl === sl);
          const q = w && kind !== 'indoor' ? `q-${level(score(kind, w))}` : '';
          return `<button type="button" class="e-pm__c ${q}" data-pm="cell" data-day="${k}" data-slot="${sl}" ${open ? '' : 'disabled'} aria-label="${esc(`${dayTitle(k)} ${SLOTS[sl].toLowerCase()}`)}">${w ? `<em>${skyOf(w)}${w.t}°</em>` : '<em>—</em>'}${here.map(chip).join('')}</button>`;
        }).join('')}`;
      }).join('')}
    </div>
    ${P.items.length ? `<div class="card e-list e-pm__list">${P.items.map(x => {
      const w = slotsOn(x.k)?.[x.sl];
      const moved = x.k !== x.from;
      return `<button type="button" class="e-row ${P.sel === x.s.id ? 'is-sel' : ''}" data-pm="pick" data-id="${esc(x.s.id)}"><span class="e-tile t-${TILE[kindOf(x.s)]}">${esc(abbr(x.s))}</span><span class="e-row__b"><span class="e-row__t">${esc(x.s.training || familyOf(x.s)?.name || 'Séance')}</span><span class="e-row__s">${esc(`${dayWord(x.k)}${x.sl ? ` ${SLOTS[x.sl].toLowerCase()}` : ''}`)}${w && kindOf(x.s) !== 'indoor' ? ` · ${w.t}° · pluie ${w.rain} % · vent ${w.wind}` : kindOf(x.s) === 'indoor' ? ' · intérieur' : ''}${moved ? `<br><span class="e-better">déplacée depuis ${esc(dayWord(x.from))}</span>` : ''}</span></span></button>`;
    }).join('')}</div>` : ''}`;
  const moved = changedItems().filter(x => x.k !== x.from).length;
  const ok = el.querySelector('[data-pm="apply"]');
  ok.disabled = !n;
  ok.textContent = !n ? 'Rien à changer' : moved ? `Valider · ${moved} déplacée${moved > 1 ? 's' : ''}` : 'Valider les créneaux';
}
function openPlan() {
  loadWx();
  P = { items: proposeWeek(), sel: null };
  const el = planEl();
  el.hidden = false;
  document.body.classList.add('e-flow-on');
  renderPlan();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
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
  closePlan();
  buzz(12);
  toast(`Semaine programmée · ${list.length} séance${list.length > 1 ? 's' : ''} placée${list.length > 1 ? 's' : ''}`, { action: { label: 'Annuler', onClick: () => { Object.assign(state.plans, before); commit('plans'); } } });
}
function onPlanClick(e) {
  if (e.target === planEl()) return closePlan();
  const b = e.target.closest('[data-pm]');
  if (!b || b.disabled) return;
  const a = b.dataset.pm;
  if (a === 'close') return closePlan();
  if (a === 'apply') return applyPlan();
  if (a === 'pick') {
    e.stopPropagation();
    P.sel = P.sel === b.dataset.id ? null : b.dataset.id;
    return renderPlan();
  }
  if (a === 'cell') {
    const x = P.items.find(y => y.s.id === P.sel);
    if (x) {
      x.k = b.dataset.day;
      x.sl = b.dataset.slot;
      P.sel = null;
      P.touched = true;
      buzz(8);
    } else {
      const here = P.items.filter(y => y.k === b.dataset.day && y.sl === b.dataset.slot);
      if (here.length === 1) P.sel = here[0].s.id;
    }
    renderPlan();
  }
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
const STEPS = { task: ['kind', 'title', 'day', 'done'], appointments: ['kind', 'title', 'day', 'time', 'done'], events: ['kind', 'title', 'day', 'done'], sess: ['kind', 'family', 'type', 'day', 'slot', 'done'] };
let F = null;
const flowEl = () => $('#eFlow');
function openFlow(preset) {
  F = { type: null, i: 0, d: {}, ...(preset || {}) };
  const el = flowEl();
  el.hidden = false;
  document.body.classList.add('e-flow-on');
  showStep('in');
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
}
function closeFlow() {
  const el = flowEl();
  el.classList.remove('is-open');
  document.body.classList.remove('e-flow-on');
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
      return `<h2 class="e-q">Qu’est-ce que tu ajoutes ?</h2><div class="e-kinds">${[['task', 'Tâche', 'Avec ou sans date', 't-task', I.list], ['appointments', 'Rendez-vous', 'Un jour, une heure', 't-rdv', I.clock], ['events', 'Événement', 'Une journée à retenir', 't-rdv', I.star], ['sess', 'Séance', 'Placée avec la météo', 't-run', I.run]].map(([k, b, s, t, ic], i) => `<button type="button" class="e-kind" data-fl="kind" data-val="${k}" style="animation-delay:${i * 50}ms"><span class="e-tile ${t}">${ic}</span><b>${b}</b><span>${s}</span></button>`).join('')}</div>
        <p class="e-lab">Ou écris tout d’un coup</p><form class="e-big" data-fl="quick" autocomplete="off"><input id="eQuick" placeholder="dentiste jeudi 17h30" aria-label="Écrire en une phrase" maxlength="120"><button type="submit" aria-label="Valider">${I.go}</button></form><div id="eQuickChip"></div>`;
    case 'title':
      return `<h2 class="e-q">${F.type === 'task' ? 'Qu’y a-t-il à faire ?' : F.type === 'appointments' ? 'Quel rendez-vous ?' : 'Quel événement ?'}</h2><form class="e-big" data-fl="title" autocomplete="off"><input value="${esc(d.title || '')}" placeholder="${F.type === 'task' ? 'Payer la cantine' : F.type === 'appointments' ? 'Dentiste' : 'Anniversaire'}" aria-label="Titre" maxlength="100"><button type="submit" aria-label="Continuer">${I.go}</button></form>`;
    case 'family':
      return `<h2 class="e-q">Quel sport ?${d.fixedDay ? `<small>Pour ${dayWord(d.day)}.</small>` : ''}</h2><div class="e-kinds">${(state.families || []).map((f, i) => `<button type="button" class="e-kind" data-fl="family" data-val="${esc(f.id)}" style="animation-delay:${i * 40}ms"><span class="e-tile t-${TILE[kindOfFamily(f.name)]}">${esc(abbrOf(f.name))}</span><b>${esc(f.name)}</b><span>${kindOfFamily(f.name) === 'indoor' ? 'intérieur' : 'dehors'}</span></button>`).join('')}</div>`;
    case 'type':
      return `<h2 class="e-q">Quelle séance ?</h2><div class="e-opts e-opts--2">${(fam?.types || []).filter(t => !isRestTraining(t)).map((t, i) => `<button type="button" data-fl="type" data-val="${esc(t)}" style="animation-delay:${i * 30}ms">${esc(t)}</button>`).join('')}</div>`;
    case 'day':
      return `<h2 class="e-q">Quel jour ?${F.type === 'sess' && kind !== 'indoor' ? '<small>La pastille donne la météo du meilleur moment.</small>' : ''}</h2>
        ${F.type === 'task' ? `<div class="e-opts e-opts--2" style="margin-bottom:14px"><button type="button" data-fl="day" data-val="">Sans date</button><button type="button" data-fl="day" data-val="${todayKey()}">Aujourd’hui</button></div>` : ''}
        <div class="e-days">${days.map((k, i) => { const x = fromKey(k); const b = F.type === 'sess' && kind !== 'indoor' ? bestSlot(kind, k) : null; return `<button type="button" data-fl="day" data-val="${k}" style="animation-delay:${i * 18}ms"><small>${i ? WD[x.getDay()] : 'auj'}</small><b>${x.getDate()}</b><i class="${b ? `q-${level(score(kind, slotsOn(k)[b]))}` : ''}"></i></button>`; }).join('')}</div>`;
    case 'time':
      return `<h2 class="e-q">À quelle heure, ${dayWord(d.day)} ?</h2><div class="e-opts e-opts--5">${Array.from({ length: 16 }, (_, i) => i + 7).map((h, i) => `<button type="button" data-fl="hour" data-val="${h}" aria-pressed="${d.h === h}" style="animation-delay:${i * 15}ms">${h} h</button>`).join('')}</div>
        <p class="e-lab">Minutes</p><div class="e-opts e-opts--4">${['00', '15', '30', '45'].map(m => `<button type="button" data-fl="min" data-val="${m}" aria-pressed="${(d.m || '00') === m}">${m}</button>`).join('')}</div><button type="button" class="e-btn" data-fl="timeok" ${d.h ? '' : 'disabled'}>Ajouter</button>`;
    case 'slot': {
      const ws = slotsOn(d.day);
      const b = kind !== 'indoor' ? bestSlot(kind, d.day) : null;
      return `<h2 class="e-q">À quel moment, ${dayWord(d.day)} ?${b ? `<small>Carnet conseille ${SLOTS[b].toLowerCase()}.</small>` : ''}</h2><div class="e-slotpick">${SLOT_IDS.map((sl, i) => { const w = ws?.[sl]; const p = slotPast(d.day, sl); return `<button type="button" class="${p || !w || kind === 'indoor' ? '' : `q-${level(score(kind, w))}`}" data-fl="slot" data-val="${sl}" ${p ? 'disabled' : ''} style="animation-delay:${i * 60}ms">${w ? skyOf(w) : ''}<b>${SLOTS[sl]}${sl === b ? ' · conseillé' : ''}</b><span>${w ? `${w.t}° · pluie ${w.rain} % · vent ${w.wind}` : ''}</span></button>`; }).join('')}</div>`;
    }
    case 'done':
      return `<div class="e-stamp"><i>${I.check}</i><b>Ajouté</b><span class="e-row__s">${esc(F.type === 'sess' ? `${d.type}, ${dayWord(d.day)} ${SLOTS[d.slot].toLowerCase()}` : `${d.title}${d.day ? `, ${dayWord(d.day)}` : ''}`)}</span></div>`;
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
    weekStart = dateKey(mondayOf(fromKey(d.day)));
    focusDay = d.day;
    target = 'weekView';
  } else {
    state.dashboard[F.type].push({ id, title: d.title, date: d.day, time: F.type === 'appointments' ? `${pad(d.h)}:${d.m || '00'}` : '', note: '' });
    commit('dashboard');
    const pos = upcoming().findIndex(x => x.id === id);
    more = Math.max(more, pos + 1);
    daySel = null;
    target = 'agendaView';
  }
  flash = id;
  buzz(12);
  const r = flowEl().getBoundingClientRect();
  setTimeout(() => burst(r.left + r.width / 2, r.top + r.height / 2 - 40, 20), 250);
  setTimeout(() => {
    closeFlow();
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
      F.d = {};
    }
    return showStep('back');
  }
  if (a === 'kind') {
    F.type = v;
    F.d = {};
    if (v === 'sess') loadWx();
    return nextStep();
  }
  if (a === 'family') {
    d.family = v;
    return nextStep();
  }
  if (a === 'type' || a === 'day') {
    d[a] = v;
    b.classList.add('is-picked');
    return setTimeout(nextStep, 160);
  }
  if (a === 'hour' || a === 'min') {
    if (a === 'hour') d.h = Number(v);
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
  renderCurrent();
  if (land && !flash) scrollToDay(land);
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
    case 'more':
      more += 8;
      return renderAgendaView();
    case 'mo':
      monthOff = Math.max(0, monthOff + Number(b.dataset.step));
      return renderAgendaView();
    case 'mday':
      daySel = daySel === day ? null : day;
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
      return openFlow({ type: 'sess', i: 1, d: { day, fixedDay: true } });
    case 'sedit':
      if (current !== 'weekView') {
        // Depuis l'accueil : la séance s'ouvre dans Sport, sur son jour.
        weekStart = dateKey(mondayOf(fromKey(day)));
        editId = id;
        focusDay = day;
        return goto('weekView');
      }
      editId = editId === id ? null : id;
      renderWeekView();
      if (editId) requestAnimationFrame(() => document.querySelector('.e-ed')?.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }));
      return;
    case 'sdel':
      return deleteSession(day, id);
    case 'program':
      return openPlan();
    case 'sports':
      return openSportManager();
  }
}

export function initVivant({ go }) {
  goto = go;
  ['#todayView', '#agendaView', '#todoView', '#weekView'].forEach(sel => $(sel).addEventListener('click', onClick));
  // Une ligne de séance est un bouton (role) : Entrée l'ouvre aussi.
  ['#todayView', '#weekView'].forEach(sel => $(sel).addEventListener('keydown', e => e.key === 'Enter' && e.target.matches('.e-row[role="button"][data-v]') && e.target.click()));
  $('#weekView').addEventListener('change', onEditChange);
  // Note : on enregistre sans jamais réécrire le champ (le curseur reste où on tape).
  let noteTimer;
  $('#todayView').addEventListener('input', e => {
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
  pm.className = 'e-pm';
  pm.hidden = true;
  pm.innerHTML = `<div class="e-pm__card" role="dialog" aria-modal="true" aria-labelledby="ePlanTitle"><div class="e-pm__h"><h2 id="ePlanTitle">Programmer ma semaine</h2><button type="button" class="k-round" data-pm="close" aria-label="Fermer">${I.x}</button></div><div class="e-pm__b"></div><div class="e-pm__f"><button type="button" class="e-btn e-btn--ghost" data-pm="close">Annuler</button><button type="button" class="e-btn" data-pm="apply">Valider</button></div></div>`;
  document.body.appendChild(pm);
  pm.addEventListener('click', onPlanClick);
  document.addEventListener('keydown', e => e.key === 'Escape' && !pm.hidden && closePlan());
  // L'anneau du prochain rendez-vous reste juste si l'app reste ouverte.
  setInterval(() => current === 'todayView' && !document.hidden && document.activeElement?.id !== 'vNote' && !document.querySelector('.k-sw [style*="translateX"]') && renderTodayView(), 60000);
}
