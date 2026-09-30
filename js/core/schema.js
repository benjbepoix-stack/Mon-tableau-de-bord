/*
 * Schéma des données et normalisation.
 * Toute donnée lue (localStorage ou Firebase) passe par ici : on ne fait
 * jamais confiance à sa forme (Firebase supprime les tableaux vides et peut
 * transformer un tableau en objet indexé).
 */
import { uid } from './utils.js';
import { isDateKey, isTime, isRepeat } from './dates.js';

export const REST_TRAINING = 'Journée off - repos';
const LEGACY_REST = 'Repos';
export const isRestTraining = v => v === REST_TRAINING || v === LEGACY_REST;

export const DEFAULT_FAMILIES = [
  { id: 'course-pied', name: 'Course à pied', types: [REST_TRAINING, 'Footing facile', 'Sortie longue', 'Fractionné', 'Seuil / tempo', 'Récupération'] },
  { id: 'trail', name: 'Trail', types: ['Endurance trail', 'Sortie longue vallonnée', 'Dénivelé', 'Technique descente', 'Fractionné côte'] },
  { id: 'cyclisme', name: 'Cyclisme', types: ['Endurance', 'Sortie longue', 'Tempo / Sweet Spot', 'Seuil', 'VO₂max', 'Force'] },
  { id: 'ski-fond', name: 'Ski de fond', types: ['Endurance', 'Technique', 'Intensité', 'Sortie longue'] },
  { id: 'ski-roue', name: 'Ski-roue', types: ['Endurance', 'Technique', 'Intensité', 'Force'] },
  { id: 'musculation', name: 'Musculation', types: ['Force', 'Renforcement', 'Mobilité'] },
  { id: 'escalade', name: 'Escalade', types: ['Bloc', 'Voie', 'Technique'] },
  { id: 'vtt', name: 'VTT', types: ['Endurance', 'Technique', 'Sortie longue'] },
  { id: 'gravel', name: 'Gravel', types: ['Endurance', 'Sortie longue', 'Tempo'] }
];

export const RACE_SPORTS = ['Cyclisme', 'Trail', 'Course à pied', 'Ski de fond', 'Ski-roue', 'VTT', 'Gravel', 'Escalade', 'Autre'];

export const asArray = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const str = (v, max = 2000) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)).slice(0, max);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const posNum = v => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/* ---------- Dashboard ---------- */
function normalizeItem(raw, withDone) {
  if (!isObj(raw)) return null;
  const title = str(raw.title, 100).trim();
  if (!title) return null;
  const item = {
    id: str(raw.id) || uid(),
    title,
    date: isDateKey(raw.date) ? raw.date : '',
    time: isTime(raw.time) ? raw.time : '',
    note: str(raw.note, 500)
  };
  if (isTime(raw.endTime)) item.endTime = raw.endTime;
  if (raw.location) item.location = str(raw.location, 120);
  if (!withDone && isRepeat(raw.repeat)) item.repeat = raw.repeat;
  if (withDone) item.done = Boolean(raw.done);
  return item;
}

export function normalizeDashboard(raw) {
  const d = isObj(raw) ? raw : {};
  return {
    tasks: asArray(d.tasks).map(x => normalizeItem(x, true)).filter(Boolean),
    appointments: asArray(d.appointments).map(x => normalizeItem(x, false)).filter(Boolean),
    events: asArray(d.events).map(x => normalizeItem(x, false)).filter(Boolean)
  };
}

/* ---------- Sport ---------- */
export function normalizeFamilies(raw) {
  const list = asArray(raw)
    .filter(isObj)
    .map(f => ({
      id: str(f.id) || uid(),
      name: str(f.name, 60).trim(),
      types: [...new Set(asArray(f.types).map(t => str(t, 80).trim()).filter(Boolean))]
    }))
    .filter(f => f.name);
  return list.length ? list : DEFAULT_FAMILIES.map(f => ({ ...f, types: [...f.types] }));
}

