/* Confirmation d'enregistrement cloud pour les opérations importantes. */
import { isOnline, waitForSync } from '../services/firebase.js';

/**
 * Attend l'accusé de réception Firebase si l'on est connecté.
 * @returns {Promise<boolean>} true si synchronisé, false si enregistré localement seulement.
 */
export async function confirmSaved(timeout = 5000) {
  if (!isOnline()) return false;
  return waitForSync(timeout);
}
