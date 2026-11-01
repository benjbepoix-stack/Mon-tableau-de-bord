/* =========================================================
   Routines : étirements, gainage, mobilité… avec un chrono ludique.
   Liste des routines (prêtes + les tiennes), fiche d'une routine, éditeur,
   et le lecteur plein écran : anneau qui se vide, 3-2-1, côté gauche / droit,
   bulle de respiration, petits sons, série de jours.
   Données dans le navigateur (carnet_routines, carnet_routine_log).
   ========================================================= */
import { $, esc, uid } from '../core/utils.js';
import { readJSON, write } from '../services/storage.js';
import { burst, buzz } from '../ui/feedback.js';
import { toast } from '../ui/toast.js';

const KEY = 'carnet_routines';
const LOG = 'carnet_routine_log';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const pad = n => String(n).padStart(2, '0');
const dKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Routines prêtes à l'emploi. side : l'exercice se fait de chaque côté (deux fois la durée). */
const PRESETS = [
  { id: 'p-etir', name: 'Étirements après la course', ill: 'yoga', color: 'teal', rest: 5, breath: true, ex: [
    { n: 'Mollets contre un mur', s: 30, side: true, tip: 'Talon au sol, jambe arrière tendue.' },
    { n: 'Ischio-jambiers', s: 30, side: true, tip: 'Dos droit, on penche depuis les hanches.' },
    { n: 'Quadriceps debout', s: 30, side: true, tip: 'Genoux serrés, bassin en avant.' },
    { n: 'Fente basse (psoas)', s: 30, side: true, tip: 'Le genou arrière au sol, on pousse la hanche.' },
    { n: 'Fessiers en « 4 »', s: 30, side: true, tip: 'Cheville sur le genou opposé, on ramène.' },
    { n: 'Posture de l’enfant', s: 45, tip: 'On relâche le dos, on respire lentement.' }
  ] },
  { id: 'p-gain', name: 'Gainage express', ill: 'gym', color: 'rose', rest: 15, ex: [
    { n: 'Planche', s: 40, tip: 'Corps aligné, on serre les fessiers.' },
    { n: 'Planche sur le côté', s: 30, side: true, tip: 'Hanches hautes.' },
    { n: 'Pont fessier', s: 40, tip: 'On monte le bassin, on tient en haut.' },
    { n: 'Superman', s: 30, tip: 'Bras et jambes décollés, regard au sol.' },
    { n: 'Dead bug', s: 40, tip: 'Le bas du dos reste collé au sol.' },
    { n: 'Planche, la dernière !', s: 45, tip: 'On tient jusqu’au bout.' }
  ] },
  { id: 'p-mob', name: 'Mobilité du matin', ill: 'run', color: 'sun', rest: 5, breath: true, ex: [
    { n: 'Cercles de chevilles', s: 30, tip: 'Dans un sens puis dans l’autre.' },
    { n: 'Cercles de hanches', s: 30, tip: 'Grands cercles, mains sur les hanches.' },
    { n: 'Chat-vache', s: 40, tip: 'On enroule puis on creuse le dos, au rythme du souffle.' },
    { n: 'Rotations du buste', s: 30, side: true, tip: 'À quatre pattes, la main derrière la tête.' },
    { n: 'Squat profond', s: 40, tip: 'Talons au sol, coudes contre les genoux.' },
    { n: 'Ouverture des épaules', s: 30, tip: 'Grands cercles de bras.' }
  ] },
  { id: 'p-ski', name: 'Renfo ski de fond', ill: 'xc', color: 'sky', rest: 15, ex: [
    { n: 'Pompes triceps', s: 30, tip: 'Coudes le long du corps.' },
    { n: 'Fentes sautées', s: 30, tip: 'On amortit en douceur.' },
    { n: 'Chaise contre un mur', s: 45, tip: 'Cuisses parallèles au sol.' },
    { n: 'Équilibre sur une jambe', s: 30, side: true, tip: 'Genou souple, on regarde loin.' },
    { n: 'Tirage élastique', s: 40, tip: 'Comme une poussée de bâtons.' }
  ] }
];
const COLORS = { teal: ['#0E3B4A', '#1C5B6B'], rose: ['#B8264B', '#E0315B'], sun: ['#C77A12', '#F5A623'], sky: ['#1F5F96', '#2F7FC0'], green: ['#2E6E3A', '#4E9A55'] };
const DURS = [15, 20, 30, 40, 45, 60, 90, 120];

