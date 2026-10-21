/*
 * Briefing du matin : à la première ouverture de la journée, quatre écrans plein
 * écran avant l'app.
 *  1. Météo et séance du jour (« Je la fais » ou « Demain » : la séance passe au lendemain) ;
 *  2. Rendez-vous, événements et courses des 7 prochains jours, avec compte à rebours ;
 *  3. Tâches échues (en retard ou du jour) en pile : glisser à droite = faite, à gauche = demain ;
 *  4. Bilan : une plante qui gagne une feuille par geste, et la série de matins.
 * Rejouable depuis l'en-tête. Les gestes écrivent dans les vraies données (store → Firebase).
 */
import { $, esc } from '../core/utils.js';
import { state, commit } from '../core/store.js';
import { todayKey, dateKey, addDays, mondayOf, combine, isRepeat, nextOccurrenceKey, formatKey } from '../core/dates.js';
import { isRestTraining } from '../core/schema.js';
import { readJSON, write } from '../services/storage.js';
import { fetchWeek, getPlace } from '../services/weather.js';
import { lateAlerts, GARAGE_URL, MAISON_URL } from './linked-apps.js';
import { burst, buzz } from '../ui/feedback.js';

const DAYS_KEY = 'carnet_brief_days';
const MORNING_KEY = 'carnet_brief_morning';
const STORIES = 4;

let story = 0;
let weather = null;
let onClose = null;

/* ---------- Données ---------- */
const morning = () => {
  const m = readJSON(MORNING_KEY, null);
  return m && m.day === todayKey() ? m : { day: todayKey(), done: 0, later: 0, planned: false };
};
const saveMorning = m => write(MORNING_KEY, JSON.stringify(m));
const briefDays = () => (Array.isArray(readJSON(DAYS_KEY, [])) ? readJSON(DAYS_KEY, []) : []);

