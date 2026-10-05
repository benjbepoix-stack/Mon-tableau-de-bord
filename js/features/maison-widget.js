/*
 * Widget « Maison » de l'accueil : lecture seule, en direct, du résumé publié
 * par l'app Ma Maison (base Firebase partagée, chemin `maison_alerts`) :
 * entretiens en retard ou proches, garanties qui expirent, tâches de saison
 * du mois. Carnet n'écrit jamais ici — Ma Maison pousse, Carnet lit.
 * Écouteur indépendant de la synchronisation propre à Carnet.
 */
import { $, esc } from '../core/utils.js';
import { icon } from '../ui/icons.js';
import { FIREBASE_CONFIG, FIREBASE_SDK_VERSION, DB_ROOT } from '../config/firebase-config.js';

const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
const LEVEL_RANK = { late: 0, soon: 1, info: 2 };

function render(data) {
  const section = $('#maisonSection');
  if (!data || typeof data !== 'object' || !data.name) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const items = (Array.isArray(data.alerts) ? data.alerts : Object.values(data.alerts || {}))
    .filter(Boolean)
    .sort((a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3))
    .slice(0, 4);
  $('#maisonWidget').innerHTML = items.length
    ? items
        .map(
          a => `<div class="task">
        <span class="garage-dot is-${esc(a.level)}"></span>
        <div class="task__body"><div class="task__title">${esc(a.title)}</div><div class="task__sub">${esc(a.text)}</div></div>
      </div>`
        )
        .join('')
    : `<div class="empty-state"><span class="empty-state__icon">${icon('check', 22)}</span><p>Rien à prévoir pour la maison.</p></div>`;
}

/** Démarre l'écoute en direct ; n'affiche jamais d'erreur (fonctionnalité annexe). */
export async function initMaisonWidget() {
  try {
    const [appMod, dbMod] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-database.js`)]);
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(FIREBASE_CONFIG);
    const db = dbMod.getDatabase(app);
    dbMod.onValue(
      dbMod.ref(db, `${DB_ROOT}/maison_alerts`),
      snap => {
        $('#maisonLive').hidden = false;
        render(snap.val());
      },
      () => ($('#maisonLive').hidden = true)
    );
  } catch {
    // Hors ligne ou SDK indisponible : le widget reste simplement masqué.
  }
}
