/*
 * Saison : phases d'entraînement planifiées et courses, jour par jour.
 *
 * Les phases sont stockées dans `state.objectives.seasonPhases` : le nœud
 * `objectives` accepte déjà du contenu libre dans les règles Firebase, ce qui
 * évite d'avoir à republier les règles (une clé inconnue serait refusée et
 * couperait la synchronisation).
 */
import { state } from './store.js';
import { asArray } from './schema.js';
import { combine, isDateKey } from './dates.js';
import { uid } from './utils.js';

export const PHASES_KEY = 'seasonPhases';

/**
 * Types de phase : nom et orientation des séances (couleur : classe CSS .phase--<type>).
 * `group: 'spec'` regroupe les variantes de préparation spécifique dans le formulaire.
 * Le type historique `build` est conservé pour les phases déjà enregistrées.
 */
export const PHASE_TYPES = {
  base: {
    name: 'Préparation générale (foncier)',
    short: 'Foncier',
    advice: 'Volume en endurance fondamentale, sorties longues faciles, renforcement et technique. Peu d’intensité.'
  },
  buildVolume: {
    name: 'Spécifique volume',
    short: 'Spé volume',
    group: 'spec',
    advice: 'Augmenter progressivement la charge : sorties longues spécifiques (dénivelé, terrain, durée proche de la course), enchaînements sur deux jours. Intensité modérée (tempo, seuil long).'
  },
  buildIntensity: {
    name: 'Spécifique intensité',
    short: 'Spé intensité',
    group: 'spec',
    advice: 'Volume stable ou en léger retrait, qualité en hausse : fractionné VO₂max, seuil, côtes, 2 séances dures par semaine maximum, bien encadrées de récupération.'
  },
  buildRace: {
    name: 'Spécifique allure course',
    short: 'Spé course',
    group: 'spec',
    advice: 'Répétitions et simulations à l’allure cible, test du matériel et de la nutrition, sortie « répétition générale » 2 à 3 semaines avant la course.'
  },
  build: {
    name: 'Spécifique (mixte)',
    short: 'Spécifique',
    group: 'spec',
    advice: 'Séances au rythme de la course : seuil, fractionné, sorties longues spécifiques (dénivelé, allure cible), en alternant semaines de charge et d’assimilation.'
  },
  taper: {
    name: 'Affûtage',
    short: 'Affûtage',
    advice: 'Volume réduit de 30 à 50 %, quelques rappels d’intensité courts. Priorité à la fraîcheur et au sommeil.'
  },
  recovery: {
    name: 'Récupération',
    short: 'Récup',
    advice: 'Après la course : séances courtes et faciles, récupération active, mobilité. Aucune intensité.'
  },
  transition: {
    name: 'Transition',
    short: 'Coupure',
    advice: 'Coupure entre deux saisons : activités libres et plaisir, sans objectif chiffré.'
  }
};
export const isPhaseType = v => Object.hasOwn(PHASE_TYPES, v);

/** Phases normalisées (valeurs invalides ignorées), triées par date de début. */
export function normalizePhases(raw) {
  return asArray(raw)
    .filter(p => p && typeof p === 'object')
    .map(p => ({
      id: typeof p.id === 'string' && p.id ? p.id : uid(),
      type: p.type,
      start: p.start,
      end: p.end,
      note: typeof p.note === 'string' ? p.note.slice(0, 200) : ''
    }))
    .filter(p => isPhaseType(p.type) && isDateKey(p.start) && isDateKey(p.end) && p.end >= p.start)
    .sort((a, b) => a.start.localeCompare(b.start));
}

export const getPhases = () => normalizePhases(state.objectives?.[PHASES_KEY]);

/** Phase couvrant le jour `key` (AAAA-MM-JJ), sinon null. */
export const phaseOn = (key, phases = getPhases()) => phases.find(p => p.start <= key && key <= p.end) || null;

/** Courses d'un jour donné, triées par heure. */
export const racesOn = key =>
  state.races.filter(r => r.date === key).sort((a, b) => (combine(a.date, a.time, '00:00') ?? 0) - (combine(b.date, b.time, '00:00') ?? 0));

/** Phase qui chevauche l'intervalle [start, end] (hors `ignoreId`). */
export const overlapping = (start, end, ignoreId, phases = getPhases()) => phases.find(p => p.id !== ignoreId && p.start <= end && start <= p.end) || null;