function streak() {
  const set = new Set(briefDays());
  let d = new Date();
  if (!set.has(dateKey(d))) d = addDays(d, -1);
  let n = 0;
  while (set.has(dateKey(d))) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

const facts = x => [x.distance ? `${String(x.distance).replace('.', ',')} km` : '', x.time ? x.time.replace(/^0(\d)/, '$1').replace(':', ' h ') : '', x.elevation ? `${x.elevation} m D+` : ''].filter(Boolean).join(' · ');

/** Séance(s) du jour : { title, detail } ou null (jour libre) ; rest : jour de repos. */
function todaySession() {
  const key = todayKey();
  const races = (state.races || []).filter(r => r.date === key);
  if (races.length) return { title: races[0].name, detail: ['Course', races[0].time ? `départ ${races[0].time}` : '', races[0].distance ? `${races[0].distance} km` : ''].filter(Boolean).join(' · '), race: true };
  const sessions = (Array.isArray(state.plans?.[key]) ? state.plans[key] : []).filter(s => s.training || s.family);
  if (!sessions.length) return null;
  if (sessions.every(s => isRestTraining(s.training))) return { rest: true };
  const s = sessions.find(x => !isRestTraining(x.training));
  const f = (state.families || []).find(a => a.id === s.family);
  return { title: f ? f.name : s.training, detail: [f ? s.training : '', facts(s)].filter(Boolean).join(' · '), more: sessions.length - 1 };
}

/** Rendez-vous, événements et courses des 7 prochains jours. */
function weekAgenda() {
  const today = todayKey();
  const limit = dateKey(addDays(new Date(), 7));
  const now = Date.now();
  const items = [];
  ['appointments', 'events'].forEach(kind =>
    state.dashboard[kind].forEach(x => {
      const date = isRepeat(x.repeat) ? nextOccurrenceKey(x) : x.date;
      if (!date || date < today || date > limit) return;
      const end = combine(date, x.endTime || x.time, '23:59');
      if (end && end.getTime() < now) return;
      items.push({ title: x.title, date, time: x.time, kind });
    })
  );
  (state.races || []).filter(r => r.date >= today && r.date <= limit).forEach(r => items.push({ title: r.name, date: r.date, time: r.time, kind: 'races' }));
  return items.sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
}

const dueTasks = () =>
  state.dashboard.tasks
    .filter(t => !t.done && t.date && t.date <= todayKey())
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99').localeCompare(b.time || '99'));

function untilLabel(x) {
  const at = combine(x.date, x.time, '09:00');
  const ms = at - Date.now();
  const days = Math.round((combine(x.date, '12:00') - combine(todayKey(), '12:00')) / 86400000);
  if (days <= 0) return { n: ms > 0 && x.time ? `${Math.max(1, Math.round(ms / 3600000))} h` : 'auj.', u: x.time ? 'aujourd’hui' : '' };
  if (x.kind === 'races') return { n: `J-${days}`, u: 'course' };
  return { n: String(days), u: days > 1 ? 'jours' : 'jour' };
}

function taskMeta(t) {
  const late = t.date < todayKey();
  if (!late) return `aujourd’hui${t.time ? ` · ${t.time}` : ''}`;
  const n = Math.round((combine(todayKey(), '12:00') - combine(t.date, '12:00')) / 86400000);
  return `en retard · ${n} j`;
}

/* ---------- Rendu ---------- */
const sunIcon = '<svg class="brief__sky" width="64" height="64" viewBox="0 0 64 64" fill="none" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><g stroke="var(--pollen)"><circle cx="24" cy="24" r="9"/><path d="M24 6v4M24 38v4M6 24h4M38 24h4M11 11l3 3M34 11l-3 3M11 37l3-3"/></g><path d="M26 52h24a9 9 0 0 0 0-18 13 13 0 0 0-24 4 7 7 0 0 0 0 14z" stroke="var(--text)" fill="var(--bg)"/></svg>';
const checkIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>';

function storyWeather() {
  const now = new Date();
  const w = weather?.[todayKey()];
  const s = todaySession();
  const m = morning();
  const sessionCard = !s
    ? `<div class="brief__card"><span class="brief__eyebrow">Sport</span><span class="brief__big">Journée libre</span><span class="brief__mono">Rien de planifié aujourd’hui.</span></div>`
    : s.rest
      ? `<div class="brief__card"><span class="brief__eyebrow">Sport</span><span class="brief__big">Jour de repos</span><span class="brief__mono">Récupère, c’est aussi de l’entraînement.</span></div>`
      : `<div class="brief__card ${s.race ? 'is-race' : ''}">
          <span class="brief__eyebrow">${s.race ? 'Course du jour' : 'Ta séance'}</span>
          <span class="brief__big">${esc(s.title)}</span>
          ${s.detail ? `<span class="brief__mono">${esc(s.detail)}${s.more ? ` · +${s.more}` : ''}</span>` : ''}
          ${s.race ? '' : `<div class="brief__row">
            <button type="button" class="brief__btn ${m.planned ? 'is-pollen' : 'is-light'}" data-brief="plan">${m.planned ? 'C’est noté' : 'Je la fais'}</button>
            <button type="button" class="brief__btn is-ghost" data-brief="move">Demain</button>
          </div>`}
        </div>`;
  return `<span class="brief__eyebrow brief__mono">${esc(formatKey(todayKey(), { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase())} · ${esc(getPlace().name.toUpperCase())}</span>
    <h1 class="brief__title">${now.getHours() < 18 ? 'Bonjour' : 'Bonsoir'} Benjamin.</h1>
    <div class="brief__weather">${sunIcon}<div><div class="brief__temp">${w ? `${w.max}°` : '—'}</div><div class="brief__lead">${w ? `${esc(w.label)} · ${w.min}° le matin` : 'Météo en cours…'}</div></div></div>
    ${sessionCard}
    <div class="brief__foot"><button type="button" class="brief__btn is-light" data-brief="next">Ma semaine</button></div>`;
}

function storyAgenda() {
  const list = weekAgenda();
  const rows = list
    .map((x, i) => {
      const c = untilLabel(x);
      const near = c.u === 'aujourd’hui' || c.n === '1' || c.n === '2' || x.kind === 'races';
      return `<div class="brief__rdv" style="animation-delay:${80 + i * 70}ms">
        <div class="brief__count"><b class="${near ? 'is-near' : ''}">${esc(c.n)}</b><small>${esc(c.u)}</small></div>
        <div class="brief__rdv-body"><b>${esc(x.title)}</b><span>${esc(formatKey(x.date, { weekday: 'short', day: 'numeric' }))}${x.time ? ` · ${x.time}` : ''}</span></div>
        <span class="brief__tag">${x.kind === 'races' ? 'Course' : x.kind === 'events' ? 'Événement' : 'RDV'}</span>
      </div>`;
    })
    .join('');
  const n = list.length;
  return `<span class="brief__eyebrow brief__mono">LES 7 PROCHAINS JOURS</span>
    <h1 class="brief__title">${n ? (n === 1 ? 'Un rendez-vous cette semaine.' : `${n} rendez-vous cette semaine.`) : 'Semaine libre.'}</h1>
    <div class="brief__list">${rows || '<p class="brief__lead">Rien de prévu. Profite.</p>'}</div>
    <div class="brief__foot"><button type="button" class="brief__btn is-light" data-brief="next">À régler</button></div>`;
}

function storyDeck() {
  const deck = dueTasks();
  const cards = deck
    .slice(0, 3)
    .map(
      (t, i) => `<div class="brief__deck-card ${t.date < todayKey() ? 'is-late' : ''}" data-task="${esc(t.id)}" style="z-index:${10 - i};transform:translateY(${i * 14}px) scale(${1 - i * 0.05})">
        <span class="brief__chip">${esc(taskMeta(t))}</span>
        <span class="brief__deck-title">${esc(t.title)}</span>
        <div class="brief__hint"><span>← demain</span><span>fait →</span></div>
        <span class="brief__stamp is-done">FAIT</span><span class="brief__stamp is-later">DEMAIN</span>
      </div>`
    )
    .reverse()
    .join('');
  const n = deck.length;
  return `<span class="brief__eyebrow brief__mono">UN GESTE CHACUNE</span>
    <h1 class="brief__title">${n ? (n === 1 ? 'Plus qu’une.' : `${n} choses à régler.`) : 'Tout est réglé.'}</h1>
    <div class="brief__deck" id="briefDeck">${cards || '<p class="brief__lead">Aucune tâche en retard ni prévue aujourd’hui.</p>'}</div>
    <div class="brief__foot"><button type="button" class="brief__btn ${n ? 'is-ghost' : 'is-light'}" data-brief="next">${n ? 'Plus tard' : 'Continuer'}</button></div>`;
}

function storyPlant() {
  const m = morning();
  const total = m.done + m.later + (m.planned ? 1 : 0);
  const n = Math.max(2, total);
  const leaves = Array.from({ length: n }, (_, j) => {
    const left = j % 2 === 0;
    return `<span class="brief__leaf ${j < total ? 'is-on' : ''}" style="left:calc(50% + ${left ? -42 : 2}px);bottom:${50 + j * 34}px;transform-origin:${left ? 'right' : 'left'} center;--r:${left ? -28 : 28}deg;animation-delay:${250 + j * 150}ms"></span>`;
  }).join('');
  const sk = streak() + (briefDays().includes(todayKey()) ? 0 : 1);
  const alerts = lateAlerts();
  const garage = alerts.filter(a => a.source === 'garage').length;
  const maison = alerts.filter(a => a.source === 'maison').length;
  const links = [garage ? `<a href="${GARAGE_URL}">Garage : ${garage} en retard</a>` : '', maison ? `<a href="${MAISON_URL}#/entretien">Maison : ${maison} en retard</a>` : ''].filter(Boolean).join('');
  return `<span class="brief__eyebrow brief__mono is-pollen">${sk > 1 ? `${sk} MATINS D’AFFILÉE` : 'PREMIER MATIN'}</span>
    <h1 class="brief__title">Prêt.</h1>
    <p class="brief__lead">${m.planned ? '1 séance prévue · ' : ''}${m.done} réglée${m.done > 1 ? 's' : ''} · ${m.later} pour demain</p>
    ${links ? `<div class="brief__links">${links}</div>` : ''}
    <div class="brief__plant"><span class="brief__stem" style="height:${40 + n * 34}px"></span>${leaves}<span class="brief__flower" style="bottom:${60 + n * 34}px"></span></div>
    <div class="brief__foot"><button type="button" class="brief__btn is-pollen" data-brief="close">Ouvrir mon carnet</button></div>`;
}

function render() {
  const host = $('#briefing');
  const body = [storyWeather, storyAgenda, storyDeck, storyPlant][story]();
  host.innerHTML = `<div class="brief__bars" aria-hidden="true">${Array.from({ length: STORIES }, (_, i) => `<span><i class="${i <= story ? 'is-on' : ''}"></i></span>`).join('')}</div>
    <div class="brief__top"><button type="button" class="brief__skip" data-brief="close">Passer</button></div>
    <div class="brief__story" key="${story}">${body}</div>`;
  bindDeck();
}

/* ---------- Pile de cartes ---------- */
function bindDeck() {
  const deck = $('#briefDeck');
  const top = deck?.querySelector('.brief__deck-card:last-child');
  if (!top) return;
  const under = [...deck.querySelectorAll('.brief__deck-card')].slice(0, -1).reverse();
  const sDone = top.querySelector('.is-done');
  const sLater = top.querySelector('.is-later');
  let st = null;
  const set = (x, y, anim) => {
    top.style.transition = anim ? '' : 'none';
    top.style.transform = `translate(${x}px, ${y}px) rotate(${x / 16}deg)`;
    sDone.style.opacity = Math.max(0, Math.min(1, x / 110));
    sLater.style.opacity = Math.max(0, Math.min(1, -x / 110));
    const p = Math.min(1, Math.hypot(x, y) / 160);
    under.forEach((c, i) => {
      const k = i + 1;
      c.style.transition = anim ? '' : 'none';
      c.style.transform = `translateY(${14 * k - 14 * p}px) scale(${1 - 0.05 * k + 0.05 * p})`;
    });
  };
  top.addEventListener('pointerdown', e => {
    top.setPointerCapture(e.pointerId);
    st = { x: e.clientX, y: e.clientY, dx: 0, h: [{ x: e.clientX, t: e.timeStamp }] };
  });
  top.addEventListener('pointermove', e => {
    if (!st) return;
    st.h.push({ x: e.clientX, t: e.timeStamp });
    if (st.h.length > 6) st.h.shift();
    let dy = e.clientY - st.y;
    dy = (dy * 200 * 0.55) / (200 + 0.55 * Math.abs(dy)); // résistance élastique verticale
    st.dx = e.clientX - st.x;
    set(st.dx, dy, false);
  });
  const end = () => {
    if (!st) return;
    const a = st.h[0];
    const b = st.h[st.h.length - 1];
    const v = ((b.x - a.x) / Math.max(16, b.t - a.t)) * 1000;
    // Projection de l'élan : un petit lancer suffit (décélération 0,99).
    const proj = st.dx + ((v / 1000) * 0.99) / 0.01;
    st = null;
    if (Math.abs(proj) < 150) return set(0, 0, true);
    const done = proj > 0;
    top.style.transition = 'transform 360ms cubic-bezier(.2,.8,.2,1)';
    top.style.transform = `translate(${done ? 560 : -560}px, 40px) rotate(${done ? 24 : -24}deg)`;
    if (done) {
      const r = top.getBoundingClientRect();
      burst(r.right - 40, r.top + r.height / 2, 22);
      buzz(12);
    } else buzz(8);
    setTimeout(() => settle(top.dataset.task, done), 300);
  };
  top.addEventListener('pointerup', end);
  top.addEventListener('pointercancel', end);
}

function settle(id, done) {
  const t = state.dashboard.tasks.find(x => x.id === id);
  if (!t) return render();
  const m = morning();
  if (done) {
    t.done = true;
    t.doneAt = todayKey();
    m.done++;
  } else {
    t.date = dateKey(addDays(new Date(), 1));
    m.later++;
  }
  saveMorning(m);
  commit('dashboard');
  render();
}

/** Séance(s) du jour reportée(s) au lendemain, ajoutée(s) à ce qui y est déjà prévu. */
function moveSessionToTomorrow() {
  const key = todayKey();
  const next = dateKey(addDays(new Date(), 1));
  const planned = s => s.training || s.family;
  const today = (state.plans[key] || []).filter(planned);
  if (!today.length) return;
  const keep = (state.plans[next] || []).filter(planned).filter(s => !isRestTraining(s.training));
  state.plans[next] = [...keep, ...today.filter(s => !isRestTraining(s.training))];
  delete state.plans[key];
  commit('plans');
}

/* ---------- Ouverture / fermeture ---------- */
function onClick(e) {
  const b = e.target.closest('[data-brief]');
  if (!b) return;
  const act = b.dataset.brief;
  if (act === 'next') {
    story = Math.min(STORIES - 1, story + 1);
    render();
  } else if (act === 'close') close();
  else if (act === 'plan') {
    const m = morning();
    if (!m.planned) {
      m.planned = true;
      saveMorning(m);
      const r = b.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top, 16);
      buzz(12);
    }
    render();
  } else if (act === 'move') {
    moveSessionToTomorrow();
    buzz(8);
    story = 1;
    render();
  }
}

