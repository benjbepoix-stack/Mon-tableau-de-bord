/*
 * Les trois écrans principaux, dans l'esprit de Mon Garage et Mon budget :
 *  - Aujourd'hui : toutes les séances du jour (avec la météo de leur créneau), deux tuiles
 *    (à faire, prochain rendez-vous), ce qui est à régler, les 7 prochains jours, la note ;
 *  - À faire : saisie en langage naturel, tâches groupées (glisser à droite = faite,
 *    à gauche = demain), puis ce que publient Allure, Garage et Maison ;
 *  - Semaine (« Planifier ») : 7 jours en trois créneaux (matin, après-midi, soir) avec la
 *    prévision heure par heure, une couleur selon le sport, le meilleur créneau, et les
 *    séances qu'on déplace vers un meilleur moment.
 * L'édition détaillée reste celle de l'app : fiche tâche / RDV (dashboard.js), planning (training.js).
 */
import { $, esc, uid } from '../core/utils.js';
import { state, commit } from '../core/store.js';
import { todayKey, dateKey, addDays, fromKey, combine, formatKey, formatDate, isRepeat, nextOccurrenceKey, REPEATS } from '../core/dates.js';
import { isRestTraining } from '../core/schema.js';
import { parseEntry } from '../core/parse.js';
import { readJSON, write } from '../services/storage.js';
import { fetchSlots, SLOT_HOURS } from '../services/weather.js';
import { toast } from '../ui/toast.js';
import { burst, buzz } from '../ui/feedback.js';
import { linkedItems, GARAGE_URL, MAISON_URL } from '../features/linked-apps.js';
import { sportTasks } from '../features/sport-tasks.js';
import { openEditor, openArchive, ALLURE_URL } from './dashboard.js';
import { setTrainingWeek } from './training.js';

const DONE_KEY = 'carnet_sessions_done';
const WD = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const WD_FULL = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const SLOTS = { matin: 'Matin', aprem: 'Après-midi', soir: 'Soir' };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let planStart = todayKey();
let planFor = 'run';
let moving = null; // { id, k } : séance en cours de déplacement
let landed = null;
let wx = {};
const wxAsked = new Set();
let goto = () => {};
let current = 'todayView';
let entering = true;

