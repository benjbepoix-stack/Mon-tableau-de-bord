/* Accès sécurisé au localStorage (mode privé, quota plein, JSON corrompu). */

export function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === '') return fallback;
    const value = JSON.parse(raw);
    return value === null ? fallback : value;
  } catch (error) {
    console.warn(`[storage] lecture impossible (${key})`, error);
    return fallback;
  }
}

export function readText(key, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function write(key, value) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`[storage] écriture impossible (${key})`, error);
    return false;
  }
}
