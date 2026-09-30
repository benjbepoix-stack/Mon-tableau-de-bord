/* Vue Parcours : génération de boucles vélo de route selon la séance, le vent et le trafic. */
import { $, esc, parseNumber, clamp } from '../core/utils.js';
import { todayKey, combine, dateKey, addDays } from '../core/dates.js';
import { state } from '../core/store.js';
import { SESSIONS, QUIET_LEVELS, compass, compassLong, toGPX, haversine } from '../core/ride.js';
import { planLoops } from '../features/route-planner.js';
import { brouterWebLink } from '../services/routing.js';
import { WEATHER_PLACE } from '../services/weather.js';
import { readJSON, write } from '../services/storage.js';
import { toast, toastError } from '../ui/toast.js';
import { icon } from '../ui/icons.js';

const PREFS_KEY = 'dashboard_route_prefs';
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
const DEFAULT_FTP = 220;
const DEFAULT_WEIGHT = 72;
const BIKE_KG = 9;

const prefs = {
  session: 'endurance',
  km: SESSIONS.endurance.km,
  ascent: '',
  quiet: 'quiet',
  start: [WEATHER_PLACE.lat, WEATHER_PLACE.lon],
  startName: WEATHER_PLACE.name,
  ...readJSON(PREFS_KEY, {})
};
if (!SESSIONS[prefs.session]) prefs.session = 'endurance';
if (!QUIET_LEVELS[prefs.quiet]) prefs.quiet = 'quiet';
if (!Array.isArray(prefs.start) || prefs.start.length !== 2 || !prefs.start.every(Number.isFinite)) {
  prefs.start = [WEATHER_PLACE.lat, WEATHER_PLACE.lon];
  prefs.startName = WEATHER_PLACE.name;
}
const savePrefs = () => write(PREFS_KEY, prefs);

let L = null;
let map = null;
let startMarker = null;
let routeLayer = null;
let result = null;
let selected = 0;
let running = null;

/* ---------- Cycliste (FTP et poids issus de l'onglet Mesures) ---------- */
function rider() {
  const last = rows => rows?.[rows.length - 1]?.value;
  const ftp = last(state.bodyMetrics?.ftp) || null;
  const weight = last(state.bodyMetrics?.weight) || null;
  return { ftp: ftp || DEFAULT_FTP, weight: weight || DEFAULT_WEIGHT, known: { ftp: !!ftp, weight: !!weight } };
}

function renderRider() {
  const r = rider();
  const s = SESSIONS[prefs.session];
  const power = Math.round(r.ftp * s.ftp);
  const src = r.known.ftp && r.known.weight ? 'd’après vos mesures' : 'valeurs par défaut — renseignez FTP et poids dans « Mesures »';
  $('#riderNote').innerHTML = `Estimation à <strong>${power} W</strong> de moyenne (${Math.round(s.ftp * 100)} % de FTP ${r.ftp} W, ${r.weight} kg), ${esc(src)}.`;
}

/* ---------- Formulaire ---------- */
function renderSessions() {
  $('#sessionChips').innerHTML = Object.entries(SESSIONS)
    .map(([key, s]) => `<button type="button" class="session-chip" role="radio" data-session="${key}" aria-checked="${key === prefs.session}">${esc(s.label)}</button>`)
    .join('');
  $('#sessionHint').textContent = SESSIONS[prefs.session].hint;
}

function renderStart() {
  const [lat, lon] = prefs.start;
  $('#startLabel').textContent = `Départ : ${prefs.startName || `${lat.toFixed(4)}, ${lon.toFixed(4)}`} — touchez la carte pour le déplacer.`;
  if (startMarker) startMarker.setLatLng(prefs.start);
}

function setStart(latlng, name = null) {
  prefs.start = [Number(latlng[0].toFixed(5)), Number(latlng[1].toFixed(5))];
  prefs.startName = name;
  savePrefs();
  renderStart();
}

function nextHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function readForm() {
  const form = $('#routeForm');
  const km = parseNumber(form.km.value);
  const ascentRaw = parseNumber(form.ascent.value);
  const startTime = combine(form.date.value, form.time.value);
  if (!km || km < 10 || km > 300) return { error: 'Distance entre 10 et 300 km.', field: form.km };
  if (ascentRaw !== null && (ascentRaw < 0 || ascentRaw > 6000)) return { error: 'Dénivelé entre 0 et 6000 m.', field: form.ascent };
  if (!startTime) return { error: 'Choisissez le jour et l’heure de départ.', field: form.date };
  const max = addDays(new Date(), 15);
  if (startTime > max) return { error: 'Prévisions de vent disponibles jusqu’à 15 jours.', field: form.date };
  const session = SESSIONS[prefs.session];
  const ascent = ascentRaw ?? (session.climb === null ? null : Math.round(session.climb * km));
  return { km, ascent, ascentAuto: ascentRaw === null, startTime, quiet: form.quiet.value };
}

/* ---------- Carte (Leaflet chargé à la demande) ---------- */
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!document.querySelector('link[data-leaflet]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${LEAFLET}leaflet.min.css`;
    css.dataset.leaflet = '';
    document.head.appendChild(css);
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${LEAFLET}leaflet.min.js`;
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error('Impossible de charger la carte'));
    document.head.appendChild(script);
  });
}

async function ensureMap() {
  if (map) {
    map.invalidateSize();
    return;
  }
  const host = $('#routeMap');
  host.innerHTML = `<div class="map-loading"><span class="spinner"></span>Chargement de la carte…</div>`;
  try {
    L = await loadLeaflet();
  } catch (error) {
    host.innerHTML = `<div class="map-loading">${esc(error.message)} (hors ligne ?)</div>`;
    return;
  }
  host.innerHTML = '';
  map = L.map(host, { zoomControl: true, attributionControl: true }).setView(prefs.start, 11);
  const cyclosm = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    maxZoom: 19,
    subdomains: 'abc',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · CyclOSM'
  });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, subdomains: 'abc', attribution: '© OpenStreetMap · OpenTopoMap' });
  const cycleRoutes = L.tileLayer('https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png', { maxZoom: 18, opacity: 0.8, attribution: 'Waymarked Trails' });
  cyclosm.addTo(map);
  L.control.layers({ 'Vélo (CyclOSM)': cyclosm, 'Standard': osm, 'Relief': topo }, { 'Itinéraires cyclables balisés': cycleRoutes }, { position: 'topright' }).addTo(map);

  startMarker = L.marker(prefs.start, {
    draggable: true,
    keyboard: false,
    icon: L.divIcon({ className: '', html: '<div class="start-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] })
  }).addTo(map);
  startMarker.on('dragend', () => {
    const p = startMarker.getLatLng();
    setStart([p.lat, p.lng]);
  });
  map.on('click', e => setStart([e.latlng.lat, e.latlng.lng]));
  routeLayer = L.layerGroup().addTo(map);
  if (result) drawRoute();
}

const WIND_CLASS = head => (head > 4 ? 'head' : head < -4 ? 'tail' : 'cross');

function drawRoute() {
  if (!map || !result) return;
  routeLayer.clearLayers();
  const r = result.routes[selected];
  if (!r) return;
  const css = getComputedStyle(document.documentElement);
  const colors = { head: css.getPropertyValue('--wind-head').trim(), cross: css.getPropertyValue('--wind-cross').trim(), tail: css.getPropertyValue('--wind-tail').trim() };
  // Contour sombre puis tronçons colorés selon le vent au moment du passage.
  L.polyline(r.coords.map(c => [c[0], c[1]]), { color: '#0b0f1a', weight: 8, opacity: 0.55 }).addTo(routeLayer);
  let cls = null;
  let run = [];
  const flush = () => run.length > 1 && L.polyline(run, { color: colors[cls], weight: 5, opacity: 0.95 }).addTo(routeLayer);
  for (const s of r.sim.segs) {
    const c = WIND_CLASS(s.head);
    const a = r.coords[s.i - 1];
    const b = r.coords[s.i];
    if (c !== cls) {
      flush();
      cls = c;
      run = [[a[0], a[1]]];
    }
    run.push([b[0], b[1]]);
  }
  flush();
  // Flèches de sens tous les ~10 km
  const step = Math.max(5000, r.meters / 8);
  let next = step;
  for (const s of r.sim.segs) {
    if (s.d1 < next) continue;
    next += step;
    const p = r.coords[s.i];
    L.marker([p[0], p[1]], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({ className: '', html: `<svg width="16" height="16" viewBox="0 0 16 16" style="transform:rotate(${s.heading}deg)"><path d="M8 2 13 13 8 10 3 13z" fill="#fff" stroke="#0b0f1a" stroke-width="1.2"/></svg>`, iconSize: [16, 16], iconAnchor: [8, 8] })
    }).addTo(routeLayer);
  }
  map.fitBounds(L.latLngBounds(r.coords.map(c => [c[0], c[1]])), { padding: [24, 24] });
}

/* ---------- Affichage des résultats ---------- */
const fmtKm = m => `${(m / 1000).toFixed(m < 100000 ? 1 : 0).replace('.', ',')} km`;
const fmtDuration = s => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 60 ? `${h + 1} h 00` : `${h} h ${String(m).padStart(2, '0')}`;
};
const pct = x => `${Math.round(x * 100)} %`;
const arrowSvg = rotation => `<svg width="22" height="22" viewBox="0 0 24 24" style="transform:rotate(${rotation}deg)" aria-hidden="true"><path d="M12 3v18M6 9l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function renderWind() {
  const host = $('#windBanner');
  if (!result) {
    host.innerHTML = '';
    return;
  }
  const w = result.windNow;
  const temp = Number.isFinite(w.temp) ? ` · ${Math.round(w.temp)} °C` : '';
  const rain = Number.isFinite(w.rain) ? ` · pluie ${w.rain} %` : '';
  const advice =
    w.speed < 8
      ? 'Vent faible : toutes les directions se valent, place au relief.'
      : `Conseil : partez vers le ${compassLong(w.dir)} (face au vent), retour vent dans le dos.`;
  host.innerHTML = `
    <div class="wind-arrow" title="Le vent souffle dans le sens de la flèche">${arrowSvg((w.dir + 180) % 360)}</div>
    <div class="wind-banner__main">
      <div class="wind-banner__title">Vent de ${compass(w.dir)} · ${Math.round(w.speed)} km/h</div>
      <div class="wind-banner__sub">Rafales ${Math.round(w.gust)} km/h${temp}${rain}</div>
      <div class="wind-banner__advice">${esc(advice)}</div>
    </div>`;
}

