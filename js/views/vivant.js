/*
 * Les trois écrans « Vivant » (maquette du briefing) sur les vraies données :
 *  - Aujourd'hui : séance du jour (rond à cocher), prochain rendez-vous avec compte à rebours,
 *    tâches à régler, autres apps, rendez-vous / événements / courses à venir, note ;
 *  - À faire : saisie en langage naturel, tâches en cartes (glisser à droite = faite,
 *    à gauche = demain), tâches faites du jour, puis ce que publient Allure, Garage et Maison ;
 *  - Semaine : volume par jour en barres, un jour par carte (météo, séance, rendez-vous).
 * L'édition détaillée reste celle de l'app : fiche tâche / RDV (dashboard.js), planning (training.js).
 */
import { $, esc, uid } from '../core/utils.js';
import { state, commit } from '../core/store.js';
import { todayKey, dateKey, addDays, mondayOf, fromKey, combine, formatKey, formatDate, isRepeat, nextOccurrenceKey, REPEATS } from '../core/dates.js';
import { isRestTraining } from '../core/schema.js';
import { parseEntry } from '../core/parse.js';
import { readJSON, write } from '../services/storage.js';
import { fetchWeek } from '../services/weather.js';
import { toast } from '../ui/toast.js';
import { burst, buzz } from '../ui/feedback.js';
import { linkedItems, GARAGE_URL, MAISON_URL } from '../features/linked-apps.js';
import { sportTasks } from '../features/sport-tasks.js';
import { openEditor, openArchive, ALLURE_URL } from './dashboard.js';
import { setTrainingWeek } from './training.js';

const DONE_KEY = 'carnet_sessions_done';
const WD = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const WD_FULL = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const SKY = label => label || '';

let weekStart = mondayOf(new Date());
let weather = {};
let weatherFor = '';
let scrolledWeek = '';
let goto = () => {};

/* ---------- Données ---------- */
const sessionsDone = () => readJSON(DONE_KEY, {}) || {};
const isSessionDone = key => Boolean(sessionsDone()[key]);
function toggleSessionDone(key) {
  const all = sessionsDone();
  if (all[key]) delete all[key];
  else all[key] = true;
  // On ne garde que les 120 derniers jours.
  const limit = dateKey(addDays(new Date(), -120));
  Object.keys(all).forEach(k => k < limit && delete all[k]);
  write(DONE_KEY, all);
  return Boolean(all[key]);
}

const num = v => parseFloat(String(v || '').replace(',', '.')) || 0;
const facts = x => [x.distance ? `${String(x.distance).replace('.', ',')} km` : '', x.time ? x.time.replace(/^0(\d)/, '$1').replace(':', ' h ') : '', x.elevation ? `${x.elevation} m D+` : ''].filter(Boolean).join(' · ');

/** Ce qui est prévu un jour : { title, detail, km, rest, race } ou null. */
function dayPlan(key) {
  const race = (state.races || []).find(r => r.date === key);
  if (race) return { title: race.name, detail: [race.distance ? `${race.distance} km` : '', race.elevation ? `${race.elevation} D+` : '', race.time ? `départ ${race.time}` : ''].filter(Boolean).join(' · '), km: num(race.distance), race: true };
  const sessions = (Array.isArray(state.plans?.[key]) ? state.plans[key] : []).filter(s => s.training || s.family);
  if (!sessions.length) return null;
  const real = sessions.filter(s => !isRestTraining(s.training));
  if (!real.length) return { title: 'Repos', detail: 'récupération', km: 0, rest: true };
  const s = real[0];
  const f = (state.families || []).find(a => a.id === s.family);
  const more = real.length > 1 ? ` · +${real.length - 1} séance${real.length > 2 ? 's' : ''}` : '';
  return { title: f ? (s.training ? `${f.name}` : f.name) : s.training, detail: `${[f && s.training ? s.training : '', facts(s)].filter(Boolean).join(' · ')}${more}`, km: real.reduce((n, x) => n + num(x.distance), 0) };
}

