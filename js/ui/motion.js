/* Animations de l'app (les 12 de la maquette) : glissement des onglets, cascade,
   chiffres qui défilent, tirer pour actualiser… Tout est coupé si l'appareil
   demande de réduire les animations. */
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const TABS = ['todayView', 'agendaView', 'todoView', 'weekView'];

/* 2 · Apparition en cascade : chaque bloc et chaque ligne arrivent l'un après l'autre. */
const UNITS = '.d-sec, .d-mode, .d-past, .d-day__h, .d-it, .d-strip, .d-card, .e-sec, .k-sw, .e-row, .e-empty, .d-cal, .s-phase, .j-sd, .s-wh, .rt-entry, .k-blk, .d-today-btn';
export function stagger(host) {
  if (reduced()) return;
  let i = 0;
  const top = host.getBoundingClientRect().top;
  host.querySelectorAll(UNITS).forEach(el => {
    // Les lignes déjà prises dans un bloc animé suivent leur bloc.
    if (el.parentElement.closest('.mo-u') && !el.matches('.d-it, .k-sw, .e-row, .j-sd')) return;
    if (el.getBoundingClientRect().top - top > window.innerHeight * 1.3) return;
    el.classList.add('mo-u');
    el.style.setProperty('--i', Math.min(i++, 14));
  });
  host.classList.add('mo-in');
  clearTimeout(host._mo);
  host._mo = setTimeout(() => {
    host.classList.remove('mo-in');
    host.querySelectorAll('.mo-u').forEach(el => el.classList.remove('mo-u'));
  }, 1300);
}

/* 9 · Chiffres qui défilent jusqu'à leur valeur. */
export function countUp(root) {
  if (reduced()) return;
  root.querySelectorAll('[data-count]').forEach(el => {
    const n = Number(el.dataset.count);
    if (!Number.isFinite(n) || n <= 0) return;
    const t0 = performance.now();
    const dur = Math.min(900, 450 + n * 12);
    const step = t => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(n * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    el.textContent = '0';
    requestAnimationFrame(step);
  });
}

/* 1 · Onglets : la pastille glisse d'un onglet à l'autre, l'écran arrive du bon côté. */
let lastTab = null;
export function moveInk() {
  const bar = document.querySelector('.tabbar');
  const on = bar?.querySelector('.tabbar__item.is-active');
  if (!bar || !on) return;
  let ink = bar.querySelector('.mo-ink');
  if (!ink) {
    ink = document.createElement('span');
    ink.className = 'mo-ink';
    ink.setAttribute('aria-hidden', 'true');
    bar.prepend(ink);
    bar.classList.add('has-ink');
  }
  ink.style.width = `${on.offsetWidth}px`;
  ink.style.height = `${on.offsetHeight}px`;
  ink.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
}
export function tabChanged(id) {
  const from = lastTab;
  lastTab = id;
  requestAnimationFrame(moveInk);
  if (!from || from === id || reduced()) return;
  const a = TABS.indexOf(from);
  const b = TABS.indexOf(id);
  if (a < 0 || b < 0) return;
  const view = document.getElementById(id);
  if (!view) return;
  view.classList.remove('mo-from-r', 'mo-from-l');
  void view.offsetWidth;
  view.classList.add(b > a ? 'mo-from-r' : 'mo-from-l');
  setTimeout(() => view.classList.remove('mo-from-r', 'mo-from-l'), 450);
}
addEventListener('resize', () => requestAnimationFrame(moveInk));
if (document.fonts?.ready) document.fonts.ready.then(() => moveInk());

/* 11 · Tirer pour actualiser la météo (accueil, en haut de la page). */
export function initPullToRefresh(onRefresh) {
  const el = document.createElement('div');
  el.className = 'mo-ptr';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<span class="mo-ptr__sun"><svg class="d-ill" viewBox="0 0 64 64"><use href="#d-sun"/></svg></span><small>Tirer pour actualiser la météo</small>';
  document.body.appendChild(el);
  const label = el.querySelector('small');
  const sun = el.querySelector('.mo-ptr__sun');
  let y0 = null;
  let pull = 0;
  let busy = false;
  const can = () => !busy && window.scrollY <= 0 && document.body.dataset.screen === 'todayView'
    && !document.body.classList.contains('e-flow-on') && !document.querySelector('.e-pm.is-open, dialog[open]');
  addEventListener('touchstart', e => { y0 = can() && e.touches.length === 1 ? e.touches[0].clientY : null; pull = 0; }, { passive: true });
  addEventListener('touchmove', e => {
    if (y0 === null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy <= 0 || window.scrollY > 0) { pull = 0; el.style.transform = ''; el.classList.remove('is-pull'); return; }
    pull = Math.min(110, dy * 0.5);
    el.classList.add('is-pull');
    el.style.transition = 'none';
    el.style.transform = `translate(-50%, ${pull}px)`;
    sun.style.transform = `rotate(${dy * 1.6}deg) scale(${Math.min(1, 0.4 + pull / 120)})`;
    el.classList.toggle('is-armed', pull > 70);
    label.textContent = pull > 70 ? 'Lâcher pour actualiser' : 'Tirer pour actualiser la météo';
  }, { passive: true });
  addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null;
    el.style.transition = '';
    sun.style.transform = '';
    if (pull > 70 && !reduced()) {
      busy = true;
      el.classList.add('is-loading');
      el.style.transform = 'translate(-50%, 70px)';
      label.textContent = 'Actualisation…';
      try { navigator.vibrate?.(8); } catch { /* sans vibreur */ }
      Promise.resolve(onRefresh()).catch(() => {}).finally(() => {
        setTimeout(() => {
          label.textContent = 'Météo à jour';
          setTimeout(() => {
            el.classList.remove('is-loading', 'is-armed', 'is-pull');
            el.style.transform = '';
            busy = false;
          }, 600);
        }, 700);
      });
    } else {
      el.classList.remove('is-armed', 'is-pull');
      el.style.transform = '';
    }
    pull = 0;
  });
}
