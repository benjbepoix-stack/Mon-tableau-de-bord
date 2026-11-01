/*
 * Feuille Réglages (bouton de l'en-tête) :
 *  - thème Auto / Sombre / Clair (tranche synchronisée « theme ») ;
 *  - compte : « Connecté : e-mail » + « Se déconnecter », ou « Se connecter » sans compte ;
 *  - notifications de cet appareil (features/push.js).
 */
import { $ } from '../core/utils.js';
import { state, commit } from '../core/store.js';
import { openSheet, closeSheet, confirmDialog } from '../ui/dialog.js';
import { toastError } from '../ui/toast.js';
import { currentUser, canSignIn, signOutUser } from '../services/firebase.js';
import { openAuth } from './auth.js';
import { render as renderPush } from './push.js';

/** Ligne « compte » des Réglages, selon le compte connecté et la disponibilité de Firebase. */
export function renderAccount() {
  const user = currentUser();
  const online = canSignIn();
  $('#accountLine').textContent = user
    ? `Connecté : ${user.email || 'compte sans e-mail'}`
    : online
      ? 'Sans compte : vos données restent sur cet appareil, sans synchronisation.'
      : 'Synchronisation indisponible : données enregistrées sur cet appareil.';
  $('#logoutBtn').hidden = !user;
  $('#loginBtn').hidden = Boolean(user) || !online;
}

export function initSettings() {
  $('#settingsBtn').addEventListener('click', () => {
    renderAccount();
    renderPush();
    openSheet('settingsSheet', { focus: false });
  });
  $('#themeSwitch').addEventListener('click', e => {
    const pick = e.target.closest('[data-theme-pick]')?.dataset.themePick;
    if (pick && pick !== state.theme) commit('theme', { theme: pick });
  });
  // Taille du texte : réglage propre à cet appareil (appliqué avant le premier rendu dans index.html).
  const markText = () => {
    const lg = document.documentElement.dataset.text === 'lg';
    document.querySelectorAll('[data-text-pick]').forEach(b => b.setAttribute('aria-checked', String((b.dataset.textPick === 'lg') === lg)));
  };
  markText();
  $('#textSwitch').addEventListener('click', e => {
    const pick = e.target.closest('[data-text-pick]')?.dataset.textPick;
    if (!pick) return;
    if (pick === 'lg') document.documentElement.dataset.text = 'lg';
    else delete document.documentElement.dataset.text;
    try { localStorage.setItem('carnet_text', pick); } catch { /* navigation privée */ }
    markText();
    window.dispatchEvent(new Event('resize'));
  });
  $('#loginBtn').addEventListener('click', () => {
    closeSheet('settingsSheet');
    openAuth();
  });
  $('#logoutBtn').addEventListener('click', async () => {
    if (!currentUser()) return;
    const ok = await confirmDialog({
      title: 'Se déconnecter ?',
      message: 'Vos données restent enregistrées dans votre compte et sur cet appareil.',
      confirmLabel: 'Se déconnecter'
    });
    if (!ok) return;
    try {
      closeSheet('settingsSheet');
      await signOutUser();
    } catch (error) {
      console.warn('[auth]', error);
      toastError('Déconnexion impossible. Réessayez.');
    }
  });
}
