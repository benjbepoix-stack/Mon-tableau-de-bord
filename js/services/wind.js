/* Vent heure par heure (Open-Meteo, gratuit, sans clé) pour un point et une journée. */
import { dateKey, addDays } from '../core/dates.js';

const CACHE_TTL = 20 * 60 * 1000;
const cache = new Map();

/**
 * Prévisions horaires couvrant la sortie (jour de départ + lendemain matin).
 * @returns {Promise<Array<{t:number, speed:number, gust:number, dir:number, temp:number, rain:number, code:number}>>}
 *   speed / gust en km/h, dir = direction d'où vient le vent (degrés)
 */
export async function fetchWind(lat, lon, start) {
  const key = `${lat.toFixed(2)}_${lon.toFixed(2)}_${dateKey(start)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  Object.entries({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,precipitation_probability,weather_code',
    wind_speed_unit: 'kmh',
    timezone: 'UTC',
    start_date: dateKey(addDays(start, -1)),
    end_date: dateKey(addDays(start, 1))
  }).forEach(([k, v]) => url.searchParams.set(k, v));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.error) throw new Error(json.reason || `HTTP ${response.status}`);
    const h = json.hourly;
    if (!h?.time?.length) throw new Error('Réponse météo invalide');
    const data = h.time
      .map((t, i) => ({
        t: Date.parse(`${t}:00Z`),
        speed: h.wind_speed_10m[i],
        dir: h.wind_direction_10m[i],
        gust: h.wind_gusts_10m[i],
        temp: h.temperature_2m[i],
        rain: h.precipitation_probability?.[i] ?? null,
        code: h.weather_code?.[i] ?? null
      }))
      .filter(x => Number.isFinite(x.speed) && Number.isFinite(x.dir));
    if (!data.length) throw new Error('Prévision indisponible pour cette date');
    cache.set(key, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}
