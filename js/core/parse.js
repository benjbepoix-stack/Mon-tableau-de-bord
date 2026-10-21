/*
 * Saisie en langage naturel : « dentiste jeudi 17h30 », « payer la cantine demain »,
 * « anniversaire de Léa le 4/11 ». Renvoie le titre nettoyé, la date et l'heure reconnues.
 */
import { addDays, dateKey } from './dates.js';

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/** @returns {{ title: string, date: string, time: string }} date AAAA-MM-JJ et heure HH:MM, ou '' */
export function parseEntry(text, now = new Date()) {
  const s = ` ${text.toLowerCase()} `;
  let title = ` ${text} `;
  let offset = null;
  let date = '';
  let time = '';
  const cut = re => (title = title.replace(re, ' '));

  if (/\saujourd'?hui\s/.test(s)) {
    offset = 0;
    cut(/\saujourd'?hui(?=\s)/i);
  } else if (/\sapr[eè]s-demain\s/.test(s)) {
    offset = 2;
    cut(/\sapr[eè]s-demain(?=\s)/i);
  } else if (/\sdemain\s/.test(s)) {
    offset = 1;
    cut(/\sdemain(?=\s)/i);
  } else if (/\sce soir\s/.test(s)) {
    offset = 0;
    time = '19:00';
    cut(/\sce soir(?=\s)/i);
  } else {
    for (let i = 0; i < 7; i++) {
      const re = new RegExp(`\\s${WEEKDAYS[i]}(\\sprochain)?(?=\\s)`, 'i');
      if (re.test(s)) {
        offset = (i - now.getDay() + 7) % 7 || 7;
        cut(re);
        break;
      }
    }
    const m = s.match(/\s(?:le\s)?(\d{1,2})\/(\d{1,2})(?=\s)/);
    if (offset === null && m && +m[2] >= 1 && +m[2] <= 12) {
      let d = new Date(now.getFullYear(), +m[2] - 1, +m[1], 12);
      if (dateKey(d) < dateKey(now)) d = new Date(now.getFullYear() + 1, +m[2] - 1, +m[1], 12);
      date = dateKey(d);
      cut(/\s(?:le\s)?\d{1,2}\/\d{1,2}(?=\s)/i);
    }
  }
  if (offset !== null) date = dateKey(addDays(now, offset));

  const h = s.match(/\s(\d{1,2})\s?h\s?(\d{2})?(?=\s)/);
  if (h && +h[1] < 24 && (!h[2] || +h[2] < 60)) {
    time = `${h[1].padStart(2, '0')}:${h[2] || '00'}`;
    cut(/\s(?:à\s)?\d{1,2}\s?h\s?(?:\d{2})?(?=\s)/i);
  }
  title = title.replace(/\s+/g, ' ').trim();
  if (title) title = title.charAt(0).toUpperCase() + title.slice(1);
  // Une heure seule (sans jour) vaut pour aujourd'hui.
  if (time && !date) date = dateKey(now);
  return { title: title.slice(0, 100), date, time };
}
