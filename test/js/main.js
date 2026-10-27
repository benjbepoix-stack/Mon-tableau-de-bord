/* Point d'entrée : initialise l'état, les vues, la navigation, le compte et la synchronisation. */
import { $, $$ } from './core/utils.js';
import { state, loadLocal, subscribe, applyRemote, setCloudSink, snapshot, resetLocal, SLICES } from './core/store.js';
import { initCloud, pushCloud, flushNow, clearPending, isStarting } from './services/firebase.js';
import { readText, write } from './services/storage.js';
import { initDialogs, isOpen } from './ui/dialog.js';
import { applyTheme } from './ui/theme.js';
import { renderStatus } from './ui/status.js';
import { toastError } from './ui/toast.js';
import { icon } from './ui/icons.js';
import { initCalendarPrompt } from './features/calendar-prompt.js';
import { setLinked, linkedLocal, onLinkedChange, linkedReady } from './features/linked-apps.js';
import { initAuth, openAuth, closeAuth, noAccountChosen, forgetNoAccount } from './features/auth.js';
import { initSettings, renderAccount } from './features/settings.js';
import { tidyTasks } from './features/task-tidy.js';
import { initOverduePrompt, checkOverdue } from './features/overdue-prompt.js';
import { initDashboard, renderDashboard, renderNotes } from './views/dashboard.js';
import { initTraining } from './views/training.js';
import { initBriefing, maybeShowBriefing, isBriefingOpen } from './features/briefing.js';
import { initVivant, showVivant } from './views/vivant.js';

// Les quatre espaces (vivant.js) se redessinent à chaque changement. Sport contient le planning
// détaillé et se place lui-même sur le jour en cours (pas de retour en haut de page).
const ALL = ['dashboard', 'notes', 'races', 'plans', 'families', 'objectives'];
const vivant = id => ({ show: () => showVivant(id), render: () => showVivant(id), slices: ALL });
const VIEWS = {
  todayView: { title: 'Accueil', ...vivant('todayView') },
  agendaView: { title: 'Agenda', ...vivant('agendaView') },
  todoView: { title: 'Tâches', ...vivant('todoView') },
  weekView: { title: 'Sport', ...vivant('weekView'), keepScroll: true }
};
/** Anciens noms d'écran (onglet mémorisé, liens data-goto). */
const LEGACY = { dashboardView: 'todayView', tasksView: 'todoView', trainingView: 'weekView' };
const VIEW_KEY = 'dashboard_last_view';
/** Dernier compte connecté sur cet appareil (un autre compte vide d'abord les données locales). */
const LAST_UID = 'dashboard_last_uid';
let currentView = 'todayView';
/** Données du cloud reçues (ou mode local) : le ménage des tâches cochées peut se faire sans risque. */
let settled = false;

function settle() {
  if (settled) return;
  settled = true;
  tidyTasks();
  // Briefing du matin (première ouverture du jour), sinon pop-up « en retard » : sur des données
  // à jour, une fois les résumés Garage / Maison lus — sans les attendre plus de 2,5 s.
  Promise.race([linkedReady, new Promise(r => setTimeout(r, 2500))]).then(() => maybeShowBriefing() || checkOverdue());
}