const mine = () => readJSON(KEY, []) || [];
const all = () => [...mine(), ...PRESETS];
const byId = id => all().find(r => r.id === id);
const REPS = [1, 2, 3, 4, 5, 6, 8, 10];
const repsOf = x => Math.max(1, Number(x.rep) || 1);
/** Les étapes réelles : chaque exercice autant de fois que demandé ; « de chaque côté » = gauche puis droite.
 *  flip : passage au côté droit (3 s pour changer) ; set : « Série 2 sur 3 ». */
const stepsOf = r => r.ex.flatMap((x, xi) => {
  const n = repsOf(x);
  return Array.from({ length: n }, (_, k) => {
    const set = n > 1 ? `Série ${k + 1} sur ${n}` : '';
    return x.side ? [{ ...x, xi, set, sd: 'Côté gauche' }, { ...x, xi, set, sd: 'Côté droit', flip: true }] : [{ ...x, xi, set }];
  }).flat();
});
const stepSub = x => [x.set, x.sd].filter(Boolean).join(' · ');
const totalSec = r => stepsOf(r).reduce((a, x) => a + x.s, 0) + Math.max(0, stepsOf(r).length - 1) * (r.rest || 0);
const minLabel = s => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);
const ill = (name, cls = '') => `<svg class="d-ill ${cls}" viewBox="0 0 64 64" aria-hidden="true"><use href="#d-${name}"/></svg>`;