export function openBriefing() {
  story = 0;
  const host = $('#briefing');
  host.hidden = false;
  document.documentElement.classList.add('is-briefing');
  render();
  host.focus({ preventScroll: true });
  fetchWeek(mondayOf(new Date()))
    .then(w => {
      weather = w;
      if (!host.hidden && story === 0) render();
    })
    .catch(() => {});
}

function close() {
  const days = briefDays();
  if (!days.includes(todayKey())) write(DAYS_KEY, JSON.stringify([...days, todayKey()].slice(-90)));
  const host = $('#briefing');
  host.classList.add('is-leaving');
  setTimeout(() => {
    host.hidden = true;
    host.classList.remove('is-leaving');
    host.innerHTML = '';
    document.documentElement.classList.remove('is-briefing');
    onClose?.();
  }, 260);
}

/** Première ouverture du jour : affiche le briefing. Renvoie true s'il s'affiche. */
export function maybeShowBriefing() {
  if (briefDays().includes(todayKey()) || !$('#briefing').hidden) return false;
  openBriefing();
  return true;
}

export const isBriefingOpen = () => !$('#briefing').hidden;

export function initBriefing({ onDone } = {}) {
  onClose = onDone;
  $('#briefing').addEventListener('click', onClick);
  $('#briefingBtn')?.addEventListener('click', openBriefing);
}
