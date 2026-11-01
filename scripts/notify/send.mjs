/*
 * Notifications de Carnet (Web Push), lancé par
 * .github/workflows/notifications.yml (heure de Paris : TZ=Europe/Paris).
 *
 * Pour chaque compte, lit dans Firebase :
 *  - users/<uid>/carnet_push/devices/<appareil> : abonnements écrits par l'app
 *    (Réglages → Notifications), avec les préférences de l'appareil ;
 *  - users/<uid>/carnet : agenda, tâches et planning ;
 * puis envoie :
 *  - un rappel avant chaque rendez-vous / événement à heure fixe (délai `lead`, en minutes) ;
 *  - un rappel à l'heure des tâches qui en ont une ;
 *  - un résumé du matin à l'heure `morning` (séances, rendez-vous, tâches du jour et en retard,
 *    échéances Garage / Maison) ;
 *  - une notification quand Mon Garage ou Ma Maison publie une nouvelle tâche (`linked`).
 * Chaque envoi est noté dans users/<uid>/carnet_push/sent : jamais deux fois, même si
 * GitHub lance la tâche en retard. Un abonnement expiré (404/410) est supprimé.
 *
 * Secrets (dépôt → Settings → Secrets and variables → Actions) :
 *  FIREBASE_SERVICE_ACCOUNT (JSON du compte de service), VAPID_PRIVATE_KEY.
 * Sans eux, le script s'arrête sans erreur (rien n'est envoyé).
 *
 * `node send.mjs --dry` : affiche ce qui serait envoyé, sans rien envoyer ni noter.
 */
import { createHash } from 'node:crypto';
import { dateKey, addDays, combine, occurrencesBetween, nextTaskDate, isTime } from '../../js/core/dates.js';
import { normalizeDashboard, normalizeFamilies, normalizePlans, isRestTraining } from '../../js/core/schema.js';

export const VAPID_PUBLIC_KEY = 'BBWMKxkxDXx0JH9c04kgLlBXBrrql91E4DZIZLejdfgULy1qQEdKBZAZUuGoEp8U0ZctPmh0Deex1mbVuMsrqsU';
const VAPID_SUBJECT = 'https://benjbepoix-stack.github.io/Mon-tableau-de-bord/';
const DATABASE_URL = 'https://test-e27e9-default-rtdb.europe-west1.firebasedatabase.app/';
/** Résumé du matin : envoyé au plus tard 3 h après l'heure choisie (sinon on attend le lendemain). */
const MORNING_WINDOW_MS = 3 * 3600_000;
/** Tâche à heure fixe : rappel jusqu'à 30 min après l'heure. */
const TASK_WINDOW_MS = 30 * 60_000;
const KEEP_SENT_MS = 3 * 86400_000;
/** Échéance Garage / Maison disparue : oubliée après 60 jours (si elle revient avant, pas de nouvelle notification). */
const KEEP_LINKED_MS = 60 * 86400_000;
const APP_NAMES = { garage: 'Mon Garage', maison: 'Ma Maison' };

