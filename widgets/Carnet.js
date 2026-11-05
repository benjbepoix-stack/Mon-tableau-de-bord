// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: pink; icon-glyph: calendar-check;
/*
 * Carnet · widgets iPhone pour Scriptable
 *
 * Écran d'accueil : A Aujourd'hui (petit), B Prochaine séance (petit), C Tâches (petit),
 *                   D Ma journée (moyen), F Le briefing (grand).
 * Écran verrouillé : un seul widget, le rectangle « Ma journée » en 3 lignes :
 *                    prochain RDV ou événement, séance(s) du jour, tâches du jour.
 *
 * Installation : coller ce script dans Scriptable (nom « Carnet »), le lancer une fois
 * pour se connecter, puis ajouter un widget Scriptable, choisir « Carnet » et mettre la
 * lettre dans « Parameter ». Sans lettre : petit = A, moyen = D, grand = F.
 * Sur l'écran verrouillé, choisir le rectangle : pas besoin de lettre.
 * Les widgets de l'écran d'accueil restent toujours en clair.
 *
 * Données : le compte Carnet (le même que Mon Garage et Ma Maison). Le mot de passe
 * n'est pas gardé : seul le jeton de connexion de Firebase est rangé dans le trousseau
 * de l'iPhone (Keychain). Les dernières données sont gardées sur l'iPhone pour
 * s'afficher même hors connexion.
 */

const API_KEY = 'AIzaSyAdtuzUxcc7JIxtYDXh3dPmrXMP3HePBT4';
const DB_URL = 'https://test-e27e9-default-rtdb.europe-west1.firebasedatabase.app';
const APP_URL = 'https://benjbepoix-stack.github.io/Mon-tableau-de-bord/';
const KC = { refresh: 'carnet.refresh', uid: 'carnet.uid', email: 'carnet.email', token: 'carnet.token', place: 'carnet.place' };
const DEFAULT_PLACE = { name: 'Besançon', lat: 47.2378, lon: 6.0241 };
const REFRESH_MIN = 15;

const fm = FileManager.local();
const CACHE_FILE = fm.joinPath(fm.documentsDirectory(), 'carnet-widget-data.json');
const WEATHER_FILE = fm.joinPath(fm.documentsDirectory(), 'carnet-widget-meteo.json');

/* ---------- Couleurs (style Doux : blanc, bleu canard, rose du logo) ---------- */
const hex = h => new Color(h);
/** Toujours la version claire, même quand l'iPhone est en mode sombre. */
const dyn = light => hex(light);
const C = {
  bg: dyn('#FFFFFF', '#1C1D21'),
  ink: dyn('#222222', '#F2F2F2'),
  ink2: dyn('#6A6A6A', '#9A9AA0'),
  line: dyn('#EDEDF0', '#2E2F34'),
  soft: dyn('#F4F4F7', '#2A2B30'),
  rose: dyn('#E0315B', '#FF5C80'),
  ses: dyn('#2A7F94', '#6FC0D2'),
  task: hex('#A9A9B2'),
  teal: dyn('#0E3B4A', '#0B2E3A'),
  onTeal: hex('#FFFFFF'),
  mist: hex('#BFD3D8'),
  pinkOnTeal: hex('#FF9BB1'),
  white: hex('#FFFFFF')
};

/* ---------- Dates (comme js/core/dates.js de l'app) ---------- */
const WD = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const WD_FULL = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const SLOTS = { matin: 'Matin', aprem: 'Après-midi', soir: 'Soir' };
const SLOT_SHORT = { matin: 'Matin', aprem: 'Aprèm', soir: 'Soir' };
const SLOT_HOURS = { matin: [7, 12], aprem: [12, 18], soir: [18, 22] };
const SLOT_SORT = { matin: '07:00', aprem: '12:00', soir: '18:00' };
const REST = ['Journée off - repos', 'Repos'];
const DEFAULT_FAMILIES = [
  ['course-pied', 'Course à pied'], ['trail', 'Trail'], ['cyclisme', 'Cyclisme'], ['ski-fond', 'Ski de fond'],
  ['ski-roue', 'Ski-roue'], ['musculation', 'Musculation'], ['escalade', 'Escalade'], ['vtt', 'VTT'], ['gravel', 'Gravel']
].map(([id, name]) => ({ id, name }));
const SPORT_ICONS = {
  'course-pied': 'figure.run', trail: 'mountain.2', cyclisme: 'bicycle', 'ski-fond': 'figure.skiing.crosscountry',
  'ski-roue': 'figure.skiing.crosscountry', musculation: 'dumbbell', escalade: 'figure.climbing', vtt: 'bicycle', gravel: 'bicycle'
};

const pad = n => String(n).padStart(2, '0');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isDateKey = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const fromKey = k => (isDateKey(k) ? new Date(`${k}T12:00:00`) : null);
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const combine = (key, time, fallback = '00:00') => (isDateKey(key) ? new Date(`${key}T${isTime(time) ? time : fallback}:00`) : null);
/** 09:30 -> 9:30 */
const hm = t => (isTime(t) ? `${Number(t.slice(0, 2))}:${t.slice(3)}` : '');
const REPEATS = ['daily', 'weekly', 'monthly', 'yearly'];

