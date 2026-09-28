/* Vue Mesures : poids, FTP, mensurations, historique éditable. */
import { $, esc, uid, parseNumber } from '../core/utils.js';
import { formatKey, todayKey } from '../core/dates.js';
import { state, commit } from '../core/store.js';
import { MEASURE_FIELDS } from '../core/schema.js';
import { rules, validate, showErrors, clearErrors, formValues } from '../core/validation.js';
import { openSheet, confirmDialog, isOpen } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { icon } from '../ui/icons.js';
import { renderLineChart } from '../ui/charts.js';

const WINDOW = 6;
const SERIES = {
  weight: { title: 'Historique du poids', unit: 'kg', decimals: 1, min: 20, max: 400, minPad: 0.8, label: 'Poids' },
  ftp: { title: 'Historique de la FTP', unit: 'W', decimals: 0, min: 30, max: 2500, minPad: 5, label: 'FTP' }
};
const MEASURE_RANGE = { min: 5, max: 300 };

const offsets = { weight: 0, ftp: 0 };
let refIndex = null;
let history = { type: null, editing: null };

const fmt = (n, d) => Number(n).toFixed(d).replace('.', ',');
const byDate = (a, b) => a.date.localeCompare(b.date);

function delta(cur, prev, unit, decimals) {
  if (prev === undefined || prev === null) return { text: 'Première mesure', cls: 'neutral' };
  const d = cur - prev;
  const pct = prev ? (d / prev) * 100 : 0;
  if (Math.abs(d) < 1e-9) return { text: 'Stable', cls: 'neutral' };
  const sign = d > 0 ? '+' : '−';
  return { text: `${sign}${fmt(Math.abs(d), decimals)} ${unit} · ${sign}${fmt(Math.abs(pct), 1)} %`, cls: d > 0 ? 'up' : 'down' };
}

/* ---------- Rendu ---------- */
function renderSeries(kind) {
  const cfg = SERIES[kind];
  const rows = state.bodyMetrics[kind];
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  $(`#${kind}Latest`).innerHTML = last ? `${fmt(last.value, cfg.decimals)}<small>${cfg.unit}</small>` : '—';
  const dl = last ? delta(last.value, prev?.value, cfg.unit, cfg.decimals) : { text: 'Aucune mesure', cls: 'neutral' };
  const deltaEl = $(`#${kind}Delta`);
  deltaEl.className = `delta delta--${dl.cls}`;
  deltaEl.textContent = dl.text;

  const maxOffset = Math.max(0, Math.ceil(rows.length / WINDOW) - 1);
  offsets[kind] = Math.min(offsets[kind], maxOffset);
  const end = rows.length - offsets[kind] * WINDOW;
  const shown = rows.slice(Math.max(0, end - WINDOW), end);
  const nav = $(`#${kind}Nav`);
  nav.hidden = rows.length <= WINDOW;
  nav.querySelector('[data-dir="1"]').disabled = offsets[kind] >= maxOffset;
  nav.querySelector('[data-dir="-1"]').disabled = offsets[kind] === 0;
  nav.querySelector('.chart-nav__range').textContent = shown.length ? `${formatKey(shown[0].date)} → ${formatKey(shown[shown.length - 1].date)}` : '';
  renderLineChart($(`#${kind}Chart`), shown, { unit: ` ${cfg.unit}`, decimals: cfg.decimals, minPad: cfg.minPad });
}

