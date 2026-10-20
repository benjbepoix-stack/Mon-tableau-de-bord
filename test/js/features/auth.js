/*
 * Feuille de connexion : compte commun à Mon Garage, Ma Maison, Allure et Mon budget.
 * Jamais affichée au démarrage : seulement quand Firebase répond « pas de compte »,
 * par-dessus l'app déjà affichée avec les données de l'appareil.
 * « Continuer sans compte » (ou fermer la feuille) : données sur l'appareil, sans
 * synchronisation, jusqu'à la fermeture de l'app (choix gardé pour la session : un
 * rechargement ne redemande pas ; au prochain lancement, la feuille revient — on peut
 * aussi se connecter depuis les Réglages).
 */
import { $ } from '../core/utils.js';
import { rules, validate } from '../core/validation.js';
import { signIn, signUp, resetPassword, describeAuthError } from '../services/firebase.js';
import { openSheet, closeSheet, isOpen } from '../ui/dialog.js';

const NO_ACCOUNT_KEY = 'dashboard_no_account';
const session = {
  get: () => {
    try {
      return sessionStorage.getItem(NO_ACCOUNT_KEY) === '1';
    } catch {
      return false;
    }
  },
  set: on => {
    try {
      if (on) sessionStorage.setItem(NO_ACCOUNT_KEY, '1');
      else sessionStorage.removeItem(NO_ACCOUNT_KEY);
    } catch {
      /* navigation privée : sans importance */
    }
  }
};
const TEXTS = {
  login: ['Connexion', 'Même compte que Mon Garage et Ma Maison.', 'Se connecter', 'Créer un compte'],
  signup: ['Créer mon compte', 'Un seul compte pour Carnet, Allure, Mon budget, Ma Maison et Mon Garage.', 'Créer le compte', 'J’ai déjà un compte'],
  reset: ['Mot de passe oublié', 'Indiquez votre e-mail : vous recevrez un lien pour choisir un nouveau mot de passe.', 'Envoyer le lien', 'Retour à la connexion']
};

let mode = 'login';
let onLocal = () => {};
/** Fermeture après une connexion réussie : pas de passage en mode local. */
let signedIn = false;

/** « Continuer sans compte » choisi pendant cette session de l'app. */
export const noAccountChosen = () => session.get();
export const forgetNoAccount = () => session.set(false);

function renderMode() {
  [$('#authTitle').textContent, $('#authSub').textContent, $('#authSubmit').textContent, $('#authSwitch').textContent] = TEXTS[mode];
  $('#authPasswordField').hidden = mode === 'reset';
  $('#authForgot').hidden = mode !== 'login';
  $('#authPassword').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#authError').textContent = '';
  $('#authError').classList.remove('is-success');
}

export function openAuth() {
  if (isOpen('authSheet')) return;
  mode = 'login';
  signedIn = false;
  renderMode();
  openSheet('authSheet', {
    onClose: () => {
      if (signedIn) return;
      session.set(true);
      onLocal();
    }
  });
}

/** Compte connecté : la feuille se ferme sans passer en mode local. */
export function closeAuth() {
  if (!isOpen('authSheet')) return;
  signedIn = true;
  closeSheet('authSheet');
}

async function onSubmit(e) {
  e.preventDefault();
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const err = $('#authError');
  const { valid, errors } = validate(
    { email, password },
    {
      email: [rules.required('L’e-mail'), v => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Adresse e-mail invalide.')],
      password: mode === 'reset' ? [] : [rules.required('Le mot de passe'), v => (v.length >= 6 ? null : '6 caractères minimum.')]
    }
  );
  err.classList.remove('is-success');
  if (!valid) {
    err.textContent = Object.values(errors)[0];
    return;
  }
  const btn = $('#authSubmit');
  btn.classList.add('is-loading');
  btn.disabled = true;
  err.textContent = '';
  try {
    if (mode === 'login') await signIn(email, password);
    else if (mode === 'signup') await signUp(email, password);
    else {
      await resetPassword(email);
      err.classList.add('is-success');
      err.textContent = 'E-mail envoyé. Pensez à vérifier vos courriers indésirables.';
    }
    // Connexion réussie : la feuille se ferme à la réponse de Firebase (main.js → closeAuth).
  } catch (error) {
    console.warn('[auth]', error);
    err.textContent = describeAuthError(error);
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

/** @param {{ onLocal: () => void }} options — appelé quand l'utilisateur continue sans compte. */
export function initAuth(options) {
  onLocal = options.onLocal;
  $('#authForm').addEventListener('submit', onSubmit);
  $('#authSwitch').addEventListener('click', () => {
    mode = mode === 'login' ? 'signup' : 'login';
    renderMode();
  });
  $('#authForgot').addEventListener('click', () => {
    mode = 'reset';
    renderMode();
  });
  $('#authLocal').addEventListener('click', () => closeSheet('authSheet'));
}