function occurrenceKey(key, repeat, k) {
  const d = fromKey(key);
  if (!d || !REPEATS.includes(repeat) || k <= 0) return key;
  if (repeat === 'daily' || repeat === 'weekly') return dateKey(addDays(d, k * (repeat === 'daily' ? 1 : 7)));
  const month = d.getMonth() + (repeat === 'monthly' ? k : 12 * k);
  const last = new Date(d.getFullYear(), month + 1, 0).getDate();
  return dateKey(new Date(d.getFullYear(), month, Math.min(d.getDate(), last), 12));
}

function occurrencesBetween({ date, repeat }, from, to) {
  if (!isDateKey(date) || date > to) return [];
  if (!REPEATS.includes(repeat)) return date >= from ? [date] : [];
  const out = [];
  const perStep = { daily: 1, weekly: 7, monthly: 28, yearly: 365 }[repeat];
  let k = Math.max(0, Math.floor((fromKey(from) - fromKey(date)) / 86400000 / perStep) - 2);
  for (let guard = 0; guard < 500; guard++, k++) {
    const key = occurrenceKey(date, repeat, k);
    if (key > to) break;
    if (key >= from) out.push(key);
  }
  return out;
}

function nextTaskDate({ date, anchor, repeat, doneAt }) {
  const base = isDateKey(anchor) ? anchor : date;
  if (!REPEATS.includes(repeat) || !fromKey(base)) return date;
  const after = doneAt && doneAt > date ? doneAt : date;
  for (let k = 1; k < 5000; k++) {
    const key = occurrenceKey(base, repeat, k);
    if (key > after) return key;
  }
  return date;
}

/* ---------- Lecture des données ---------- */
const asArray = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());

function items(list, withDone) {
  return asArray(list)
    .filter(isObj)
    .map(x => ({
      id: str(x.id),
      title: str(x.title),
      date: isDateKey(x.date) ? x.date : '',
      time: isTime(x.time) ? x.time : '',
      endTime: isTime(x.endTime) ? x.endTime : '',
      endDate: isDateKey(x.endDate) && isDateKey(x.date) && x.endDate > x.date ? x.endDate : '',
      location: str(x.location),
      repeat: REPEATS.includes(x.repeat) ? x.repeat : '',
      anchor: isDateKey(x.anchor) ? x.anchor : '',
      done: withDone ? Boolean(x.done) : false,
      doneAt: isDateKey(x.doneAt) ? x.doneAt : ''
    }))
    .filter(x => x.title);
}

function sessionsOf(day, families) {
  let list;
  if (Array.isArray(day) || (isObj(day) && !('training' in day) && !('family' in day))) list = asArray(day);
  else list = [day];
  return list
    .filter(isObj)
    .map(s => ({
      family: families.find(f => f.id === s.family) || null,
      training: str(s.training),
      distance: str(s.distance),
      elevation: str(s.elevation),
      slot: SLOTS[s.slot] ? s.slot : ''
    }))
    .filter(s => s.family && !REST.includes(s.training));
}

function model(raw, now = new Date()) {
  const dash = isObj(raw.dashboard) ? raw.dashboard : {};
  const fam = asArray(raw.families).filter(isObj).map(f => ({ id: str(f.id), name: str(f.name) })).filter(f => f.id && f.name);
  const families = fam.length ? fam : DEFAULT_FAMILIES;
  const plans = isObj(raw.plans) ? raw.plans : {};
  const agenda = [
    ...items(dash.appointments, false).map(x => ({ ...x, kind: 'rdv' })),
    ...items(dash.events, false).map(x => ({ ...x, kind: 'evt' }))
  ];
  const tasks = items(dash.tasks, true);
  return { now, today: dateKey(now), agenda, tasks, plans, families };
}