function renderList() {
  $('#routeList').innerHTML = result.routes
    .map(
      (r, i) => `<button type="button" class="route-option" role="option" data-route="${i}" aria-selected="${i === selected}">
        <span class="route-option__top"><span class="route-option__name">Boucle ${esc(compassLong(r.heading))}</span>${i === 0 ? '<span class="badge badge--accent">Recommandée</span>' : ''}</span>
        <span class="route-option__stats"><span>${fmtKm(r.meters)}</span><span>${Math.round(r.ascent)} m D+</span><span>${fmtDuration(r.sim.seconds)}</span></span>
        <span class="split-bar" aria-hidden="true"><span style="--c:var(--wind-tail);flex:${r.shares.tail}"></span><span style="--c:var(--wind-cross);flex:${r.shares.cross}"></span><span style="--c:var(--wind-head);flex:${r.shares.head}"></span></span>
      </button>`
    )
    .join('');
}

function elevationSvg(r, width) {
  const pts = [];
  let d = 0;
  for (let i = 0; i < r.coords.length; i++) {
    if (i) d += haversine(r.coords[i - 1], r.coords[i]);
    if (Number.isFinite(r.coords[i][2])) pts.push([d, r.coords[i][2]]);
  }
  if (pts.length < 2) return '<p class="chart-empty">Altitude indisponible.</p>';
  const step = Math.max(1, Math.floor(pts.length / 400));
  const sample = pts.filter((_, i) => i % step === 0);
  const W = Math.max(280, width);
  const H = 150;
  const L0 = 38;
  const B = 20;
  const T = 8;
  const eles = sample.map(p => p[1]);
  const lo = Math.floor(Math.min(...eles) / 50) * 50;
  const hi = Math.max(lo + 100, Math.ceil(Math.max(...eles) / 50) * 50);
  const x = v => L0 + (v / d) * (W - L0 - 4);
  const y = v => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const line = sample.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const area = `${line}L${x(sample[sample.length - 1][0]).toFixed(1)},${H - B}L${x(0)},${H - B}Z`;
  const kmStep = d > 100000 ? 20 : d > 40000 ? 10 : 5;
  let ticks = '';
  for (let k = kmStep; k * 1000 < d - 2000; k += kmStep) ticks += `<text class="chart-axis" x="${x(k * 1000)}" y="${H - 4}" text-anchor="middle">${k}</text>`;
  // Bande de vent sous le profil
  const band = r.sim.segs
    .filter((_, i) => i % 3 === 0)
    .map(s => `<rect x="${x(s.d0).toFixed(1)}" y="${H - B + 2}" width="${Math.max(0.6, x(Math.min(d, s.d1 + (s.d1 - s.d0) * 2)) - x(s.d0)).toFixed(1)}" height="4" fill="var(--wind-${WIND_CLASS(s.head)})"/>`)
    .join('');
  return `<svg class="elev-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Profil altimétrique de ${lo} à ${hi} m">
    <defs><linearGradient id="elevFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <line class="chart-grid" x1="${L0}" x2="${W}" y1="${y(hi)}" y2="${y(hi)}"/><line class="chart-grid" x1="${L0}" x2="${W}" y1="${y(lo)}" y2="${y(lo)}"/>
    <text class="chart-axis" x="${L0 - 6}" y="${y(hi) + 4}" text-anchor="end">${hi}</text><text class="chart-axis" x="${L0 - 6}" y="${y(lo) + 4}" text-anchor="end">${lo}</text>
    <path class="elev-area" d="${area}"/><path class="elev-line" d="${line}"/>${band}${ticks}
  </svg>`;
}

