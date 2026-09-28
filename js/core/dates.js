/* Manipulation des dates en heure locale (format ISO AAAA-MM-JJ). */

const pad = n => String(n).padStart(2, '0');

export function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const todayKey = () => dateKey(new Date());

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Lundi de la semaine contenant `date`, à midi (évite les pièges DST). */
export function mondayOf(date) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - (day - 1));
  return d;
}

/** Date locale à midi à partir d'une clé ISO ; null si invalide. */
export function fromKey(key) {
  if (!isDateKey(key)) return null;
  const d = new Date(`${key}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const isDateKey = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T12:00:00`).getTime());
export const isTime = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** Date + heure locale -> Date. Sans heure : `fallbackTime`. */
export function combine(dateValue, timeValue, fallbackTime = '00:00') {
  if (!isDateKey(dateValue)) return null;
  const t = isTime(timeValue) ? timeValue : fallbackTime;
  const d = new Date(`${dateValue}T${t}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const fmtCache = new Map();
function fmt(options) {
  const key = JSON.stringify(options);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('fr-FR', options));
  return fmtCache.get(key);
}
export const formatDate = (date, options) => fmt(options).format(date).replaceAll('.', '');

export const formatKey = (key, options = { day: 'numeric', month: 'short', year: 'numeric' }) => {
  const d = fromKey(key);
  return d ? formatDate(d, options) : '—';
};

/** « Aujourd'hui », « Demain », « Dans 3 jours »… */
export function relativeDay(key) {
  const d = fromKey(key);
  if (!d) return '';
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'Aujourd’hui';
  if (diff === 1) return 'Demain';
  if (diff === -1) return 'Hier';
  if (diff > 1) return `Dans ${diff} jours`;
  return `Il y a ${Math.abs(diff)} jours`;
}

/** Durée « h:mm », « 1h30 », « 1.5 » -> minutes. */
export function parseDuration(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value * 60;
  const s = String(value).trim();
  const hm = s.match(/^(\d{1,3}):([0-5]\d)$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const h = s.match(/^(\d+(?:[.,]\d+)?)\s*h\s*(\d{1,2})?/i);
  if (h) return Math.round(Number(h[1].replace(',', '.')) * 60) + Number(h[2] || 0);
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 60) : 0;
}

export function minutesLabel(total) {
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  return `${h}h${pad(m)}`;
}

/** Compte à rebours lisible jusqu'à `target`. */
export function countdown(target, now = new Date()) {
  const diff = target - now;
  if (diff <= 0) return null;
  const totalMin = Math.floor(diff / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days} j · ${hours} h · ${mins} min`;
  if (hours > 0) return `${hours} h · ${mins} min`;
  return `${mins} min`;
}
