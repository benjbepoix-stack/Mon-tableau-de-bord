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
