/*
 * Mannequin de mensurations : silhouette de face, une bande pointillée par zone
 * de mesure et, à côté, la case où noter la valeur. Toucher une zone place le
 * curseur dans la bonne case ; la consigne de mesure s'affiche dessous.
 */
import { esc } from '../core/utils.js';

/** Zones : clé de donnée, libellé, côté de la case, hauteur (repère 0–440), bande [x1, x2] et consigne. */
export const ZONES = [
  { key: 'chest', label: 'Poitrine', side: 'right', y: 128, band: [120, 200], tip: 'Ruban horizontal sous les aisselles, à hauteur des mamelons, en fin d’expiration.' },
  { key: 'arm', label: 'Bras', side: 'left', y: 122, band: [95, 118], tip: 'Biceps relâché, bras le long du corps, à mi-distance entre l’épaule et le coude.' },
  { key: 'waist', label: 'Taille', side: 'left', y: 190, band: [128, 192], tip: 'Au niveau du nombril, ventre relâché, sans rentrer le ventre.' },
  { key: 'hip', label: 'Hanche', side: 'right', y: 228, band: [122, 198], tip: 'Au point le plus large des fesses, pieds joints.' },
  { key: 'thigh', label: 'Cuisse', side: 'left', y: 276, band: [124, 158], tip: 'Debout, jambe relâchée, au plus large : environ 15 cm sous le pli de l’aine.' },
  { key: 'calf', label: 'Mollet', side: 'right', y: 352, band: [169, 196], tip: 'Debout, poids réparti sur les deux jambes, au point le plus large du mollet.' }
];

const W = 320;
const H = 440;
const LEFT_EDGE = 70; // bord intérieur des cases de gauche (repère SVG)
const RIGHT_EDGE = 250;

/** Silhouette neutre, de face (centre x = 160). */
const BODY = `
  <g class="bm-body">
    <circle cx="160" cy="40" r="22"/>
    <rect x="150" y="58" width="20" height="20" rx="6"/>
    <path d="M116 86Q160 74 204 86L200 140Q192 172 192 190Q202 212 200 238Q160 252 120 238Q118 212 128 190Q128 172 120 140Z"/>
    <path class="bm-limb" d="M111 96L99 160L93 226" stroke-width="22"/>
    <path class="bm-limb" d="M209 96L221 160L227 226" stroke-width="22"/>
    <path class="bm-limb" d="M142 236L139 320" stroke-width="36"/>
    <path class="bm-limb" d="M139 320L137 414" stroke-width="25"/>
    <path class="bm-limb" d="M178 236L181 320" stroke-width="36"/>
    <path class="bm-limb" d="M181 320L183 414" stroke-width="25"/>
  </g>`;

/**
 * @param {Record<string, number|null>} values valeurs à afficher (édition)
 * @param {Record<string, number|null>} previous dernière prise (rappel « préc. »)
 */
export function bodyMapHTML(values = {}, previous = {}) {
  const fmt = n => String(n).replace('.', ',');
  const bands = ZONES.map(z => {
    const [x1, x2] = z.band;
    const rx = (x2 - x1) / 2;
    const cx = x1 + rx;
    const anchorX = z.side === 'left' ? x1 : x2;
    const edge = z.side === 'left' ? LEFT_EDGE : RIGHT_EDGE;
    return `<g class="bm-zone" data-zone="${z.key}">
      <ellipse class="bm-band" cx="${cx}" cy="${z.y}" rx="${rx}" ry="${Math.max(4, rx * 0.16)}"/>
      <path class="bm-lead" d="M${edge} ${z.y}H${anchorX}"/>
      <circle class="bm-dot" cx="${anchorX}" cy="${z.y}" r="3"/>
      <rect class="bm-hit" x="${x1 - 6}" y="${z.y - 12}" width="${x2 - x1 + 12}" height="24" rx="8"><title>${esc(z.label)}</title></rect>
    </g>`;
  }).join('');
  const fields = ZONES.map(z => {
    const prev = previous[z.key];
    const val = values[z.key];
    const style = `top:${((z.y / H) * 100).toFixed(2)}%`;
    return `<div class="bm-field bm-field--${z.side}" style="${style}" data-field="${z.key}">
      <label class="bm-field__label" for="m-${z.key}">${esc(z.label)}</label>
      <span class="bm-field__box"><input class="bm-field__input" id="m-${z.key}" name="${z.key}" inputmode="decimal" autocomplete="off" enterkeyhint="next" placeholder="—" value="${val !== null && val !== undefined ? fmt(val) : ''}"><span class="bm-field__unit">cm</span></span>
      ${prev !== null && prev !== undefined ? `<span class="bm-field__prev">préc. ${fmt(prev)}</span>` : ''}
    </div>`;
  }).join('');
  return `<div class="body-map">
    <svg class="bm-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true">${BODY}${bands}</svg>
    ${fields}
  </div>
  <p class="bm-tip" id="bmTip" aria-live="polite">Touchez une zone du mannequin ou une case pour voir comment mesurer.</p>`;
}

/** Relie mannequin, cases et consigne. */
export function bindBodyMap(root) {
  // Le contenu est reconstruit à chaque ouverture : on relit la consigne à chaque fois.
  const setActive = key => {
    const tip = root.querySelector('#bmTip');
    root.querySelectorAll('.bm-zone, .bm-field').forEach(el => el.classList.toggle('is-active', (el.dataset.zone || el.dataset.field) === key));
    const zone = ZONES.find(z => z.key === key);
    if (zone && tip) tip.innerHTML = `<strong>${esc(zone.label)}</strong> · ${esc(zone.tip)}`;
  };
  root.addEventListener('focusin', e => {
    const field = e.target.closest('[data-field]');
    if (field) setActive(field.dataset.field);
  });
  root.addEventListener('click', e => {
    const zone = e.target.closest('[data-zone]');
    if (!zone) return;
    setActive(zone.dataset.zone);
    root.querySelector(`#m-${zone.dataset.zone}`)?.focus();
  });
  // « Suivant » du clavier : passe à la zone suivante, de haut en bas.
  const order = [...ZONES].sort((a, b) => a.y - b.y).map(z => z.key);
  root.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.matches('.bm-field__input')) return;
    const next = order[order.indexOf(e.target.name) + 1];
    if (next) {
      e.preventDefault();
      root.querySelector(`#m-${next}`)?.focus();
    }
  });
}
