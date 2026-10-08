/*
 * Store central : état en mémoire + persistance locale + diffusion des
 * changements. La synchronisation cloud est branchée via `setCloudSink`.
 * Les clés localStorage sont conservées à l'identique pour ne perdre
 * aucune donnée des versions précédentes.
 */
import { readJSON, readText, write } from '../services/storage.js';
import { sameJSON } from './utils.js';
import {
  normalizeDashboard,
  normalizeFamilies,
  normalizePlans,
  normalizeObjectives,
  normalizeRaces,
  normalizeBodyMetrics,
  normalizeTheme,
  normalizeNotes,
  prunePlans
} from './schema.js';

const LOCAL_KEYS = {
  dashboard: 'dashboard_clean_v1',
  notes: 'dashboard_notes',
  theme: 'dashboard_theme',
  families: 'sport_families',
  plans: 'sport_plans',
  objectives: 'sport_objectives',
  races: 'sport_races',
  bodyMetrics: 'sport_body_metrics'
};
export const SLICES = Object.keys(LOCAL_KEYS);

export const state = {};
const listeners = new Set();
let cloudSink = null;

function normalizeSlice(slice, value) {
  switch (slice) {
    case 'dashboard': return normalizeDashboard(value);
    case 'notes': return normalizeNotes(value);
    case 'theme': return normalizeTheme(value);
    case 'families': return normalizeFamilies(value);
    case 'plans': return normalizePlans(value, state.families || normalizeFamilies(null));
    case 'objectives': return normalizeObjectives(value);
    case 'races': return normalizeRaces(value);
    case 'bodyMetrics': return normalizeBodyMetrics(value);
    default: return value;
  }
}

/** Valeur enregistrée d'une tranche (planning : jours vides retirés). */
const stored = slice => (slice === 'plans' ? prunePlans(state.plans) : state[slice]);

function persist(slice) {
  const value = stored(slice);
  write(LOCAL_KEYS[slice], typeof value === 'string' ? value : JSON.stringify(value));
}

function notify(slices, source) {
  listeners.forEach(fn => {
    try {
      fn(slices, source);
    } catch (error) {
      console.error('[store] erreur dans un abonné', error);
    }
  });
}

/** Charge l'état depuis le localStorage (ordre important : families avant plans). */
export function loadLocal() {
  state.dashboard = normalizeDashboard(readJSON(LOCAL_KEYS.dashboard, null));
  state.notes = normalizeNotes(readText(LOCAL_KEYS.notes, ''));
  state.theme = normalizeTheme(readText(LOCAL_KEYS.theme, 'dark'));
  state.families = normalizeFamilies(readJSON(LOCAL_KEYS.families, null));
  state.plans = normalizePlans(readJSON(LOCAL_KEYS.plans, {}), state.families);
  state.objectives = normalizeObjectives(readJSON(LOCAL_KEYS.objectives, {}));
  state.races = normalizeRaces(readJSON(LOCAL_KEYS.races, []));
  state.bodyMetrics = normalizeBodyMetrics(readJSON(LOCAL_KEYS.bodyMetrics, null));
  SLICES.forEach(persist);
}

export const subscribe = fn => (listeners.add(fn), () => listeners.delete(fn));
export const setCloudSink = fn => (cloudSink = fn);

/**
 * Valide une modification locale d'une ou plusieurs tranches d'état
 * (déjà mutées en place ou fournies dans `patch`).
 */
export function commit(slices, patch = {}) {
  const list = Array.isArray(slices) ? slices : [slices];
  const payload = {};
  list.forEach(slice => {
    if (slice in patch) state[slice] = patch[slice];
    persist(slice);
    payload[slice] = stored(slice);
  });
  cloudSink?.(payload);
  notify(list, 'local');
}

/** Applique des données distantes ; ignore les tranches inchangées (écho de nos propres écritures). */
export function applyRemote(cloud, skip = new Set()) {
  if (!cloud || typeof cloud !== 'object') return [];
  const changed = [];
  // families d'abord : la normalisation des plans en dépend.
  const order = ['families', ...SLICES.filter(s => s !== 'families')];
  for (const slice of order) {
    if (skip.has(slice)) continue;
    // Firebase supprime les nœuds vides : une tranche absente d'une base
    // initialisée signifie « vidée ailleurs » (sauf le thème).
    if (!(slice in cloud) && slice === 'theme') continue;
    const next = normalizeSlice(slice, slice in cloud ? cloud[slice] : null);
    if (sameJSON(next, stored(slice))) continue;
    state[slice] = next;
    persist(slice);
    changed.push(slice);
  }
  if (changed.includes('families') && !changed.includes('plans')) {
    state.plans = normalizePlans(state.plans, state.families);
    persist('plans');
  }
  if (changed.length) notify(changed, 'remote');
  return changed;
}

export const snapshot = () => Object.fromEntries(SLICES.map(s => [s, stored(s)]));
