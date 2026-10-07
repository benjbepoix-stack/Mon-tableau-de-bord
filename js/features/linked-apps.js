/*
 * Échéances publiées par les apps Mon Garage (`app/garage_alerts`) et Ma Maison
 * (`app/maison_alerts`) dans la base partagée : lecture seule, en direct.
 * Carnet n'écrit jamais ici — les apps poussent, Carnet lit.
 *
 * Affiché dans l'onglet Tâches :
 *  - « Garage » et « Maison » : tout ce qui est en retard ou dû dans les 30 jours
 *    (date d'échéance quand elle existe), pour anticiper les rendez-vous ;
 *  - « Saison » : les tâches du calendrier de saison de Ma Maison restant à faire ce mois-ci.
 * Les échéances datées apparaissent aussi dans le calendrier mensuel de l'accueil.
 *
 * Écouteurs indépendants de la synchronisation propre à Carnet
 * (js/services/firebase.js) : une panne de l'un n'affecte pas l'autre.
 */
import { $, esc } from '../core/utils.js';
import { formatKey } from '../core/dates.js';
import { icon } from '../ui/icons.js';
import { FIREBASE_CONFIG, FIREBASE_SDK_VERSION, DB_ROOT } from '../config/firebase-config.js';

const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
export const GARAGE_URL = 'https://benjbepoix-stack.github.io/Mon-garage/';
export const MAISON_URL = 'https://benjbepoix-stack.github.io/Ma-maison/';
const LEVEL_RANK = { late: 0, soon: 1, info: 2 };
const isDue = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const asList = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []).filter(x => x && typeof x === 'object');

let garage = [];
let maison = [];
let season = { month: '', tasks: [] };
const listeners = new Set();

/** Échéances lues : { source: 'garage'|'maison', level, title, text, due?, owner? } */
function readGarage(data) {
  const out = [];
  asList(data).forEach(v => asList(v.alerts).forEach(a => out.push({ source: 'garage', owner: String(v.vehicleName || ''), level: a.level, title: String(a.title || ''), text: String(a.text || ''), due: isDue(a.due) ? a.due : '' })));
  return out;
}
function readMaison(data) {
  if (!data || typeof data !== 'object' || !data.name) return { alerts: [], season: { month: '', tasks: [] } };
  return {
    alerts: asList(data.alerts)
      // Ancien format : une ligne « info » résumait les tâches de saison, désormais listées à part.
      .filter(a => a.level !== 'info')
      .map(a => ({ source: 'maison', owner: '', level: a.level, title: String(a.title || ''), text: String(a.text || ''), due: isDue(a.due) ? a.due : '' })),
    season: { month: String(data.seasonMonth || ''), tasks: asList(data.season).map(t => ({ label: String(t.label || ''), category: String(t.category || '') })).filter(t => t.label) }
  };
}

const byUrgency = (a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3) || (a.due || '9999').localeCompare(b.due || '9999');

/** Échéances datées (pour le calendrier). */
export const datedAlerts = () => [...garage, ...maison].filter(a => a.due);
export const onLinkedChange = fn => listeners.add(fn);

function alertRow(a, url) {
  // Le texte publié dit déjà « dans 12 j », « en retard de 5 j »… : on y ajoute seulement la date.
  const sub = [a.due ? formatKey(a.due, { weekday: 'short', day: 'numeric', month: 'short' }) : '', a.text].filter(Boolean).join(' · ');
  return `<a class="task" href="${url}">
    <span class="garage-dot is-${esc(a.level)}"></span>
    <div class="task__body"><div class="task__title">${a.owner ? `${esc(a.owner)} · ` : ''}${esc(a.title)}</div><div class="task__sub"><span class="${a.level === 'late' ? 'is-overdue' : ''}">${esc(sub)}</span></div></div>
  </a>`;
}

function renderSection(section, host, items, url, empty) {
  $(section).hidden = items === null;
  if (items === null) return;
  $(host).innerHTML = items.length ? [...items].sort(byUrgency).map(a => alertRow(a, url)).join('') : `<div class="empty-state"><span class="empty-state__icon">${icon('check', 22)}</span><p>${empty}</p></div>`;
}

let garageSeen = false;
let maisonSeen = false;

export function renderLinked() {
  renderSection('#garageSection', '#garageWidget', garageSeen ? garage : null, GARAGE_URL, 'Rien à prévoir sur vos véhicules dans les 30 jours.');
  renderSection('#maisonSection', '#maisonWidget', maisonSeen ? maison : null, `${MAISON_URL}#/entretien`, 'Rien à prévoir pour la maison dans les 30 jours.');
  $('#seasonSection').hidden = !season.tasks.length;
  $('#seasonTitle').textContent = season.month ? `Saison · ${season.month}` : 'Saison';
  $('#seasonWidget').innerHTML = season.tasks
    .map(t => `<a class="task" href="${MAISON_URL}#/entretien/saison"><span class="garage-dot is-info"></span><div class="task__body"><div class="task__title">${esc(t.label)}</div><div class="task__sub"><span>${esc(t.category)}</span></div></div></a>`)
    .join('');
}

function changed() {
  renderLinked();
  listeners.forEach(fn => fn());
}

/**
 * Démarre l'écoute en direct ; n'affiche jamais d'erreur (fonctionnalité annexe).
 * `onGarage`, si fourni, reçoit les données brutes de Garage à chaque mise à jour (et une
 * seule fois `null` si Garage est injoignable) — utilisé par le pop-up de démarrage.
 */
export async function initLinkedApps({ onGarage } = {}) {
  try {
    const [appMod, dbMod] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-database.js`)]);
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(FIREBASE_CONFIG);
    const db = dbMod.getDatabase(app);
    dbMod.onValue(
      dbMod.ref(db, `${DB_ROOT}/garage_alerts`),
      snap => {
        const data = snap.val();
        garage = readGarage(data);
        garageSeen = Boolean(data);
        $('#garageLive').hidden = false;
        changed();
        onGarage?.(data);
      },
      () => {
        $('#garageLive').hidden = true;
        onGarage?.(null);
      }
    );
    dbMod.onValue(
      dbMod.ref(db, `${DB_ROOT}/maison_alerts`),
      snap => {
        const data = readMaison(snap.val());
        maison = data.alerts;
        season = data.season;
        maisonSeen = Boolean(snap.val());
        $('#maisonLive').hidden = false;
        changed();
      },
      () => ($('#maisonLive').hidden = true)
    );
  } catch {
    // Hors ligne ou SDK indisponible : les sections restent simplement masquées.
    onGarage?.(null);
  }
}
