/*
 * Validation stricte des formulaires avant tout envoi vers Firebase.
 * Chaque règle retourne un message d'erreur (string) ou null.
 */
import { isDateKey, isTime } from './dates.js';
import { parseNumber } from './utils.js';

export const rules = {
  required: (label = 'Ce champ') => v => (String(v ?? '').trim() ? null : `${label} est obligatoire.`),
  maxLength: max => v => (String(v ?? '').trim().length <= max ? null : `${max} caractères maximum.`),
  date: ({ required = false } = {}) => v => {
    if (!v) return required ? 'La date est obligatoire.' : null;
    if (!isDateKey(v)) return 'Date invalide.';
    const year = Number(v.slice(0, 4));
    return year >= 1900 && year <= 2200 ? null : 'Année hors limites.';
  },
  time: () => v => (!v || isTime(v) ? null : 'Heure invalide (HH:MM).'),
  number: ({ min = 0, max = Infinity, required = false, integer = false, label = 'La valeur' } = {}) => v => {
    if (v === '' || v === null || v === undefined) return required ? `${label} est obligatoire.` : null;
    const n = parseNumber(v);
    if (n === null) return 'Nombre invalide.';
    if (integer && !Number.isInteger(n)) return 'Nombre entier attendu.';
    if (n < min) return `Minimum ${min}.`;
    if (n > max) return `Maximum ${max}.`;
    return null;
  }
};

/**
 * Valide un objet de valeurs selon un schéma { champ: [règle, …] }.
 * @returns {{ valid: boolean, errors: Record<string,string> }}
 */
export function validate(values, schema) {
  const errors = {};
  for (const [field, fieldRules] of Object.entries(schema)) {
    for (const rule of fieldRules) {
      const message = rule(values[field], values);
      if (message) {
        errors[field] = message;
        break;
      }
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Affiche les erreurs sous les champs (attributs `name`) d'un formulaire. */
export function showErrors(form, errors) {
  clearErrors(form);
  let first = null;
  for (const [name, message] of Object.entries(errors)) {
    const input = form.querySelector(`[name="${name}"]`);
    if (!input) continue;
    input.setAttribute('aria-invalid', 'true');
    const field = input.closest('.field') || input.parentElement;
    const hint = document.createElement('p');
    hint.className = 'field-error';
    hint.id = `${form.id || 'form'}-${name}-error`;
    hint.textContent = message;
    input.setAttribute('aria-describedby', hint.id);
    field.appendChild(hint);
    first ??= input;
  }
  if (first) {
    first.focus({ preventScroll: true });
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

export function clearErrors(form) {
  form.querySelectorAll('.field-error').forEach(el => el.remove());
  form.querySelectorAll('[aria-invalid]').forEach(el => {
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
  });
}

/** Récupère les valeurs nommées d'un formulaire (chaînes trimées). */
export function formValues(form) {
  const values = {};
  new FormData(form).forEach((v, k) => (values[k] = typeof v === 'string' ? v.trim() : v));
  return values;
}