/** Rendez-vous et événements d'un jour (événements sur plusieurs jours compris), sans heure d'abord. */
function dayAgenda(m, key) {
  return m.agenda
    .filter(x => (x.repeat ? occurrencesBetween(x, key, key).length > 0 : x.date === key || (x.endDate && x.date <= key && key <= x.endDate)))
    .map(x => ({ ...x, on: key, multi: Boolean(x.endDate) && !x.repeat }))
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

/** Pas encore terminé (fin = endTime, sinon heure, sinon fin de journée). */
const notOver = (m, x) => combine(x.on, x.endTime || x.time, '23:59') >= m.now;

/** Prochain rendez-vous à heure fixe, sur 30 jours. */
function nextAppt(m) {
  for (let i = 0; i < 30; i++) {
    const key = dateKey(addDays(m.now, i));
    const hit = dayAgenda(m, key).find(x => x.time && notOver(m, x));
    if (hit) return hit;
  }
  return null;
}

/** Tâches à faire aujourd'hui ou en retard (comme dans l'app), puis celles cochées aujourd'hui. */
function taskLists(m) {
  const open = [];
  const done = [];
  for (const t of m.tasks) {
    let x = t;
    if (x.done && x.repeat && x.doneAt && x.doneAt < m.today) x = { ...x, done: false, date: nextTaskDate(x) };
    if (x.done) {
      if (x.doneAt === m.today) done.push(x);
    } else if (x.date && x.date <= m.today) open.push({ ...x, late: x.date < m.today });
  }
  open.sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
  return { open, done };
}

function sessionsOn(m, key) {
  return sessionsOf(m.plans[key], m.families).map(s => ({ ...s, on: key }));
}

/** Séance du jour, sinon la prochaine sur 7 jours. */
function nextSession(m) {
  for (let i = 0; i < 8; i++) {
    const key = dateKey(addDays(m.now, i));
    const list = sessionsOn(m, key);
    if (list.length) return list[0];
  }
  return null;
}

/* ---------- Libellés ---------- */
function dayLabel(m, key, short = false) {
  if (key === m.today) return "Aujourd'hui";
  if (key === dateKey(addDays(m.now, 1))) return 'Demain';
  const d = fromKey(key);
  return short ? `${cap(WD[d.getDay()])}. ${d.getDate()}` : `${cap(WD_FULL[d.getDay()])} ${d.getDate()}`;
}
const sessionTitle = s => s.training || s.family.name;
const sessionDetail = (s, withFamily = true) =>
  [withFamily && s.training ? s.family.name : '', s.distance && `${s.distance} km`, s.elevation && `${s.elevation} m D+`].filter(Boolean).join(' · ');
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const tasksLabel = n => (n ? plural(n, 'tâche') : 'Aucune tâche');
function windLine(w) {
  if (!w) return '';
  return `vent ${w.wind} km/h`;
}

/* ---------- Réseau : compte Firebase ---------- */
async function postJSON(url, body, form = false) {
  const r = new Request(url);
  r.method = 'POST';
  r.headers = { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' };
  r.body = form ? body : JSON.stringify(body);
  r.timeoutInterval = 12;
  return r.loadJSON();
}

const AUTH_ERRORS = {
  INVALID_LOGIN_CREDENTIALS: 'E-mail ou mot de passe incorrect.',
  INVALID_PASSWORD: 'Mot de passe incorrect.',
  EMAIL_NOT_FOUND: 'Aucun compte avec cet e-mail.',
  INVALID_EMAIL: "Cet e-mail n'est pas valide.",
  USER_DISABLED: 'Ce compte est désactivé.',
  TOKEN_EXPIRED: 'Connexion expirée : reconnecte-toi.',
  INVALID_REFRESH_TOKEN: 'Connexion expirée : reconnecte-toi.'
};
const authError = code => new Error(AUTH_ERRORS[String(code).split(' ')[0]] || String(code));

async function signIn(email, password) {
  const j = await postJSON(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    email,
    password,
    returnSecureToken: true
  });
  if (j.error) throw authError(j.error.message);
  Keychain.set(KC.refresh, j.refreshToken);
  Keychain.set(KC.uid, j.localId);
  Keychain.set(KC.email, email);
  Keychain.set(KC.token, JSON.stringify({ id: j.idToken, until: Date.now() + (Number(j.expiresIn) - 300) * 1000 }));
}

const signedIn = () => Keychain.contains(KC.refresh) && Keychain.contains(KC.uid);

async function idToken() {
  if (Keychain.contains(KC.token)) {
    try {
      const t = JSON.parse(Keychain.get(KC.token));
      if (t.until > Date.now()) return t.id;
    } catch (e) {}
  }
  const j = await postJSON(
    `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`,
    `grant_type=refresh_token&refresh_token=${encodeURIComponent(Keychain.get(KC.refresh))}`,
    true
  );
  if (j.error) throw authError(j.error.message);
  if (j.refresh_token) Keychain.set(KC.refresh, j.refresh_token);
  Keychain.set(KC.token, JSON.stringify({ id: j.id_token, until: Date.now() + (Number(j.expires_in) - 300) * 1000 }));
  return j.id_token;
}

function signOut() {
  for (const k of [KC.refresh, KC.uid, KC.token, KC.email]) if (Keychain.contains(k)) Keychain.remove(k);
  if (fm.fileExists(CACHE_FILE)) fm.remove(CACHE_FILE);
}

async function readNode(path, token, query = '') {
  const r = new Request(`${DB_URL}/users/${Keychain.get(KC.uid)}/carnet/${path}.json?auth=${encodeURIComponent(token)}${query}`);
  r.timeoutInterval = 12;
  const j = await r.loadJSON();
  if (isObj(j) && typeof j.error === 'string') throw new Error(/permission/i.test(j.error) ? 'Accès refusé par Firebase.' : j.error);
  return j;
}

/** Données du compte (agenda, tâches, séances des 4 semaines autour d'aujourd'hui), avec repli sur la dernière copie. */
async function loadData() {
  try {
    const token = await idToken();
    const from = dateKey(addDays(new Date(), -7));
    const to = dateKey(addDays(new Date(), 21));
    const q = `&orderBy=${encodeURIComponent('"$key"')}&startAt=${encodeURIComponent(`"${from}"`)}&endAt=${encodeURIComponent(`"${to}"`)}`;
    const [dashboard, families, plans] = await Promise.all([readNode('dashboard', token), readNode('families', token), readNode('plans', token, q)]);
    const raw = { dashboard, families, plans, at: Date.now() };
    fm.writeString(CACHE_FILE, JSON.stringify(raw));
    return raw;
  } catch (error) {
    if (fm.fileExists(CACHE_FILE)) {
      const raw = JSON.parse(fm.readString(CACHE_FILE));
      raw.stale = error.message;
      return raw;
    }
    throw error;
  }
}

/* ---------- Météo (Open-Meteo), seulement pour la séance ---------- */
function place() {
  try {
    if (Keychain.contains(KC.place)) return JSON.parse(Keychain.get(KC.place));
  } catch (e) {}
  return DEFAULT_PLACE;
}

async function weatherFor(session) {
  if (!session) return null;
  const p = place();
  let data = null;
  try {
    if (fm.fileExists(WEATHER_FILE)) {
      const c = JSON.parse(fm.readString(WEATHER_FILE));
      if (c.lat === p.lat && c.lon === p.lon && Date.now() - c.at < 3600000) data = c.data;
    }
    if (!data) {
      const r = new Request(
        `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&hourly=temperature_2m,wind_speed_10m&wind_speed_unit=kmh&timezone=auto&forecast_days=9`
      );
      r.timeoutInterval = 10;
      data = await r.loadJSON();
      fm.writeString(WEATHER_FILE, JSON.stringify({ lat: p.lat, lon: p.lon, at: Date.now(), data }));
    }
  } catch (e) {
    return null;
  }
  const h = data && data.hourly;
  if (!h || !h.time) return null;
  const [start, end] = SLOT_HOURS[session.slot] || [8, 20];
  const winds = [];
  const temps = [];
  h.time.forEach((t, i) => {
    if (t.slice(0, 10) !== session.on) return;
    const hour = Number(t.slice(11, 13));
    if (hour >= start && hour < end) {
      winds.push(h.wind_speed_10m[i]);
      temps.push(h.temperature_2m[i]);
    }
  });
  if (!winds.length) return null;
  return { wind: Math.round(Math.max(...winds)), temp: Math.round(temps.reduce((a, b) => a + b, 0) / temps.length) };
}

/* ---------- Petites briques de dessin ---------- */
function text(stack, value, font, color, opts = {}) {
  const t = stack.addText(String(value));
  t.font = font;
  t.textColor = color;
  t.lineLimit = opts.lines === undefined ? 1 : opts.lines;
  if (opts.scale) t.minimumScaleFactor = opts.scale;
  if (opts.opacity) t.textOpacity = opts.opacity;
  if (opts.center) t.centerAlignText();
  return t;
}
const F = {
  kick: () => Font.boldSystemFont(11),
  big: n => Font.heavyRoundedSystemFont(n),
  title: n => Font.boldSystemFont(n),
  semi: n => Font.semiboldSystemFont(n),
  body: n => Font.systemFont(n),
  med: n => Font.mediumSystemFont(n)
};
function row(stack, spacing = 6) {
  const s = stack.addStack();
  s.layoutHorizontally();
  s.centerAlignContent();
  s.spacing = spacing;
  return s;
}
function col(stack, spacing = 0) {
  const s = stack.addStack();
  s.layoutVertically();
  s.spacing = spacing;
  return s;
}
function dot(stack, color, size = 7) {
  const d = stack.addStack();
  d.size = new Size(size, size);
  d.cornerRadius = size / 2;
  d.backgroundColor = color;
  return d;
}
function symbol(stack, name, size, color, fallback = 'circle') {
  const sym = SFSymbol.named(name) || SFSymbol.named(fallback);
  sym.applyFont(Font.semiboldSystemFont(size));
  const img = stack.addImage(sym.image);
  img.imageSize = new Size(size, size);
  img.tintColor = color;
  return img;
}
function pill(stack, color, label) {
  const p = row(stack, 5);
  p.backgroundColor = C.soft;
  p.cornerRadius = 9;
  p.setPadding(3, 8, 3, 8);
  dot(p, color);
  text(p, label, F.semi(11), C.ink2);
  return p;
}
function dateBlock(stack, m, bigSize) {
  const d = m.now;
  text(stack, WD_FULL[d.getDay()].toUpperCase(), F.kick(), C.rose);
  text(stack, d.getDate(), F.big(bigSize), C.ink);
  text(stack, MONTHS[d.getMonth()], F.body(12), C.ink2);
}

/** Ligne « heure | titre / détail » pour les rendez-vous et séances. */
function agendaRow(stack, when, title, detail, isSession, timeWidth = 40, titleSize = 13.5) {
  const r = stack.addStack();
  r.layoutHorizontally();
  r.spacing = 8;
  const w = r.addStack();
  w.size = new Size(timeWidth, 0);
  text(w, when, F.title(12), C.ink2, { scale: 0.7 });
  w.addSpacer();
  const c = col(r, 1);
  text(c, title, F.semi(titleSize), isSession ? C.ses : C.ink);
  if (detail) text(c, detail, F.body(11.5), C.ink2);
  r.addSpacer();
}

/** Journée dans l'ordre : rendez-vous pas encore terminés + séances (rangées selon leur créneau). */
function timeline(m, weather) {
  const out = dayAgenda(m, m.today)
    .filter(x => notOver(m, x))
    .map(x => ({
      sort: x.time || '00:00',
      when: x.time ? hm(x.time) : 'Jour',
      title: x.title,
      detail: x.location || (x.endTime ? `jusqu'à ${hm(x.endTime)}` : ''),
      session: false
    }));
  for (const s of sessionsOn(m, m.today)) {
    out.push({
      sort: SLOT_SORT[s.slot] || '06:00',
      when: SLOT_SHORT[s.slot] || 'Sport',
      title: s.training ? `${s.family.name} · ${s.training}` : s.family.name,
      detail: [s.distance && `${s.distance} km`, weather && windLine(weather)].filter(Boolean).join(' · '),
      session: true
    });
  }
  return out.sort((a, b) => a.sort.localeCompare(b.sort));
}

function emptyLine(stack, label, sub) {
  text(stack, label, F.semi(13.5), C.ink);
  if (sub) text(stack, sub, F.body(11.5), C.ink2, { lines: 2 });
}

/* ---------- Widgets de l'écran d'accueil ---------- */
function widgetA(w, m) {
  w.backgroundColor = C.bg;
  w.setPadding(14, 14, 14, 14);
  dateBlock(w, m, 48);
  w.addSpacer();
  const next = nextAppt(m);
  if (next) {
    const prefix = next.on === m.today ? '' : `${dayLabel(m, next.on, true)} · `;
    text(w, `${prefix}${hm(next.time)} ${next.title}`, F.title(14), C.ink, { scale: 0.8 });
  } else text(w, 'Aucun RDV prévu', F.semi(13), C.ink2);
  w.addSpacer(6);
  const p = row(w, 5);
  const { open } = taskLists(m);
  pill(p, C.task, tasksLabel(open.length));
  const s = sessionsOn(m, m.today)[0];
  if (s) pill(p, C.ses, s.family.name.split(' ')[0]);
}

function widgetB(w, m, s, weather) {
  w.backgroundColor = C.teal;
  w.setPadding(14, 14, 14, 14);
  if (!s) {
    symbol(w, 'figure.run', 22, C.onTeal);
    w.addSpacer(8);
    text(w, 'Pas de séance prévue', F.title(16), C.onTeal, { lines: 2 });
    w.addSpacer(3);
    text(w, 'Programme ta semaine dans le Carnet', F.body(12), C.mist, { lines: 2 });
    w.addSpacer();
    return;
  }
  const top = row(w, 6);
  const ico = top.addStack();
  ico.size = new Size(34, 34);
  ico.cornerRadius = 10;
  ico.backgroundColor = new Color('#FFFFFF', 0.12);
  ico.centerAlignContent();
  symbol(ico, SPORT_ICONS[s.family.id] || 'figure.run', 19, C.onTeal, 'figure.run');
  top.addSpacer();
  const when = [s.on === m.today ? '' : dayLabel(m, s.on, true), SLOTS[s.slot] || ''].filter(Boolean).join(' · ') || "Aujourd'hui";
  text(top, when.toUpperCase(), F.kick(), C.pinkOnTeal, { scale: 0.7 });
  w.addSpacer(8);
  text(w, sessionTitle(s), F.title(17), C.onTeal, { lines: 3, scale: 0.8 });
  const det = sessionDetail(s);
  if (det) {
    w.addSpacer(3);
    text(w, det, F.body(12), C.mist, { scale: 0.8 });
  }
  w.addSpacer();
  if (weather) {
    const r = row(w, 4);
    symbol(r, 'wind', 11, C.mist);
    text(r, `${weather.wind} km/h · ${weather.temp}°`, F.body(11), C.mist);
  }
}

function widgetC(w, m) {
  w.backgroundColor = C.bg;
  w.setPadding(14, 14, 14, 14);
  const { open, done } = taskLists(m);
  const h = row(w, 4);
  text(h, 'Tâches', F.title(15), C.ink);
  h.addSpacer();
  text(h, open.length, F.big(22), C.rose);
  w.addSpacer(8);
  const list = [...open.slice(0, 4), ...done.slice(0, Math.max(0, 4 - open.length))];
  if (!list.length) {
    emptyLine(w, 'Rien à faire', "Aucune tâche pour aujourd'hui.");
  }
  list.forEach((t, i) => {
    if (i) w.addSpacer(7);
    const r = row(w, 8);
    if (t.done) symbol(r, 'checkmark.circle.fill', 16, C.rose);
    else symbol(r, 'circle', 16, t.late ? C.rose : C.ink2);
    text(r, t.title, F.body(13), t.done ? C.ink2 : C.ink);
    r.addSpacer();
  });
  if (open.length > 4) {
    w.addSpacer(6);
    text(w, `+ ${open.length - 4} autre${open.length > 5 ? 's' : ''}`, F.semi(11), C.ink2);
  }
  w.addSpacer();
}

function widgetD(w, m, weather) {
  w.backgroundColor = C.bg;
  w.setPadding(14, 14, 14, 14);
  const main = row(w, 14);
  main.topAlignContent();
  const left = col(main, 0);
  left.size = new Size(92, 130);
  dateBlock(left, m, 46);
  left.addSpacer();
  const { open } = taskLists(m);
  pill(left, C.task, tasksLabel(open.length));
  const bar = main.addStack();
  bar.size = new Size(1, 130);
  bar.backgroundColor = C.line;
  const right = col(main, 8);
  const tl = timeline(m, weather);
  if (!tl.length) {
    const next = nextAppt(m);
    emptyLine(right, "Rien de prévu aujourd'hui", next ? `Prochain RDV : ${dayLabel(m, next.on, true)} à ${hm(next.time)}, ${next.title}` : '');
  }
  const shown = tl.length > 3 ? tl.slice(0, 2) : tl;
  shown.forEach(x => agendaRow(right, x.when, x.title, x.detail, x.session));
  if (tl.length > 3) text(right, `+ ${tl.length - 2} autres dans la journée`, F.semi(11.5), C.ink2);
  right.addSpacer();
}

function widgetF(w, m, s, weather) {
  w.backgroundColor = C.bg;
  w.setPadding(16, 16, 14, 16);
  const head = row(w, 6);
  head.topAlignContent();
  const hc = col(head, 0);
  text(hc, WD_FULL[m.now.getDay()].toUpperCase(), F.kick(), C.rose);
  text(hc, `${m.now.getDate()} ${MONTHS[m.now.getMonth()]}`, F.big(22), C.ink);
  head.addSpacer();
  symbol(head, 'calendar.badge.checkmark', 24, C.rose, 'calendar');

  const label = t => {
    w.addSpacer(9);
    text(w, t.toUpperCase(), F.title(10.5), C.ink2);
    w.addSpacer(4);
  };

  const appts = dayAgenda(m, m.today).filter(x => notOver(m, x));
  label('Rendez-vous');
  if (!appts.length) text(w, "Rien d'autre aujourd'hui", F.body(13), C.ink2);
  appts.slice(0, 2).forEach((x, i) => {
    if (i) w.addSpacer(4);
    agendaRow(w, x.time ? hm(x.time) : 'Jour', x.title, '', false, 40, 13.5);
  });
  if (appts.length > 2) text(w, `+ ${appts.length - 2} autre${appts.length > 3 ? 's' : ''}`, F.semi(11), C.ink2);

  if (s) {
    label(s.on === m.today ? 'Séance' : `Séance · ${dayLabel(m, s.on)}`);
    const card = row(w, 10);
    card.backgroundColor = C.teal;
    card.cornerRadius = 14;
    card.setPadding(9, 12, 9, 12);
    symbol(card, SPORT_ICONS[s.family.id] || 'figure.run', 20, C.onTeal, 'figure.run');
    const cc = col(card, 1);
    text(cc, sessionTitle(s), F.title(13.5), C.onTeal);
    text(cc, [SLOTS[s.slot], s.training ? s.family.name : '', s.distance && `${s.distance} km`, windLine(weather)].filter(Boolean).join(' · '), F.body(11.5), C.mist);
    card.addSpacer();
  }

  const { open } = taskLists(m);
  label(`Tâches · ${open.length}`);
  if (!open.length) text(w, 'Tout est fait', F.body(13), C.ink2);
  const maxTasks = s ? 3 : 4;
  open.slice(0, maxTasks).forEach((t, i) => {
    if (i) w.addSpacer(5);
    const r = row(w, 8);
    symbol(r, 'circle', 15, t.late ? C.rose : C.ink2);
    text(r, t.title, F.body(13), C.ink);
    r.addSpacer();
  });
  if (open.length > maxTasks) {
    w.addSpacer(4);
    text(w, `+ ${open.length - maxTasks} autre${open.length - maxTasks > 1 ? 's' : ''}`, F.semi(11), C.ink2);
  }

  w.addSpacer();
  const sep = w.addStack();
  sep.size = new Size(0, 1);
  sep.backgroundColor = C.line;
  sep.addSpacer();
  w.addSpacer(6);
  const week = row(w, 0);
  const monday = addDays(m.now, -((m.now.getDay() || 7) - 1));
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    const key = dateKey(d);
    const c = col(week, 2);
    const top = row(c, 0);
    top.addSpacer();
    text(top, WD[d.getDay()].charAt(0).toUpperCase(), F.semi(10), C.ink2);
    top.addSpacer();
    const n = c.addStack();
    n.size = new Size(0, 22);
    n.centerAlignContent();
    n.addSpacer();
    const bubble = n.addStack();
    bubble.size = new Size(22, 22);
    bubble.cornerRadius = 11;
    bubble.centerAlignContent();
    if (key === m.today) bubble.backgroundColor = C.rose;
    text(bubble, d.getDate(), F.title(12.5), key === m.today ? C.white : C.ink);
    n.addSpacer();
    const dots = row(c, 2);
    dots.size = new Size(0, 5);
    dots.addSpacer();
    if (dayAgenda(m, key).length) dot(dots, C.rose, 4);
    if (sessionsOn(m, key).length) dot(dots, C.ses, 4);
    dots.addSpacer();
    if (i < 6) week.addSpacer();
  }
}