function renderCompare() {
  const rows = state.bodyMetrics.measurements;
  const host = $('#measureCompare');
  if (!rows.length) {
    host.innerHTML = '<p class="chart-empty">Aucune prise de mensurations pour le moment.</p>';
    return;
  }
  const latest = rows.length - 1;
  const maxRef = Math.max(0, latest - 1);
  refIndex = refIndex === null ? maxRef : Math.min(Math.max(0, refIndex), maxRef);
  const current = rows[latest];
  const ref = latest >= 1 ? rows[refIndex] : null;
  const nav = rows.length > 2
    ? `<div class="chart-nav"><button type="button" class="chip-btn" data-action="ref" data-dir="-1" ${refIndex === 0 ? 'disabled' : ''}>${icon('chevronLeft', 14)} Plus ancienne</button><span class="chart-nav__range">Réf. ${ref ? formatKey(ref.date) : '—'}</span><button type="button" class="chip-btn" data-action="ref" data-dir="1" ${refIndex >= maxRef ? 'disabled' : ''}>Plus récente ${icon('chevronRight', 14)}</button></div>`
    : '';
  const cards = MEASURE_FIELDS.map(([key, label]) => {
    const cur = current[key];
    const old = ref?.[key];
    let d = { text: '—', cls: 'neutral' };
    if (cur !== null && old !== null && old !== undefined) d = delta(cur, old, 'cm', 1);
    else if (cur !== null && ref) d = { text: 'Pas de référence', cls: 'neutral' };
    return `<div class="compare-card"><span class="compare-card__label">${label}</span><strong class="compare-card__value">${cur !== null ? `${fmt(cur, 1)} cm` : '—'}</strong><span class="compare-card__ref">${old !== null && old !== undefined ? `avant : ${fmt(old, 1)} cm` : '&nbsp;'}</span><span class="delta delta--${d.cls}">${d.text}</span></div>`;
  }).join('');
  host.innerHTML = `${nav}<p class="compare-caption">Dernière prise du <strong>${formatKey(current.date)}</strong>${ref ? ` comparée au <strong>${formatKey(ref.date)}</strong>` : ''}</p><div class="compare-grid">${cards}</div>`;
}

export function renderMetrics() {
  ['weightForm', 'ftpForm', 'measureForm'].forEach(id => {
    const input = $(`#${id}`).elements.date;
    if (!input.value) input.value = todayKey();
  });
  renderSeries('weight');
  renderSeries('ftp');
  renderCompare();
  if (isOpen('historySheet')) renderHistory();
}

/* ---------- Ajout ---------- */
function measureSchema() {
  const schema = { date: [rules.date({ required: true })] };
  MEASURE_FIELDS.forEach(([k]) => (schema[k] = [rules.number(MEASURE_RANGE)]));
  return schema;
}

function seriesSchema(kind) {
  const cfg = SERIES[kind];
  return { date: [rules.date({ required: true })], value: [rules.number({ min: cfg.min, max: cfg.max, required: true, label: cfg.label })] };
}

function measureRow(v, id) {
  const row = { id, date: v.date };
  MEASURE_FIELDS.forEach(([k]) => (row[k] = parseNumber(v[k])));
  return row;
}

