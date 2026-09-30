/* Planification de boucles : génère des candidates dans plusieurs directions,
   les fait router par BRouter puis les classe (distance, dénivelé, vent, trafic). */
import { loopWaypoints, simulate, overlapRatio, roadMix, scoreRoute, windShares, ROAD_FACTOR } from '../core/ride.js';
import { route } from '../services/routing.js';
import { fetchWind } from '../services/wind.js';

const DIRECTIONS = 8;
const REFINE = 3;
const CONCURRENCY = 3;

/** Exécute des tâches asynchrones avec un parallélisme limité (serveur public). */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]().catch(error => ({ error }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * @param {object} p
 * @param {[number,number]} p.start [lat, lon]
 * @param {number} p.km distance visée
 * @param {number|null} p.ascent dénivelé visé (m) ou null
 * @param {string} p.quiet niveau de tranquillité (QUIET_LEVELS)
 * @param {Date} p.startTime départ
 * @param {number} p.power puissance moyenne (W)
 * @param {number} p.mass cycliste + vélo (kg)
 * @param {(done:number,total:number,label:string)=>void} [p.onProgress]
 * @param {AbortSignal} [p.signal]
 */
export async function planLoops({ start, km, ascent, quiet, startTime, power, mass, onProgress, signal }) {
  onProgress?.(0, 1, 'Prévisions de vent…');
  const wind = await fetchWind(start[0], start[1], startTime);
  const t0 = startTime.getTime();
  const windNow = wind.reduce((best, h) => (Math.abs(h.t - t0) < Math.abs(best.t - t0) ? h : best), wind[0]);
  const target = { km, ascent };
  const total = DIRECTIONS + REFINE;
  let done = 0;

  const evaluate = (res, heading, factor) => {
    const sim = simulate(res.coords, { power, mass, startTime: t0, wind });
    const r = {
      ...res,
      heading,
      factor,
      sim,
      overlap: overlapRatio(res.coords),
      mix: roadMix(res.messages),
      shares: windShares(sim)
    };
    r.score = scoreRoute(r, target);
    return r;
  };

  const attempt = (heading, factor) => async () => {
    if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
    const waypoints = loopWaypoints(start, heading, km, { factor });
    try {
      const res = await route(waypoints, quiet, { signal });
      return evaluate({ ...res, waypoints }, heading, factor);
    } finally {
      onProgress?.(++done, total, 'Calcul des boucles…');
    }
  };

  // 1) Une boucle par direction, la première face au vent dominant.
  const headings = Array.from({ length: DIRECTIONS }, (_, k) => (windNow.dir + (k * 360) / DIRECTIONS) % 360);
  const first = await pool(headings.map(h => attempt(h, ROAD_FACTOR)), CONCURRENCY);
  if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
  const ok = first.filter(r => r && !r.error);
  if (!ok.length) {
    const reason = first.find(r => r?.error)?.error?.message || 'aucun itinéraire trouvé';
    throw new Error(`Calcul impossible : ${reason}`);
  }

  // 2) Recalage de la distance sur les meilleures : le facteur de sinuosité
  //    observé corrige la taille de la boucle.
  ok.sort((a, b) => a.score.total - b.score.total);
  const refine = ok.slice(0, REFINE).filter(r => Math.abs(r.meters / 1000 - km) / km > 0.04);
  done += REFINE - refine.length;
  const second = await pool(
    refine.map(r => attempt(r.heading, Math.min(2.2, Math.max(0.8, r.factor * (r.meters / 1000 / km))))),
    CONCURRENCY
  );
  const all = [...ok, ...second.filter(r => r && !r.error)].sort((a, b) => a.score.total - b.score.total);

  // Une seule boucle par direction (la mieux notée).
  const seen = new Set();
  const routes = all.filter(r => {
    const key = Math.round(r.heading);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  onProgress?.(total, total, 'Terminé');
  return { routes: routes.slice(0, 5), wind, windNow };
}