/* ---------- Série de jours ---------- */
const logMap = () => readJSON(LOG, {}) || {};
function streak() {
  const m = logMap();
  const d = new Date();
  if (!m[dKey(d)]) d.setDate(d.getDate() - 1);
  let n = 0;
  while (m[dKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function weekDots() {
  const m = logMap();
  const d = new Date();
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const x = new Date(d);
    x.setDate(d.getDate() - i);
    out.push({ on: Boolean(m[dKey(x)]), l: 'DLMMJVS'[x.getDay()], today: i === 0 });
  }
  return out;
}
function logDone(sec) {
  const m = logMap();
  const k = dKey();
  m[k] = (m[k] || 0) + Math.round(sec / 60) || 1;
  write(LOG, m);
}

/* ---------- La page ---------- */
let view = { mode: 'list', id: null, draft: null };
const el = () => $('#rtPage');
export function openRoutines() {
  view = { mode: 'list', id: null, draft: null };
  const e = el();
  e.hidden = false;
  document.body.classList.add('e-flow-on');
  render();
  requestAnimationFrame(() => e.classList.add('is-open'));
}
function closeRoutines() {
  const e = el();
  e.classList.remove('is-open');
  document.body.classList.remove('e-flow-on');
  setTimeout(() => (e.hidden = true), reduced() ? 0 : 300);
}
const X = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const BACK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>';
const UP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';
const DOWN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const PLAY = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.5-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z"/></svg>';

function render() {
  const e = el();
  if (view.mode === 'edit') return renderEdit(e);
  if (view.mode === 'detail') return renderDetail(e);
  const st = streak();
  const dots = weekDots();
  const card = r => `<div class="rt-card c-${r.color || 'teal'}"><button type="button" class="rt-card__m" data-rt="detail" data-id="${esc(r.id)}"><span class="rt-card__i">${ill(r.ill || 'yoga')}</span><span class="rt-card__b"><b>${esc(r.name)}</b><small>${minLabel(totalSec(r))} · ${r.ex.length} exercice${r.ex.length > 1 ? 's' : ''}</small></span></button><button type="button" class="rt-go" data-rt="play" data-id="${esc(r.id)}" aria-label="Lancer ${esc(r.name)}">${PLAY}</button></div>`;
  e.innerHTML = `<div class="rt-top"><span></span><button type="button" class="rt-x" data-rt="close" aria-label="Fermer">${X}</button></div>
    <h1 class="rt-h">Routines</h1>
    <section class="rt-streak"><div><b>${st ? `${st} jour${st > 1 ? 's' : ''}` : 'C’est parti'}</b><small>${st ? 'd’affilée, continue !' : 'Une routine aujourd’hui lance ta série.'}</small></div>
      <div class="rt-week">${dots.map(x => `<span class="${x.on ? 'is-on' : ''} ${x.today ? 'is-today' : ''}"><i></i>${x.l}</span>`).join('')}</div></section>
    ${mine().length ? `<h2 class="rt-sub">Mes routines</h2><div class="rt-list">${mine().map(card).join('')}</div>` : ''}
    <h2 class="rt-sub">Prêtes à lancer</h2><div class="rt-list">${PRESETS.map(card).join('')}</div>
    <button type="button" class="rt-new" data-rt="new">+ Créer ma routine</button>`;
}
function renderDetail(e) {
  const r = byId(view.id);
  if (!r) { view.mode = 'list'; return render(); }
  const own = !r.id.startsWith('p-');
  e.innerHTML = `<div class="rt-top"><button type="button" class="rt-x" data-rt="list" aria-label="Retour">${BACK}</button><button type="button" class="rt-x" data-rt="close" aria-label="Fermer">${X}</button></div>
    <div class="rt-hero c-${r.color || 'teal'}">${ill(r.ill || 'yoga')}<h1>${esc(r.name)}</h1><p>${minLabel(totalSec(r))} · ${r.ex.length} exercices${r.rest ? ` · ${r.rest} s de pause` : ''}</p></div>
    <ol class="rt-ex">${r.ex.map((x, i) => `<li><span class="rt-ex__n">${i + 1}</span><span class="rt-ex__b"><b>${esc(x.n)}</b>${x.tip ? `<small>${esc(x.tip)}</small>` : ''}</span><span class="rt-ex__t">${repsOf(x) > 1 ? `${repsOf(x)} × ` : ''}${x.s} s${x.side ? '<small>× 2 côtés</small>' : ''}</span></li>`).join('')}</ol>
    <div class="rt-actions"><button type="button" class="rt-ghost" data-rt="${own ? 'edit' : 'copy'}" data-id="${esc(r.id)}">${own ? 'Modifier' : 'Copier et modifier'}</button><button type="button" class="rt-play" data-rt="play" data-id="${esc(r.id)}">${PLAY} Lancer</button></div>`;
}
function renderEdit(e) {
  const d = view.draft;
  const n = d.ex.length;
  const row = (x, i) => `<div class="rt-er">
    <span class="rt-er__mv"><button type="button" data-rt="exup" data-i="${i}" aria-label="Monter ${esc(x.n || `l’exercice ${i + 1}`)}" ${i ? '' : 'disabled'}>${UP}</button><button type="button" data-rt="exdown" data-i="${i}" aria-label="Descendre ${esc(x.n || `l’exercice ${i + 1}`)}" ${i < n - 1 ? '' : 'disabled'}>${DOWN}</button></span>
    <input class="rt-er__n" data-rf="n" data-i="${i}" value="${esc(x.n)}" placeholder="Exercice ${i + 1}" maxlength="60" aria-label="Exercice ${i + 1}">
    <button type="button" class="rt-del" data-rt="exdel" data-i="${i}" aria-label="Retirer">${X}</button>
    <span class="rt-er__o">
      <select data-rf="s" data-i="${i}" aria-label="Durée">${DURS.map(v => `<option value="${v}" ${v === x.s ? 'selected' : ''}>${minLabel(v)}</option>`).join('')}</select>
      <select data-rf="rep" data-i="${i}" aria-label="Nombre de fois">${REPS.map(v => `<option value="${v}" ${v === repsOf(x) ? 'selected' : ''}>${v === 1 ? '1 fois' : `${v} fois`}</option>`).join('')}</select>
      <label class="rt-side"><input type="checkbox" data-rf="side" data-i="${i}" ${x.side ? 'checked' : ''}>2 côtés</label>
    </span></div>`;
  e.innerHTML = `<div class="rt-top"><button type="button" class="rt-x" data-rt="${d.isNew ? 'list' : 'detail'}" data-id="${esc(d.id)}" aria-label="Retour">${BACK}</button><button type="button" class="rt-x" data-rt="close" aria-label="Fermer">${X}</button></div>
    <h1 class="rt-h">${d.isNew ? 'Nouvelle routine' : 'Modifier'}</h1>
    <label class="rt-f"><span>Nom</span><input data-rf="name" value="${esc(d.name)}" placeholder="Ex. Étirements du soir" maxlength="50"></label>
    <div class="rt-f"><span>Couleur</span><div class="rt-colors">${Object.keys(COLORS).map(c => `<button type="button" class="c-${c} ${d.color === c ? 'is-on' : ''}" data-rt="color" data-c="${c}" aria-label="${c}" aria-pressed="${d.color === c}"></button>`).join('')}</div></div>
    <div class="rt-f"><span>Pause entre les exercices</span><select data-rf="rest">${[0, 5, 10, 15, 20, 30].map(v => `<option value="${v}" ${v === d.rest ? 'selected' : ''}>${v ? `${v} s` : 'Aucune'}</option>`).join('')}</select></div>
    <label class="rt-check"><input type="checkbox" data-rf="breath" ${d.breath ? 'checked' : ''}> Bulle de respiration (pour les étirements)</label>
    <div class="rt-f"><span>Exercices</span><div class="rt-ers">${d.ex.map(row).join('')}</div><button type="button" class="rt-new" data-rt="exadd">+ Exercice</button></div>
    <div class="rt-actions">${d.isNew ? '<span></span>' : `<button type="button" class="rt-ghost is-danger" data-rt="remove" data-id="${esc(d.id)}">Supprimer</button>`}<button type="button" class="rt-play" data-rt="save">Enregistrer</button></div>`;
}
function save() {
  const d = view.draft;
  const ex = d.ex.map(x => ({ ...x, n: x.n.trim() })).filter(x => x.n);
  if (!d.name.trim()) return toast('Donne un nom à ta routine', { type: 'error' });
  if (!ex.length) return toast('Ajoute au moins un exercice', { type: 'error' });
  const r = { id: d.id, name: d.name.trim(), color: d.color, rest: d.rest, breath: d.breath, ill: d.breath ? 'yoga' : 'gym', ex };
  write(KEY, [r, ...mine().filter(x => x.id !== r.id)]);
  view = { mode: 'detail', id: r.id };
  render();
  toast('Routine enregistrée');
}
function onClick(e) {
  const b = e.target.closest('[data-rt]');
  if (!b) return;
  const { rt, id } = b.dataset;
  if (rt === 'close') return closeRoutines();
  if (rt === 'list') { view = { mode: 'list' }; return render(); }
  if (rt === 'detail') { view = { mode: 'detail', id }; return render(); }
  if (rt === 'play') return play(id);
  if (rt === 'new') { view = { mode: 'edit', draft: { id: uid(), isNew: true, name: '', color: 'teal', rest: 10, breath: true, ex: [{ n: '', s: 30, side: false }] } }; return render(); }
  if (rt === 'edit' || rt === 'copy') {
    const r = byId(id);
    view = { mode: 'edit', draft: { ...JSON.parse(JSON.stringify(r)), id: rt === 'copy' ? uid() : r.id, isNew: rt === 'copy', name: rt === 'copy' ? `${r.name} (à moi)` : r.name } };
    return render();
  }
  if (rt === 'color') { view.draft.color = b.dataset.c; return render(); }
  if (rt === 'exadd') { view.draft.ex.push({ n: '', s: 30, side: false }); render(); return el().querySelector('.rt-er:last-child input')?.focus(); }
  if (rt === 'exdel') { view.draft.ex.splice(Number(b.dataset.i), 1); return render(); }
  if (rt === 'exup' || rt === 'exdown') {
    const i = Number(b.dataset.i);
    const j = rt === 'exup' ? i - 1 : i + 1;
    const ex = view.draft.ex;
    if (j < 0 || j >= ex.length) return;
    [ex[i], ex[j]] = [ex[j], ex[i]];
    render();
    // Le focus suit l'exercice déplacé (on peut enchaîner les appuis).
    const btn = el().querySelector(`[data-rt="${rt}"][data-i="${j}"]:not([disabled])`) || el().querySelector(`[data-rt="${rt === 'exup' ? 'exdown' : 'exup'}"][data-i="${j}"]`);
    btn?.focus({ preventScroll: true });
    const rowEl = el().querySelectorAll('.rt-er')[j];
    rowEl?.classList.add('is-moved');
    return;
  }
  if (rt === 'save') return save();
  if (rt === 'remove') {
    const before = mine();
    write(KEY, before.filter(x => x.id !== id));
    view = { mode: 'list' };
    render();
    return toast('Routine supprimée', { action: { label: 'Annuler', onClick: () => { write(KEY, before); render(); } } });
  }
}
function onInput(e) {
  const t = e.target;
  const f = t.dataset.rf;
  if (!f || !view.draft) return;
  const d = view.draft;
  if (f === 'name') d.name = t.value;
  else if (f === 'rest') d.rest = Number(t.value);
  else if (f === 'breath') d.breath = t.checked;
  else {
    const x = d.ex[Number(t.dataset.i)];
    if (f === 'n') x.n = t.value;
    if (f === 's') x.s = Number(t.value);
    if (f === 'side') x.side = t.checked;
    if (f === 'rep') x.rep = Number(t.value);
  }
}

/* ---------- Le lecteur ---------- */
let P = null; // { r, steps, i, phase: 'count'|'go'|'rest'|'end', end, left, paused, raf }
const pl = () => $('#rtPlay');
let audio = null;
function beep(freq = 880, ms = 120, vol = 0.18) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + ms / 1000);
  } catch { /* pas de son */ }
}
/* ---------- Écran toujours allumé pendant la routine ----------
   1) Verrou d'écran (Screen Wake Lock) quand le navigateur le permet ; il saute quand l'app passe
      en arrière-plan, on le reprend au retour.
   2) En secours (iPhone, anciens iOS, PWA sur l'écran d'accueil) : une petite vidéo muette et noire
      lue en boucle, qui empêche la mise en veille. Lancée pendant l'appui sur « Lancer ». */
