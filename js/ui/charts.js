/* Graphiques légers sans dépendance : anneau (donut) et courbe SVG. */
import { esc } from '../core/utils.js';
import { formatKey } from '../core/dates.js';

export const PALETTE = ['#2ee6a8', '#6c8cff', '#ffc24b', '#ff7a85', '#b48cff', '#4fd1d9', '#ff9ecf', '#9aa8bf'];

/**
 * Anneau de répartition.
 * @param {{donut:HTMLElement, legend:HTMLElement, total:HTMLElement}} els
 * @param {Array<[string, number]>} entries
 */
export function renderDonut({ donut, legend, total }, entries, emptyText) {
  const sum = entries.reduce((s, [, n]) => s + n, 0);
  total.textContent = String(sum);
  if (!sum) {
    donut.style.setProperty('--donut', 'conic-gradient(var(--surface-3) 0deg 360deg)');
    legend.innerHTML = `<p class="chart-empty">${esc(emptyText)}</p>`;
    return;
  }
  let cursor = 0;
  const stops = entries.map(([, n], i) => {
    const start = (cursor / sum) * 360;
    cursor += n;
    const end = (cursor / sum) * 360;
    // léger espace entre segments pour un rendu plus raffiné
    const gap = entries.length > 1 ? 1.2 : 0;
    const color = PALETTE[i % PALETTE.length];
    return `${color} ${start}deg ${Math.max(start, end - gap)}deg, transparent ${Math.max(start, end - gap)}deg ${end}deg`;
  });
  donut.style.setProperty('--donut', `conic-gradient(${stops.join(',')})`);
  legend.innerHTML = entries
    .map(
      ([name, n], i) =>
        `<div class="legend__item"><span class="legend__dot" style="--c:${PALETTE[i % PALETTE.length]}"></span><span class="legend__name">${esc(name)}</span><span class="legend__count">${n}</span><span class="legend__pct">${Math.round((n / sum) * 100)}%</span></div>`
    )
    .join('');
}

/**
 * Courbe d'évolution (6 points max affichés).
 * @param {HTMLElement} host
 * @param {Array<{date:string,value:number}>} rows  triés par date croissante
 */
export function renderLineChart(host, rows, { unit, decimals = 0, minPad = 1 }) {
  if (!rows.length) {
    host.innerHTML = '<p class="chart-empty">Aucune mesure enregistrée pour le moment.</p>';
    return;
  }
  // Largeur réelle en pixels : le texte SVG garde sa taille sur mobile.
  const W = Math.max(300, Math.round(host.clientWidth || 600));
  const H = 240;
  const L = 16;
  const R = 16;
  const T = 34;
  const B = 44;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const values = rows.map(r => r.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const pad = Math.max((max - min) * 0.25, minPad);
  min -= pad;
  max += pad;
  const x = i => L + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const y = v => T + ((max - v) / (max - min)) * plotH;
  const pts = rows.map((r, i) => [x(i), y(r.value)]);

  // Courbe lissée (Catmull-Rom -> Bézier)
  const path = pts
    .map((p, i) => {
      if (i === 0) return `M${p[0]},${p[1]}`;
      const p0 = pts[i - 2] || pts[i - 1];
      const p1 = pts[i - 1];
      const p3 = pts[i + 1] || p;
      const c1 = [p1[0] + (p[0] - p0[0]) / 6, p1[1] + (p[1] - p0[1]) / 6];
      const c2 = [p[0] - (p3[0] - p1[0]) / 6, p[1] - (p3[1] - p1[1]) / 6];
      return `C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p[0]},${p[1]}`;
    })
    .join(' ');
  const area = `${path} L${pts[pts.length - 1][0]},${T + plotH} L${pts[0][0]},${T + plotH} Z`;
  const grid = [0, 0.5, 1].map(t => `<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${T + t * plotH}" y2="${T + t * plotH}"/>`).join('');
  const points = rows
    .map((r, i) => {
      const [px, py] = pts[i];
      const label = `${Number(r.value).toFixed(decimals).replace('.', ',')}${unit}`;
      const anchor = i === 0 && rows.length > 1 ? 'start' : i === rows.length - 1 && rows.length > 1 ? 'end' : 'middle';
      const lx = anchor === 'start' ? px - 6 : anchor === 'end' ? px + 6 : px;
      const ly = i % 2 === 0 || rows.length < 4 ? py - 12 : py + 22;
      return `<circle class="chart-dot" cx="${px}" cy="${py}" r="5"/><text class="chart-value" x="${lx}" y="${ly}" text-anchor="${anchor}">${label}</text><text class="chart-date" x="${lx}" y="${H - 14}" text-anchor="${anchor}">${formatKey(r.date, { day: 'numeric', month: 'short' })}</text><text class="chart-year" x="${lx}" y="${H - 1}" text-anchor="${anchor}">${r.date.slice(0, 4)}</text>`;
    })
    .join('');
  const gid = `g${Math.random().toString(36).slice(2, 8)}`;
  host.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Graphique d’évolution">
    <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#${gid})"/><path class="chart-line" d="${path}"/>${points}</svg>`;
}
