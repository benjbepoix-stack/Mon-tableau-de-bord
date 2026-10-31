/*
 * Firebase : compte (e-mail / mot de passe, le même que Mon Garage et Ma Maison)
 * + Realtime Database.
 *
 * - Le SDK est chargé dynamiquement : si le CDN est inaccessible (hors ligne,
 *   bloqueur…), l'application continue en mode local sans planter.
 * - Données : users/<uid>/carnet (tranches de Carnet, partagées avec Allure). Le même
 *   nœud reçoit les échéances de Mon Garage (`garage_alerts`) et de Ma Maison
 *   (`maison_alerts`) : transmises à `onLinked` à chaque instantané, jamais réécrites ici.
 * - Les écritures sont regroupées (debounce) puis envoyées en un seul `update`.
 * - Tant que la première lecture n'est pas arrivée, les modifications locales
 *   sont mises en attente et ne sont pas écrasées par le cloud.
 * - Premier instantané sans `migrated` : transfert unique depuis l'ancienne base
 *   publique (voir `start`).
 * - Sans compte : rien n'est envoyé, les données restent sur l'appareil.
 * - L'état est exposé via `onStatus` : connecting | online | syncing | offline | local
 */
import { FIREBASE_CONFIG, FIREBASE_SDK_VERSION, DB_NODE, LEGACY_DB_URL, LEGACY_DB_PATH } from '../config/firebase-config.js';

const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
const LOAD_TIMEOUT = 12000;
const LEGACY_TIMEOUT = 8000;
const WRITE_DELAY = 250;
const NOTES_DELAY = 700;
const NO_ACCOUNT = 'Sans compte : données enregistrées sur cet appareil uniquement.';

let authMod = null;
let dbMod = null;
let auth = null;
let db = null;
let user = null;
/** Firebase a répondu « pas de compte » (déconnecté, ou « Continuer sans compte »). */
let signedOut = false;
let rootRef = null;
let ready = false;
let connected = null;
let fatal = null;
let inflight = 0;
let buffer = {};
let flushTimer = null;
let unsubscribeData = null;
/** Incrémenté à chaque changement de compte : les réponses d'une session précédente sont ignorées. */
let session = 0;
/** Session dont le premier chargement (transfert compris) est en cours (0 : aucune). */
let startingSession = 0;
let handlers = {
  slices: [],
  onUser: () => {},
  onRemote: () => {},
  onLinked: () => {},
  onReady: () => {},
  onStatus: () => {},
  onError: () => {},
  getSnapshot: () => ({}),
  adaptLegacy: data => data
};