/** Rendez-vous, événements et courses à venir (prochaine occurrence des répétés). */
function agenda() {
  const today = todayKey();
  const now = Date.now();
  const items = [];
  ['appointments', 'events'].forEach(kind =>
    state.dashboard[kind].forEach(x => {
      const date = isRepeat(x.repeat) ? nextOccurrenceKey(x) : x.date;
      if (!date || date < today) return;
      const end = combine(date, x.endTime || x.time, '23:59');
      if (end && end.getTime() < now) return;
      items.push({ id: x.id, title: x.title, date, time: x.time, kind });
    })
  );
  (state.races || []).filter(r => r.date >= today).forEach(r => items.push({ id: r.id, title: r.name, date: r.date, time: r.time, kind: 'races' }));
  return items.sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
}

function countdown(x) {
  const at = combine(x.date, x.time, '09:00');
  const ms = at - Date.now();
  if (ms <= 0) return 'maintenant';
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${String(min % 60).padStart(2, '0')}`;
  return `${min} min`;
}

const openTasks = () => state.dashboard.tasks.filter(t => !t.done).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '99').localeCompare(b.time || '99'));
const isLate = t => t.date && t.date < todayKey();

function taskMeta(t) {
  const rep = isRepeat(t.repeat) ? ' ↻' : '';
  if (!t.date) return `sans date${rep}`;
  const d = Math.round((fromKey(t.date) - fromKey(todayKey())) / 86400000);
  if (d < 0) return `en retard · ${-d} j${rep}`;
  if (d === 0) return `aujourd’hui${t.time ? ` · ${t.time}` : ''}${rep}`;
  if (d === 1) return `demain${t.time ? ` · ${t.time}` : ''}${rep}`;
  return `${formatKey(t.date, { weekday: 'short', day: 'numeric' })}${t.time ? ` · ${t.time}` : ''}${rep}`;
}

const shortDate = (key, time) => `${formatKey(key, { weekday: 'short', day: 'numeric' })}${time ? ` ${time}` : ''}`;
const eyebrowDate = () => formatDate(new Date(), { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();

function loadWeather() {
  const key = dateKey(weekStart);
  const cur = dateKey(mondayOf(new Date()));
  [cur, key].forEach(k => {
    if (weatherFor.includes(k)) return;
    weatherFor += `${k};`;
    fetchWeek(fromKey(k))
      .then(data => {
        weather = { ...weather, ...data };
        renderCurrent();
      })
      .catch(() => (weatherFor = weatherFor.replace(`${k};`, '')));
  });
}

const checkSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>';
const plusSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const chevron = dir => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${dir < 0 ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'}"/></svg>`;

/* ---------- Aujourd'hui ---------- */
export function renderTodayView() {
  const host = $('#todayView');
  const key = todayKey();
  const p = dayPlan(key);
  const w = weather[key];
  const list = agenda();
  const next = list.find(x => x.kind !== 'races') || list[0];
  const tasks = openTasks();
  const late = tasks.filter(isLate).length;
  const { garage, maison } = linkedItems();
  const gLate = garage.some(a => a.level === 'late');
  const mLate = maison.some(a => a.level === 'late');
  const done = isSessionDone(key);
  const noteFocused = document.activeElement?.id === 'vNote';
  const keepNote = noteFocused ? document.activeElement.value : null;

  host.innerHTML = `
    <div class="v-head"><div><span class="v-eyebrow v-mono">${esc(eyebrowDate())}${w ? ` · ${w.max}°` : ''}</span><h1>Aujourd’hui</h1></div>
      <button type="button" class="v-pill" data-v="brief">Revoir le briefing</button></div>
    ${
      p && !p.rest
        ? `<div class="v-today ${p.race ? 'is-race' : ''}"><div><span class="v-eyebrow">${p.race ? 'Course du jour' : 'Séance'}</span><div class="v-today__title">${esc(p.title)}</div>${p.detail ? `<span class="v-mono v-sub">${esc(p.detail)}</span>` : ''}</div>
          ${p.race ? '' : `<button type="button" class="v-ring ${done ? 'is-on' : ''}" data-v="session" data-day="${key}" aria-pressed="${done}" aria-label="${done ? 'Séance faite' : 'Marquer la séance faite'}">${checkSvg}</button>`}</div>`
        : `<button type="button" class="v-today" data-v="plan-week"><div><span class="v-eyebrow">Sport</span><div class="v-today__title">${p ? 'Jour de repos' : 'Journée libre'}</div><span class="v-sub">${p ? 'Récupère, c’est aussi de l’entraînement.' : 'Planifier une séance'}</span></div></button>`
    }
    <div class="v-tiles">
      <button type="button" class="v-tile" data-v="agenda"><span class="v-eyebrow">Prochain RDV</span><b>${next ? esc(next.title) : 'Aucun'}</b><span class="v-big">${next ? countdown(next) : '—'}</span></button>
      <button type="button" class="v-tile" data-go="todoView"><span class="v-eyebrow">À régler</span><b>${tasks.length} tâche${tasks.length > 1 ? 's' : ''}</b><span class="v-big ${late ? 'is-late' : ''}">${late ? `${late} en retard` : 'à jour'}</span></button>
    </div>
    <nav class="v-apps" aria-label="Mes autres apps">
      <a href="${ALLURE_URL}"><i class="is-on"></i>Allure</a>
      <a href="https://benjbepoix-stack.github.io/Mon-budget/"><i></i>Budget</a>
      <a href="${MAISON_URL}"><i class="${mLate ? 'is-late' : ''}"></i>Maison</a>
      <a href="${GARAGE_URL}"><i class="${gLate ? 'is-late' : ''}"></i>Garage</a>
    </nav>
    <section id="vAgenda" class="v-section">
      <div class="v-section__head"><span class="v-eyebrow">Rendez-vous et événements</span>
        <span class="v-section__tools"><button type="button" class="v-mini" data-v="add" data-type="appointments">+ RDV</button><button type="button" class="v-mini" data-v="add" data-type="events">+ Événement</button></span></div>
      ${
        list
          .slice(0, 8)
          .map(
            x => `<button type="button" class="v-line" ${x.kind === 'races' ? `data-v="allure"` : `data-v="edit" data-type="${x.kind}" data-id="${esc(x.id)}"`}>
            <span class="v-mono">${esc(shortDate(x.date, x.time))}</span><span class="v-line__t">${esc(x.title)}</span>${x.kind === 'races' ? '<span class="v-tag">Course</span>' : x.kind === 'events' ? '<span class="v-tag">Événement</span>' : ''}</button>`
          )
          .join('') || '<p class="v-empty">Aucun rendez-vous. Écris « dentiste jeudi 17h30 » dans À faire.</p>'
      }
      <div class="v-links"><button type="button" data-v="archive" data-type="appointments">Tous les RDV</button><button type="button" data-v="archive" data-type="events">Tous les événements</button></div>
    </section>
    <label class="v-note"><span class="v-eyebrow">Note</span><textarea id="vNote" placeholder="Écrire…" maxlength="20000">${esc(keepNote ?? state.notes)}</textarea></label>`;
  if (noteFocused) {
    const t = $('#vNote');
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }
  loadWeather();
}

/* ---------- À faire ---------- */
export function renderTodoView() {
  const host = $('#todoView');
  const tasks = openTasks();
  const doneToday = state.dashboard.tasks.filter(t => t.done);
  const late = tasks.filter(isLate).length;
  const draft = $('#vDraft')?.value || '';
  const hadFocus = document.activeElement?.id === 'vDraft';
  const { garage, maison, season } = linkedItems();
  const linked = [
    ...sportTasks().map(a => ({ t: a.title, src: 'Allure', href: ALLURE_URL, late: a.level === 'late' })),
    ...garage.map(a => ({ t: `${a.owner ? `${a.owner} · ` : ''}${a.title}`, src: 'Garage', href: GARAGE_URL, late: a.level === 'late', sub: a.text })),
    ...maison.map(a => ({ t: a.title, src: 'Maison', href: `${MAISON_URL}#/entretien`, late: a.level === 'late', sub: a.text })),
    ...season.map(s => ({ t: s.label, src: 'Saison', href: `${MAISON_URL}#/entretien/saison` }))
  ];
  const row = t => `<div class="v-row-wrap"><div class="v-row-under"><span>FAIT</span><span>DEMAIN</span></div>
      <div class="v-row ${isLate(t) ? 'is-late' : ''}" data-task="${esc(t.id)}" tabindex="0" role="button" aria-label="Modifier « ${esc(t.title)} »"><span class="v-row__t">${esc(t.title)}</span><span class="v-row__m">${esc(taskMeta(t))}</span></div></div>`;

  host.innerHTML = `
    <div class="v-head"><div><span class="v-eyebrow v-mono">${tasks.length} À FAIRE${late ? ` · <span class="is-late">${late} EN RETARD</span>` : ''}</span><h1>À faire</h1></div></div>
    <form class="v-add" id="vAdd" autocomplete="off" novalidate>
      <label for="vDraft" class="v-sr">Nouvelle tâche ou rendez-vous</label>
      <input id="vDraft" placeholder="dentiste jeudi 17h30…" enterkeyhint="done" maxlength="120">
      <span id="vChip"></span>
      <button type="submit" class="v-plus" aria-label="Ajouter (champ vide : formulaire complet)">${plusSvg}</button>
    </form>
    <span class="v-eyebrow v-hint">→ fait · ← demain</span>
    <div class="v-rows">${tasks.map(row).join('') || '<p class="v-empty">Rien à faire. Belle journée.</p>'}</div>
    ${
      doneToday.length
        ? `<span class="v-eyebrow v-hint">Faites</span><div class="v-rows">${doneToday
            .map(t => `<button type="button" class="v-row is-done" data-v="undo" data-id="${esc(t.id)}"><span class="v-check">${checkSvg}</span><span class="v-row__t">${esc(t.title)}</span><span class="v-row__m">${isRepeat(t.repeat) ? esc(REPEATS[t.repeat].label.toLowerCase()) : 'disparaît demain'}</span></button>`)
            .join('')}</div>`
        : ''
    }
    ${linked.length ? `<span class="v-eyebrow v-hint">Depuis tes apps</span><div class="v-chips">${linked.map(k => `<a class="v-chip-link ${k.late ? 'is-late' : ''}" href="${k.href}"${k.sub ? ` title="${esc(k.sub)}"` : ''}>${esc(k.t)}<small>${esc(k.src)}</small></a>`).join('')}</div>` : ''}`;
  const input = $('#vDraft');
  input.value = draft;
  renderChip();
  if (hadFocus) input.focus();
  bindRows(host);
}

function renderChip() {
  const input = $('#vDraft');
  const chip = $('#vChip');
  if (!input || !chip) return;
  const { date, time } = parseEntry(input.value);
  if (!input.value.trim() || !date) return (chip.innerHTML = '');
  const d = Math.round((fromKey(date) - fromKey(todayKey())) / 86400000);
  const label = d === 0 ? 'aujourd’hui' : d === 1 ? 'demain' : formatKey(date, { weekday: 'short', day: 'numeric' });
  chip.innerHTML = `<span class="v-chip">${esc(label)}${time ? ` ${time} · RDV` : ''}</span>`;
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
    toast(`Rendez-vous · ${shortDate(date, time)}`);
  } else state.dashboard.tasks.push({ id: uid(), title, date, time: '', note: '', done: false });
  input.value = '';
  const r = $('#vAdd .v-plus').getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, 10);
  buzz(10);
  commit('dashboard');
  $('#vDraft')?.focus();
}

