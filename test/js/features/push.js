/*
 * Notifications (Web Push) — bloc « Notifications » des Réglages.
 *
 * L'app abonne l'appareil (permission du navigateur + PushManager du service worker)
 * et enregistre l'abonnement et les préférences dans
 * users/<uid>/carnet_push/devices/<appareil>. L'envoi est fait toutes les 10 minutes
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
const DEFAULT_PREFS = { appts: true, lead: 60, tasks: true, morning: '07:30' };

const LEADS = [[15, '15 min avant'], [30, '30 min avant'], [60, '1 h avant'], [120, '2 h avant'], [1440, 'La veille (24 h avant)'], [-1, 'Pas de rappel']];
const MORNINGS = ['06:30', '07:00', '07:30', '08:00', '08:30', '09:00'];

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
    prefs: { appts: p.lead >= 0, lead: Math.max(0, p.lead), tasks: p.tasks, morning: p.morning || '' },
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
  // Essai de bout en bout : le serveur enverra la sienne à son prochain passage (10 min au plus, souvent moins).
  await save(sub, { test: Date.now() });
  toast('Une 2ᵉ notification arrivera du serveur d’ici 10 minutes', { type: 'info', duration: 4000 });
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
    box.innerHTML = `${line('Rappels avant vos rendez-vous et résumé de la journée chaque matin, même app fermée.')}
      <button type="button" class="btn btn--primary btn--block" data-push="on">Activer les notifications</button>`;
    return;
  }
  const p = prefs();
  box.innerHTML = `
    <div class="field"><label class="field__label" for="pushLead">Rendez-vous et événements</label>${select('pushLead', LEADS, p.lead)}</div>
    <div class="field"><label class="field__label" for="pushMorning">Résumé du matin</label>${select('pushMorning', [...MORNINGS.map(t => [t, `Chaque jour à ${Number(t.slice(0, 2))} h ${t.slice(3)}`]), ['', 'Pas de résumé']], p.morning)}</div>
    <div class="field"><label class="field__label" for="pushTasks">Tâches avec une heure</label>${select('pushTasks', [['1', 'Rappel à l’heure'], ['0', 'Pas de rappel']], p.tasks ? '1' : '0')}</div>
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
    else if (e.target.id === 'pushMorning') p.morning = e.target.value;
    else if (e.target.id === 'pushTasks') p.tasks = e.target.value === '1';
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