/* ---------- Séances ---------- */
const familyOf = s => (state.families || []).find(f => f.id === s.family);
/** Genre de sport : la météo ne compte pas pareil à vélo, à pied ou en salle. */
function kindOf(s) {
  const n = (familyOf(s)?.name || '').toLowerCase();
  if (/cycl|vélo|velo|vtt|gravel|route|ski-roue|roller/.test(n)) return 'bike';
  if (/natation|nage|piscine|muscu|renfo|gainage|yoga|escalade|salle|pilates/.test(n)) return 'indoor';
  return 'run';
}
const TILE = { run: 'run', bike: 'bike', indoor: 'gym' };
function abbr(s) {
  const n = familyOf(s)?.name || '';
  const known = { 'course à pied': 'RUN', trail: 'TRAIL', cyclisme: 'VÉLO', vtt: 'VTT', gravel: 'GRAV', musculation: 'MUSC', escalade: 'GRIMP', 'ski de fond': 'SKI', 'ski-roue': 'S-R' };
  return known[n.toLowerCase()] || n.slice(0, 4).toUpperCase() || '—';
}
const num = v => parseFloat(String(v || '').replace(',', '.')) || 0;
const durMin = t => { if (!t) return 0; const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const durLabel = m => (!m ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`);
const km = v => `${String(Math.round(num(v) * 10) / 10).replace('.', ',')} km`;
const facts = s => [s.distance ? km(s.distance) : '', durLabel(durMin(s.time)), s.elevation ? `${s.elevation} m D+` : ''].filter(Boolean).join(' · ');
const titleOf = s => [familyOf(s)?.name, s.training].filter(Boolean).join(' · ') || 'Séance';

/** Séances réelles d'un jour (le repos et les séances vides sont écartés). */
const sessionsOn = k => (Array.isArray(state.plans?.[k]) ? state.plans[k] : []).filter(s => s.family && !isRestTraining(s.training));
const isRestDay = k => (Array.isArray(state.plans?.[k]) ? state.plans[k] : []).some(s => isRestTraining(s.training));
const racesOn = k => (state.races || []).filter(r => r.date === k);

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
  [todayKey(), planStart].forEach(k => {
    if (wxAsked.has(k)) return;
    wxAsked.add(k);
    fetchSlots(k, 7)
      .then(data => {
        wx = { ...wx, ...data };
        if (Object.keys(data).length) renderCurrent();
      })
      .catch(err => {
        console.warn('[météo]', err);
        wxAsked.delete(k);
      });
  });
}
const slotsOn = k => wx[k]?.slots || null;

/** Note d'un créneau pour un genre de sport (0 à 100). */
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
const LEVEL_LABEL = { good: 'idéal', ok: 'moyen', bad: 'à éviter' };
const slotPast = (k, sl) => k < todayKey() || (k === todayKey() && new Date().getHours() > SLOT_HOURS[sl].at(-1));
function bestSlot(kind, k) {
  const ws = slotsOn(k);
  if (!ws) return null;
  const open = Object.keys(SLOTS).filter(sl => ws[sl] && !slotPast(k, sl));
  if (!open.length) return null;
  return open.reduce((a, b) => (score(kind, ws[b]) > score(kind, ws[a]) ? b : a));
}
/** Créneau d'une séance : celui choisi, sinon le meilleur selon la météo. */
const slotOf = (s, k) => s.slot || bestSlot(kindOf(s), k) || '';
const why = w => [w.rain >= 50 ? `pluie ${w.rain} %` : '', w.wind >= 28 ? `vent ${w.wind} km/h` : '', w.gust >= 55 ? `rafales ${w.gust}` : '', w.t < 2 ? `${w.t}°` : '', w.sky === 'storm' ? 'orage' : ''].filter(Boolean).join(', ');

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
    for (const s2 of Object.keys(SLOTS)) {
      if (!w2[s2] || slotPast(dk, s2)) continue;
      const v = score(kind, w2[s2]) - Math.abs((fromKey(dk) - fromKey(k)) / 86400000) * 3;
      if (!best || v > best.v) best = { k: dk, sl: s2, v };
    }
  }
  return best && best.v - cur >= 20 && !(best.k === k && best.sl === sl) ? best : null;
}

const SKY = {
  sun: '<svg class="k-sky" viewBox="0 0 24 24" fill="none" stroke="var(--k-run)" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2" fill="var(--k-run)"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
  part: '<svg class="k-sky" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="9" r="3.6" fill="var(--k-run)" stroke="var(--k-run)"/><path d="M8 19h9a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.6 1.6A2.7 2.7 0 0 0 8 19z" fill="var(--surface)" stroke="var(--text-2)"/></svg>',
  cloud: '<svg class="k-sky" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" stroke-width="2" stroke-linecap="round"><path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 2A3 3 0 0 0 7 18z"/></svg>',
  fog: '<svg class="k-sky" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" stroke-width="2" stroke-linecap="round"><path d="M4 9h16M3 13h18M5 17h14"/></svg>',
  rain: '<svg class="k-sky" viewBox="0 0 24 24" fill="none" stroke="var(--k-bike)" stroke-width="2" stroke-linecap="round"><path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 2A3 3 0 0 0 7 14z" stroke="var(--text-2)"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/></svg>',
  snow: '<svg class="k-sky" viewBox="0 0 24 24" fill="none" stroke="var(--k-bike)" stroke-width="2" stroke-linecap="round"><path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 2A3 3 0 0 0 7 14z" stroke="var(--text-2)"/><path d="M8 18h.01M12 20h.01M16 18h.01"/></svg>',
  storm: '<svg class="k-sky" viewBox="0 0 24 24" fill="none" stroke="var(--late, #c2381f)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 2A3 3 0 0 0 7 14z" stroke="var(--text-2)"/><path d="m12 15-2 4h4l-2 4"/></svg>',
  wind: '<svg class="k-sky" viewBox="0 0 24 24" fill="none" stroke="var(--k-swim)" stroke-width="2" stroke-linecap="round"><path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3M3 12h8"/></svg>'
};
const skyOf = w => SKY[w.wind >= 30 && (w.sky === 'cloud' || w.sky === 'part' || w.sky === 'sun') ? 'wind' : w.sky] || SKY.cloud;
const arrow = deg => `<svg width="11" height="11" viewBox="0 0 24 24" style="transform:rotate(${Math.round(deg + 180)}deg)" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V4M6 10l6-6 6 6"/></svg>`;
const drop = '<svg width="10" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2s7 8 7 13a7 7 0 0 1-14 0c0-5 7-13 7-13z"/></svg>';
const checkSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>';
const plusSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const starSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>';
const chevron = dir => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${dir < 0 ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'}"/></svg>`;

/* ---------- Agenda et tâches ---------- */
function agenda(days = 7) {
  const today = todayKey();
  const last = dateKey(addDays(new Date(), days - 1));
  const now = Date.now();
  const items = [];
  ['appointments', 'events'].forEach(kind =>
    state.dashboard[kind].forEach(x => {
      const date = isRepeat(x.repeat) ? nextOccurrenceKey(x) : x.date;
      if (!date || date < today || date > last) return;
      const end = combine(date, x.endTime || x.time, '23:59');
      if (end && end.getTime() < now) return;
      items.push({ id: x.id, title: x.title, date, time: x.time, kind });
    })
  );
  return items.sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
}
function countdown(x) {
  const at = combine(x.date, x.time, '09:00');
  const min = Math.floor((at - Date.now()) / 60000);
  if (min <= 0) return 'maintenant';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  if (d > 0) return `dans ${d} j${h ? ` ${h} h` : ''}`;
  return h > 0 ? `dans ${h} h ${String(min % 60).padStart(2, '0')}` : `dans ${min} min`;
}
const openTasks = () => state.dashboard.tasks.filter(t => !t.done).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '99').localeCompare(b.time || '99'));
const isLate = t => t.date && t.date < todayKey();
const dayDiff = k => Math.round((fromKey(k) - fromKey(todayKey())) / 86400000);
function dayWord(k) {
  const d = dayDiff(k);
  if (d === 0) return 'aujourd’hui';
  if (d === 1) return 'demain';
  return formatKey(k, { weekday: 'short', day: 'numeric' });
}
function taskMeta(t) {
  const rep = isRepeat(t.repeat) ? ' ↻' : '';
  if (!t.date) return `sans date${rep}`;
  const d = dayDiff(t.date);
  if (d < 0) return `en retard · ${-d} j${rep}`;
  return `${dayWord(t.date)}${t.time ? ` · ${t.time}` : ''}${rep}`;
}

/* ---------- Morceaux communs ---------- */
function ring(k, s) {
  const on = isDone(k, s);
  return `<button type="button" class="k-ring ${on ? 'is-on' : ''}" data-v="session" data-day="${k}" data-id="${esc(s.id)}" aria-pressed="${on}" aria-label="${on ? 'Séance faite' : 'Marquer la séance faite'}">${checkSvg}</button>`;
}
function wxLine(s, k) {
  const sl = slotOf(s, k);
  const w = slotsOn(k)?.[sl];
  if (!w || kindOf(s) === 'indoor' || k < todayKey()) return '';
  const lv = level(score(kindOf(s), w));
  return `<span class="k-wx is-${lv}">${w.t}° · pluie ${w.rain} % · vent ${w.wind} km/h</span>`;
}
function sessRow(s, i, total, k) {
  const sl = slotOf(s, k);
  return `<div class="k-sess ${isDone(k, s) ? 'is-done' : ''}"><span class="k-tile t-${TILE[kindOf(s)]}">${esc(abbr(s))}</span>
    <div class="k-sess__b">${total > 1 ? `<span class="k-sess__n">Séance ${i + 1}</span>` : ''}<span class="k-sess__t">${esc(titleOf(s))}</span>
    <span class="k-sess__s">${esc([sl ? SLOTS[sl].toLowerCase() : '', facts(s)].filter(Boolean).join(' · ') || 'à compléter')}</span>${wxLine(s, k)}</div>${ring(k, s)}</div>`;
}
function taskRow(t) {
  return `<div class="k-sw" data-dir="done"><div class="k-sw__u"><span class="u-done">${checkSvg}Fait</span><span class="u-later">Demain →</span></div>
    <div class="k-task" data-task="${esc(t.id)}" tabindex="0" role="button" aria-label="Modifier « ${esc(t.title)} »"><button type="button" class="k-chk" data-v="tdone" data-id="${esc(t.id)}" aria-label="Cocher « ${esc(t.title)} »">${checkSvg}</button>
    <span class="k-task__b"><span class="k-task__t">${esc(t.title)}</span><span class="k-task__s ${isLate(t) ? 'is-late' : ''}">${esc(taskMeta(t))}</span></span></div></div>`;
}
const head = (kicker, title, tools = '') => `<header class="k-hd"><div><p class="k-kicker">${kicker}</p><h1>${title}</h1></div>${tools}</header>`;

/* ---------- Aujourd'hui ---------- */
export function renderTodayView() {
  const host = $('#todayView');
  const k = todayKey();
  const ss = sessionsOn(k);
  const races = racesOn(k);
  const w = wx[k];
  const tasks = openTasks();
  const late = tasks.filter(isLate).length;
  const now = tasks.filter(t => t.date && t.date <= k);
  const list = agenda(7);
  const next = agenda(60)[0];
  const totKm = ss.reduce((a, s) => a + num(s.distance), 0);
  const totMin = ss.reduce((a, s) => a + durMin(s.time), 0);
  const note = document.activeElement?.id === 'vNote' ? document.activeElement : null;
  const keep = note ? { value: note.value, a: note.selectionStart, b: note.selectionEnd } : null;
  const hour = new Date().getHours();

  const sport = races.length || ss.length
    ? `${races.map(r => `<button type="button" class="k-sess k-race" data-v="allure"><span class="k-tile t-run">🏁</span><div class="k-sess__b"><span class="k-sess__n">Course du jour</span><span class="k-sess__t">${esc(r.name)}</span><span class="k-sess__s">${esc([r.distance ? `${r.distance} km` : '', r.elevation ? `${r.elevation} m D+` : '', r.time ? `départ ${r.time}` : ''].filter(Boolean).join(' · '))}</span></div></button>`).join('')}
       ${ss.map((s, i) => sessRow(s, i, ss.length, k)).join('')}
       ${ss.length > 1 ? `<div class="k-foot"><span>${ss.length} séances</span><b>${[totKm ? km(totKm) : '', durLabel(totMin)].filter(Boolean).join(' · ')}</b></div>` : ''}`
    : `<button type="button" class="k-sess" data-v="plan-day" data-day="${k}"><span class="k-tile t-rest">—</span><div class="k-sess__b"><span class="k-sess__t">${isRestDay(k) ? 'Jour de repos' : 'Rien de prévu'}</span><span class="k-sess__s">${isRestDay(k) ? 'Récupère, c’est aussi de l’entraînement.' : 'Planifier une séance'}</span></div></button>`;

  host.innerHTML = `
    ${head(`${esc(cap(formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })))}${w ? ` · ${w.min}° / ${w.max}°` : ''}`, hour >= 18 ? 'Bonsoir' : 'Bonjour')}
    <section class="k-blk k-blk--first">
      <div class="k-blk-h"><h2>Sport du jour</h2><button type="button" class="k-lnk" data-go="weekView">Planifier</button></div>
      <div class="k-card">${sport}</div>
    </section>
    <div class="k-tiles">
      <button type="button" class="k-card k-stat" data-go="todoView"><span>À faire</span><strong>${tasks.length}</strong>${late ? `<span class="k-badge b-late">${late} en retard</span>` : '<span class="k-badge b-ok">à jour</span>'}</button>
      <button type="button" class="k-card k-stat" ${next ? `data-v="edit" data-type="${next.kind}" data-id="${esc(next.id)}"` : 'data-v="add" data-type="appointments"'}><span>Prochain RDV</span><strong class="k-stat__t">${next ? esc(next.title) : 'Aucun'}</strong><em>${next ? esc(countdown(next)) : 'Ajouter'}</em></button>
    </div>
    <section class="k-blk">
      <div class="k-blk-h"><h2>À régler aujourd’hui</h2><button type="button" class="k-lnk" data-go="todoView">Tout voir</button></div>
      ${now.length ? `<div class="k-rows">${now.map(taskRow).join('')}</div>` : '<div class="k-card k-empty">Rien pour aujourd’hui.</div>'}
    </section>
    <section class="k-blk" id="vAgenda">
      <div class="k-blk-h"><h2>Les 7 prochains jours</h2><span class="k-tools"><button type="button" class="k-lnk" data-v="add" data-type="appointments">+ RDV</button><button type="button" class="k-lnk" data-v="add" data-type="events">+ Événement</button></span></div>
      <div class="k-card">${
        list
          .map(x => {
            const d = fromKey(x.date);
            return `<button type="button" class="k-ag" data-v="edit" data-type="${x.kind}" data-id="${esc(x.id)}"><span class="k-leaf"><small>${WD[d.getDay()]}</small><b>${d.getDate()}</b></span><span class="k-ag__b"><span class="k-ag__t">${esc(x.title)}</span><span class="k-ag__s">${esc([dayDiff(x.date) === 0 ? 'aujourd’hui' : dayDiff(x.date) === 1 ? 'demain' : '', x.time ? x.time.replace(':', ' h ') : 'toute la journée', x.kind === 'events' ? 'événement' : ''].filter(Boolean).join(' · '))}</span></span></button>`;
          })
          .join('') || '<p class="k-empty">Aucun rendez-vous. Écris « dentiste jeudi 17h30 » dans À faire.</p>'
      }</div>
      <div class="k-links"><button type="button" data-v="archive" data-type="appointments">Tous les RDV</button><button type="button" data-v="archive" data-type="events">Tous les événements</button></div>
    </section>
    <section class="k-blk"><div class="k-blk-h"><h2><label for="vNote">Note</label></h2><span class="k-save" id="vNoteState" aria-live="polite"></span></div>
      <div class="k-card k-note"><textarea id="vNote" placeholder="Écrire…" maxlength="20000">${esc(keep ? keep.value : state.notes)}</textarea></div></section>`;
  if (keep) {
    const t = $('#vNote');
    t.focus({ preventScroll: true });
    t.setSelectionRange(keep.a, keep.b);
  }
  bindRows(host);
  enter(host);
  loadWx();
}