/* ---------- Widget de l'écran verrouillé (affiché en blanc par iOS) ---------- */
/** Ligne 1 : prochain rendez-vous ou événement (à heure fixe d'abord, puis ceux de la journée entière). */
function nextAgendaItem(m) {
  for (let i = 0; i < 30; i++) {
    const key = dateKey(addDays(m.now, i));
    const list = dayAgenda(m, key).filter(x => notOver(m, x));
    const hit = list.find(x => x.time) || list[0];
    if (hit) return hit;
  }
  return null;
}

/** Date courte pour gagner de la place : « Dem. », « Sam 7 ». */
function shortDay(m, key) {
  if (key === dateKey(addDays(m.now, 1))) return 'Dem.';
  const d = fromKey(key);
  return `${cap(WD[d.getDay()])} ${d.getDate()}`;
}

function agendaLine(m, x) {
  if (!x) return 'Aucun RDV prévu';
  const when = [x.on === m.today ? '' : shortDay(m, x.on), x.time ? hm(x.time) : ''].filter(Boolean).join(' ');
  return when ? `${when} ${x.title}` : x.title;
}

/** Ligne 2 : séance(s) du jour. Deux séances : les deux si elles tiennent, sinon la première « +1 ». */
const LINE_FIT = 24;
function sportLine(m) {
  const list = sessionsOn(m, m.today);
  if (!list.length) return 'Pas de séance aujourd’hui';
  const one = s => (s.training ? `${s.family.name} · ${s.training}` : s.family.name);
  if (list.length === 1) return one(list[0]);
  const both = list.map(s => s.family.name).join(' + ');
  if (list.length === 2 && both.length <= LINE_FIT) return both;
  const first = list[0].family.name;
  return `${first.length > LINE_FIT - 4 ? first.slice(0, LINE_FIT - 5) + '…' : first} +${list.length - 1}`;
}

