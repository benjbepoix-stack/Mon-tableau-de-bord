/* Calcul d'itinéraires vélo via BRouter (serveur public brouter.de, gratuit, sans clé).
   BRouter s'appuie sur OpenStreetMap et estime le trafic : ses profils « lowtraffic »
   évitent les grands axes, ce qui est l'objectif pour le vélo de route. */
import { QUIET_LEVELS } from '../core/ride.js';

const ENDPOINT = 'https://brouter.de/brouter';
const TIMEOUT = 25000;

/** Profil de repli si un profil « lowtraffic » n'est pas disponible sur le serveur. */
const FALLBACK = 'fastbike';

async function call(waypoints, profile, signal) {
  const url = new URL(ENDPOINT);
  // BRouter attend lon,lat séparés par « | ».
  url.searchParams.set('lonlats', waypoints.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join('|'));
  url.searchParams.set('profile', profile);
  url.searchParams.set('alternativeidx', '0');
  url.searchParams.set('format', 'geojson');

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(text.trim().slice(0, 160) || `HTTP ${response.status}`);
    const json = JSON.parse(text);
    const feature = json.features?.[0];
    if (!feature?.geometry?.coordinates?.length) throw new Error('Itinéraire vide');
    const p = feature.properties || {};
    return {
      coords: feature.geometry.coordinates.map(([lon, lat, ele]) => [lat, lon, Number.isFinite(ele) ? ele : null]),
      meters: Number(p['track-length']) || 0,
      ascent: Number(p['filtered ascend']) || 0,
      messages: p.messages || [],
      profile
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

const unknownProfile = error => /profile|not found|no such/i.test(error.message);

/**
 * Itinéraire passant par les points donnés.
 * @param {Array<[number,number]>} waypoints [lat, lon]
 * @param {keyof QUIET_LEVELS} quiet
 */
export async function route(waypoints, quiet = 'quiet', { signal } = {}) {
  const profile = QUIET_LEVELS[quiet]?.profile || FALLBACK;
  try {
    return await call(waypoints, profile, signal);
  } catch (error) {
    if (profile !== FALLBACK && unknownProfile(error) && !signal?.aborted) return call(waypoints, FALLBACK, signal);
    throw error;
  }
}

/** Lien vers l'interface web de BRouter pour retoucher l'itinéraire à la main. */
export function brouterWebLink(waypoints, quiet) {
  const profile = QUIET_LEVELS[quiet]?.profile || FALLBACK;
  const [lat, lon] = waypoints[0];
  const lonlats = waypoints.map(([a, b]) => `${b.toFixed(5)},${a.toFixed(5)}`).join(';');
  return `https://brouter.de/brouter-web/#map=11/${lat.toFixed(4)}/${lon.toFixed(4)}/standard&lonlats=${lonlats}&profile=${profile}`;
}