export const defaultSession = () => ({ id: uid(), family: '', training: '', distance: '', time: '', elevation: '' });

function familyForLegacyTraining(training, families) {
  const exact = families.find(f => f.types.includes(training));
  if (exact) return exact.id;
  const low = training.toLowerCase();
  return families.find(f => low.includes(f.name.toLowerCase().split(' ')[0]))?.id || '';
}

function normalizeSession(v, families) {
  if (!v) return defaultSession();
  if (typeof v === 'string') {
    const training = isRestTraining(v) ? REST_TRAINING : v;
    return { ...defaultSession(), family: familyForLegacyTraining(v, families), training };
  }
  if (!isObj(v)) return defaultSession();
  const family = families.find(f => f.id === v.family);
  if (!family) return { ...defaultSession(), id: str(v.id) || uid() };
  const raw = isRestTraining(v.training) ? REST_TRAINING : str(v.training);
  const training = raw && (family.types.includes(raw) || isRestTraining(raw)) ? raw : '';
  return {
    id: str(v.id) || uid(),
    family: family.id,
    training,
    distance: str(v.distance, 12),
    time: str(v.time, 8),
    elevation: str(v.elevation, 12)
  };
}

export function normalizeDay(v, families) {
  if (Array.isArray(v) || (isObj(v) && !('training' in v) && !('family' in v))) {
    const list = asArray(v).map(s => normalizeSession(s, families));
    return list.length ? list : [defaultSession()];
  }
  if (isObj(v) || typeof v === 'string') return [normalizeSession(v, families)];
  return [defaultSession()];
}

export function normalizePlans(raw, families) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (isDateKey(key)) out[key] = normalizeDay(value, families);
  }
  return out;
}

export const normalizeObjectives = raw => (isObj(raw) ? raw : {});

/* ---------- Courses ---------- */
export function normalizeRaces(raw) {
  return asArray(raw)
    .filter(isObj)
    .map(r => ({
      ...r,
      id: str(r.id) || uid(),
      name: str(r.name, 100).trim(),
      sport: str(r.sport, 40) || 'Autre',
      date: isDateKey(r.date) ? r.date : '',
      time: isTime(r.time) ? r.time : '',
      location: str(r.location, 100),
      distance: str(r.distance, 12),
      elevation: str(r.elevation, 12),
      price: str(r.price, 12),
      target: str(r.target, 40),
      notes: str(r.notes, 2000),
      resultTime: str(r.resultTime, 40),
      resultRank: str(r.resultRank, 40),
      resultDistance: str(r.resultDistance, 40)
    }))
    .filter(r => r.name && r.date);
}

/* ---------- Mesures ---------- */
export const MEASURE_FIELDS = [
  ['thigh', 'Cuisse'],
  ['calf', 'Mollet'],
  ['waist', 'Taille'],
  ['hip', 'Hanche'],
  ['chest', 'Poitrine'],
  ['arm', 'Bras']
];

const byDate = (a, b) => a.date.localeCompare(b.date);

export function normalizeBodyMetrics(raw) {
  const m = isObj(raw) ? raw : {};
  const simple = list =>
    asArray(list)
      .filter(isObj)
      .map(r => ({ id: str(r.id) || uid(), date: r.date, value: posNum(r.value) }))
      .filter(r => isDateKey(r.date) && r.value !== null)
      .sort(byDate);
  const measurements = asArray(m.measurements)
    .filter(isObj)
    .map(r => {
      const row = { id: str(r.id) || uid(), date: r.date };
      MEASURE_FIELDS.forEach(([k]) => (row[k] = posNum(r[k])));
      return row;
    })
    .filter(r => isDateKey(r.date) && MEASURE_FIELDS.some(([k]) => r[k] !== null))
    .sort(byDate);
  return { weight: simple(m.weight), ftp: simple(m.ftp), measurements };
}

export const normalizeTheme = v => (v === 'light' ? 'light' : 'dark');
export const normalizeNotes = v => str(v, 20000);