function onAdd(e) {
  const form = e.target.closest('form[data-kind]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.kind;
  const v = formValues(form);
  if (kind === 'measurements') {
    const { valid, errors } = validate(v, measureSchema());
    if (!valid) return showErrors(form, errors);
    if (!MEASURE_FIELDS.some(([k]) => v[k])) return showErrors(form, { [MEASURE_FIELDS[0][0]]: 'Renseignez au moins une mesure.' });
    state.bodyMetrics.measurements.push(measureRow(v, uid()));
    state.bodyMetrics.measurements.sort(byDate);
    refIndex = null;
  } else {
    const { valid, errors } = validate(v, seriesSchema(kind));
    if (!valid) return showErrors(form, errors);
    state.bodyMetrics[kind].push({ id: uid(), date: v.date, value: parseNumber(v.value) });
    state.bodyMetrics[kind].sort(byDate);
    offsets[kind] = 0;
  }
  clearErrors(form);
  const date = form.elements.date.value;
  form.reset();
  form.elements.date.value = date;
  commit('bodyMetrics');
  toast('Mesure enregistrée');
}

/* ---------- Historique ---------- */
function openHistory(type) {
  history = { type, editing: null };
  renderHistory();
  openSheet('historySheet', { focus: false });
}

function renderHistory() {
  const { type, editing } = history;
  $('#historyTitle').textContent = SERIES[type]?.title || 'Historique des mensurations';
  const host = $('#historyContent');
  const rows = [...state.bodyMetrics[type]].reverse();
  if (editing) return renderHistoryEdit(host, type, rows.find(r => r.id === editing));
  if (!rows.length) {
    host.innerHTML = '<div class="empty-state"><p>Aucune donnée enregistrée.</p></div>';
    return;
  }
  host.innerHTML = `<p class="sheet__sub">${rows.length} ${rows.length > 1 ? 'entrées' : 'entrée'}</p><div class="stack">${rows
    .map(r => {
      const value =
        type === 'measurements'
          ? MEASURE_FIELDS.filter(([k]) => r[k] !== null).map(([k, l]) => `${l} ${fmt(r[k], 1)}`).join(' · ')
          : `${fmt(r.value, SERIES[type].decimals)} ${SERIES[type].unit}`;
      return `<div class="history-row" data-id="${esc(r.id)}"><div><div class="history-row__date">${formatKey(r.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div><div class="history-row__value ${type === 'measurements' ? 'is-small' : ''}">${value}</div></div>
        <div class="row-actions"><button type="button" class="icon-btn" data-hist="edit" aria-label="Modifier">${icon('edit', 17)}</button><button type="button" class="icon-btn icon-btn--danger" data-hist="delete" aria-label="Supprimer">${icon('trash', 17)}</button></div></div>`;
    })
    .join('')}</div>`;
}

function renderHistoryEdit(host, type, row) {
  if (!row) {
    history.editing = null;
    return renderHistory();
  }
  const fields =
    type === 'measurements'
      ? `<div class="form-grid">${MEASURE_FIELDS.map(([k, l]) => `<div class="field"><label class="field__label" for="h-${k}">${l} · cm</label><input id="h-${k}" class="input" name="${k}" inputmode="decimal" value="${row[k] ?? ''}"></div>`).join('')}</div>`
      : `<div class="field"><label class="field__label" for="h-value">${SERIES[type].label} · ${SERIES[type].unit}</label><input id="h-value" class="input" name="value" inputmode="decimal" value="${row.value}"></div>`;
  host.innerHTML = `<form id="historyForm" class="form" novalidate>
    <div class="field"><label class="field__label" for="h-date">Date</label><input id="h-date" class="input" type="date" name="date" value="${row.date}" required></div>
    ${fields}
    <div class="form-actions"><button type="button" class="btn btn--ghost" data-hist="cancel">Annuler</button><button type="submit" class="btn btn--primary">Enregistrer</button></div>
  </form>`;
}

async function onHistoryClick(e) {
  const btn = e.target.closest('[data-hist]');
  if (!btn) return;
  const { type } = history;
  const id = btn.closest('[data-id]')?.dataset.id;
  const row = state.bodyMetrics[type].find(r => r.id === id);
  switch (btn.dataset.hist) {
    case 'cancel':
      history.editing = null;
      return renderHistory();
    case 'edit':
      history.editing = id;
      return renderHistory();
    case 'delete':
      if (!row) return;
      if (await confirmDialog({ title: `Supprimer la donnée du ${formatKey(row.date)} ?`, confirmLabel: 'Supprimer', danger: true })) {
        state.bodyMetrics[type] = state.bodyMetrics[type].filter(r => r.id !== id);
        commit('bodyMetrics');
        toast('Donnée supprimée');
      }
  }
}

function onHistorySubmit(e) {
  if (e.target.id !== 'historyForm') return;
  e.preventDefault();
  const form = e.target;
  const { type, editing } = history;
  const list = state.bodyMetrics[type];
  const index = list.findIndex(r => r.id === editing);
  if (index === -1) return;
  const v = formValues(form);
  if (type === 'measurements') {
    const { valid, errors } = validate(v, measureSchema());
    if (!valid) return showErrors(form, errors);
    if (!MEASURE_FIELDS.some(([k]) => v[k])) return showErrors(form, { [MEASURE_FIELDS[0][0]]: 'Renseignez au moins une mesure.' });
    list[index] = measureRow(v, editing);
  } else {
    const { valid, errors } = validate(v, seriesSchema(type));
    if (!valid) return showErrors(form, errors);
    list[index] = { id: editing, date: v.date, value: parseNumber(v.value) };
  }
  list.sort(byDate);
  history.editing = null;
  commit('bodyMetrics');
  toast('Donnée modifiée');
}

export function initMetrics() {
  const view = $('#metricsView');
  view.addEventListener('submit', onAdd);
  view.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, kind, dir } = btn.dataset;
    if (action === 'history') openHistory(kind);
    else if (action === 'window') {
      offsets[kind] = Math.max(0, offsets[kind] + Number(dir));
      renderSeries(kind);
    } else if (action === 'ref') {
      refIndex += Number(dir);
      renderCompare();
    }
  });
  const sheet = $('#historySheet');
  sheet.addEventListener('click', onHistoryClick);
  sheet.addEventListener('submit', onHistorySubmit);
}
