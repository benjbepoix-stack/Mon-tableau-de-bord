/* Point d'entrée : initialise l'état, les vues, la navigation et la synchronisation. */
import { $, $$ } from './core/utils.js';
import { state, loadLocal, subscribe, commit, applyRemote, setCloudSink, snapshot } from './core/store.js';
import { initCloud, pushCloud, flushNow } from './services/firebase.js';
import { initDialogs } from './ui/dialog.js';
import { applyTheme } from './ui/theme.js';
import { renderStatus } from './ui/status.js';
import { toastError } from './ui/toast.js';
import { icon } from './ui/icons.js';
import { initCalendarPrompt } from './features/calendar-prompt.js';
import { initLinkedApps, onLinkedChange } from './features/linked-apps.js';
import { tidyTasks } from './features/task-tidy.js';
import { initOverduePrompt, checkOverdue } from './features/overdue-prompt.js';
import { initDashboard, renderDashboard, renderNotes } from './views/dashboard.js';
import { initTraining, renderTraining, showTraining } from './views/training.js';
import { renderSportTasks } from './features/sport-tasks.js';

const showTasks = () => {
  renderDashboard();
  renderSportTasks();
};
const VIEWS = {
  dashboardView: { kicker: 'Carnet', title: 'Accueil', show: renderDashboard, render: renderDashboard, slices: ['races', 'plans', 'families', 'objectives'] },
  tasksView: { kicker: 'Carnet', title: 'Tâches', show: showTasks, render: renderSportTasks, slices: ['races'] },
  trainingView: { kicker: 'Carnet', title: 'Planning', show: showTraining, render: renderTraining, slices: ['families', 'plans', 'objectives', 'races'] }
};
const VIEW_KEY = 'dashboard_last_view';
let currentView = 'dashboardView';
/** Données du cloud reçues (ou mode local) : le ménage des tâches cochées peut se faire sans risque. */
let settled = false;

function settle() {
  settled = true;
  tidyTasks();
}

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
  document.title = `${VIEWS[id].title} · Carnet`;
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

/** Depuis le pop-up de démarrage : ouvre le tableau de bord et met la tâche en évidence. */
function goToTask(id) {
  switchView('tasksView');
  setTimeout(() => {
    const row = document.querySelector(`#tasks [data-id="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 80);
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
  initOverduePrompt({ onView: goToTask });

  renderNotes();
  renderDashboard();
  subscribe(onStateChange);

  $$('[data-view]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  document.addEventListener('click', e => {
    const go = e.target.closest('[data-goto]');
    if (go) switchView(go.dataset.goto);
  });
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


  // Retour au premier plan : les dates relatives ont pu changer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') return flushNow();
    if (settled) tidyTasks(); // nouveau jour : tâches cochées la veille retirées ou reprogrammées
    VIEWS[currentView].show();
  });
  window.addEventListener('pagehide', flushNow);

  // Synchronisation cloud
  setCloudSink(pushCloud);
  initCloud({
    onRemote: (cloud, skip) => {
      applyRemote(cloud, skip);
      if (settled) tidyTasks();
    },
    onStatus: (status, detail) => {
      renderStatus(status, detail);
      if (!settled && (status === 'online' || status === 'local')) settle();
    },
    onError: message => toastError(`Synchronisation : ${message}`),
    getSnapshot: snapshot
  });
  // Pop-up de démarrage (tâches + entretiens en retard) : on laisse une
  // chance au résumé Garage d'arriver, sans bloquer indéfiniment si l'app
  // Garage est hors ligne ou n'a encore rien publié.
  initLinkedApps({ onGarage: checkOverdue });
  onLinkedChange(() => currentView === 'dashboardView' && renderDashboard());
  setTimeout(() => checkOverdue(null), 2500);

  document.documentElement.classList.add('is-ready');

  // Mises à jour : voir sw.js. Un nouveau service worker recharge la page une fois.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(error => console.warn('[sw] enregistrement impossible', error));
  }
}

init();