let lock = null;
let awake = false;
let vid = null;
function wakeVideo() {
  if (!vid) {
    vid = document.createElement('video');
    vid.src = new URL('../../media/awake.mp4', import.meta.url).href;
    vid.muted = true;
    vid.loop = true;
    vid.playsInline = true;
    vid.setAttribute('playsinline', '');
    vid.setAttribute('muted', '');
    vid.setAttribute('aria-hidden', 'true');
    vid.style.cssText = 'position:fixed;width:1px;height:1px;left:0;bottom:0;opacity:0.01;pointer-events:none;';
    document.body.appendChild(vid);
  }
  return vid;
}
async function askLock() {
  if (!('wakeLock' in navigator) || lock) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch { lock = null; /* refusé : la vidéo prend le relais */ }
}
function keepAwake(on) {
  awake = on;
  if (on) {
    // La vidéo d'abord, encore dans le geste de l'utilisateur (sinon iOS refuse de la lire).
    try { wakeVideo().play()?.catch(() => {}); } catch { /* tant pis */ }
    askLock();
  } else {
    if (vid) vid.pause();
    if (lock) { lock.release().catch(() => {}); lock = null; }
  }
}
function play(id) {
  const r = byId(id);
  if (!r) return;
  P = { r, steps: stepsOf(r), i: 0, phase: 'count', paused: false, sound: readJSON('carnet_rt_sound', true) !== false, last: -1 };
  const e = pl();
  e.hidden = false;
  e.style.setProperty('--c1', COLORS[r.color || 'teal'][0]);
  e.style.setProperty('--c2', COLORS[r.color || 'teal'][1]);
  requestAnimationFrame(() => e.classList.add('is-open'));
  keepAwake(true);
  beep(660, 60, 0.001); // débloque le son sur iPhone (geste de l'utilisateur)
  start('count', 3);
}
function start(phase, sec) {
  P.phase = phase;
  P.dur = sec;
  P.end = performance.now() + sec * 1000;
  P.left = sec * 1000;
  P.last = -1;
  frame();
  cancelAnimationFrame(P.raf);
  if (!P.paused) P.raf = requestAnimationFrame(tick);
}
function tick(now) {
  if (!P || P.paused) return;
  P.left = Math.max(0, P.end - now);
  const s = Math.ceil(P.left / 1000);
  if (s !== P.last) {
    P.last = s;
    if (P.sound && s <= 3 && s > 0 && (P.phase !== 'count' || true)) beep(P.phase === 'go' ? 740 : 520, 90);
    if (s <= 3 && s > 0) buzz(15);
  }
  paint();
  if (P.left <= 0) return next();
  P.raf = requestAnimationFrame(tick);
}
function next(skip = false) {
  if (!P) return;
  cancelAnimationFrame(P.raf);
  if (P.phase === 'count' || P.phase === 'rest') {
    if (P.sound) beep(1046, 220, 0.22);
    buzz([40, 40, 40]);
    return start('go', P.steps[P.i].s);
  }
  if (P.phase === 'go') {
    if (!skip && P.sound) beep(392, 260, 0.2);
    P.i++;
    if (P.i >= P.steps.length) return finish();
    const flip = P.steps[P.i].flip;
    // Changement de côté : 3 secondes ; sinon (nouvelle série ou exercice suivant) la pause de la routine, ou 3 s si aucune.
    return start(flip ? 'count' : P.r.rest ? 'rest' : 'count', flip ? 3 : P.r.rest || 3);
  }
}
function prev() {
  if (!P) return;
  cancelAnimationFrame(P.raf);
  if (P.phase === 'go' && P.left < (P.dur - 2) * 1000) return start('go', P.steps[P.i].s);
  P.i = Math.max(0, P.i - (P.phase === 'go' ? 1 : 0));
  start('count', 3);
}
function togglePause() {
  if (!P || P.phase === 'end') return;
  P.paused = !P.paused;
  if (P.paused) { cancelAnimationFrame(P.raf); P.left = Math.max(0, P.end - performance.now()); }
  else { P.end = performance.now() + P.left; P.raf = requestAnimationFrame(tick); }
  frame();
}
function finish() {
  const sec = totalSec(P.r);
  logDone(sec);
  P.phase = 'end';
  keepAwake(false);
  if (P.sound) [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 180, 0.2), i * 140));
  buzz([60, 40, 60, 40, 120]);
  frame();
  const r = pl().getBoundingClientRect();
  [0, 250, 500].forEach(t => setTimeout(() => burst(r.width / 2 + (Math.random() - 0.5) * 120, r.height / 2.6, 26), t));
}
function closePlay() {
  if (!P) return;
  cancelAnimationFrame(P.raf);
  keepAwake(false);
  P = null;
  const e = pl();
  e.classList.remove('is-open');
  setTimeout(() => (e.hidden = true), reduced() ? 0 : 300);
  if (!el().hidden) render();
}
const R = 104;
const C = 2 * Math.PI * R;
/** Dessin complet de l'écran (à chaque changement d'étape). */
function frame() {
  const e = pl();
  const st = P.steps;
  const cur = st[Math.min(P.i, st.length - 1)];
  const nxt = st[P.i + 1];
  if (P.phase === 'end') {
    const s = streak();
    e.innerHTML = `<div class="rp-top"><span></span><button type="button" class="rp-x" data-rp="close" aria-label="Fermer">${X}</button></div>
      <div class="rp-end"><div class="rp-medal">${ill(P.r.ill || 'yoga')}</div><h2>Bravo !</h2><p>${esc(P.r.name)} · ${minLabel(totalSec(P.r))}</p>
      <div class="rp-stats"><span><b>${st.length}</b>étapes</span><span><b>${s}</b>jour${s > 1 ? 's' : ''} d’affilée</span></div>
      <button type="button" class="rp-btn" data-rp="close">Terminer</button><button type="button" class="rp-link" data-rp="again">Recommencer</button></div>`;
    return;
  }
  const label = P.phase === 'count' ? (cur.flip && P.i ? 'On change de côté' : 'Prêt ?') : P.phase === 'rest' ? 'Pause' : '';
  e.dataset.phase = P.phase;
  e.innerHTML = `<div class="rp-top"><div class="rp-path" aria-label="Étape ${P.i + 1} sur ${st.length}">${st.map((_, j) => `<i class="${j < P.i ? 'is-done' : j === P.i ? 'is-cur' : ''}"></i>`).join('')}</div><button type="button" class="rp-x" data-rp="close" aria-label="Arrêter">${X}</button></div>
    <p class="rp-k">${label || `Exercice ${cur.xi + 1} sur ${P.r.ex.length}`}</p>
    <h2 class="rp-n">${esc(P.phase === 'go' ? cur.n : P.phase === 'rest' ? `Ensuite : ${cur.n}` : cur.n)}</h2>
    ${stepSub(cur) ? `<p class="rp-sd">${stepSub(cur)}</p>` : '<p class="rp-sd is-empty"></p>'}
    <div class="rp-ring ${P.r.breath && P.phase === 'go' ? 'is-breath' : ''}">
      <span class="rp-bubble" aria-hidden="true"></span>
      <svg viewBox="0 0 240 240" aria-hidden="true"><circle cx="120" cy="120" r="${R}" class="rp-track"/><circle cx="120" cy="120" r="${R}" class="rp-arc" stroke-dasharray="${C.toFixed(1)}"/></svg>
      <div class="rp-c"><b class="rp-s"></b>${P.r.breath && P.phase === 'go' ? '<small class="rp-br">inspire…</small>' : P.phase === 'go' ? '<small>secondes</small>' : ''}</div>
    </div>
    <p class="rp-tip">${P.phase === 'go' && cur.tip ? esc(cur.tip) : P.phase === 'rest' ? 'Souffle un peu, on repart bientôt.' : ''}</p>
    <div class="rp-ctl"><button type="button" class="rp-sm" data-rp="prev" aria-label="Revenir">${BACK}</button><button type="button" class="rp-big" data-rp="pause" aria-label="${P.paused ? 'Reprendre' : 'Pause'}">${P.paused ? PLAY : '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.4"/><rect x="14" y="5" width="4" height="14" rx="1.4"/></svg>'}</button><button type="button" class="rp-sm" data-rp="next" aria-label="Passer">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>'}</button></div>
    <p class="rp-next">${nxt && P.phase === 'go' ? `Ensuite : ${esc(nxt.n)}${stepSub(nxt) ? ` · ${stepSub(nxt).toLowerCase()}` : ''}` : P.phase === 'go' ? 'Dernière ligne droite !' : ''}</p>
    <button type="button" class="rp-snd" data-rp="sound" aria-pressed="${P.sound}">${P.sound ? 'Son activé' : 'Son coupé'}</button>`;
  paint();
}
/** Mise à jour légère à chaque image : chiffres, anneau, bulle de respiration. */
function paint() {
  const e = pl();
  const s = e.querySelector('.rp-s');
  if (!s) return;
  const left = P.paused ? P.left : Math.max(0, P.end - performance.now());
  const sec = Math.ceil(left / 1000);
  s.textContent = P.phase === 'count' ? (sec || 'Go') : sec;
  const frac = P.dur ? left / (P.dur * 1000) : 0;
  e.querySelector('.rp-arc').style.strokeDashoffset = (C * (1 - frac)).toFixed(1);
  const br = e.querySelector('.rp-br');
  if (br) {
    // Cycle de 8 s : 4 s on inspire (la bulle grossit), 4 s on expire.
    const t = ((P.dur * 1000 - left) / 1000) % 8;
    br.textContent = t < 4 ? 'inspire…' : 'expire…';
    e.querySelector('.rp-bubble').style.transform = `scale(${0.72 + 0.28 * (t < 4 ? t / 4 : 1 - (t - 4) / 4)})`;
  }
}
function onPlayClick(e) {
  const b = e.target.closest('[data-rp]');
  if (!b || !P) return;
  const a = b.dataset.rp;
  if (a === 'close') return closePlay();
  if (a === 'pause') return togglePause();
  if (a === 'next') return P.phase === 'end' ? null : next(true);
  if (a === 'prev') return prev();
  if (a === 'again') return play(P.r.id);
  if (a === 'sound') { P.sound = !P.sound; write('carnet_rt_sound', P.sound); return frame(); }
}