function switchView(id, { scroll = true } = {}) {
  id = LEGACY[id] || id;
  if (!VIEWS[id]) id = 'todayView';
  currentView = id;
  document.body.dataset.screen = id;
  $$('.view').forEach(v => (v.hidden = v.id !== id));
  $$('[data-view]').forEach(b => {
    const active = b.dataset.view === (VIEWS[id].tab || id);
    b.classList.toggle('is-active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#headerTitle').textContent = VIEWS[id].title;
  document.title = `${VIEWS[id].title} · Carnet`;
  VIEWS[id].show();
  try {
    sessionStorage.setItem(VIEW_KEY, id);
  } catch {
    /* navigation privée : sans importance */
  }
  if (scroll && !VIEWS[id].keepScroll) window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Re-rendu ciblé selon les tranches d'état modifiées. */
function onStateChange(slices, source) {
  if (slices.includes('theme')) applyTheme(state.theme, { animate: true });
  if (slices.includes('notes')) renderNotes();
  if (slices.includes('dashboard')) renderDashboard();
  // Note tapée dans l'app : rien à redessiner (le champ garde le curseur où il est).
  if (source === 'local' && slices.length === 1 && slices[0] === 'notes') return;
  const view = VIEWS[currentView];
  if (view.render && view.slices.some(s => slices.includes(s))) view.render();
}

/** Sans compte ou sans Firebase : les données de l'appareil font foi. */
function goLocal() {
  linkedLocal();
  renderAccount();
  settle();
}

/** Réponse de Firebase sur le compte : au lancement, puis à chaque connexion / déconnexion. */
function onUser(user) {
  if (user) {
    // Autre compte que le précédent sur cet appareil : on repart de données vides avant la synchro.
    const last = readText(LAST_UID, '');
    if (last && last !== user.uid) {
      clearPending();
      resetLocal();
    }
    write(LAST_UID, user.uid);
    forgetNoAccount();
    closeAuth();
  } else {
    setLinked(null); // échéances de l'éventuel compte précédent retirées
    // Feuille de connexion par-dessus l'app déjà affichée, sauf si « Continuer sans compte » a été choisi.
    if (noAccountChosen()) goLocal();
    else openAuth();
  }
  renderAccount();
}

/** Depuis le pop-up de démarrage : ouvre le tableau de bord et met la tâche en évidence. */
function goToTask(id) {
  switchView('todoView');
  setTimeout(() => {
    const row = document.querySelector(`#todoView [data-task="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 80);
}

/** L'ancien choix de fond (paysage ou photo de l'appareil) n'existe plus : on libère la place qu'il prenait. */
function forgetBackdrop() {
  try {
    if (localStorage.getItem('carnet_backdrop') === null) return;
    localStorage.removeItem('carnet_backdrop');
    indexedDB.deleteDatabase('carnet_backdrop');
  } catch {
    /* stockage indisponible : rien à libérer */
  }
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
  // En-tête transparent sur le paysage de l'accueil, opaque dès qu'on fait défiler.
  const onScroll = () => document.body.classList.toggle('is-scrolled', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  initDialogs();
  initCalendarPrompt();
  initDashboard();
  initTraining();
  initOverduePrompt({ onView: goToTask });
  initVivant({ go: id => switchView(id) });
  initBriefing({ onDone: () => VIEWS[currentView].show() });

  renderNotes();
  renderDashboard();
  subscribe(onStateChange);

  $$('[data-view]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  document.addEventListener('click', e => {
    const go = e.target.closest('[data-goto]');
    if (go) switchView(go.dataset.goto);
  });
  initSettings();
  forgetBackdrop();
  initAuth({ onLocal: goLocal });

  let initial = 'todayView';
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
    if (settled) maybeShowBriefing(); // app laissée ouverte depuis la veille
  });
  window.addEventListener('pagehide', flushNow);

  // Compte et synchronisation cloud (users/<uid>/carnet) : l'app est déjà affichée avec les données de l'appareil.
  setCloudSink(pushCloud);
  initCloud({
    slices: SLICES,
    onUser,
    onRemote: (cloud, skip) => {
      applyRemote(cloud, skip);
      if (settled) tidyTasks();
    },
    // Échéances de Garage / Maison : dans chaque instantané du même nœud.
    onLinked: setLinked,
    // Premier instantané appliqué (après l'éventuel transfert depuis l'ancienne base).
    onReady: settle,
    onStatus: renderStatus,
    onError: message => toastError(`Synchronisation : ${message}`),
    getSnapshot: snapshot,
    // Ancienne base : le thème sombre (ancien défaut) devient Auto.
    adaptLegacy: data => (data.theme === 'dark' ? { ...data, theme: 'auto' } : data)
  }).then(ok => !ok && goLocal());
  // Hors ligne au lancement (cloud jamais reçu) : le pop-up s'appuie sur les données de l'appareil.
  // Pas tant que la feuille de connexion est ouverte, ni pendant le premier chargement du compte
  // (transfert depuis l'ancienne base compris, 8 s max) : settle() s'en chargera.
  const overdueFallback = () => {
    if (settled || isOpen('authSheet') || isBriefingOpen()) return;
    if (isStarting()) return setTimeout(overdueFallback, 1000);
    maybeShowBriefing() || checkOverdue();
  };
  setTimeout(overdueFallback, 6000);
  onLinkedChange(() => {
    renderDashboard();
    VIEWS[currentView].render();
  });

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
