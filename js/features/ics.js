/*
 * Génération d'événements iCalendar (RFC 5545) et ouverture dans le
 * calendrier natif.
 *
 * iOS / Safari : Safari affiche directement la fiche native « Ajouter à
 * Calendrier » lorsqu'on NAVIGUE vers un contenu `text/calendar` via un lien
 * simple, SANS attribut `download` (sinon le fichier part dans
 * « Téléchargements »). Les Blob URL sont refusées en mode PWA « écran
 * d'accueil » ; on utilise donc une data-URL. L'ouverture doit être
 * déclenchée par un geste utilisateur (clic) : c'est pourquoi l'app passe par
 * une modale de confirmation après l'enregistrement Firebase.
 */
import { combine, isTime, isRepeat, REPEATS } from '../core/dates.js';

const PRODID = '-//Mon Dashboard//Agenda//FR';
const DEFAULT_DURATION_MIN = 60;

const pad = n => String(n).padStart(2, '0');

/** Date -> 20261001T123000Z (UTC). */
const toUTC = d =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** Date -> 20261001 (jour local, pour les événements « journée entière »). */
const toDateValue = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

/** Échappement des valeurs TEXT (RFC 5545 §3.3.11). */
export const escapeText = value =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');

/** Repli des lignes à 75 octets (UTF-8), sans couper un caractère multi-octets. */
export function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74; // la ligne de continuation commence par un espace
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/**
 * Calcule début/fin d'un élément de l'app.
 * @param {{date:string,time?:string,endTime?:string,durationMinutes?:number}} item
 */
export function eventWindow({ date, time, endTime, durationMinutes }) {
  if (!isTime(time)) {
    const start = combine(date, '12:00');
    if (!start) return null;
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { allDay: true, start, end };
  }
  const start = combine(date, time);
  if (!start) return null;
  let end = isTime(endTime) ? combine(date, endTime) : null;
  if (end && end <= start) end.setDate(end.getDate() + 1); // se termine après minuit
  const duration = Number(durationMinutes) > 0 ? Number(durationMinutes) : DEFAULT_DURATION_MIN;
  if (!end) end = new Date(start.getTime() + duration * 60000);
  return { allDay: false, start, end };
}

/**
 * Construit le contenu .ics d'un événement.
 * @param {{id:string,title:string,date:string,time?:string,endTime?:string,
 *          location?:string,description?:string,alarmMinutes?:number,
 *          repeat?:'daily'|'weekly'|'monthly'|'yearly'}} event
 */
export function buildICS(event) {
  const span = eventWindow(event);
  if (!span) throw new Error('Date de l’événement invalide.');
  const { allDay, start, end } = span;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // UID stable : réimporter un rendez-vous modifié met à jour l'événement existant.
    `UID:${escapeText(event.id)}@mon-dashboard`,
    `DTSTAMP:${toUTC(new Date())}`,
    allDay ? `DTSTART;VALUE=DATE:${toDateValue(start)}` : `DTSTART:${toUTC(start)}`,
    allDay ? `DTEND;VALUE=DATE:${toDateValue(end)}` : `DTEND:${toUTC(end)}`,
    `SUMMARY:${escapeText(event.title)}`
  ];
  if (isRepeat(event.repeat)) lines.push(`RRULE:FREQ=${REPEATS[event.repeat].rrule}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.sequence) lines.push(`SEQUENCE:${event.sequence}`);
  lines.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE');
  const alarm = Number(event.alarmMinutes);
  if (!allDay && Number.isFinite(alarm) && alarm > 0) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(event.title)}`, `TRIGGER:-PT${Math.round(alarm)}M`, 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

const fileName = title =>
  `${String(title || 'evenement')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/(^-|-$)/g, '')
    .toLowerCase()
    .slice(0, 50) || 'evenement'}.ics`;

/**
 * Ouvre l'événement dans le calendrier. À appeler depuis un gestionnaire de clic.
 * - iOS : navigation vers une data-URL text/calendar -> fiche native Calendrier.
 * - Autres : téléchargement d'un fichier .ics (ouvert par Calendrier, Outlook…).
 */
export function openInCalendar(ics, title) {
  const name = fileName(title);
  if (isIOS()) {
    const link = document.createElement('a');
    link.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
    link.rel = 'noopener';
    link.target = '_self';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return 'ios';
  }
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'download';
}

/** Solution de repli : feuille de partage système avec le fichier .ics. */
export async function shareICS(ics, title) {
  const file = new File([ics], fileName(title), { type: 'text/calendar' });
  if (!navigator.canShare?.({ files: [file] })) return false;
  await navigator.share({ files: [file], title });
  return true;
}
