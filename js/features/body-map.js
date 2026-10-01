/*
 * Mannequin de mensurations : silhouette de face, une bande pointillée par zone
 * de mesure et, à côté, la case où noter la valeur. Toucher une zone place le
 * curseur dans la bonne case ; la consigne de mesure s'affiche dessous.
 */
import { esc } from '../core/utils.js';

/** Zones : clé de donnée, libellé, côté de la case, hauteur (repère 0–440), bande [x1, x2] et consigne. */
export const ZONES = [
  { key: 'arm', label: 'Bras', side: 'right', y: 160, band: [212, 227], tip: 'Biceps relâché, bras le long du corps, à mi-distance entre l’épaule et le coude.' },
  { key: 'chest', label: 'Poitrine', side: 'left', y: 128, band: [117, 203], tip: 'Ruban horizontal sous les aisselles, à hauteur des mamelons, en fin d’expiration.' },
  { key: 'waist', label: 'Taille', side: 'left', y: 188, band: [127, 193], tip: 'Au niveau du nombril, ventre relâché, sans rentrer le ventre.' },
  { key: 'hip', label: 'Hanche', side: 'right', y: 230, band: [114, 206], tip: 'Au point le plus large des fesses, pieds joints.' },
  { key: 'thigh', label: 'Cuisse', side: 'left', y: 280, band: [117, 155], tip: 'Debout, jambe relâchée, au plus large : environ 15 cm sous le pli de l’aine.' },
  { key: 'calf', label: 'Mollet', side: 'right', y: 352, band: [166, 197], tip: 'Debout, poids réparti sur les deux jambes, au point le plus large du mollet.' }
];

const W = 320;
const H = 440;
const LEFT_EDGE = 70; // bord intérieur des cases de gauche (repère SVG)
const RIGHT_EDGE = 250;

/* Silhouette de face, proportions d'environ 8 têtes (sommet y = 14, pieds y = 424).
   Une moitié droite est dessinée puis reproduite en miroir autour de l'axe x = 160. */
const HALF = `M160 60
  C164 60 168 62 168 66 L168 76
  C176 82 196 82 210 87
  C221 92 225 106 225 128
  L228 184 L234 246
  C236 258 236 268 230 272
  C224 274 221 266 222 252
  L216 186 L205 122
  C204 140 201 164 194 188
  C191 202 205 214 206 232
  C207 258 204 282 200 302
  C197 314 194 322 195 332
  C198 352 199 376 190 402
  L190 412 C197 416 197 424 186 424
  L172 424 L171 404
  C166 380 166 356 170 332
  C170 304 168 276 160 256 Z`;

const BODY = `
  <g class="bm-body">
    <ellipse cx="160" cy="38" rx="19" ry="24"/>
    <path d="${HALF}"/>
    <path d="${HALF}" transform="translate(320 0) scale(-1 1)"/>
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
