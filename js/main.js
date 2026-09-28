/* Point d'entrée : initialise l'état, les vues, la navigation et la synchronisation. */
import { $, $$, debounce } from './core/utils.js';
import { state, loadLocal, subscribe, commit, applyRemote, setCloudSink, snapshot } from './core/store.js';
import { initCloud, pushCloud, flushNow } from './services/firebase.js';
import { initDialogs } from './ui/dialog.js';
import { applyTheme } from './ui/theme.js';
import { renderStatus } from './ui/status.js';
import { toastError } from './ui/toast.js';
import { icon } from './ui/icons.js';
import { initCalendarPrompt } from './features/calendar-prompt.js';
import { initDashboard, renderDashboard, renderNotes } from './views/dashboard.js';
import { initTraining, renderTraining, showTraining } from './views/training.js';
import { initRaces, renderRaces, tickCountdowns } from './views/races.js';
import { initMetrics, renderMetrics } from './views/metrics.js';

const VIEWS = {
  dashboardView: { kicker: 'Tableau de bord', title: 'Mon espace', show: renderDashboard },
  trainingView: { kicker: 'Planning sportif', title: 'Entraînement', show: showTraining, render: renderTraining, slices: ['families', 'plans'] },
  raceView: { kicker: 'Calendrier sportif', title: 'Mes courses', show: renderRaces, render: renderRaces, slices: ['races'] },
  metricsView: { kicker: 'Suivi personnel', title: 'Mesures', show: renderMetrics, render: renderMetrics, slices: ['bodyMetrics'] }
};
const VIEW_KEY = 'dashboard_last_view';
let currentView = 'dashboardView';

function switchView(id, { scroll = true } = {}) {
  if (!VIEWS[id]) id = 'dashboardView';
  currentView = id;
  $$('.view').forEach(v => (v.hidden = v.id !== id));
  $$('[data-view]').forEach(b => {
    const active = b.dataset.view === id;
    b.classList.toggle('is-active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#headerKicker').textContent = VIEWS[id].kicker;
  $('#headerTitle').textContent = VIEWS[id].title;
  document.title = `${VIEWS[id].title} · Mon Dashboard`;
  VIEWS[id].show();
  try {
    sessionStorage.setItem(VIEW_KEY, id);
  } catch {
    /* navigation privée : sans importance */
  }
  if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Re-rendu ciblé selon les tranches d'état modifiées. */
function onStateChange(slices) {
  if (slices.includes('theme')) applyTheme(state.theme, { animate: true });
  if (slices.includes('notes')) renderNotes();
  if (slices.includes('dashboard')) renderDashboard();
  const view = VIEWS[currentView];
  if (view.render && view.slices.some(s => slices.includes(s))) view.render();
}

function initGlobalErrors() {
  let last = 0;
  const report = error => {
    console.error(error);
    // Limite : un seul toast d'erreur générique toutes les 4 secondes.
    if (Date.now() - last < 4000) return;
    last = Date.now();
    toastError('Une erreur inattendue est survenue. Vos données sont conservées.');
  };
  window.addEventListener('error', e => report(e.error || e.message));
  window.addEventListener('unhandledrejection', e => report(e.reason));
}

function init() {
  initGlobalErrors();
  loadLocal();
  applyTheme(state.theme);

  // Icônes de la navigation (SVG inline)
  $$('[data-icon]').forEach(el => (el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 22)));

  initDialogs();
  initCalendarPrompt();
  initDashboard();
  initTraining();
  initRaces();
  initMetrics();

  renderNotes();
  renderDashboard();
  subscribe(onStateChange);

  $$('[data-view]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#themeToggle').addEventListener('click', () => {
    commit('theme', { theme: state.theme === 'light' ? 'dark' : 'light' });
  });

  let initial = 'dashboardView';
  try {
    initial = sessionStorage.getItem(VIEW_KEY) || initial;
  } catch {
    /* ignore */
  }
  switchView(initial, { scroll: false });

  // Comptes à rebours des courses (sans re-rendu complet)
  setInterval(() => currentView === 'raceView' && tickCountdowns(), 30000);

  // Retour au premier plan : les dates relatives ont pu changer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
    else VIEWS[currentView].show();
  });
  window.addEventListener('pagehide', flushNow);
  window.addEventListener(
    'resize',
    debounce(() => currentView === 'metricsView' && renderMetrics(), 150)
  );

  // Synchronisation cloud
  setCloudSink(pushCloud);
  initCloud({
    onRemote: (cloud, skip) => applyRemote(cloud, skip),
    onStatus: renderStatus,
    onError: message => toastError(`Synchronisation : ${message}`),
    getSnapshot: snapshot
  });

  document.documentElement.classList.add('is-ready');
}

init();
