/*
 * Notifications de Carnet (Web Push), lancé toutes les 10 minutes par
 * .github/workflows/notifications.yml (heure de Paris : TZ=Europe/Paris).
 *
 * Pour chaque compte, lit dans Firebase :
 *  - users/<uid>/carnet_push/devices/<appareil> : abonnements écrits par l'app
 *    (Réglages → Notifications), avec les préférences de l'appareil ;
 *  - users/<uid>/carnet : agenda, tâches et planning ;
 * puis envoie :
 *  - un rappel avant chaque rendez-vous / événement à heure fixe (délai `lead`, en minutes) ;
 *  - un rappel à l'heure des tâches qui en ont une ;
 *  - un résumé du matin à l'heure `morning` (séances, rendez-vous, tâches du jour et en retard).
 * Chaque envoi est noté dans users/<uid>/carnet_push/sent : jamais deux fois, même si
 * GitHub lance la tâche en retard. Un abonnement expiré (404/410) est supprimé.
 *
 * Secrets (dépôt → Settings → Secrets and variables → Actions) :
 *  FIREBASE_SERVICE_ACCOUNT (JSON du compte de service), VAPID_PRIVATE_KEY.
 * Sans eux, le script s'arrête sans erreur (rien n'est envoyé).
 *
 * `node send.mjs --dry` : affiche ce qui serait envoyé, sans rien envoyer ni noter.
 */
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

const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/** 08:15 → « 8 h 15 ». */
const spoken = t => `${Number(t.slice(0, 2))} h ${t.slice(3)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
/** Clé Firebase sûre (ni . $ # [ ] /). */
const safe = s => String(s).replace(/[.$#[\]/]/g, '_');

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
      if (sessions.length) lines.push(`Sport : ${sessions.map(s => [s.training || famName(s.family), s.distance && `${s.distance} km`].filter(Boolean).join(' ')).join(', ')}`);
      if (appts.length) lines.push(`Agenda : ${appts.slice(0, 3).map(x => (x.time ? `${x.time.replace(':', 'h')} ${x.title}` : x.title)).join(', ')}${appts.length > 3 ? '…' : ''}`);
      if (tasks.length) lines.push(`À faire : ${plural(tasks.length, 'tâche')}${late ? ` dont ${late} en retard` : ''}`);
      if (lines.length) {
        push({ key: `morning_${today}`, title: 'Ta journée', body: lines.join('\n'), tag: 'morning', url: './' });
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

  const now = new Date();
  // Liste des comptes sans leur contenu (REST shallow) : on ne télécharge que ceux qui ont un appareil abonné.
  const { access_token: token } = await credential.getAccessToken();
  const res = await fetch(`${DATABASE_URL}users.json?shallow=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Lecture des comptes impossible (${res.status})`);
  const uids = Object.keys((await res.json()) || {});
  let total = 0;
  for (const uid of uids) {
    const push = (await db.ref(`users/${uid}/carnet_push`).get()).val();
    const devices = push?.devices;
    if (!devices || typeof devices !== 'object') continue;
    const user = { carnet_push: push, carnet: (await db.ref(`users/${uid}/carnet`).get()).val() };
    const sentRef = db.ref(`users/${uid}/carnet_push/sent`);
    const updates = {};
    for (const [deviceId, device] of Object.entries(devices)) {
      if (!device?.subscription?.endpoint) continue;
      const sent = user.carnet_push.sent?.[deviceId] || {};
      for (const [key, at] of Object.entries(sent)) if (now - at > KEEP_SENT_MS) updates[`${deviceId}/${key}`] = null;
      // Essai demandé depuis les Réglages il y a moins d'une heure.
      const list = device.test && now - device.test < 3600_000
        ? [{ key: `test_${device.test}`, title: 'Carnet', body: 'Les notifications fonctionnent sur cet appareil.', tag: 'test', url: './' }].filter(n => !sent[n.key])
        : [];
      list.push(...dueNotifications(user.carnet, device.prefs, now, sent));
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
  }
  console.log(`${total} notification(s) envoyée(s) à ${hm(now)}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0), error => {
    console.error(error);
    process.exit(1);
  });
}
