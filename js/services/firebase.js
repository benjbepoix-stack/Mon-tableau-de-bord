/*
 * Synchronisation Firebase Realtime Database.
 *
 * - Le SDK est chargé dynamiquement : si le CDN est inaccessible (hors ligne,
 *   bloqueur…), l'application continue en mode local sans planter.
 * - Les écritures sont regroupées (debounce) puis envoyées en un seul `update`.
 * - Tant que la première lecture n'est pas arrivée, les modifications locales
 *   sont mises en attente et ne sont pas écrasées par le cloud.
 * - L'état de connexion est exposé via `onStatus` :
 *   connecting | online | syncing | offline | local
 */
import { FIREBASE_CONFIG, FIREBASE_SDK_VERSION, DB_ROOT } from '../config/firebase-config.js';

const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
const LOAD_TIMEOUT = 12000;
const WRITE_DELAY = 250;
const NOTES_DELAY = 700;

let api = null;
let rootRef = null;
let ready = false;
let connected = null;
let fatal = null;
let inflight = 0;
let buffer = {};
let flushTimer = null;
let handlers = { onRemote: () => {}, onStatus: () => {}, onError: () => {}, getSnapshot: () => ({}) };

function emitStatus() {
  let status;
  if (fatal) status = 'local';
  else if (connected === false) status = 'offline';
  else if (!ready) status = 'connecting';
  else if (inflight > 0 || Object.keys(buffer).length) status = 'syncing';
  else status = 'online';
  handlers.onStatus(status, fatal);
}

const withTimeout = (promise, ms, message) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);

function describeError(error) {
  const code = String(error?.code || error?.message || '');
  if (/permission/i.test(code)) return 'Accès refusé par les règles Firebase.';
  if (/timeout|délai/i.test(code)) return 'Firebase ne répond pas.';
  if (/fetch|import|network|load/i.test(code)) return 'Impossible de charger Firebase (connexion ?).';
  return 'Service de synchronisation indisponible.';
}

function goLocal(error) {
  fatal = describeError(error);
  ready = false;
  console.warn('[firebase] passage en mode local :', error);
  emitStatus();
}

/** Supprime les `undefined` (refusés par Firebase) via un aller-retour JSON. */
const clean = value => JSON.parse(JSON.stringify(value));

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!ready || fatal || !Object.keys(buffer).length) return emitStatus();
  const payload = clean(buffer);
  buffer = {};
  inflight++;
  emitStatus();
  api
    .update(rootRef, payload)
    .catch(error => {
      console.error('[firebase] écriture refusée', error);
      handlers.onError(describeError(error));
      if (/permission/i.test(String(error?.code))) goLocal(error);
    })
    .finally(() => {
      inflight--;
      emitStatus();
    });
}

/** Met en file une écriture partielle ({ tranche: valeur }). */
export function pushCloud(payload) {
  Object.assign(buffer, payload);
  if (fatal) return;
  const onlyNotes = Object.keys(buffer).every(k => k === 'notes');
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, onlyNotes ? NOTES_DELAY : WRITE_DELAY);
  emitStatus();
}

/** Tranches modifiées localement et pas encore envoyées. */
export const pendingSlices = () => new Set(Object.keys(buffer));

/** Force l'envoi immédiat (ex. : l'app passe en arrière-plan). */
export const flushNow = () => flushTimer && flush();

/** Attend que toutes les écritures soient confirmées par le serveur (max `ms`). */
export async function waitForSync(ms = 6000) {
  flushNow();
  const start = Date.now();
  while ((inflight > 0 || Object.keys(buffer).length) && Date.now() - start < ms) {
    await new Promise(r => setTimeout(r, 120));
  }
  return !fatal && ready && inflight === 0;
}

export const isCloudAvailable = () => ready && !fatal;
export const isOnline = () => ready && !fatal && connected === true;

export async function initCloud(options) {
  handlers = { ...handlers, ...options };
  emitStatus();
  try {
    const [appMod, dbMod] = await withTimeout(
      Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-database.js`)]),
      LOAD_TIMEOUT,
      'timeout chargement SDK'
    );
    const app = appMod.initializeApp(FIREBASE_CONFIG);
    const db = dbMod.getDatabase(app);
    api = dbMod;
    rootRef = dbMod.ref(db, DB_ROOT);

    dbMod.onValue(dbMod.ref(db, '.info/connected'), snap => {
      connected = snap.val() === true;
      emitStatus();
    });

    let first = true;
    dbMod.onValue(
      rootRef,
      snap => {
        const cloud = snap.val();
        if (first) {
          first = false;
          const hasData = cloud && typeof cloud === 'object' && Object.keys(cloud).length > 0;
          if (hasData) {
            handlers.onRemote(cloud, pendingSlices());
          } else {
            // Base vide : les données locales deviennent la référence.
            Object.assign(buffer, handlers.getSnapshot(), buffer);
          }
          ready = true;
          flush();
          return;
        }
        if (cloud && typeof cloud === 'object') handlers.onRemote(cloud, pendingSlices());
      },
      goLocal
    );
  } catch (error) {
    goLocal(error);
  }
}