/* ---------- À faire ---------- */
export function renderTodoView() {
  const host = $('#todoView');
  const tasks = openTasks();
  const today = todayKey();
  const tomorrow = dateKey(addDays(new Date(), 1));
  const doneToday = state.dashboard.tasks.filter(t => t.done);
  const draft = $('#vDraft')?.value || '';
  const hadFocus = document.activeElement?.id === 'vDraft';
  const { garage, maison, season } = linkedItems();
  const linked = [
    ...sportTasks().map(a => ({ t: a.title, src: 'Allure', href: ALLURE_URL, late: a.level === 'late' })),
    ...garage.map(a => ({ t: `${a.owner ? `${a.owner} · ` : ''}${a.title}`, src: 'Garage', href: GARAGE_URL, late: a.level === 'late', sub: a.text })),
    ...maison.map(a => ({ t: a.title, src: 'Maison', href: `${MAISON_URL}#/entretien`, late: a.level === 'late', sub: a.text })),
    ...season.map(s => ({ t: s.label, src: 'Saison', href: `${MAISON_URL}#/entretien/saison` }))
  ];
  const groups = [
    ['En retard', tasks.filter(isLate), 'is-late'],
    ['Aujourd’hui', tasks.filter(t => t.date === today)],
    ['Demain', tasks.filter(t => t.date === tomorrow)],
    ['Plus tard', tasks.filter(t => t.date && t.date > tomorrow)],
    ['Sans date', tasks.filter(t => !t.date)]
  ].filter(g => g[1].length);

  host.innerHTML = `
    ${head(`${tasks.length} tâche${tasks.length > 1 ? 's' : ''}`, 'À faire')}
    <form class="k-card k-add" id="vAdd" autocomplete="off" novalidate>
      <label for="vDraft" class="v-sr">Nouvelle tâche ou rendez-vous</label>
      <input id="vDraft" placeholder="dentiste jeudi 17h30…" enterkeyhint="done" maxlength="120">
      <button type="submit" aria-label="Ajouter (champ vide : formulaire complet)">${plusSvg}</button>
    </form>
    <div id="vChip"></div>
    ${groups.map(([label, list, cls]) => `<p class="k-grp ${cls || ''}">${label}</p><div class="k-rows">${list.map(taskRow).join('')}</div>`).join('') || '<p class="k-hint k-hint--big">Rien à faire. Belle journée.</p>'}
    ${tasks.length ? '<p class="k-hint">→ fait · ← demain</p>' : ''}
    ${doneToday.length ? `<p class="k-grp">Faites</p><div class="k-card">${doneToday.map(t => `<button type="button" class="k-task is-done" data-v="undo" data-id="${esc(t.id)}"><span class="k-chk is-on">${checkSvg}</span><span class="k-task__b"><span class="k-task__t">${esc(t.title)}</span><span class="k-task__s">${isRepeat(t.repeat) ? esc(REPEATS[t.repeat].label.toLowerCase()) : 'disparaît demain'}</span></span></button>`).join('')}</div>` : ''}
    ${linked.length ? `<p class="k-grp">Depuis tes apps</p><div class="k-chips">${linked.map(x => `<a class="k-chip-link ${x.late ? 'is-late' : ''}" href="${x.href}"${x.sub ? ` title="${esc(x.sub)}"` : ''}>${esc(x.t)}<small>${esc(x.src)}</small></a>`).join('')}</div>` : ''}`;
  const input = $('#vDraft');
  input.value = draft;
  renderChip();
  if (hadFocus) input.focus();
  bindRows(host);
  enter(host);
}

