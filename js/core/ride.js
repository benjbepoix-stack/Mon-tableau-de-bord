/* Calculs « parcours vélo » : géométrie, génération de boucles, modèle physique,
   effet du vent, analyse des routes empruntées, score et export GPX.
   Module pur (aucun accès DOM ni réseau) : testable isolément. */

const R_EARTH = 6371000;
const toRad = d => (d * Math.PI) / 180;
const toDeg = r => (r * 180) / Math.PI;

/* ---------- Géométrie ---------- */

/** Distance orthodromique en mètres entre deux points [lat, lon]. */
export function haversine([lat1, lon1], [lat2, lon2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Cap (0 = nord, 90 = est) pour aller de a vers b, en degrés. */
export function bearing([lat1, lon1], [lat2, lon2]) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point atteint depuis [lat, lon] en suivant un cap sur une distance (m). */
export function destination([lat, lon], headingDeg, meters) {
  const δ = meters / R_EARTH;
  const θ = toRad(headingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [toDeg(φ2), ((toDeg(λ2) + 540) % 360) - 180];
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const COMPASS_LONG = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];
export const compass = deg => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
export const compassLong = deg => COMPASS_LONG[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/* ---------- Séances ---------- */

/**
 * Types de séance : intensité moyenne (fraction de FTP), dénivelé visé (m/km)
 * et distance suggérée. « Libre » laisse le dénivelé au choix de l'utilisateur.
 */
export const SESSIONS = {
  endurance: { label: 'Endurance', ftp: 0.68, climb: 9, km: 80, hint: 'Zone 2 régulière, peu de relances : un relief modéré.' },
  recovery: { label: 'Récupération', ftp: 0.52, climb: 4, km: 40, hint: 'Terrain plat et abrité, vent doux : on tourne les jambes.' },
  intervals: { label: 'Intervalles', ftp: 0.75, climb: 5, km: 60, hint: 'Routes roulantes et régulières pour tenir les blocs sans coupure.' },
  climbing: { label: 'Côtes', ftp: 0.72, climb: 18, km: 70, hint: 'Maximum de dénivelé : travail de force et de seuil en montée.' },
  long: { label: 'Sortie longue', ftp: 0.63, climb: 10, km: 120, hint: 'Volume : gérer le vent pour rentrer avec le vent dans le dos.' },
  free: { label: 'Libre', ftp: 0.68, climb: null, km: 70, hint: 'Distance et dénivelé à votre main.' }
};

/** Profils BRouter : du plus direct au plus tranquille. */
export const QUIET_LEVELS = {
  normal: { label: 'Standard', profile: 'fastbike' },
  quiet: { label: 'Peu de trafic', profile: 'fastbike-lowtraffic' },
  veryQuiet: { label: 'Très peu de trafic', profile: 'fastbike-verylowtraffic' }
};

/* ---------- Génération de boucles ---------- */

/** Rapport moyen distance routée / périmètre géométrique (routes sinueuses). */
export const ROAD_FACTOR = 1.28;

/**
 * Points de passage d'une boucle partant de `start` vers le cap `heading`.
 * La boucle est une ellipse dont le grand axe suit le cap : l'aller et le
 * retour empruntent des routes différentes, dans des directions opposées.
 * @param {[number,number]} start [lat, lon]
 * @param {number} heading cap de l'aller (degrés)
 * @param {number} km distance routée visée
 * @param {{factor?:number, stretch?:number, points?:number}} options
 * @returns {Array<[number,number]>} départ, points intermédiaires, arrivée (= départ)
 */
export function loopWaypoints(start, heading, km, { factor = ROAD_FACTOR, stretch = 1.25, points = 4 } = {}) {
  // Périmètre de Ramanujan pour une ellipse (a = demi-grand axe, b = a / stretch).
  const perimeter = (km * 1000) / factor;
  const ratio = 1 / stretch;
  const h = ((1 - ratio) / (1 + ratio)) ** 2;
  const unit = Math.PI * (1 + ratio) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  const a = perimeter / unit;
  const b = a * ratio;
  const center = destination(start, heading, a);
  const out = [start];
  // Paramètre t : le départ est à t = π (côté opposé du centre sur le grand axe).
  for (let k = 1; k <= points; k++) {
    const t = Math.PI + (k * 2 * Math.PI) / (points + 1);
    const along = a * Math.cos(t); // selon le cap
    const across = b * Math.sin(t); // perpendiculaire (sens horaire)
    const dist = Math.hypot(along, across);
    const angle = heading + toDeg(Math.atan2(across, along));
    out.push(destination(center, angle, dist));
  }
  out.push(start);
  return out;
}

/* ---------- Modèle physique ---------- */

const G = 9.81;
const RHO = 1.2;
const CDA = 0.36; // mains aux cocottes, tenue d'entraînement
const CRR = 0.0055; // pneus route, bitume de campagne
const VMAX_DESCENT = 14; // 50 km/h : plafond de sécurité en descente
/** Virages, carrefours, relances : temps réel un peu supérieur au modèle. */
const ROAD_OVERHEAD = 1.05;
/** Le vent est mesuré à 10 m : au niveau du cycliste il est plus faible. */
export const WIND_HEIGHT_FACTOR = 0.65;

/**
 * Vitesse (m/s) à puissance constante.
 * @param {number} power W
 * @param {number} grade pente (0.05 = 5 %)
 * @param {number} headwind composante de face (m/s, négative = vent dans le dos)
 * @param {number} mass cycliste + vélo (kg)
 */
export function speedFor(power, grade, headwind, mass) {
  const cos = 1 / Math.sqrt(1 + grade * grade);
  const sin = grade * cos;
  const resist = mass * G * (CRR * cos + sin);
  const f = v => {
    const air = v + headwind;
    return v * resist + 0.5 * RHO * CDA * air * Math.abs(air) * v - power;
  };
  let lo = 0.3;
  let hi = 30;
  if (f(hi) < 0) return VMAX_DESCENT;
  if (f(lo) > 0) return lo; // mur : on ne descend pas sous ~1 km/h
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return Math.min(VMAX_DESCENT, (lo + hi) / 2);
}

/**
 * Vent au moment du passage : interpolation linéaire des prévisions horaires.
 * @param {Array<{t:number, speed:number, dir:number, gust:number}>} hours  (speed km/h, dir = d'où vient le vent)
 */
export function windAt(hours, time) {
  if (!hours?.length) return { speed: 0, dir: 0, gust: 0 };
  if (time <= hours[0].t) return hours[0];
  const last = hours[hours.length - 1];
  if (time >= last.t) return last;
  const i = hours.findIndex(h => h.t > time);
  const a = hours[i - 1];
  const b = hours[i];
  const k = (time - a.t) / (b.t - a.t);
  // Interpolation vectorielle de la direction (évite le saut 359° → 0°).
  const ax = Math.sin(toRad(a.dir));
  const ay = Math.cos(toRad(a.dir));
  const bx = Math.sin(toRad(b.dir));
  const by = Math.cos(toRad(b.dir));
  const dir = (toDeg(Math.atan2(ax + (bx - ax) * k, ay + (by - ay) * k)) + 360) % 360;
  return { t: time, speed: a.speed + (b.speed - a.speed) * k, gust: a.gust + (b.gust - a.gust) * k, dir };
}

/** Composante de face (km/h) d'un vent venant de `windDir` pour un cycliste au cap `heading`. */
export const headwindComponent = (windSpeed, windDir, heading) => windSpeed * Math.cos(toRad(windDir - heading));

/**
 * Simule la sortie point par point.
 * @param {Array<[number,number,number?]>} coords [lat, lon, ele]
 * @param {{power:number, mass:number, startTime:number, wind:Array}} rider
 * @returns segments [{ d0, d1, heading, grade, head, time, noWindTime }] + totaux
 */
export function simulate(coords, { power, mass, startTime, wind }) {
  const segs = [];
  let clock = startTime;
  let dist = 0;
  let total = 0;
  let totalNoWind = 0;
  // Pente lissée sur ~200 m pour gommer le bruit du modèle d'altitude.
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  const eleAt = i => coords[i][2] ?? null;
  let j0 = 0;
  let j1 = 0;
  for (let i = 1; i < coords.length; i++) {
    const len = cum[i] - cum[i - 1];
    if (len < 0.5) continue;
    const mid = (cum[i] + cum[i - 1]) / 2;
    while (cum[j0] < mid - 100 && j0 < i - 1) j0++;
    while (j1 < coords.length - 1 && cum[j1] < mid + 100) j1++;
    const span = cum[j1] - cum[j0];
    const grade = span > 20 && eleAt(j0) !== null && eleAt(j1) !== null ? Math.max(-0.25, Math.min(0.25, (eleAt(j1) - eleAt(j0)) / span)) : 0;
    const heading = bearing(coords[i - 1], coords[i]);
    const w = windAt(wind, clock);
    const head = headwindComponent(w.speed * WIND_HEIGHT_FACTOR, w.dir, heading);
    const v = speedFor(power, grade, head / 3.6, mass);
    const v0 = speedFor(power, grade, 0, mass);
    const dt = (len / v) * ROAD_OVERHEAD;
    segs.push({ i, d0: dist, d1: dist + len, heading, grade, head, time: clock, speed: v * 3.6 });
    clock += dt * 1000;
    total += dt;
    totalNoWind += (len / v0) * ROAD_OVERHEAD;
    dist += len;
  }
  return { segs, seconds: total, secondsNoWind: totalNoWind, meters: dist };
}

/* ---------- Analyse du tracé ---------- */

/** Part du parcours passant plusieurs fois sur la même route (hors 1er / dernier km). */
export function overlapRatio(coords) {
  const cell = ([lat, lon]) => `${Math.round(lat / 0.0006)}:${Math.round(lon / 0.0009)}`;
  const seen = new Map();
  let dist = 0;
  let total = 0;
  let overlap = 0;
  for (let i = 0; i < coords.length; i++) {
    const len = i ? haversine(coords[i - 1], coords[i]) : 0;
    dist += len;
    total += len;
    const key = cell(coords[i]);
    const first = seen.get(key);
    if (first === undefined) seen.set(key, dist);
    else if (dist - first > 1500) overlap += len;
  }
  // La zone de départ/arrivée est forcément partagée : on la retire.
  return total ? Math.max(0, overlap - 2000) / total : 0;
}

const MAJOR = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'motorway']);
const MEDIUM = new Set(['secondary', 'secondary_link']);
const QUIET = new Set(['tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'cycleway', 'road']);
const PAVED = new Set(['asphalt', 'paved', 'concrete', 'concrete:plates', 'paving_stones']);

/**
 * Répartition des routes à partir des messages BRouter (tags OSM par tronçon).
 * @param {Array<Array<string>>} messages tableau BRouter (ligne 0 = en-têtes)
 * @returns {{major:number, medium:number, quiet:number, unpaved:number, cycleRoute:number}} parts (0-1)
 */
export function roadMix(messages) {
  const out = { major: 0, medium: 0, quiet: 0, other: 0, unpaved: 0, cycleRoute: 0 };
  if (!Array.isArray(messages) || messages.length < 2) return out;
  const head = messages[0];
  const iDist = head.indexOf('Distance');
  const iTags = head.indexOf('WayTags');
  if (iDist < 0 || iTags < 0) return out;
  let total = 0;
  for (const row of messages.slice(1)) {
    const d = Number(row[iDist]) || 0;
    const tags = Object.fromEntries(
      String(row[iTags] || '')
        .split(' ')
        .filter(Boolean)
        .map(t => {
          const at = t.indexOf('=');
          return [t.slice(0, at), t.slice(at + 1)];
        })
    );
    total += d;
    const hw = tags.highway || '';
    if (MAJOR.has(hw)) out.major += d;
    else if (MEDIUM.has(hw)) out.medium += d;
    else if (QUIET.has(hw)) out.quiet += d;
    else out.other += d;
    const surface = tags.surface;
    const unpavedHighway = hw === 'track' || hw === 'path' || hw === 'bridleway';
    if ((surface && !PAVED.has(surface)) || (!surface && unpavedHighway)) out.unpaved += d;
    if (Object.keys(tags).some(k => k.startsWith('route_bicycle_'))) out.cycleRoute += d;
  }
  if (total) for (const k of Object.keys(out)) out[k] /= total;
  return out;
}

/* ---------- Score ---------- */

/**
 * Évalue une boucle (plus bas = meilleur).
 * @param {{meters:number, ascent:number, sim:object, overlap:number, mix:object}} r
 * @param {{km:number, ascent:number|null}} target
 */
export function scoreRoute(r, target) {
  const km = r.meters / 1000;
  const distErr = Math.abs(km - target.km) / target.km;
  const elevErr = target.ascent === null ? 0 : Math.abs(r.ascent - target.ascent) / Math.max(target.ascent, 250);
  const windCost = r.sim.secondsNoWind ? r.sim.seconds / r.sim.secondsNoWind - 1 : 0;
  const half = splitHeadwind(r.sim);
  // Tactique : vent de face à l'aller, dans le dos au retour (bonus), l'inverse est pénalisé.
  const tactic = (half.second - half.first) / 12;
  const traffic = r.mix.major * 1.5 + r.mix.medium * 0.4;
  const parts = {
    distance: distErr * 3,
    elevation: elevErr * 1.6,
    wind: Math.max(0, windCost) * 4,
    tactic,
    overlap: r.overlap * 2,
    traffic,
    unpaved: r.mix.unpaved * 4
  };
  return { total: Object.values(parts).reduce((s, v) => s + v, 0), parts, half, windCost };
}

/** Vent de face moyen (km/h, pondéré par la distance) sur chaque moitié. */
export function splitHeadwind(sim) {
  const mid = sim.meters / 2;
  let a = 0;
  let da = 0;
  let b = 0;
  let db = 0;
  for (const s of sim.segs) {
    const len = s.d1 - s.d0;
    if (s.d1 <= mid) {
      a += s.head * len;
      da += len;
    } else {
      b += s.head * len;
      db += len;
    }
  }
  return { first: da ? a / da : 0, second: db ? b / db : 0 };
}

/** Parts de distance avec vent de face / de côté / dans le dos. */
export function windShares(sim) {
  const out = { head: 0, cross: 0, tail: 0 };
  for (const s of sim.segs) {
    const len = s.d1 - s.d0;
    if (s.head > 4) out.head += len;
    else if (s.head < -4) out.tail += len;
    else out.cross += len;
  }
  const total = sim.meters || 1;
  return { head: out.head / total, cross: out.cross / total, tail: out.tail / total };
}

/* ---------- Export ---------- */

const xml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** Fichier GPX (trace) importable dans Garmin Connect, Wahoo, Komoot, Strava… */
export function toGPX(name, coords) {
  const pts = coords
    .map(([lat, lon, ele]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${Number.isFinite(ele) ? `<ele>${ele.toFixed(1)}</ele>` : ''}</trkpt>`)
    .join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Mon Dashboard" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${xml(name)}</name></metadata>
  <trk>
    <name>${xml(name)}</name>
    <type>cycling</type>
    <trkseg>
      ${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
