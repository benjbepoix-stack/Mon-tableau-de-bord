/*
 * Fond de l'accueil (Réglages → « Image de fond »), propre à cet appareil :
 *  - auto : crépuscule en thème sombre, matin en thème clair ;
 *  - un paysage fixe (crépuscule, matin, nuit, sauge) ou « uni » (sans image) ;
 *  - photo : une image choisie sur l'appareil, réduite (1600 px max) et gardée
 *    dans IndexedDB (le localStorage, partagé par les 5 apps, reste léger).
 * Le choix est appliqué en surchargeant la variable CSS --horizon sur <html>.
 */
import { $, $$ } from '../core/utils.js';
import { readText, write } from '../services/storage.js';
import { toastError } from '../ui/toast.js';

const KEY = 'carnet_backdrop';
const PRESETS = { crepuscule: 'img/horizon-sombre.svg', matin: 'img/horizon-clair.svg', nuit: 'img/horizon-nuit.svg', sauge: 'img/horizon-sauge.svg' };
const DB = 'carnet_backdrop';
const STORE = 'files';
let photoUrl = null;

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}
/** Photo enregistrée : Blob, undefined si aucune, ou null si IndexedDB a échoué (erreur passagère possible sur iOS). */
const loadPhoto = () => idb('readonly', s => s.get('photo')).catch(error => {
  console.warn('[fond]', error);
  return null;
});
const savePhoto = blob => idb('readwrite', s => s.put(blob, 'photo'));
const deletePhoto = () => idb('readwrite', s => s.delete('photo')).catch(() => {});

const current = () => readText(KEY, 'auto');

function setVar(value) {
  const root = document.documentElement.style;
  if (value === null) root.removeProperty('--horizon');
  else root.setProperty('--horizon', value);
}

/** Applique le choix enregistré (appelé au démarrage et après chaque changement). */
export async function applyBackdrop() {
  const pick = current();
  document.documentElement.dataset.backdrop = pick;
  if (pick === 'photo') {
    if (!photoUrl) {
      const blob = await loadPhoto();
      if (blob === undefined) {
        // Photo vraiment absente (retirée ailleurs, données effacées) : retour au fond par défaut.
        write(KEY, 'auto');
        return applyBackdrop();
      }
      if (!(blob instanceof Blob)) {
        // IndexedDB indisponible pour l'instant : fond par défaut, choix conservé pour la prochaine ouverture.
        setVar(null);
        return renderPicker();
      }
      photoUrl = URL.createObjectURL(blob);
    }
    setVar(`url("${photoUrl}")`);
  } else if (PRESETS[pick]) setVar(`url("${new URL(PRESETS[pick], document.baseURI).href}")`); // adresse absolue : var() est résolue dans horizon.css
  else if (pick === 'uni') setVar('none');
  else setVar(null);
  renderPicker();
}

/** Décode l'image : createImageBitmap si possible, sinon un <img> (anciens Safari). */
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function shrink(file) {
  const bitmap = await decode(file);
  const w = bitmap.naturalWidth || bitmap.width;
  const h = bitmap.naturalHeight || bitmap.height;
  const scale = Math.min(1, 1600 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('conversion'))), 'image/jpeg', 0.85));
}

/** Changement de fond. La photo reste enregistrée : y revenir ne demande pas de la choisir à nouveau. */
async function pick(value) {
  write(KEY, value);
  await applyBackdrop();
}

function renderPicker() {
  const host = $('#backdropPicker');
  if (!host) return;
  const pickNow = current();
  $$('[data-backdrop]', host).forEach(b => b.setAttribute('aria-checked', String(b.dataset.backdrop === pickNow)));
  const photoBtn = $('[data-backdrop="photo"]', host);
  if (photoBtn) photoBtn.style.backgroundImage = photoUrl ? `url("${photoUrl}")` : '';
  $('#backdropRemove').hidden = !photoUrl;
}

export function initBackdrop() {
  const host = $('#backdropPicker');
  const input = $('#backdropFile');
  host.addEventListener('click', async e => {
    const btn = e.target.closest('[data-backdrop]');
    if (!btn) return;
    if (btn.dataset.backdrop === 'photo' && !photoUrl) return input.click();
    await pick(btn.dataset.backdrop);
  });
  $('#backdropChoose').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const blob = await shrink(file);
      await savePhoto(blob);
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      photoUrl = URL.createObjectURL(blob);
      await pick('photo');
    } catch (error) {
      console.warn('[fond]', error);
      toastError('Cette image ne peut pas être utilisée. Essayez une autre photo.');
    }
  });
  $('#backdropRemove').addEventListener('click', async () => {
    await deletePhoto();
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null;
    await pick(current() === 'photo' ? 'auto' : current());
  });
  // La photo enregistrée reste proposée même quand un autre fond est choisi.
  applyBackdrop();
  if (current() !== 'photo') {
    loadPhoto().then(blob => {
      if (blob instanceof Blob && !photoUrl) {
        photoUrl = URL.createObjectURL(blob);
        renderPicker();
      }
    });
  }
}