const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/** 08:15 → « 8 h 15 ». */
const spoken = t => `${Number(t.slice(0, 2))} h ${t.slice(3)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
/** Clé Firebase sûre (ni . $ # [ ] /). */
const safe = s => String(s).replace(/[.$#[\]/]/g, '_');

const asList = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []).filter(x => x && typeof x === 'object');
const isDue = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Tâches publiées par Mon Garage (`garage_alerts`) et Ma Maison (`maison_alerts`, y compris
 * les tâches de saison du mois), lues comme dans js/features/linked-apps.js.
 * La clé ignore le texte (« dans 12 j » change chaque jour) : titre, véhicule et échéance.
 */
export function linkedTasks(node) {
  const out = [];
  const add = (source, label, due, level, extra) =>
    label && out.push({ source, label, due: isDue(due) ? due : '', level: level || '', key: createHash('sha1').update([source, label, isDue(due) ? due : '', extra].join('|')).digest('hex').slice(0, 16) });
  asList(node?.garage_alerts).forEach(v =>
    asList(v.alerts).forEach(a => add('garage', [v.vehicleName, a.title].filter(Boolean).map(String).join(' · '), a.due, a.level))
  );
  const m = node?.maison_alerts;
  if (m && typeof m === 'object' && m.name) {
    asList(m.alerts).filter(a => a.level !== 'info').forEach(a => add('maison', String(a.title || ''), a.due, a.level));
    asList(m.season).forEach(t => add('maison', String(t.label || ''), '', 'info', `saison ${m.seasonMonth || ''}`));
  }
  return out;
}

/**
 * Nouvelles tâches Garage / Maison depuis le dernier passage, et la liste « déjà vues » à jour.
 * Premier passage (rien de connu) : tout est noté comme vu, sans notification.
 */
export function newLinkedTasks(node, seen, now) {
  const current = linkedTasks(node);
  const first = !seen;
  // `_init` : la liste existe même vide (sinon un compte sans échéance resterait au « premier passage »).
  const known = { _init: now.getTime(), ...(seen || {}) };
  const fresh = [];
  const currentKeys = new Set(current.map(t => t.key));
  for (const t of current) {
    if (known[t.key]) continue;
    known[t.key] = now.getTime();
    if (!first && !fresh.some(f => f.key === t.key)) fresh.push(t);
  }
  for (const [k, at] of Object.entries(known)) if (k !== '_init' && !currentKeys.has(k) && now - at > KEEP_LINKED_MS) delete known[k];
  return { fresh, seen: known, changed: first || JSON.stringify(known) !== JSON.stringify(seen) };
}

/** Une notification par app pour ses nouvelles tâches. */
export function linkedNotifications(fresh) {
  return Object.keys(APP_NAMES)
    .map(source => {
      const list = fresh.filter(t => t.source === source);
      if (!list.length) return null;
      const line = t => `${t.label}${t.due ? ` (${t.due.slice(8)}/${t.due.slice(5, 7)})` : ''}${t.level === 'late' ? ' · en retard' : ''}`;
      return {
        key: `linked_${source}_${list.map(t => t.key).join('').slice(0, 24)}`,
        title: list.length > 1 ? `${APP_NAMES[source]} · ${list.length} nouvelles tâches` : `${APP_NAMES[source]} · nouvelle tâche`,
        body: list.slice(0, 4).map(line).join('\n') + (list.length > 4 ? '\n…' : ''),
        tag: `linked-${source}`,
        url: './'
      };
    })
    .filter(Boolean);
}

function leadLabel(min) {
  if (min <= 0) return 'Maintenant';
  if (min < 60) return `Dans ${min} min`;
  if (min % 60 === 0) return `Dans ${min / 60} h`;
  return `Dans ${Math.floor(min / 60)} h ${min % 60}`;
}

/** Tâches à faire aujourd'hui (ou en retard), comme dans l'app : une tâche répétée cochée revient à sa prochaine échéance. */
function openTasks(tasks, today) {
  return tasks
    .map(t => {
      if (!t.done) return t;
      if (t.repeat && t.doneAt && t.doneAt < today) return { ...t, done: false, date: nextTaskDate(t) };
      return null;
    })
    .filter(t => t && !t.done && t.date && t.date <= today);
}

/**
 * Notifications dues pour un appareil, à l'instant `now`.
 * @returns {{key:string,title:string,body:string,tag:string,url:string}[]}
 */
export function dueNotifications(node, prefs, now, sent = {}) {
  const out = [];
  const dash = normalizeDashboard(node?.dashboard);
  const families = normalizeFamilies(node?.families);
  const plans = normalizePlans(node?.plans, families);
  const today = dateKey(now);
  const tomorrow = dateKey(addDays(now, 1));
  const lead = Number.isFinite(prefs?.lead) ? prefs.lead : 60;
  const push = n => !sent[n.key] && out.push(n);

  // Rendez-vous et événements à heure fixe.
  if (prefs?.appts !== false && lead >= 0) {
    for (const [kind, list] of [['rdv', dash.appointments], ['evt', dash.events]]) {
      for (const item of list) {
        if (!isTime(item.time)) continue;
        for (const day of occurrencesBetween(item, today, tomorrow)) {
          const start = combine(day, item.time);
          if (!start || now < start - lead * 60_000 || now >= start) continue;
          const left = Math.max(0, Math.round((start - now) / 60_000));
          push({
            key: safe(`${kind}_${item.id}_${day}_${item.time}`),
            title: `${leadLabel(left)} · ${item.title}`,
            body: [`${day === today ? 'Aujourd’hui' : 'Demain'} à ${spoken(item.time)}`, item.location].filter(Boolean).join(' · '),
            tag: `${kind}-${item.id}`,
            url: './'
          });
        }
      }
    }
  }

  // Tâches avec une heure : rappel à l'heure.
  if (prefs?.tasks !== false) {
    for (const t of openTasks(dash.tasks, today)) {
      if (t.date !== today || !isTime(t.time)) continue;
      const at = combine(t.date, t.time);
      if (now < at || now - at > TASK_WINDOW_MS) continue;
      push({ key: safe(`task_${t.id}_${t.date}_${t.time}`), title: `À faire · ${t.title}`, body: t.note || `Prévu à ${spoken(t.time)}`, tag: `task-${t.id}`, url: './' });
    }
  }

  // Résumé du matin.
  if (isTime(prefs?.morning)) {
    const at = combine(today, prefs.morning);
    if (now >= at && now - at < MORNING_WINDOW_MS) {
      const famName = id => families.find(f => f.id === id)?.name || '';
      const sessions = (plans[today] || []).filter(s => s.family && !isRestTraining(s.training));
      const appts = [...dash.appointments, ...dash.events]
        .filter(x => occurrencesBetween(x, today, today).length)
        .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
      const tasks = openTasks(dash.tasks, today);
      const late = tasks.filter(t => t.date < today).length;
      const lines = [];
      // Sport puis type de séance : « Course à pied · Footing facile · 10 km ».
      if (sessions.length) lines.push(`Sport : ${sessions.map(s => [famName(s.family), s.training, s.distance && `${s.distance} km`].filter(Boolean).join(' · ')).join(' / ')}`);
      if (appts.length) lines.push(`Agenda : ${appts.slice(0, 3).map(x => (x.time ? `${x.time.replace(':', 'h')} ${x.title}` : x.title)).join(', ')}${appts.length > 3 ? '…' : ''}`);
      if (tasks.length) lines.push(`À faire : ${plural(tasks.length, 'tâche')}${late ? ` dont ${late} en retard` : ''}`);
      if (prefs?.linked !== false) {
        const due = linkedTasks(node).filter(t => t.level === 'late' || (t.due && t.due <= today));
        if (due.length) lines.push(`Garage / Maison : ${due.slice(0, 2).map(t => t.label).join(', ')}${due.length > 2 ? ` et ${due.length - 2} autre${due.length > 3 ? 's' : ''}` : ''}`);
      }
      if (lines.length) {
        // Une fois par jour et par heure choisie : changer l'heure renvoie le résumé à la nouvelle heure.
        push({ key: safe(`morning_${today}_${prefs.morning}`), title: 'Ta journée', body: lines.join('\n'), tag: 'morning', url: './' });
      }
    }
  }
  return out;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const account = process.env.FIREBASE_SERVICE_ACCOUNT;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!account || (!vapidPrivate && !dry)) {
    console.log('Secrets FIREBASE_SERVICE_ACCOUNT / VAPID_PRIVATE_KEY absents : rien à faire.');
    return;
  }
  const [{ initializeApp, cert }, { getDatabase }, webpush] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/database'),
    import('web-push').then(m => m.default)
  ]);
  const credential = cert(JSON.parse(account));
  initializeApp({ credential, databaseURL: DATABASE_URL });
  const db = getDatabase();
  if (!dry) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, vapidPrivate);

  // Jeton OAuth du compte de service, réutilisé tant qu'il est valable (1 h).
  let token = null;
  let tokenUntil = 0;
  const accessToken = async () => {
    if (Date.now() > tokenUntil) {
      const t = await credential.getAccessToken();
      token = t.access_token;
      tokenUntil = Date.now() + (t.expires_in - 120) * 1000;
    }
    return token;
  };

  // GitHub ne lance la tâche planifiée que toutes les quelques heures : chaque lancement
  // tourne donc en boucle (un passage par minute) pendant LOOP_MINUTES, puis s'arrête.
  const loopMinutes = Number(process.env.LOOP_MINUTES) || 0;
  const end = Date.now() + loopMinutes * 60_000;
  let lastLog = '';
  do {
    const started = Date.now();
    try {
      const { devices, sent } = await pass(db, webpush, accessToken, dry);
      const line = `${devices} appareil(s) abonné(s)`;
      if (sent || line !== lastLog) console.log(`${hm(new Date())} · ${line} · ${sent} notification(s) envoyée(s)`);
      lastLog = line;
    } catch (error) {
      console.warn(`${hm(new Date())} · passage en erreur :`, error.message || error);
    }
    if (Date.now() + 60_000 >= end) break;
    await new Promise(r => setTimeout(r, Math.max(0, 60_000 - (Date.now() - started))));
  } while (Date.now() < end);
}

/**
 * Lecture d'un chemin via un écouteur gardé ouvert : le premier passage télécharge le
 * nœud, les suivants ne reçoivent que les changements (quota de téléchargement Firebase).
 */
const live = new Map();
function read(db, path) {
  if (!live.has(path)) {
    live.set(path, new Promise((resolve, reject) => {
      const entry = { value: null };
      db.ref(path).on('value', snap => {
        entry.value = snap.val();
        resolve(entry);
      }, reject);
    }));
  }
  return live.get(path).then(entry => entry.value);
}

/** Un passage : envoie tout ce qui est dû maintenant. */
async function pass(db, webpush, accessToken, dry) {
  const now = new Date();
  // Liste des comptes sans leur contenu (REST shallow) : on ne télécharge que ceux qui ont un appareil abonné.
  const token = await accessToken();
  const res = await fetch(`${DATABASE_URL}users.json?shallow=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Lecture des comptes impossible (${res.status})`);
  const uids = Object.keys((await res.json()) || {});
  let total = 0;
  let count = 0;
  for (const uid of uids) {
    const push = await read(db, `users/${uid}/carnet_push`);
    const devices = push?.devices;
    if (!devices || typeof devices !== 'object') continue;
    count += Object.values(devices).filter(d => d?.subscription?.endpoint).length;
    const user = { carnet_push: push, carnet: await read(db, `users/${uid}/carnet`) };
    const sentRef = db.ref(`users/${uid}/carnet_push/sent`);
    const updates = {};
    // Nouvelles tâches de Mon Garage / Ma Maison (une détection par compte, pour tous ses appareils).
    const linked = newLinkedTasks(user.carnet, push.linked_seen, now);
    const linkedList = linkedNotifications(linked.fresh);
    for (const [deviceId, device] of Object.entries(devices)) {
      if (!device?.subscription?.endpoint) continue;
      const sent = user.carnet_push.sent?.[deviceId] || {};
      for (const [key, at] of Object.entries(sent)) if (now - at > KEEP_SENT_MS) updates[`${deviceId}/${key}`] = null;
      // Essai demandé depuis les Réglages il y a moins d'une heure.
      const list = device.test && now - device.test < 3600_000
        ? [{ key: `test_${device.test}`, title: 'Carnet', body: 'Les notifications fonctionnent sur cet appareil.', tag: 'test', url: './' }].filter(n => !sent[n.key])
        : [];
      list.push(...dueNotifications(user.carnet, device.prefs, now, sent));
      if (device.prefs?.linked !== false) list.push(...linkedList.filter(n => !sent[n.key]));
      for (const n of list) {
        console.log(`${dry ? '[essai] ' : ''}${uid.slice(0, 6)}… ${deviceId} → ${n.title} | ${n.body.replace(/\n/g, ' / ')}`);
        if (dry) continue;
        try {
          await webpush.sendNotification(device.subscription, JSON.stringify(n), { TTL: 3600, urgency: 'high' });
          updates[`${deviceId}/${n.key}`] = now.getTime();
          total++;
        } catch (error) {
          console.warn(`Envoi refusé (${error.statusCode || error.message})`);
          if (error.statusCode === 404 || error.statusCode === 410) {
            await db.ref(`users/${uid}/carnet_push/devices/${deviceId}`).remove();
            // Firebase refuse un chemin et son parent dans le même update.
            for (const k of Object.keys(updates)) if (k.startsWith(`${deviceId}/`)) delete updates[k];
            updates[deviceId] = null;
            break;
          }
        }
      }
    }
    if (!dry && Object.keys(updates).length) await sentRef.update(updates);
    if (!dry && linked.changed) await db.ref(`users/${uid}/carnet_push/linked_seen`).set(linked.seen);
  }
  return { devices: count, sent: total };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0), error => {
    console.error(error);
    process.exit(1);
  });
}