/** Ligne 3 : la tâche du jour, ou « 3 tâches à faire aujourd'hui ». Les tâches en retard comptent aussi. */
function taskLine(m) {
  const { open } = taskLists(m);
  if (!open.length) return 'Aucune tâche aujourd’hui';
  if (open.length === 1) return open[0].title;
  return `${open.length} tâches à faire aujourd’hui`;
}

function widgetJ(w, m) {
  const first = nextAgendaItem(m);
  const s = sessionsOn(m, m.today)[0];
  // Toute la largeur du rectangle : pas de marge, petites icônes, et le texte rapetisse
  // jusqu'à 55 % avant d'être coupé par « … ».
  w.setPadding(0, 0, 0, 0);
  const line = (icon, value, bold = false) => {
    const r = row(w, 4);
    const ic = r.addStack();
    ic.size = new Size(11, 14);
    ic.centerAlignContent();
    symbol(ic, icon, 10, C.white, 'circle');
    text(r, value, bold ? F.semi(13) : F.med(13), C.white, { scale: 0.55 });
    r.addSpacer();
  };
  line('calendar', agendaLine(m, first), true);
  w.addSpacer(2);
  line(s ? SPORT_ICONS[s.family.id] || 'figure.run' : 'figure.run', sportLine(m));
  w.addSpacer(2);
  line('checklist', taskLine(m));
}

