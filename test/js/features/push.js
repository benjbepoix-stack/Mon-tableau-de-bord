/*
 * Notifications (Web Push) — bloc « Notifications » des Réglages : résumé du matin,
 * rappels de rendez-vous et de tâches, nouvelles tâches de Mon Garage / Ma Maison.
 *
 * L'app abonne l'appareil (permission du navigateur + PushManager du service worker)
 * et enregistre l'abonnement et les préférences dans
 * users/<uid>/carnet_push/devices/<appareil>. L'envoi est vérifié chaque minute
 * par la tâche GitHub .github/workflows/notifications.yml (scripts/notify/send.mjs),
 * qui lit l'agenda, les tâches et le planning du même compte.
 *
 * iPhone : iOS 16.4+ et app ouverte depuis l'écran d'accueil (Safari seul ne peut pas).
 */
import { $, esc } from '../core/utils.js';
import { readJSON, readText, write } from '../services/storage.js';
import { currentUser, setUserPath } from '../services/firebase.js';
import { isIOS, isStandalone } from './ics.js';
import { toast, toastError } from '../ui/toast.js';

/** Clé publique VAPID (la clé privée est le secret VAPID_PRIVATE_KEY du dépôt). */
const VAPID_PUBLIC_KEY = 'BBWMKxkxDXx0JH9c04kgLlBXBrrql91E4DZIZLejdfgULy1qQEdKBZAZUuGoEp8U0ZctPmh0Deex1mbVuMsrqsU';
const PREFS_KEY = 'carnet_push_prefs';
const DEVICE_KEY = 'carnet_push_device';
const DEFAULT_PREFS = { appts: true, lead: 60, tasks: true, linked: true, morning: '07:30', morningTime: '07:30' };

const LEADS = [[15, '15 min avant'], [30, '30 min avant'], [60, '1 h avant'], [120, '2 h avant'], [1440, 'La veille (24 h avant)'], [-1, 'Pas de rappel']];

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const prefs = () => ({ ...DEFAULT_PREFS, ...readJSON(PREFS_KEY, {}) });
const appLabel = () => (location.pathname.includes('/test/') ? 'test' : 'prod');

function deviceId() {
  let id = readText(DEVICE_KEY, '');
  if (!id) {
    id = `${isIOS() ? 'iphone' : /android/i.test(navigator.userAgent) ? 'android' : 'web'}-${Math.random().toString(36).slice(2, 10)}`;
    write(DEVICE_KEY, id);
  }
  return id;
}

/** Un enregistrement par appareil et par app (test/ et la racine ont chacune leur service worker). */
const devicePath = () => `carnet_push/devices/${deviceId()}-${appLabel()}`;

function keyBytes(base64) {
  const b64 = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function subscription() {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Enregistre l'abonnement et les préférences de cet appareil dans le compte. */
async function save(sub, extra = {}) {
  const p = prefs();
  await setUserPath(devicePath(), {
    subscription: sub.toJSON(),
    prefs: { appts: p.lead >= 0, lead: Math.max(0, p.lead), tasks: p.tasks, linked: p.linked, morning: p.morning || '' },
    app: appLabel(),
    updatedAt: Date.now(),
    ...extra
  });
}

async function enable() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    render();
    return toastError('Notifications refusées sur cet appareil.');
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }));
  await save(sub);
  toast('Notifications activées sur cet appareil', { type: 'success' });
}

async function disable() {
  const sub = await subscription();
  await sub?.unsubscribe().catch(() => {});
  await setUserPath(devicePath(), null).catch(() => {});
  toast('Notifications désactivées sur cet appareil', { type: 'info' });
}

async function sendTest() {
  const sub = await subscription();
  if (!sub) return;
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('Carnet', { body: 'Voici à quoi ressemblera une notification.', icon: 'icon-192.png', badge: 'icon-192.png', tag: 'local-test' });
  // Essai de bout en bout : le serveur enverra la sienne à son prochain passage (1 à 2 min).
  await save(sub, { test: Date.now() });
  toast('Une 2ᵉ notification arrivera du serveur d’ici 1 à 2 minutes', { type: 'info', duration: 4000 });
}

