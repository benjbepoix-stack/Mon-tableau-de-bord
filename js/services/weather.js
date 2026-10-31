/* Prévisions météo Open-Meteo (gratuit, sans clé) avec cache mémoire. */
import { addDays, dateKey } from '../core/dates.js';
import { readJSON, write } from './storage.js';

const DEFAULT_PLACE = { name: 'Besançon', lat: 47.2378, lon: 6.0241 };
const PLACE_KEY = 'weather_place';

/** Lieu météo courant (par défaut Besançon, modifiable par l'utilisateur). */
export function getPlace() {
  const saved = readJSON(PLACE_KEY, null);
  return saved && typeof saved.lat === 'number' && typeof saved.lon === 'number' ? saved : DEFAULT_PLACE;
}

/** Change le lieu météo et vide le cache (les prévisions précédentes ne sont plus valables). */
export function setPlace(place) {
  write(PLACE_KEY, place);
  cache.clear();
  slotCache.clear();
}

export const isDefaultPlace = () => !readJSON(PLACE_KEY, null);

/**
 * Cherche des villes par nom via l'API de géocodage Open-Meteo (gratuite, sans clé).
 * @returns {Promise<Array<{name, admin1, country, lat, lon}>>}
 */
export async function searchPlaces(query) {
  const q = query.trim();
  if (q.length < 2) return [];
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', q);
  url.searchParams.set('count', '6');
  url.searchParams.set('language', 'fr');
  url.searchParams.set('format', 'json');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  return (json.results || []).map(r => ({
    name: r.name,
    admin1: r.admin1 || '',
    country: r.country || '',
    lat: r.latitude,
    lon: r.longitude
  }));
}

const WMO = {
  0: ['☀️', 'Ciel dégagé'], 1: ['🌤️', 'Principalement dégagé'], 2: ['⛅', 'Partiellement nuageux'], 3: ['☁️', 'Couvert'],
  45: ['🌫️', 'Brouillard'], 48: ['🌫️', 'Brouillard givrant'], 51: ['🌦️', 'Bruine légère'], 53: ['🌦️', 'Bruine'],
  55: ['🌧️', 'Bruine forte'], 56: ['🌧️', 'Bruine verglaçante'], 57: ['🌧️', 'Bruine verglaçante'], 61: ['🌦️', 'Pluie légère'],
  63: ['🌧️', 'Pluie'], 65: ['🌧️', 'Forte pluie'], 66: ['🌧️', 'Pluie verglaçante'], 67: ['🌧️', 'Forte pluie verglaçante'],
  71: ['🌨️', 'Neige légère'], 73: ['🌨️', 'Neige'], 75: ['❄️', 'Forte neige'], 77: ['❄️', 'Grains de neige'],
  80: ['🌦️', 'Averses'], 81: ['🌧️', 'Averses fortes'], 82: ['⛈️', 'Fortes averses'], 85: ['🌨️', 'Averses de neige'],
  86: ['🌨️', 'Fortes averses de neige'], 95: ['⛈️', 'Orage'], 96: ['⛈️', 'Orage avec grêle'], 99: ['⛈️', 'Orage avec forte grêle']
};

// Fenêtre couverte par l'API « forecast » : passé récent + 16 jours.
const PAST_DAYS = 60;
const FUTURE_DAYS = 15;
const CACHE_TTL = 30 * 60 * 1000;
const cache = new Map();

/**
 * Récupère la météo quotidienne d'une semaine.
 * @returns {Promise<Record<string, {icon,label,min,max,wind}>>} indexé par date ISO
 */