/* ---------- Choix du widget ---------- */
const WIDGETS = {
  A: { fam: ['small'], session: false },
  B: { fam: ['small'], session: true },
  C: { fam: ['small'], session: false },
  D: { fam: ['medium'], session: 'today' },
  F: { fam: ['large'], session: true },
  J: { fam: ['accessoryRectangular'], session: false }
};
const DEFAULT_FOR = { small: 'A', medium: 'D', large: 'F', extraLarge: 'F', accessoryRectangular: 'J' };

function pickLetter(family, param) {
  const letter = String(param || '').trim().toUpperCase().charAt(0);
  if (WIDGETS[letter] && WIDGETS[letter].fam.includes(family)) return letter;
  return DEFAULT_FOR[family] || null;
}

function messageWidget(family, title, sub) {
  const w = new ListWidget();
  w.url = APP_URL;
  const lock = family.startsWith('accessory');
  if (!lock) {
    w.backgroundColor = C.bg;
    w.setPadding(14, 14, 14, 14);
    symbol(w, 'calendar.badge.exclamationmark', 22, C.rose, 'calendar');
    w.addSpacer(8);
  }
  text(w, title, F.title(lock ? 13 : 14), lock ? C.white : C.ink, { lines: 2, scale: 0.8 });
  if (sub && family !== 'accessoryInline') {
    w.addSpacer(3);
    text(w, sub, F.body(lock ? 11 : 12), lock ? C.white : C.ink2, { lines: 3, scale: 0.8 });
  }
  return w;
}