const select = (id, options, value) =>
  `<select class="input select" id="${id}">${options.map(([v, label]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;

/** Contenu du bloc Notifications, selon l'appareil, le compte et la permission. */
export async function render() {
  const box = $('#pushBlock');
  if (!box) return;
  const line = text => `<p class="account__line">${text}</p>`;
  if (isIOS() && !isStandalone()) {
    box.innerHTML = line('Sur iPhone, ajoutez d’abord Carnet à l’écran d’accueil (Partager → « Sur l’écran d’accueil »), puis ouvrez-la depuis son icône.');
    return;
  }
  if (!supported()) {
    box.innerHTML = line('Ce navigateur ne permet pas les notifications.');
    return;
  }
  if (!currentUser()) {
    box.innerHTML = line('Connectez-vous pour recevoir des notifications.');
    return;
  }
  if (Notification.permission === 'denied') {
    box.innerHTML = line(isIOS() ? 'Notifications refusées : Réglages de l’iPhone → Notifications → Carnet.' : 'Notifications refusées : autorisez-les dans les réglages du navigateur pour ce site.');
    return;
  }
  const sub = Notification.permission === 'granted' ? await subscription() : null;
  if (!sub) {
    box.innerHTML = `${line('Résumé de la journée chaque matin, rappels avant vos rendez-vous et nouvelles tâches de Mon Garage et Ma Maison, même app fermée.')}
      <button type="button" class="btn btn--primary btn--block" data-push="on">Activer les notifications</button>`;
    return;
  }
  const p = prefs();
  box.innerHTML = `
    <div class="field"><label class="field__label" for="pushMorningOn">Résumé de la journée</label>${select('pushMorningOn', [['1', 'Chaque jour'], ['0', 'Pas de résumé']], p.morning ? '1' : '0')}</div>
    <div class="field"${p.morning ? '' : ' hidden'}><label class="field__label" for="pushMorningTime">À quelle heure</label><input class="input" type="time" id="pushMorningTime" value="${esc(p.morning || p.morningTime)}"></div>
    <div class="field"><label class="field__label" for="pushLead">Rendez-vous et événements</label>${select('pushLead', LEADS, p.lead)}</div>
    <div class="field"><label class="field__label" for="pushTasks">Tâches avec une heure</label>${select('pushTasks', [['1', 'Rappel à l’heure'], ['0', 'Pas de rappel']], p.tasks ? '1' : '0')}</div>
    <div class="field"><label class="field__label" for="pushLinked">Mon Garage et Ma Maison</label>${select('pushLinked', [['1', 'À chaque nouvelle tâche'], ['0', 'Pas de notification']], p.linked ? '1' : '0')}</div>
    <button type="button" class="btn btn--soft btn--block" data-push="test">Envoyer une notification d’essai</button>
    <button type="button" class="btn btn--ghost btn--block" data-push="off">Désactiver sur cet appareil</button>`;
}

/** Après connexion : met à jour l'abonnement de l'appareil (il peut changer). */
export async function syncPush() {
  try {
    if (!currentUser() || !supported() || Notification.permission !== 'granted') return;
    const sub = await subscription();
    if (sub) await save(sub);
  } catch (error) {
    console.warn('[push] synchro', error);
  }
}

export function initPush() {
  const box = $('#pushBlock');
  if (!box) return;
  box.addEventListener('click', async e => {
    const action = e.target.closest('[data-push]')?.dataset.push;
    if (!action) return;
    const btn = e.target.closest('button');
    btn.disabled = true;
    try {
      if (action === 'on') await enable();
      else if (action === 'off') await disable();
      else if (action === 'test') await sendTest();
    } catch (error) {
      console.warn('[push]', error);
      toastError('Impossible de régler les notifications. Réessayez.');
    } finally {
      btn.disabled = false;
      render();
    }
  });
  box.addEventListener('change', async e => {
    const p = prefs();
    if (e.target.id === 'pushLead') p.lead = Number(e.target.value);
    else if (e.target.id === 'pushMorningOn') {
      if (p.morning) p.morningTime = p.morning;
      p.morning = e.target.value === '1' ? p.morningTime || '07:30' : '';
      $('#pushMorningTime').closest('.field').hidden = !p.morning;
    } else if (e.target.id === 'pushMorningTime') {
      // Heure libre ; un champ vidé garde l'heure précédente.
      if (!/^\d{2}:\d{2}$/.test(e.target.value)) return;
      p.morning = p.morningTime = e.target.value;
    }
    else if (e.target.id === 'pushTasks') p.tasks = e.target.value === '1';
    else if (e.target.id === 'pushLinked') p.linked = e.target.value === '1';
    else return;
    write(PREFS_KEY, p);
    try {
      const sub = await subscription();
      if (sub) await save(sub);
    } catch (error) {
      console.warn('[push]', error);
      toastError('Réglage non enregistré (connexion ?).');
    }
  });
}