const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function emitStatus() {
  let status;
  let detail = fatal;
  if (fatal) status = 'local';
  else if (signedOut) {
    status = 'local';
    detail = NO_ACCOUNT;
  } else if (connected === false) status = 'offline';
  else if (!ready) status = 'connecting';
  else if (inflight > 0 || Object.keys(buffer).length) status = 'syncing';
  else status = 'online';
  handlers.onStatus(status, detail);
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

export function describeAuthError(error) {
  const map = {
    'auth/invalid-email': 'Adresse e-mail invalide.',
    'auth/invalid-credential': 'E-mail ou mot de passe incorrect.',
    'auth/wrong-password': 'E-mail ou mot de passe incorrect.',
    'auth/user-not-found': 'Aucun compte avec cette adresse e-mail.',
    'auth/missing-password': 'Indiquez votre mot de passe.',
    'auth/email-already-in-use': 'Cette adresse possède déjà un compte : utilisez « Se connecter ».',
    'auth/weak-password': 'Le mot de passe doit contenir au moins 6 caractères.',
    'auth/operation-not-allowed': 'La connexion e-mail / mot de passe n’est pas activée dans Firebase (Authentication → Sign-in method).',
    'auth/network-request-failed': 'Connexion Internet indisponible.',
    'auth/too-many-requests': 'Trop de tentatives. Réessayez dans quelques minutes.'
  };
  return map[error?.code] || 'Une erreur est survenue. Réessayez.';
}

function goLocal(error) {
  fatal = describeError(error);
  ready = false;
  console.warn('[firebase] passage en mode local :', error);
  emitStatus();
}

/** Supprime les `undefined` (refusés par Firebase) via un aller-retour JSON. */
const clean = value => JSON.parse(JSON.stringify(value));

/** Le nœud contient au moins une tranche de Carnet (les échéances et `migrated` ne comptent pas). */
const hasCarnetData = value => isObj(value) && handlers.slices.some(s => value[s] !== undefined && value[s] !== null);

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!ready || fatal || !rootRef || !Object.keys(buffer).length) return emitStatus();
  const payload = clean(buffer);
  const id = session;
  buffer = {};
  inflight++;
  emitStatus();
  dbMod
    .update(rootRef, payload)
    .catch(error => {
      console.error('[firebase] écriture refusée', error);
      // Écriture d'un compte précédent (déconnexion entre-temps) : sans effet sur le compte actuel.
      if (id !== session) return;
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
  // Sans compte : rien à envoyer, ni maintenant ni plus tard (le cloud du compte primera à la connexion).
  if (signedOut) return;
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

/** Abandonne les écritures en attente (changement de compte). */
export function clearPending() {
  clearTimeout(flushTimer);
  flushTimer = null;
  buffer = {};
}

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

/* ---------- Transfert depuis l'ancienne base publique (une seule fois) ---------- */

/** Lecture REST de l'ancienne base (délai max 8 s) : objet, ou null si vide / injoignable. */
async function readLegacy() {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    const data = await withTimeout(
      fetch(`${LEGACY_DB_URL}/${LEGACY_DB_PATH}.json`, { cache: 'no-store', signal: ctrl?.signal }).then(res => (res.ok ? res.json() : null)),
      LEGACY_TIMEOUT,
      'timeout ancienne base'
    );
    return isObj(data) ? data : null;
  } catch (error) {
    ctrl?.abort();
    console.warn('[firebase] ancienne base injoignable', error);
    return null;
  }
}

/** Tranches de Carnet trouvées dans l'ancienne base (pas les échéances de Garage / Maison). */
function legacySlices(legacy) {
  if (!isObj(legacy)) return {};
  const found = Object.fromEntries(handlers.slices.filter(s => legacy[s] !== undefined && legacy[s] !== null).map(s => [s, legacy[s]]));
  return Object.keys(found).length ? handlers.adaptLegacy(found) : {};
}

/**
 * Premier instantané du compte. Sans `migrated`, l'ancienne base est lue une fois :
 * ses tranches sont écrites dans le nouveau nœud (sans écraser celles qu'une autre
 * app y a déjà mises) puis appliquées comme des données distantes. Ancienne base
 * vide ou injoignable : les données de l'appareil deviennent la référence.
 */
async function start(id, latest) {
  startingSession = id;
  try {
    let cloud = latest();
    let migration = null;
    if (!cloud.migrated) {
      const found = legacySlices(await readLegacy());
      if (id !== session) return;
      cloud = latest(); // instantanés reçus pendant la lecture
      // Allure a pu faire le transfert pendant la lecture : sa marque n'est pas réécrite.
      if (!cloud.migrated) {
        const fresh = Object.fromEntries(Object.entries(found).filter(([k]) => cloud[k] === undefined));
        const from = Object.keys(found).length ? new URL(LEGACY_DB_URL).host : 'local';
        migration = { ...fresh, migrated: { from, at: Date.now(), by: 'carnet' } };
        cloud = { ...cloud, ...fresh };
      }
    }
    if (hasCarnetData(cloud)) handlers.onRemote(cloud, pendingSlices());
    // Nœud vide (ou seulement des échéances) : les données de l'appareil deviennent la référence.
    else Object.assign(buffer, handlers.getSnapshot(), buffer);
    // Modifications faites avant la synchro : elles priment sur l'ancienne base.
    if (migration) buffer = { ...migration, ...buffer };
    ready = true;
    flush();
    handlers.onReady();
  } finally {
    if (startingSession === id) startingSession = 0;
  }
}

/** Premier chargement du compte en cours (instantané reçu, transfert de 8 s max éventuel). */
export const isStarting = () => startingSession !== 0 && startingSession === session;

/* ---------- Données du compte ---------- */
function listen(u) {
  unsubscribeData?.();
  const id = ++session;
  ready = false;
  // Accès refusé pour la session précédente (ex. : mot de passe changé ailleurs) : nouvel essai pour ce compte.
  fatal = null;
  rootRef = dbMod.ref(db, `users/${u.uid}/${DB_NODE}`);
  let first = true;
  let value = {};
  unsubscribeData = dbMod.onValue(
    rootRef,
    snap => {
      if (id !== session) return;
      const raw = snap.val();
      value = isObj(raw) ? raw : {};
      handlers.onLinked(value);
      if (first) {
        first = false;
        start(id, () => value);
        return;
      }
      // Instantané sans tranche de Carnet (nœud effacé, échéances seules) : ignoré, comme un nœud vide.
      if (ready && hasCarnetData(value)) handlers.onRemote(value, pendingSlices());
    },
    error => {
      if (id !== session) return;
      console.error('[firebase] lecture refusée', error);
      goLocal(error);
      handlers.onError(fatal);
      handlers.onReady();
    }
  );
}

function stopListening() {
  session++;
  unsubscribeData?.();
  unsubscribeData = null;
  ready = false;
  rootRef = null;
}

/* ---------- Initialisation ---------- */
export const isConfigured = () => Boolean(FIREBASE_CONFIG?.apiKey && FIREBASE_CONFIG?.databaseURL);

/** @returns {Promise<boolean>} false si la synchronisation est indisponible (mode local). */
export async function initCloud(options) {
  handlers = { ...handlers, ...options };
  if (!isConfigured()) {
    fatal = 'Synchronisation non configurée : données enregistrées sur cet appareil.';
    emitStatus();
    return false;
  }
  emitStatus();
  try {
    const [appMod, authM, dbM] = await withTimeout(
      Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-database.js`)]),
      LOAD_TIMEOUT,
      'timeout chargement SDK'
    );
    authMod = authM;
    dbMod = dbM;
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(FIREBASE_CONFIG);
    auth = authMod.getAuth(app);
    db = dbMod.getDatabase(app);
    // Même stockage de session que Mon Garage et Ma Maison (même origine : une seule connexion).
    await authMod.setPersistence(auth, authMod.browserLocalPersistence).catch(() => {});

    dbMod.onValue(dbMod.ref(db, '.info/connected'), snap => {
      connected = snap.val() === true;
      emitStatus();
    });

    authMod.onAuthStateChanged(auth, u => {
      if (u && user && u.uid === user.uid && unsubscribeData) return; // même compte, déjà à l'écoute
      stopListening();
      user = u || null;
      signedOut = !u;
      if (!u) clearPending();
      // onUser d'abord : l'app peut vider les données d'un autre compte avant la synchro.
      handlers.onUser(user);
      if (u) listen(u);
      emitStatus();
    });
    return true;
  } catch (error) {
    goLocal(error);
    return false;
  }
}

export const currentUser = () => user;

/**
 * Écrit (ou efface avec null) un chemin du compte hors du nœud de Carnet, ex. :
 * `carnet_push/devices/<appareil>` (abonnement aux notifications, voir features/push.js).
 */
export async function setUserPath(path, value) {
  if (!user || !dbMod || !db) throw new Error('Pas de compte connecté');
  await dbMod.set(dbMod.ref(db, `users/${user.uid}/${path}`), value === null ? null : clean(value));
}
/** Connexion possible (SDK chargé) : sinon l'app reste en mode local. */
export const canSignIn = () => Boolean(authMod && auth && !fatal);

export async function signIn(email, password) {
  return authMod.signInWithEmailAndPassword(auth, email, password);
}
export async function signUp(email, password) {
  return authMod.createUserWithEmailAndPassword(auth, email, password);
}
export async function resetPassword(email) {
  return authMod.sendPasswordResetEmail(auth, email);
}
export async function signOutUser() {
  await waitForSync(3000);
  return authMod.signOut(auth);
}