/** Cartes glissables : à droite = faite, à gauche = demain ; un appui ouvre la fiche. */
function bindRows(host) {
  host.querySelectorAll('.v-row[data-task]').forEach(row => {
    const wrap = row.parentElement;
    let st = null;
    row.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
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
      wrap.style.setProperty('--swipe', Math.min(1, Math.abs(dx) / 110).toFixed(3));
    });
    const end = () => {
      if (!st) return;
      const { dx, lock } = st;
      st = null;
      row.style.transition = '';
      if (lock !== 'x') return openEditor('tasks', row.dataset.task);
      const t = state.dashboard.tasks.find(x => x.id === row.dataset.task);
      if (!t || Math.abs(dx) < 110) {
        row.style.transform = '';
        wrap.style.removeProperty('--swipe');
        return;
      }
      const prev = { done: t.done, doneAt: t.doneAt, date: t.date };
      const undo = () => {
        Object.assign(t, prev);
        if (!prev.doneAt) delete t.doneAt;
        commit('dashboard');
      };
      row.style.transform = `translateX(${dx > 0 ? 110 : -110}%)`;
      row.style.opacity = '0';
      if (dx > 0) {
        const r = row.getBoundingClientRect();
        burst(r.left + 40, r.top + r.height / 2, 14);
        buzz(12);
      } else buzz(8);
      setTimeout(() => {
        if (dx > 0) {
          t.done = true;
          t.doneAt = todayKey();
        } else t.date = dateKey(addDays(new Date(), 1));
        commit('dashboard');
        toast(dx > 0 ? 'Fait.' : 'Pour demain.', { action: { label: 'Annuler', onClick: undo } });
      }, 240);
    };
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', () => {
      st = null;
      row.style.transform = '';
    });
    row.addEventListener('keydown', e => e.key === 'Enter' && openEditor('tasks', row.dataset.task));
  });
}

