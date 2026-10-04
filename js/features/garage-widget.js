/*
 * Widget « Garage » de l'accueil : lecture seule, en direct, du résumé des
 * échéances publié par l'app Mon Garage (base Firebase partagée, chemin
 * `garage_alerts`). Carnet n'écrit jamais ici — Garage pousse, Carnet lit.
 * Écouteur indépendant de la synchronisation propre à Carnet
 * (js/services/firebase.js) : une panne de l'un n'affecte pas l'autre.
 */
import { $, esc } from '../core/utils.js';
import { icon } from '../ui/icons.js';
import { FIREBASE_CONFIG, FIREBASE_SDK_VERSION, DB_ROOT } from '../config/firebase-config.js';

const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
const LEVEL_RANK = { late: 0, soon: 1 };

function render(data) {
  const section = $('#garageSection');
  const vehicles = data && typeof data === 'object' ? Object.values(data).filter(Boolean) : [];
  if (!vehicles.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const items = [];
  vehicles.forEach(v => (Array.isArray(v.alerts) ? v.alerts : []).forEach(a => items.push({ ...a, vehicleName: v.vehicleName })));
  items.sort((a, b) => (LEVEL_RANK[a.level] ?? 2) - (LEVEL_RANK[b.level] ?? 2));
  const top = items.slice(0, 4);
  $('#garageWidget').innerHTML = top.length
    ? top
        .map(
          a => `<div class="task">
        <span class="garage-dot is-${esc(a.level)}"></span>
        <div class="task__body"><div class="task__title">${esc(a.vehicleName)} · ${esc(a.title)}</div><div class="task__sub">${esc(a.text)}</div></div>
      </div>`
        )
        .join('')
    : `<div class="empty-state"><span class="empty-state__icon">${icon('check', 22)}</span><p>Tout est à jour sur vos véhicules.</p></div>`;
}

/**
 * Démarre l'écoute en direct ; n'affiche jamais d'erreur (fonctionnalité annexe).
 * `onData`, si fourni, reçoit les données brutes à chaque mise à jour (et une
 * seule fois avec `null` si Garage est hors ligne ou injoignable) — utilisé
 * par le pop-up de démarrage pour y ajouter les entretiens en retard.
 */
export async function initGarageWidget({ onData } = {}) {
  try {
    const [appMod, dbMod] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-database.js`)]);
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(FIREBASE_CONFIG);
    const db = dbMod.getDatabase(app);
    dbMod.onValue(
      dbMod.ref(db, `${DB_ROOT}/garage_alerts`),
      snap => {
        $('#garageLive').hidden = false;
        render(snap.val());
        onData?.(snap.val());
      },
      () => {
        $('#garageLive').hidden = true;
        onData?.(null);
      }
    );
  } catch {
    // Hors ligne ou SDK indisponible : le widget reste simplement masqué.
    onData?.(null);
  }
}
