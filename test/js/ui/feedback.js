/* Retours sensoriels brefs : gerbe de pollen à l'endroit du geste et vibration légère (Android). */

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function burst(x, y, count = 18) {
  if (reduced()) return;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    const a = Math.random() * Math.PI * 2;
    const r = 50 + Math.random() * 100;
    const s = 4 + Math.random() * 6;
    p.className = 'pollen';
    p.style.cssText = `left:${x}px;top:${y}px;width:${s}px;height:${s}px;--tx:${Math.cos(a) * r}px;--ty:${Math.sin(a) * r - 20}px`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 850);
  }
}

export function buzz(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* non pris en charge */
  }
}