/* ---------- Semaine ---------- */
export function renderWeekView() {
  const host = $('#weekView');
  const keys = Array.from({ length: 7 }, (_, i) => dateKey(addDays(weekStart, i)));
  const today = todayKey();
  const plans = keys.map(dayPlan);
  const done = sessionsDone();
  const tot = plans.reduce((n, p) => n + (p && !p.rest ? p.km : 0), 0);
  const doneKm = plans.reduce((n, p, i) => n + (p && !p.rest && (done[keys[i]] || (p.race && keys[i] < today)) ? p.km : 0), 0);
  const max = Math.max(10, ...plans.map(p => (p ? p.km : 0)));
  const end = addDays(weekStart, 6);
  const range = `${weekStart.getDate()}${weekStart.getMonth() !== end.getMonth() ? ` ${formatDate(weekStart, { month: 'short' }).toUpperCase()}` : ''} – ${end.getDate()} ${formatDate(end, { month: 'short' }).toUpperCase()}`;
  const isCurrent = keys.includes(today);
  const prevScroll = host.querySelector('.v-days')?.scrollLeft;
  const rdvOn = key =>
    ['appointments', 'events']
      .flatMap(kind => state.dashboard[kind].filter(x => (isRepeat(x.repeat) ? nextOccurrenceKey(x) : x.date) === key))
      .map(x => `${x.title}${x.time ? ` ${x.time}` : ''}`)
      .join(' · ');

  host.innerHTML = `
    <div class="v-head"><div><span class="v-eyebrow v-mono">${Math.round(doneKm)} / ${Math.round(tot)} KM · ${esc(range)}</span><h1>${isCurrent ? 'Ma semaine' : 'Semaine'}</h1></div>
      <div class="v-head__tools"><button type="button" class="v-round" data-v="week" data-step="-1" aria-label="Semaine précédente">${chevron(-1)}</button>${isCurrent ? '' : '<button type="button" class="v-pill" data-v="week" data-step="0">Aujourd’hui</button>'}<button type="button" class="v-round" data-v="week" data-step="1" aria-label="Semaine suivante">${chevron(1)}</button></div></div>
    <div class="v-bars">${keys
      .map((k, i) => {
        const p = plans[i];
        const h = !p ? 4 : p.rest ? 6 : Math.max(14, Math.round(((p.km || 8) / max) * 56));
        const cls = p && !p.rest && (done[k] || (p.race && k < today)) ? 'is-done' : p?.race ? 'is-race' : '';
        return `<button type="button" class="${k === today ? 'is-today' : ''}" data-v="day" data-i="${i}" aria-label="${WD_FULL[fromKey(k).getDay()]}"><i class="${cls}" style="height:${h}px"></i><small>${WD[fromKey(k).getDay()].replace('.', '')}</small></button>`;
      })
      .join('')}</div>
    <div class="v-days">${keys
      .map((k, i) => {
        const p = plans[i];
        const d = fromKey(k);
        const wx = weather[k];
        const rdv = rdvOn(k);
        const isDone = Boolean(done[k]);
        return `<article class="v-day ${k === today ? 'is-today' : ''} ${p?.race ? 'is-race' : ''}">
          <div class="v-day__head"><span>${WD_FULL[d.getDay()]} ${d.getDate()}</span><span class="v-mono v-day__temp">${wx ? `${wx.max}°` : ''}</span></div>
          <span class="v-day__sky">${wx ? `${esc(SKY(wx.label))} · ${wx.min}° / ${wx.max}°` : ''}</span>
          ${p ? `<span class="v-day__title">${esc(p.title)}</span>${p.detail ? `<span class="v-mono v-day__detail">${esc(p.detail)}</span>` : ''}` : '<span class="v-day__title is-empty">Rien de prévu</span>'}
          ${rdv ? `<span class="v-day__rdv">${esc(rdv)}</span>` : ''}
          <div class="v-day__foot">
            ${p && !p.rest && !p.race ? `<button type="button" class="v-btn ${isDone ? 'is-done' : ''}" data-v="session" data-day="${k}">${isDone ? 'Faite' : 'Marquer faite'}</button>` : ''}
            <button type="button" class="v-link" data-v="plan-day" data-day="${k}">${p ? 'Modifier' : 'Planifier une séance'}</button>
          </div>
        </article>`;
      })
      .join('')}</div>`;
  const days = host.querySelector('.v-days');
  const wk = dateKey(weekStart);
  if (scrolledWeek !== wk) {
    scrolledWeek = wk;
    const i = isCurrent ? keys.indexOf(today) : 0;
    requestAnimationFrame(() => (days.scrollLeft = i * (days.firstElementChild.offsetWidth + 12)));
  } else if (prevScroll != null) days.scrollLeft = prevScroll;
  loadWeather();
}