export async function fetchWeek(weekStart, { force = false } = {}) {
  const today = new Date();
  const min = addDays(today, -PAST_DAYS);
  const max = addDays(today, FUTURE_DAYS);
  const start = weekStart < min ? min : weekStart;
  const endWanted = addDays(weekStart, 6);
  const end = endWanted > max ? max : endWanted;
  if (start > end) return {}; // semaine entièrement hors fenêtre : pas d'appel réseau

  const place = getPlace();
  const key = `${place.lat},${place.lon}_${dateKey(start)}_${dateKey(end)}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  Object.entries({
    latitude: place.lat,
    longitude: place.lon,
    daily: 'weather_code,temperature_2m_min,temperature_2m_max,wind_speed_10m_max',
    timezone: 'Europe/Paris',
    wind_speed_unit: 'kmh',
    start_date: dateKey(start),
    end_date: dateKey(end)
  }).forEach(([k, v]) => url.searchParams.set(k, v));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (json.error || !json.daily?.time) throw new Error(json.reason || 'Réponse météo invalide');
    const d = json.daily;
    const data = {};
    d.time.forEach((day, i) => {
      const [icon, label] = WMO[d.weather_code[i]] || ['🌡️', 'Conditions météo'];
      data[day] = {
        icon,
        label,
        min: Math.round(d.temperature_2m_min[i]),
        max: Math.round(d.temperature_2m_max[i]),
        wind: Math.round(d.wind_speed_10m_max[i])
      };
    });
    cache.set(key, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Prévision par créneau (planifier les séances) ---------- */
/** Heures couvertes par chaque créneau de la journée. */
export const SLOT_HOURS = { matin: [7, 8, 9, 10, 11], aprem: [12, 13, 14, 15, 16, 17], soir: [18, 19, 20, 21] };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const slotCache = new Map();
let lastAt = null;
/** Heure du dernier chargement réussi des prévisions par créneau (null si aucun). */
export const wxAt = () => lastAt;

/** Famille d'icône d'un code WMO. */
const skyOf = code => (code >= 95 ? 'storm' : code >= 71 && code <= 77 ? 'snow' : code === 85 || code === 86 ? 'snow' : code >= 51 ? 'rain' : code >= 45 ? 'fog' : code === 3 ? 'cloud' : code === 2 ? 'part' : 'sun');

/**
 * Météo heure par heure regroupée en matin / après-midi / soir, du jour `fromKey` sur `days` jours
 * (dans la fenêtre de prévision : aujourd'hui + 15 jours).
 * @returns {Promise<Record<string, {min,max,sky,label,sunrise,sunset,slots:Record<string,{t,rain,mm,wind,gust,dir,deg,sky,label}>}>>}
 */
export async function fetchSlots(fromKey, days = 7, { force = false } = {}) {
  const today = new Date();
  const first = new Date(`${fromKey}T12:00:00`);
  const start = first < today ? today : first;
  const max = addDays(today, FUTURE_DAYS);
  const endWanted = addDays(first, days - 1);
  const end = endWanted > max ? max : endWanted;
  if (start > end) return {};

  const place = getPlace();
  const key = `${place.lat},${place.lon}_${dateKey(start)}_${dateKey(end)}`;
  const hit = slotCache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  Object.entries({
    latitude: place.lat,
    longitude: place.lon,
    hourly: 'temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code',
    daily: 'weather_code,temperature_2m_min,temperature_2m_max,sunrise,sunset',
    timezone: 'Europe/Paris',
    wind_speed_unit: 'kmh',
    start_date: dateKey(start),
    end_date: dateKey(end)
  }).forEach(([k, v]) => url.searchParams.set(k, v));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (json.error || !json.hourly?.time || !json.daily?.time) throw new Error(json.reason || 'Réponse météo invalide');
    const h = json.hourly;
    const byHour = {};
    h.time.forEach((t, i) => (byHour[t] = i));
    const data = {};
    json.daily.time.forEach((day, di) => {
      const slots = {};
      for (const [slot, hours] of Object.entries(SLOT_HOURS)) {
        const idx = hours.map(x => byHour[`${day}T${String(x).padStart(2, '0')}:00`]).filter(i => i !== undefined);
        if (!idx.length) continue;
        const pick = name => idx.map(i => h[name][i]).filter(v => v !== null && v !== undefined);
        const temps = pick('temperature_2m');
        const winds = pick('wind_speed_10m');
        const strongest = idx.reduce((a, b) => ((h.wind_speed_10m[b] ?? 0) > (h.wind_speed_10m[a] ?? 0) ? b : a));
        const code = Math.max(...pick('weather_code'), 0);
        const deg = h.wind_direction_10m[strongest] ?? 0;
        slots[slot] = {
          t: Math.round(temps.reduce((a, b) => a + b, 0) / (temps.length || 1)),
          rain: Math.max(0, ...pick('precipitation_probability')),
          mm: Math.round(pick('precipitation').reduce((a, b) => a + b, 0) * 10) / 10,
          wind: Math.round(Math.max(0, ...winds)),
          gust: Math.round(Math.max(0, ...pick('wind_gusts_10m'))),
          deg,
          dir: COMPASS[Math.round(deg / 45) % 8],
          sky: skyOf(code),
          label: (WMO[code] || ['', 'Conditions météo'])[1]
        };
      }
      // Heure par heure, de 6 h à 22 h : pour la vue détaillée d'un jour.
      const hours = [];
      for (let x = 6; x <= 22; x++) {
        const i = byHour[`${day}T${String(x).padStart(2, '0')}:00`];
        if (i === undefined || h.temperature_2m[i] == null) continue;
        hours.push({
          h: x,
          t: Math.round(h.temperature_2m[i]),
          rain: h.precipitation_probability[i] ?? 0,
          mm: Math.round((h.precipitation[i] ?? 0) * 10) / 10,
          wind: Math.round(h.wind_speed_10m[i] ?? 0),
          gust: Math.round(h.wind_gusts_10m[i] ?? 0),
          dir: COMPASS[Math.round((h.wind_direction_10m[i] ?? 0) / 45) % 8],
          sky: skyOf(h.weather_code[i] ?? 0),
          label: (WMO[h.weather_code[i]] || ['', 'Conditions météo'])[1]
        });
      }
      const code = json.daily.weather_code[di];
      data[day] = {
        hours,
        min: Math.round(json.daily.temperature_2m_min[di]),
        max: Math.round(json.daily.temperature_2m_max[di]),
        sky: skyOf(code),
        label: (WMO[code] || ['', 'Conditions météo'])[1],
        sunrise: (json.daily.sunrise[di] || '').slice(11, 16),
        sunset: (json.daily.sunset[di] || '').slice(11, 16),
        slots
      };
    });
    slotCache.set(key, { at: Date.now(), data });
    lastAt = new Date();
    return data;
  } finally {
    clearTimeout(timer);
  }
}