async function buildWidget(family, param) {
  if (!signedIn()) return messageWidget(family, 'Carnet : connecte-toi', 'Ouvre le script Carnet dans Scriptable.');
  let raw;
  try {
    raw = await loadData();
  } catch (error) {
    return messageWidget(family, 'Carnet indisponible', error.message);
  }
  const m = model(raw);
  const letter = pickLetter(family, param);
  if (!letter) return messageWidget(family, 'Carnet', family === 'accessoryInline' ? 'Prends le rectangle' : 'Prends le widget rectangle');
  const need = WIDGETS[letter].session;
  const s = need === 'today' ? sessionsOn(m, m.today)[0] || null : need ? nextSession(m) : null;
  const weather = s ? await weatherFor(s) : null;
  const w = new ListWidget();
  w.url = APP_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60000);
  ({ A: () => widgetA(w, m), B: () => widgetB(w, m, s, weather), C: () => widgetC(w, m), D: () => widgetD(w, m, weather), F: () => widgetF(w, m, s, weather), J: () => widgetJ(w, m) })[letter]();
  return w;
}

/* ---------- Dans l'app Scriptable : connexion, aperçus, réglages ---------- */
async function askLogin() {
  const a = new Alert();
  a.title = 'Connexion au Carnet';
  a.message = 'Le même compte que Mon Garage et Ma Maison. Le mot de passe n’est pas gardé sur l’iPhone.';
  a.addTextField('E-mail', Keychain.contains(KC.email) ? Keychain.get(KC.email) : '');
  a.addSecureTextField('Mot de passe', '');
  a.addAction('Se connecter');
  a.addCancelAction('Annuler');
  if ((await a.presentAlert()) === -1) return false;
  try {
    await signIn(a.textFieldValue(0).trim(), a.textFieldValue(1));
    await loadData();
    await info('Connecté', 'Tu peux maintenant ajouter les widgets Carnet sur ton écran d’accueil et ton écran verrouillé.');
    return true;
  } catch (error) {
    await info('Connexion impossible', error.message);
    return false;
  }
}

