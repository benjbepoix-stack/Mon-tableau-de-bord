/* Liste des sports et de leurs séances types (feuille « Sports et types de séance », ouverte depuis Sport).
   Le planning lui-même est dans l'onglet Sport (vivant.js). */
import { $, esc, uid, slugify, plural } from '../core/utils.js';
import { state, commit } from '../core/store.js';
import { openSheet, confirmDialog, promptDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';
import { icon } from '../ui/icons.js';

const familyById = id => state.families.find(f => f.id === id);

/* ---------- Gestion des sports ---------- */
function renderManager() {
  const fams = state.families;
  $('#familyList').innerHTML = fams
    .map(
      (f, fi) => `<section class="family" data-family="${esc(f.id)}">
      <header class="family__head">
        <div><h3 class="family__name">${esc(f.name)}</h3><span class="family__count">${f.types.length} ${plural(f.types.length, 'séance type', 'séances types')}</span></div>
        <div class="row-actions">
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="family-up" ${fi === 0 ? 'disabled' : ''} aria-label="Monter">${icon('chevronUp', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="family-down" ${fi === fams.length - 1 ? 'disabled' : ''} aria-label="Descendre">${icon('chevronDown', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="family-edit" aria-label="Renommer">${icon('edit', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-mgr="family-delete" aria-label="Supprimer">${icon('trash', 16)}</button>
        </div>
      </header>
      ${f.types
        .map(
          (t, i) => `<div class="family__type" data-index="${i}"><span>${esc(t)}</span><div class="row-actions">
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="type-up" ${i === 0 ? 'disabled' : ''} aria-label="Monter">${icon('chevronUp', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="type-down" ${i === f.types.length - 1 ? 'disabled' : ''} aria-label="Descendre">${icon('chevronDown', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm" data-mgr="type-edit" aria-label="Renommer">${icon('edit', 16)}</button>
          <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-mgr="type-delete" aria-label="Supprimer">${icon('trash', 16)}</button>
        </div></div>`
        )
        .join('')}
      <form class="inline-form" data-mgr-form="type"><input class="input" name="name" maxlength="80" placeholder="Nouvelle séance type…" aria-label="Nouvelle séance pour ${esc(f.name)}"><button type="submit" class="btn btn--primary btn--icon" aria-label="Ajouter">${icon('plus', 18)}</button></form>
    </section>`
    )
    .join('');
}

const eachSession = fn => Object.values(state.plans).forEach(day => Array.isArray(day) && day.forEach(fn));
const swap = (arr, i, j) => ([arr[i], arr[j]] = [arr[j], arr[i]]);

/*
 * `objectives` n'est plus écrit d'ici : il porte les phases de saison d'Allure, et
 * l'envoyer en bloc depuis un appareil pas à jour les écraserait.
 */
function saveFamilies(message) {
  commit(['families', 'plans']);
  renderManager();
  if (message) toast(message);
}

async function onManagerClick(e) {
  const btn = e.target.closest('[data-mgr]');
  if (!btn) return;
  const famEl = btn.closest('[data-family]');
  const f = familyById(famEl?.dataset.family);
  if (!f) return;
  const fi = state.families.indexOf(f);
  const ti = Number(btn.closest('[data-index]')?.dataset.index);
  switch (btn.dataset.mgr) {
    case 'family-up':
    case 'family-down': {
      const j = fi + (btn.dataset.mgr === 'family-up' ? -1 : 1);
      if (j < 0 || j >= state.families.length) return;
      swap(state.families, fi, j);
      return saveFamilies();
    }
    case 'family-edit': {
      const name = await promptDialog({ title: 'Renommer le sport', label: 'Nom', value: f.name, maxLength: 60 });
      if (!name || name === f.name) return;
      if (state.families.some(x => x !== f && x.name.toLowerCase() === name.toLowerCase())) return toastError('Ce sport existe déjà.');
      f.name = name;
      return saveFamilies('Sport renommé');
    }
    case 'family-delete': {
      if (state.families.length <= 1) return toastError('Conservez au moins un sport.');
      const ok = await confirmDialog({ title: `Supprimer « ${f.name} » ?`, message: 'Ses séances types seront supprimées et les séances planifiées associées seront vidées.', confirmLabel: 'Supprimer', danger: true });
      if (!ok) return;
      eachSession(s => {
        if (s.family === f.id) Object.assign(s, { family: '', training: '', distance: '', time: '', elevation: '' });
      });
      state.families = state.families.filter(x => x !== f);
      return saveFamilies('Sport supprimé');
    }
    case 'type-up':
    case 'type-down': {
      const j = ti + (btn.dataset.mgr === 'type-up' ? -1 : 1);
      if (j < 0 || j >= f.types.length) return;
      swap(f.types, ti, j);
      return saveFamilies();
    }
    case 'type-edit': {
      const old = f.types[ti];
      const name = await promptDialog({ title: 'Renommer la séance', label: 'Nom', value: old });
      if (!name || name === old) return;
      if (f.types.some((x, i) => i !== ti && x.toLowerCase() === name.toLowerCase())) return toastError('Cette séance existe déjà.');
      f.types[ti] = name;
      eachSession(s => {
        if (s.family === f.id && s.training === old) s.training = name;
      });
      return saveFamilies('Séance renommée');
    }
    case 'type-delete': {
      const removed = f.types[ti];
      if (!(await confirmDialog({ title: `Supprimer « ${removed} » ?`, confirmLabel: 'Supprimer', danger: true }))) return;
      f.types.splice(ti, 1);
      eachSession(s => {
        if (s.family === f.id && s.training === removed) s.training = '';
      });
      return saveFamilies('Séance supprimée');
    }
  }
}

function onManagerSubmit(e) {
  const form = e.target.closest('[data-mgr-form]');
  if (!form) return;
  e.preventDefault();
  const input = form.elements.name;
  const name = input.value.trim();
  if (!name) {
    input.setAttribute('aria-invalid', 'true');
    return input.focus();
  }
  input.removeAttribute('aria-invalid');
  if (form.dataset.mgrForm === 'family') {
    if (name.length > 60) return toastError('60 caractères maximum.');
    if (state.families.some(f => f.name.toLowerCase() === name.toLowerCase())) return toastError('Ce sport existe déjà.');
    let id = slugify(name) || uid();
    if (familyById(id)) id = `${id}-${uid().slice(-4)}`;
    state.families.push({ id, name, types: [] });
    saveFamilies('Sport ajouté');
    requestAnimationFrame(() => $(`[data-family="${CSS.escape(id)}"] input`)?.focus());
  } else {
    const f = familyById(form.closest('[data-family]')?.dataset.family);
    if (!f) return;
    if (f.types.some(t => t.toLowerCase() === name.toLowerCase())) return toastError('Cette séance existe déjà.');
    f.types.push(name);
    saveFamilies('Séance ajoutée');
    requestAnimationFrame(() => $(`[data-family="${CSS.escape(f.id)}"] input`)?.focus());
  }
  input.value = '';
}

export function openSportManager() {
  renderManager();
  openSheet('sportSheet', { focus: false });
}

export function initTraining() {
  const sheet = $('#sportSheet');
  sheet.addEventListener('click', onManagerClick);
  sheet.addEventListener('submit', onManagerSubmit);
}
