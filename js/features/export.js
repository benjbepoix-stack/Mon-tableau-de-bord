/*
 * Export CSV de l'historique (mesures et entraînements), pour un suivi
 * externe (tableur, coach…). Même contrainte que les .ics (voir ics.js) :
 * les Blob URL sont refusées en mode PWA « écran d'accueil » sur iOS, donc
 * on privilégie le partage natif, avec repli sur une data-URL puis un
 * téléchargement classique.
 */
import { state } from '../core/store.js';
import { MEASURE_FIELDS } from '../core/schema.js';
import { isIOS, isStandalone } from './ics.js';

const csvEscape = v => {
  const s = String(v ?? '');
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = cells => cells.map(csvEscape).join(';') + '\r\n';

/** CSV des mensurations : poids, FTP vélo, mensurations détaillées. */
export function metricsCSV() {
  let csv = '﻿'; // BOM : Excel détecte l'UTF-8
  csv += 'Poids\r\n' + row(['Date', 'Poids (kg)']);
  state.bodyMetrics.weight.forEach(r => (csv += row([r.date, r.value])));
  csv += '\r\nFTP vélo\r\n' + row(['Date', 'FTP (W)']);
  state.bodyMetrics.ftp.forEach(r => (csv += row([r.date, r.value])));
  csv += '\r\nMensurations\r\n' + row(['Date', ...MEASURE_FIELDS.map(([, l]) => `${l} (cm)`)]);
  state.bodyMetrics.measurements.forEach(r => (csv += row([r.date, ...MEASURE_FIELDS.map(([k]) => r[k] ?? '')])));
  return csv;
}

/** CSV de toutes les séances planifiées (passées et à venir), triées par date. */
export function trainingCSV() {
  const familyById = id => state.families.find(f => f.id === id);
  let csv = '﻿' + row(['Date', 'Sport', 'Séance', 'Distance (km)', 'Durée', 'D+ (m)']);
  Object.keys(state.plans)
    .sort()
    .forEach(day => {
      (state.plans[day] || []).forEach(s => {
        if (!s.training) return;
        const f = s.family ? familyById(s.family) : null;
        csv += row([day, f?.name || '', s.training, s.distance || '', s.time || '', s.elevation || '']);
      });
    });
  return csv;
}

function fileName(base) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${base}-${stamp}.csv`;
}

/**
 * Télécharge un contenu CSV. Préfère la feuille de partage système
 * (fonctionne dans tous les modes) ; sinon ouverture d'une data-URL sur iOS
 * en PWA installée, sinon téléchargement classique via Blob.
 */
export async function downloadCSV(content, baseName) {
  const name = fileName(baseName);
  const file = new File([content], name, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'share';
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
      // Partage indisponible pour ce fichier : on retombe sur le téléchargement.
    }
  }
  if (isIOS() && isStandalone()) {
    const link = document.createElement('a');
    link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(content)}`;
    link.rel = 'noopener';
    link.target = '_self';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return 'ios';
  }
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'download';
}

export const exportMetrics = () => downloadCSV(metricsCSV(), 'mensurations');
export const exportTraining = () => downloadCSV(trainingCSV(), 'entrainements');