async function info(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction('OK');
  await a.presentAlert();
}

async function askPlace() {
  const a = new Alert();
  a.title = 'Ville pour la météo';
  a.message = `Actuellement : ${place().name}. Sert au vent affiché sur la séance.`;
  a.addTextField('Ville', '');
  a.addAction('Chercher');
  a.addCancelAction('Annuler');
  if ((await a.presentAlert()) === -1) return;
  const q = a.textFieldValue(0).trim();
  if (!q) return;
  try {
    const r = new Request(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=fr`);
    const j = await r.loadJSON();
    const list = (j.results || []).map(x => ({ name: x.name, lat: x.latitude, lon: x.longitude, more: [x.admin1, x.country].filter(Boolean).join(', ') }));
    if (!list.length) return info('Ville introuvable', `Aucun résultat pour « ${q} ».`);
    const pick = new Alert();
    pick.title = 'Quelle ville ?';
    list.forEach(x => pick.addAction(`${x.name} (${x.more})`));
    pick.addCancelAction('Annuler');
    const i = await pick.presentSheet();
    if (i === -1) return;
    const { name, lat, lon } = list[i];
    Keychain.set(KC.place, JSON.stringify({ name, lat, lon }));
    if (fm.fileExists(WEATHER_FILE)) fm.remove(WEATHER_FILE);
    await info('Ville enregistrée', name);
  } catch (error) {
    await info('Recherche impossible', error.message);
  }
}

const PREVIEWS = [
  ['A · Aujourd’hui (petit)', 'small', 'A'],
  ['B · Prochaine séance (petit)', 'small', 'B'],
  ['C · Tâches (petit)', 'small', 'C'],
  ['D · Ma journée (moyen)', 'medium', 'D'],
  ['F · Le briefing (grand)', 'large', 'F'],
  ['Écran verrouillé · Ma journée en 3 lignes', 'accessoryRectangular', 'J']
];

async function preview() {
  const a = new Alert();
  a.title = 'Aperçu';
  a.message = 'Le widget de l’écran verrouillé s’affiche ici en grand, en blanc sur fond sombre.';
  PREVIEWS.forEach(p => a.addAction(p[0]));
  a.addCancelAction('Retour');
  const i = await a.presentSheet();
  if (i === -1) return;
  const [, family, letter] = PREVIEWS[i];
  const w = await buildWidget(family, letter);
  if (family === 'small') await w.presentSmall();
  else if (family === 'medium') await w.presentMedium();
  else if (family === 'large') await w.presentLarge();
  else if (family === 'accessoryCircular') await w.presentAccessoryCircular();
  else if (family === 'accessoryRectangular') await w.presentAccessoryRectangular();
  else await w.presentAccessoryInline();
}

async function menu() {
  if (!signedIn() && !(await askLogin())) return;
  for (;;) {
    const a = new Alert();
    a.title = 'Carnet · widgets';
    a.message = `Connecté : ${Keychain.contains(KC.email) ? Keychain.get(KC.email) : 'oui'}\nMétéo : ${place().name}`;
    a.addAction('Voir un widget');
    a.addAction('Ville pour la météo');
    a.addDestructiveAction('Se déconnecter');
    a.addCancelAction('Fermer');
    const i = await a.presentSheet();
    if (i === 0) await preview();
    else if (i === 1) await askPlace();
    else if (i === 2) {
      signOut();
      await info('Déconnecté', 'Les widgets affichent « connecte-toi » jusqu’à la prochaine connexion.');
      return;
    } else return;
  }
}

if (config.runsInWidget || config.runsInAccessoryWidget) {
  Script.setWidget(await buildWidget(config.widgetFamily || 'small', args.widgetParameter));
} else {
  await menu();
}
Script.complete();