export function initRoutines() {
  const page = document.createElement('section');
  page.id = 'rtPage';
  page.className = 'rt';
  page.hidden = true;
  page.setAttribute('role', 'dialog');
  page.setAttribute('aria-modal', 'true');
  page.setAttribute('aria-label', 'Routines');
  document.body.appendChild(page);
  page.addEventListener('click', onClick);
  page.addEventListener('input', onInput);
  page.addEventListener('change', onInput);
  const p = document.createElement('section');
  p.id = 'rtPlay';
  p.className = 'rp';
  p.hidden = true;
  p.setAttribute('role', 'dialog');
  p.setAttribute('aria-modal', 'true');
  p.setAttribute('aria-label', 'Routine en cours');
  document.body.appendChild(p);
  p.addEventListener('click', onPlayClick);
  document.addEventListener('keydown', e => {
    if (P && !pl().hidden) {
      if (e.key === 'Escape') closePlay();
      else if (e.key === ' ') { e.preventDefault(); togglePause(); }
      else if (e.key === 'ArrowRight') next(true);
      else if (e.key === 'ArrowLeft') prev();
    } else if (e.key === 'Escape' && !page.hidden) closeRoutines();
  });
  // L'écran revient au premier plan : on recale le chrono sur l'horloge.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Retour au premier plan : on reprend le verrou d'écran (le système le lâche en arrière-plan).
    if (awake) { askLock(); if (vid && vid.paused) vid.play()?.catch(() => {}); }
    if (P && !P.paused && P.phase !== 'end') { cancelAnimationFrame(P.raf); P.raf = requestAnimationFrame(tick); }
  });
}