/* ---------- Actions ---------- */
let current = 'todayView';
function renderCurrent() {
  if (current === 'todayView') renderTodayView();
  else if (current === 'todoView') renderTodoView();
  else if (current === 'weekView') renderWeekView();
}
export function showVivant(id) {
  current = id;
  renderCurrent();
}

function onClick(e) {
  const go = e.target.closest('[data-go]');
  if (go) return goto(go.dataset.go);
  const b = e.target.closest('[data-v]');
  if (!b) return;
  const { v, type, id, day } = b.dataset;
  switch (v) {
    case 'brief':
      return $('#briefingBtn')?.click();
    case 'session': {
      const on = toggleSessionDone(day);
      if (on) {
        const r = b.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2, 18);
        buzz(12);
      }
      return renderCurrent();
    }
    case 'agenda':
      return $('#vAgenda')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      weekStart = b.dataset.step === '0' ? mondayOf(new Date()) : addDays(weekStart, Number(b.dataset.step) * 7);
      return renderWeekView();
    case 'day': {
      const days = $('#weekView .v-days');
      return days.scrollTo({ left: Number(b.dataset.i) * (days.firstElementChild.offsetWidth + 12), behavior: 'smooth' });
    }
    case 'plan-week':
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
  $('#todayView').addEventListener('input', e => {
    if (e.target.id !== 'vNote') return;
    state.notes = e.target.value.slice(0, 20000);
    commit('notes');
  });
  // Le compte à rebours du prochain rendez-vous reste juste si l'app reste ouverte.
  setInterval(() => current === 'todayView' && !document.hidden && document.activeElement?.id !== 'vNote' && renderTodayView(), 60000);
}