function renderDetail() {
  const r = result.routes[selected];
  const host = $('#routeDetail');
  if (!r) {
    host.innerHTML = '';
    return;
  }
  const speed = r.meters / 1000 / (r.sim.seconds / 3600);
  const lost = r.sim.seconds - r.sim.secondsNoWind;
  const { first, second } = r.score.half;
  const fmtHead = v => (Math.abs(v) < 1.5 ? 'vent neutre' : v > 0 ? `${Math.round(v)} km/h de face` : `${Math.round(-v)} km/h dans le dos`);
  const back = new Date(result.startTime.getTime() + r.sim.seconds * 1000);
  const mix = r.mix;
  const warnings = [];
  const target = result.target;
  if (Math.abs(r.meters / 1000 - target.km) / target.km > 0.12) warnings.push(`Distance éloignée de l’objectif (${target.km} km) : le réseau routier local limite les possibilités.`);
  if (target.ascent !== null && Math.abs(r.ascent - target.ascent) > Math.max(250, target.ascent * 0.35))
    warnings.push(`Dénivelé ${r.ascent > target.ascent ? 'supérieur' : 'inférieur'} à la cible (${target.ascent} m) : ${r.ascent < target.ascent ? 'essayez un autre départ, plus proche du relief' : 'réduisez la distance ou choisissez une autre boucle'}.`);
  if (mix.major > 0.08) warnings.push(`${pct(mix.major)} sur routes principales : prudence, ou choisissez « Très peu de trafic ».`);
  if (mix.unpaved > 0.03) warnings.push(`${pct(mix.unpaved)} de revêtement non asphalté signalé dans OpenStreetMap.`);
  if (r.overlap > 0.15) warnings.push(`${pct(r.overlap)} de la boucle repasse par les mêmes routes.`);
  const gusts = Math.max(...result.wind.filter(h => h.t >= result.startTime.getTime() && h.t <= back.getTime()).map(h => h.gust), 0);
  if (gusts >= 45) warnings.push(`Rafales jusqu’à ${Math.round(gusts)} km/h pendant la sortie : attention aux passages exposés.`);

  host.innerHTML = `
    <header class="card__head"><div><h2 class="card__title">Boucle ${esc(compassLong(r.heading))}</h2><p class="card__sub">${esc(SESSIONS[prefs.session].label)} · retour estimé vers ${back.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</p></div></header>
    <div class="stats-grid">
      <div class="stat"><strong>${fmtKm(r.meters)}</strong><span>Distance</span></div>
      <div class="stat"><strong>${Math.round(r.ascent)} m</strong><span>Dénivelé +</span></div>
      <div class="stat"><strong>${fmtDuration(r.sim.seconds)}</strong><span>Durée estimée</span></div>
      <div class="stat"><strong>${speed.toFixed(1).replace('.', ',')} km/h</strong><span>Moyenne estimée</span></div>
    </div>

    <div class="route-block">
      <h3 class="route-block__title">Vent</h3>
      <div class="split-bar"><span style="--c:var(--wind-tail);flex:${r.shares.tail}"></span><span style="--c:var(--wind-cross);flex:${r.shares.cross}"></span><span style="--c:var(--wind-head);flex:${r.shares.head}"></span></div>
      <div class="split-legend"><span style="--c:var(--wind-tail)">Dos ${pct(r.shares.tail)}</span><span style="--c:var(--wind-cross)">Côté ${pct(r.shares.cross)}</span><span style="--c:var(--wind-head)">Face ${pct(r.shares.head)}</span></div>
      <p class="route-note" style="margin-top:8px">Aller : <strong>${fmtHead(first)}</strong> en moyenne · Retour : <strong>${fmtHead(second)}</strong>. ${
        Math.abs(lost) >= 60 ? `Le vent ${lost > 0 ? 'coûte' : 'fait gagner'} environ <strong>${Math.round(Math.abs(lost) / 60)} min</strong> sur cette boucle.` : 'Impact du vent négligeable.'
      }</p>
    </div>

    <div class="route-block">
      <h3 class="route-block__title">Profil</h3>
      ${elevationSvg(r, $('#routeDetail').clientWidth - 40)}
    </div>

    <div class="route-block">
      <h3 class="route-block__title">Routes empruntées</h3>
      <div class="split-bar"><span style="--c:var(--accent);flex:${mix.quiet}"></span><span style="--c:var(--blue);flex:${mix.medium}"></span><span style="--c:var(--danger);flex:${mix.major}"></span><span style="--c:var(--text-3);flex:${mix.other}"></span></div>
      <div class="split-legend"><span style="--c:var(--accent)">Petites routes ${pct(mix.quiet)}</span><span style="--c:var(--blue)">Départementales ${pct(mix.medium)}</span><span style="--c:var(--danger)">Grands axes ${pct(mix.major)}</span>${mix.other > 0.01 ? `<span style="--c:var(--text-3)">Autres ${pct(mix.other)}</span>` : ''}</div>
      ${mix.cycleRoute > 0.05 ? `<p class="route-note" style="margin-top:8px">${pct(mix.cycleRoute)} sur des itinéraires cyclables balisés.</p>` : ''}
      ${warnings.map(w => `<p class="route-warn">${icon('alert', 16)}<span>${esc(w)}</span></p>`).join('')}
    </div>

    <div class="route-actions">
      <button type="button" class="btn btn--primary" data-route-action="gpx">${icon('download', 18)}<span>Exporter en GPX</span></button>
      <a class="btn btn--soft" href="${esc(stravaHeatmapLink(r))}" target="_blank" rel="noopener">${icon('external', 18)}<span>Comparer à la heatmap Strava</span></a>
      <a class="btn btn--soft" href="${esc(brouterWebLink(r.waypoints, r.quiet))}" target="_blank" rel="noopener">${icon('edit', 18)}<span>Retoucher dans BRouter</span></a>
    </div>`;
}

