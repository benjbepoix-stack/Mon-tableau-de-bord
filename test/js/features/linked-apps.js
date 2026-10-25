/*
 * Échéances publiées par les apps Mon Garage (`garage_alerts`) et Ma Maison
 * (`maison_alerts`) dans le nœud de Carnet (users/<uid>/carnet) : lues dans
 * l'instantané de ce nœud (js/services/firebase.js appelle `setLinked`), sans
 * écouteur séparé. Carnet n'écrit jamais ces chemins — les apps poussent, Carnet lit.
 *
 * Affiché dans l'onglet Tâches :
 *  - « Garage » et « Maison » : tout ce qui est en retard ou dû dans les 30 jours
 *    (date d'échéance quand elle existe), pour anticiper les rendez-vous ;
 *  - « Saison » : les tâches du calendrier de saison de Ma Maison restant à faire ce mois-ci.
 * Les échéances datées apparaissent aussi dans le calendrier mensuel de l'accueil ;
 * les retards, en pastille rouge sur les tuiles Ma Maison / Mon Garage de l'accueil.
 */
import { $, esc } from '../core/utils.js';
import { formatKey } from '../core/dates.js';
import { icon } from '../ui/icons.js';

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
/** Échéances en retard publiées par Garage et Maison (pop-up de démarrage). */
export const lateAlerts = () => [...garage, ...maison].filter(a => a.level === 'late').sort(byUrgency);
export const onLinkedChange = fn => listeners.add(fn);
/** Tout ce que publient Garage et Maison, plus les tâches de saison du mois. */
export const linkedItems = () => ({ garage: [...garage].sort(byUrgency), maison: [...maison].sort(byUrgency), season: season.tasks });

/* Prêt : premier instantané du nœud reçu (ou mode local, sans échéances). */
let readyResolve;
export const linkedReady = new Promise(resolve => (readyResolve = resolve));
export const linkedLocal = () => readyResolve();

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

/** Pastille rouge sur une tuile de l'accueil : nombre d'entretiens en retard. */
function renderBadge(tile, badge, items, name) {
  const late = items.filter(a => a.level === 'late').length;
  const el = $(badge);
  if (!el) return;
  el.hidden = !late;
  el.textContent = late > 9 ? '9+' : String(late);
  if (late) $(tile).setAttribute('aria-label', `${name} · ${late} en retard`);
  else $(tile).removeAttribute('aria-label');
}

function changed() {
  renderLinked();
  renderBadge('#garageTile', '#garageBadge', garage, 'Mon Garage');
  renderBadge('#maisonTile', '#maisonBadge', maison, 'Ma Maison');
  listeners.forEach(fn => fn());
}

let last = null;

/**
 * Lit les échéances dans un instantané du nœud de Carnet (null : aucune, ex. après
 * une déconnexion). Ne redessine que si elles ont changé.
 */
export function setLinked(node) {
  readyResolve();
  const g = node?.garage_alerts ?? null;
  const m = node?.maison_alerts ?? null;
  const json = JSON.stringify([g, m]);
  if (json === last) return;
  last = json;
  garage = readGarage(g);
  garageSeen = Boolean(g);
  const data = readMaison(m);
  maison = data.alerts;
  season = data.season;
  maisonSeen = Boolean(m);
  $('#garageLive').hidden = !garageSeen;
  $('#maisonLive').hidden = !maisonSeen;
  changed();
}