function renderChip() {
  const input = $('#vDraft');
  const box = $('#vChip');
  if (!input || !box) return;
  const raw = input.value.trim();
  let html = '';
  if (raw) {
    const { date, time } = parseEntry(raw);
    html = `<span class="k-chip">${date && time ? 'Rendez-vous' : 'Tâche'} · ${esc(date ? `${dayWord(date)}${time ? ` · ${time.replace(':', ' h ')}` : ''}` : 'sans date')}</span>`;
  }
  if (box.dataset.last !== html) {
    box.innerHTML = html;
    box.dataset.last = html;
  }
}

function addEntry(e) {
  e.preventDefault();
  const input = $('#vDraft');
  const raw = input.value.trim();
  if (!raw) return openEditor('tasks');
  const { title, date, time } = parseEntry(raw);
  if (!title) return;
  if (date && time) {
    state.dashboard.appointments.push({ id: uid(), title, date, time, note: '' });
    toast(`Rendez-vous · ${dayWord(date)} ${time}`);
  } else state.dashboard.tasks.push({ id: uid(), title, date, time: '', note: '', done: false });
  input.value = '';
  const r = $('#vAdd button').getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, 10);
  buzz(10);
  commit('dashboard');
  $('#vDraft')?.focus();
}

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
    const wrap = row.parentElement;
    let st = null;
    row.addEventListener('pointerdown', e => {
      if (e.button > 0 || e.target.closest('.k-chk')) return;
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

/* ---------- Semaine : planifier selon la météo ---------- */
export function renderWeekView() {
  const host = $('#weekView');
  const today = todayKey();
  if (planStart < today) planStart = today;
  const start = fromKey(planStart);
  const keys = Array.from({ length: 7 }, (_, i) => dateKey(addDays(start, i)));
  const end = addDays(start, 6);
  const all = doneMap();
  let tot = 0;
  let nOut = 0;
  let nBad = 0;
  keys.forEach(k =>
    sessionsOn(k).forEach(s => {
      tot += num(s.distance);
      const w = slotsOn(k)?.[slotOf(s, k)];
      if (kindOf(s) !== 'indoor' && w) {
        nOut++;
        if (level(score(kindOf(s), w)) === 'bad') nBad++;
      }
    })
  );
  const mv = moving && sessionsOn(moving.k).find(s => s.id === moving.id);
  if (moving && !mv) moving = null;
  const kind = mv && kindOf(mv) !== 'indoor' ? kindOf(mv) : planFor;
  const nSess = keys.reduce((a, k) => a + sessionsOn(k).length, 0);
  const isCur = planStart === today;
  const range = `${start.getDate()}${start.getMonth() !== end.getMonth() ? ` ${formatDate(start, { month: 'short' })}` : ''} – ${end.getDate()} ${formatDate(end, { month: 'short' })}`;
  const anyWx = keys.some(k => slotsOn(k));

  host.innerHTML = `
    ${mv ? `<div class="k-moving"><span>Où placer ${esc(titleOf(mv).toLowerCase())} ?</span><button type="button" data-v="mvcancel">Annuler</button></div>` : ''}
    ${head(esc(range), 'Planifier', `<div class="k-nav"><button type="button" class="k-round" data-v="week" data-step="-1" aria-label="7 jours plus tôt" ${isCur ? 'disabled' : ''}>${chevron(-1)}</button><button type="button" class="k-round" data-v="week" data-step="1" aria-label="7 jours plus tard">${chevron(1)}</button></div>`)}
    <div class="k-card k-sum">
      <div class="k-sum__n"><strong>${Math.round(tot)}</strong><span>km prévus · ${nSess} séance${nSess > 1 ? 's' : ''}</span></div>
      ${anyWx ? `<span class="k-badge ${nBad ? 'b-late' : 'b-ok'}">${nBad ? `${nBad} séance${nBad > 1 ? 's' : ''} sous la pluie ou le vent` : nOut ? 'Les sorties tombent sur de bons créneaux' : 'Aucune sortie dehors prévue'}</span>` : '<span class="k-badge b-soon">Prévision pas encore disponible</span>'}
      <div class="k-for"><span>Couleurs pour</span><div class="k-seg" role="group" aria-label="Sport pour les couleurs">${[['run', 'Course'], ['bike', 'Vélo']].map(([v, l]) => `<button type="button" data-v="pfor" data-kind="${v}" aria-pressed="${kind === v}">${l}</button>`).join('')}</div></div>
    </div>
    <div class="k-legend"><span><i class="q-good"></i>idéal</span><span><i class="q-ok"></i>moyen</span><span><i class="q-bad"></i>à éviter</span><span>${starSvg} meilleur créneau</span></div>
    ${keys.map(k => planDay(k, kind, mv, all)).join('')}
    <button type="button" class="k-btn-soft" data-v="plan-day" data-day="${planStart}">Planning détaillé et volumes</button>`;
  enter(host);
  loadWx();
}

function planDay(k, kind, mv, all) {
  const d = fromKey(k);
  const day = wx[k];
  const ws = day?.slots;
  const ss = sessionsOn(k);
  const races = racesOn(k);
  const best = bestSlot(kind, k);
  const title = dayDiff(k) === 0 ? 'Aujourd’hui' : dayDiff(k) === 1 ? 'Demain' : cap(WD_FULL[d.getDay()]);
  const slots = ws
    ? `<div class="k-slots">${Object.keys(SLOTS)
        .map(sl => {
          const w = ws[sl];
          if (!w) return '<span class="k-slot is-past"></span>';
          const past = slotPast(k, sl);
          const v = score(kind, w);
          const here = ss.filter(s => slotOf(s, k) === sl);
          const from = mv && moving.k === k && slotOf(mv, k) === sl;
          return `<button type="button" class="k-slot ${past ? 'is-past' : `q-${level(v)}`} ${mv && !from && !past ? 'is-target' : ''} ${from ? 'is-from' : ''}" data-v="slot" data-day="${k}" data-slot="${sl}" ${past ? 'disabled' : ''} aria-label="${SLOTS[sl]} : ${w.t} degrés, pluie ${w.rain} %, vent ${w.wind} km/h, ${LEVEL_LABEL[level(v)]}">
            <span class="k-slot__l">${SLOTS[sl]}</span>
            <span class="k-slot__w">${skyOf(w)}<b>${w.t}°</b></span>
            <span class="k-slot__m ${w.rain >= 50 ? 'is-strong' : ''}">${drop}${w.rain} %${w.mm ? ` · ${String(w.mm).replace('.', ',')} mm` : ''}</span>
            <span class="k-slot__m ${w.wind >= 28 ? 'is-strong' : ''}">${arrow(w.deg)}${w.wind} km/h</span>
            <span class="k-slot__m k-slot__g ${w.gust >= 50 ? 'is-strong' : ''}">rafales ${w.gust}</span>
            ${here.length ? `<span class="k-slot__s">${here.map(s => `<em class="t-${TILE[kindOf(s)]}">${esc(abbr(s))}</em>`).join('')}</span>` : ''}
            ${sl === best && !past ? `<span class="k-slot__best">${starSvg}</span>` : ''}
          </button>`;
        })
        .join('')}</div>`
    : `<p class="k-nowx">${dayDiff(k) > 15 ? 'Prévision disponible à 15 jours.' : 'Prévision en cours de chargement…'}</p>`;
  const rows = ss
    .map(s => {
      const sl = slotOf(s, k);
      const w = ws?.[sl];
      const sk = kindOf(s);
      const lv = sk === 'indoor' || !w ? 'good' : level(score(sk, w));
      const sug = !mv && lv !== 'good' ? suggestion(s, k) : null;
      const sub = sk === 'indoor' ? [sl ? SLOTS[sl].toLowerCase() : '', 'en intérieur', facts(s)].filter(Boolean).join(' · ') : lv === 'bad' ? `${SLOTS[sl].toLowerCase()} · ${why(w) || 'conditions difficiles'}` : [sl ? SLOTS[sl].toLowerCase() : '', facts(s)].filter(Boolean).join(' · ');
      const auto = !s.slot && sl ? ' <span class="k-auto">conseillé</span>' : '';
      const action = sug
        ? `<button type="button" class="k-mv is-go" data-v="mvto" data-id="${esc(s.id)}" data-day="${k}" data-to="${sug.k}" data-slot="${sug.sl}">Déplacer</button>`
        : `<button type="button" class="k-mv" data-v="mv" data-id="${esc(s.id)}" data-day="${k}">Déplacer</button>`;
      return `<div class="k-pse ${landed === s.id ? 'is-moved' : ''}"><span class="k-tile t-${TILE[sk]}">${esc(abbr(s))}</span>
        <span class="k-pse__b"><span class="k-pse__t">${esc(titleOf(s))}</span><span class="k-pse__s ${lv === 'bad' ? 'is-warn' : ''}">${esc(sub || 'à compléter')}${auto}${sug ? `<br><span class="k-better">Mieux : ${esc(sug.k === k ? '' : `${dayWord(sug.k)} `)}${esc(SLOTS[sug.sl].toLowerCase())}</span>` : ''}</span></span>
        ${isDone(k, s, all) ? '<span class="k-badge b-ok">faite</span>' : mv ? '' : action}</div>`;
    })
    .join('');
  return `<article class="k-card k-pday ${k === todayKey() ? 'is-today' : ''}" id="pday-${k}">
    <div class="k-pday__h">${day ? skyOf({ ...day, wind: 0 }) : ''}<h3>${title}<small>${d.getDate()} ${formatDate(d, { month: 'short' })}</small></h3>${day ? `<span class="k-pday__t">${day.min}° <span>/</span> ${day.max}°</span>` : ''}</div>
    ${races.map(r => `<button type="button" class="k-race-line" data-v="allure">🏁 ${esc(r.name)}${r.time ? ` · départ ${r.time}` : ''}</button>`).join('')}
    ${slots}
    ${rows ? `<div class="k-pses">${rows}</div>` : isRestDay(k) ? '<p class="k-rest">Repos</p>' : ''}
    <div class="k-pday__e"><span>${day?.sunrise ? `Lever ${day.sunrise.replace(':', ' h ')} · coucher ${day.sunset.replace(':', ' h ')}` : ''}</span><button type="button" class="k-lnk" data-v="plan-day" data-day="${k}">${ss.length ? 'Modifier' : '+ Séance'}</button></div>
  </article>`;
}

function moveSession(id, from, to, slot) {
  const list = Array.isArray(state.plans[from]) ? state.plans[from] : [];
  const s = list.find(x => x.id === id);
  if (!s) return;
  const prev = { slot: s.slot };
  const put = (src, dst, sl) => {
    state.plans[src] = (state.plans[src] || []).filter(x => x.id !== id);
    s.slot = sl;
    // Un jour vide peut contenir une séance vierge (affichage du planning) : on la remplace.
    const target = (state.plans[dst] || []).filter(x => x.family || x.training || x.distance || x.time || x.elevation);
    state.plans[dst] = [...target, s];
  };
  put(from, to, slot);
  moving = null;
  landed = id;
  commit('plans');
  setTimeout(() => (landed = null), 1300);
  const card = document.getElementById(`pday-${to}`);
  card?.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  const w = slotsOn(to)?.[slot];
  if (w && level(score(kindOf(s), w)) === 'good') {
    setTimeout(() => {
      const r = card?.querySelector(`[data-slot="${slot}"]`)?.getBoundingClientRect();
      if (r) burst(r.left + r.width / 2, r.top + r.height / 2, 14);
    }, 380);
  }
  buzz(10);
  toast(`${titleOf(s)} · ${dayWord(to)} ${SLOTS[slot].toLowerCase()}`, {
    action: {
      label: 'Annuler',
      onClick: () => {
        put(to, from, prev.slot);
        commit('plans');
      }
    }
  });
}

/* ---------- Rendu, entrées animées ---------- */
function enter(host) {
  host.classList.toggle('k-in', entering && !reduced());
  entering = false;
}
function renderCurrent() {
  if (current === 'todayView') renderTodayView();
  else if (current === 'todoView') renderTodoView();
  else if (current === 'weekView') renderWeekView();
}
export function showVivant(id) {
  if (id !== current) {
    entering = true;
    moving = null;
  }
  current = id;
  renderCurrent();
}

function onClick(e) {
  const go = e.target.closest('[data-go]');
  if (go) return goto(go.dataset.go);
  const b = e.target.closest('[data-v]');
  if (!b || b.disabled) return;
  const { v, type, id, day } = b.dataset;
  switch (v) {
    case 'session': {
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
    case 'add':
      return openEditor(type);
    case 'edit':
      return openEditor(type, id);
    case 'archive':
      return openArchive(type);
    case 'allure':
      return (location.href = ALLURE_URL);
    case 'undo': {
      const t = state.dashboard.tasks.find(x => x.id === id);
      if (!t) return;
      t.done = false;
      delete t.doneAt;
      return commit('dashboard');
    }
    case 'week':
      planStart = dateKey(addDays(fromKey(planStart), Number(b.dataset.step) * 7));
      entering = true;
      renderWeekView();
      return window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
    case 'pfor':
      planFor = b.dataset.kind;
      return renderWeekView();
    case 'mv':
      moving = { id, k: day };
      renderWeekView();
      return window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
    case 'mvcancel':
      moving = null;
      return renderWeekView();
    case 'mvto':
      return moveSession(id, day, b.dataset.to, b.dataset.slot);
    case 'slot': {
      if (moving) return moveSession(moving.id, moving.k, day, b.dataset.slot);
      const w = slotsOn(day)?.[b.dataset.slot];
      if (w) toast(`${SLOTS[b.dataset.slot]} : ${w.label.toLowerCase()}, ${w.t}°, vent ${w.dir} ${w.wind} km/h (rafales ${w.gust})`);
      return;
    }
    case 'plan-day':
      setTrainingWeek(day ? fromKey(day) : new Date());
      return goto('trainingView');
  }
}

export function initVivant({ go }) {
  goto = go;
  ['#todayView', '#todoView', '#weekView'].forEach(sel => $(sel).addEventListener('click', onClick));
  $('#todoView').addEventListener('submit', e => e.target.id === 'vAdd' && addEntry(e));
  $('#todoView').addEventListener('input', e => e.target.id === 'vDraft' && renderChip());
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
  // Bouton + : saisie rapide dans À faire.
  $('#kFab')?.addEventListener('click', () => {
    goto('todoView');
    requestAnimationFrame(() => $('#vDraft')?.focus());
  });
  // Le compte à rebours du prochain rendez-vous reste juste si l'app reste ouverte.
  setInterval(() => current === 'todayView' && !document.hidden && document.activeElement?.id !== 'vNote' && !document.querySelector('.k-sw [style*="translateX"]') && renderTodayView(), 60000);
}