function stravaHeatmapLink(r) {
  const lats = r.coords.map(c => c[0]);
  const lons = r.coords.map(c => c[1]);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const zoom = r.meters > 90000 ? 10 : 11;
  return `https://www.strava.com/maps/global-heatmap?sport=Ride&style=dark&gColor=hot#${zoom}/${lat.toFixed(4)}/${lon.toFixed(4)}`;
}

function renderResults() {
  const has = !!result?.routes.length;
  $('#routeResults').hidden = !has;
  renderWind();
  if (!has) return;
  renderList();
  renderDetail();
  drawRoute();
}

/* ---------- Actions ---------- */
async function exportGPX() {
  const r = result.routes[selected];
  const name = `${SESSIONS[prefs.session].label} ${Math.round(r.meters / 1000)} km – ${dateKey(result.startTime)}`;
  const gpx = toGPX(name, r.coords);
  const fileName = `velo-${dateKey(result.startTime)}-${Math.round(r.meters / 1000)}km.gpx`;
  const file = new File([gpx], fileName, { type: 'application/gpx+xml' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('Fichier GPX téléchargé');
}

async function searchPlace() {
  const q = $('#r-place').value.trim();
  if (!q) return;
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    Object.entries({ q, format: 'jsonv2', limit: '1', 'accept-language': 'fr' }).forEach(([k, v]) => url.searchParams.set(k, v));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const [hit] = await response.json();
    if (!hit) {
      toastError('Lieu introuvable');
      return;
    }
    setStart([Number(hit.lat), Number(hit.lon)], hit.name || hit.display_name.split(',')[0]);
    map?.setView(prefs.start, 12);
  } catch {
    toastError('Recherche de lieu indisponible');
  }
}

function locate() {
  if (!navigator.geolocation) {
    toastError('Géolocalisation non disponible');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      setStart([pos.coords.latitude, pos.coords.longitude], 'Ma position');
      map?.setView(prefs.start, 12);
    },
    () => toastError('Position refusée ou indisponible'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function setProgress(done, total, label) {
  const host = $('#routeProgress');
  host.hidden = false;
  host.querySelector('.progress__bar').style.setProperty('--value', `${Math.round((done / total) * 100)}%`);
  host.querySelector('.progress__label').textContent = label;
}

async function generate(event) {
  event.preventDefault();
  const form = $('#routeForm');
  const input = readForm();
  if (input.error) {
    toastError(input.error);
    input.field.focus();
    return;
  }
  prefs.km = input.km;
  prefs.ascent = form.ascent.value.trim();
  prefs.quiet = input.quiet;
  savePrefs();

  running?.abort();
  const controller = new AbortController();
  running = controller;
  const button = $('#routeSubmit');
  button.disabled = true;
  setProgress(0, 1, 'Préparation…');
  const r = rider();
  try {
    const planned = await planLoops({
      start: prefs.start,
      km: input.km,
      ascent: input.ascent,
      quiet: input.quiet,
      startTime: input.startTime,
      power: r.ftp * SESSIONS[prefs.session].ftp,
      mass: r.weight + BIKE_KG,
      onProgress: setProgress,
      signal: controller.signal
    });
    planned.routes.forEach(route => (route.quiet = input.quiet));
    result = { ...planned, startTime: input.startTime, target: { km: input.km, ascent: input.ascent } };
    selected = 0;
    renderResults();
    $('#routeResults').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (error.name !== 'AbortError') toastError(error.message || 'Calcul impossible');
  } finally {
    if (running === controller) running = null;
    button.disabled = false;
    $('#routeProgress').hidden = true;
  }
}

/* ---------- Initialisation ---------- */
export function initRoutes() {
  const form = $('#routeForm');
  $('#r-quiet').innerHTML = Object.entries(QUIET_LEVELS)
    .map(([k, q]) => `<option value="${k}"${k === prefs.quiet ? ' selected' : ''}>${esc(q.label)}</option>`)
    .join('');
  form.km.value = prefs.km;
  form.ascent.value = prefs.ascent;
  const start = nextHour();
  form.date.value = dateKey(start);
  form.date.min = todayKey();
  form.date.max = dateKey(addDays(new Date(), 15));
  form.time.value = `${String(start.getHours()).padStart(2, '0')}:00`;
  renderSessions();
  renderStart();

  $('#sessionChips').addEventListener('click', e => {
    const chip = e.target.closest('[data-session]');
    if (!chip) return;
    const previous = SESSIONS[prefs.session];
    prefs.session = chip.dataset.session;
    // La distance suit la séance tant que l'utilisateur ne l'a pas personnalisée.
    if (Number(form.km.value) === previous.km) form.km.value = SESSIONS[prefs.session].km;
    savePrefs();
    renderSessions();
    renderRider();
  });
  form.addEventListener('submit', generate);
  $('#placeSearch').addEventListener('click', searchPlace);
  $('#r-place').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchPlace();
    }
  });
  $('#locateMe').addEventListener('click', locate);
  $('#routeList').addEventListener('click', e => {
    const option = e.target.closest('[data-route]');
    if (!option) return;
    selected = clamp(Number(option.dataset.route), 0, result.routes.length - 1);
    renderList();
    renderDetail();
    drawRoute();
  });
  $('#routeDetail').addEventListener('click', e => {
    if (e.target.closest('[data-route-action="gpx"]')) exportGPX();
  });
}

export function showRoutes() {
  renderRider();
  ensureMap();
  if (result) renderDetail();
}
