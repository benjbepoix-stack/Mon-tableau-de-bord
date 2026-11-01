/* Maquette Carnet : mêmes écrans et mêmes données fictives pour les pages
   « styles » et « animations ». Les animations sont activées par window.CARNET_ANIM. */
(function () {
  'use strict';
  const ANIM = window.CARNET_ANIM || {};
  const on = k => !!ANIM[k];
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------- Dates (tout est relatif à aujourd'hui) ---------- */
  const T = new Date(); T.setHours(0, 0, 0, 0);
  const dd = i => new Date(T.getFullYear(), T.getMonth(), T.getDate() + i);
  const DN = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  const DFULL = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const DL = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
  const MO = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const idxOf = d => Math.round((d - T) / 864e5);
  const dayLabel = i => i === 0 ? 'Aujourd’hui' : i === 1 ? 'Demain' : cap(DFULL[dd(i).getDay()]);

  /* ---------- Données fictives ---------- */
  const S = {
    view: 'todayView', sel: 0, mOff: 0, mSel: 0, showPast: false,
    items: [
      { id: 'e1', type: 'evt', title: 'Week-end Jura', d: 5, d2: 6 },
      { id: 'r1', type: 'rdv', title: 'Dentiste', d: 1, time: '17 h 30' },
      { id: 'r2', type: 'rdv', title: 'Réunion école', d: 3, time: '18 h' },
      { id: 'c1', type: 'course', title: 'Drive courses', d: 4, time: '9 h 30' },
      { id: 'r3', type: 'rdv', title: 'Coiffeur', d: 9, time: '10 h' },
      { id: 'e2', type: 'evt', title: 'Anniversaire Léa', d: 12 },
      { id: 's1', type: 'sport', sport: 'run', title: 'Course à pied', sub: 'Footing facile · 10 km · 1 h', d: 0, done: false, mins: 60 },
      { id: 's2', type: 'sport', sport: 'bike', title: 'Vélo', sub: 'Sortie tranquille · 40 km · 1 h 30', d: 2, done: false, mins: 90 },
      { id: 's3', type: 'sport', sport: 'gym', title: 'Gainage', sub: 'Routine · 20 min', d: 3, done: false, mins: 20 },
      { id: 's4', type: 'sport', sport: 'trail', title: 'Trail', sub: 'Sortie longue · 18 km · 2 h 15', d: 5, done: false, mins: 135 },
      { id: 't1', type: 'task', title: 'Payer la cantine', d: -2, done: false },
      { id: 't2', type: 'task', title: 'Rendre les livres', d: 0, done: false },
      { id: 't3', type: 'task', title: 'Changer les pneus du vélo', d: 2, done: false },
      { id: 't4', type: 'task', title: 'Appeler mamie', d: 4, done: false },
      { id: 't5', type: 'task', title: 'Réserver le gîte', d: null, done: false },
      { id: 't6', type: 'task', title: 'Trier les photos', d: null, done: false }
    ],
    wx: [
      { ic: 'part', t: 'Éclaircies', mn: 4, mx: 13, w: 12 },
      { ic: 'rain', t: 'Pluie', mn: 6, mx: 10, w: 18 },
      { ic: 'sun', t: 'Soleil', mn: 2, mx: 14, w: 8 },
      { ic: 'cloud', t: 'Nuageux', mn: 5, mx: 11, w: 15 },
      { ic: 'sun', t: 'Soleil', mn: 3, mx: 15, w: 10 },
      { ic: 'part', t: 'Éclaircies', mn: 4, mx: 12, w: 14 },
      { ic: 'rain', t: 'Averses', mn: 5, mx: 9, w: 22 }
    ]
  };
  const byId = id => S.items.find(x => x.id === id);
  const onDay = i => S.items.filter(x => x.d !== null && (x.d === i || (x.d2 != null && x.d <= i && i <= x.d2)));
  const order = { evt: 0, rdv: 1, course: 2, sport: 3, task: 4 };
  const lateTasks = () => S.items.filter(x => x.type === 'task' && !x.done && x.d !== null && x.d < 0);

  /* ---------- Illustrations ---------- */
  const ILL = {
    rdv: '<svg viewBox="0 0 40 40"><rect x="7" y="9" width="26" height="24" rx="5" fill="#fff" stroke="#E7D9D3" stroke-width="1.5"/><path d="M7 14a5 5 0 0 1 5-5h16a5 5 0 0 1 5 5v2H7z" fill="#E0315B"/><rect x="13" y="6" width="3" height="7" rx="1.5" fill="#8A2A3E"/><rect x="24" y="6" width="3" height="7" rx="1.5" fill="#8A2A3E"/><g fill="#F4C9D3"><circle cx="14" cy="22" r="1.8"/><circle cx="20" cy="22" r="1.8"/><circle cx="26" cy="22" r="1.8"/><circle cx="14" cy="28" r="1.8"/></g><circle cx="20" cy="28" r="2.2" fill="#E0315B"/></svg>',
    evt: '<svg viewBox="0 0 40 40"><rect x="7" y="9" width="26" height="24" rx="5" fill="#fff" stroke="#D3DFE2" stroke-width="1.5"/><path d="M7 14a5 5 0 0 1 5-5h16a5 5 0 0 1 5 5v2H7z" fill="#1C5B6B"/><rect x="13" y="6" width="3" height="7" rx="1.5" fill="#0E3B4A"/><rect x="24" y="6" width="3" height="7" rx="1.5" fill="#0E3B4A"/><rect x="12" y="21" width="16" height="4" rx="2" fill="#BFD3D8"/><rect x="12" y="27" width="10" height="3" rx="1.5" fill="#BFD3D8"/></svg>',
    task: '<svg viewBox="0 0 40 40"><rect x="9" y="8" width="22" height="27" rx="4" fill="#E9B97A"/><rect x="11.5" y="11" width="17" height="21.5" rx="2.5" fill="#fff"/><rect x="15" y="6" width="10" height="6" rx="2" fill="#8C6A43"/><path d="M14.5 18l1.6 1.6 3-3M14.5 25l1.6 1.6 3-3" stroke="#E0315B" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><rect x="21" y="17.5" width="5" height="2" rx="1" fill="#D9D9D9"/><rect x="21" y="24.5" width="5" height="2" rx="1" fill="#D9D9D9"/></svg>',
    course: '<svg viewBox="0 0 40 40"><path d="M12 17l4-8M28 17l-4-8" stroke="#8C6A43" stroke-width="2.2" stroke-linecap="round"/><path d="M7 16h26l-3 15a3 3 0 0 1-3 2.5H13a3 3 0 0 1-3-2.5z" fill="#F5B531"/><path d="M15 21v8M20 21v8M25 21v8" stroke="#9A5B00" stroke-width="1.8" stroke-linecap="round" opacity=".55"/><circle cx="16" cy="13" r="3.5" fill="#7BC27B"/><circle cx="23" cy="12" r="3" fill="#E0315B"/></svg>',
    run: '<svg viewBox="0 0 40 40"><path d="M6 27c0-3 2-4 4-4.5l6-1.5 3-7 5 1-1 5 4 2c3 1.3 7 2 7 6v1.5c0 1-.8 1.5-1.8 1.5H8c-1.2 0-2-.8-2-1.8z" fill="#E0315B"/><path d="M6 29.5h28v1.5c0 1-.8 1.8-1.8 1.8H7.8C6.8 32.8 6 32 6 31z" fill="#fff" stroke="#E7D9D3"/><path d="M17 19l3 1.2M16 22l3 1.2" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
    bike: '<svg viewBox="0 0 40 40"><circle cx="11" cy="26" r="6.5" fill="none" stroke="#0E3B4A" stroke-width="2.4"/><circle cx="29" cy="26" r="6.5" fill="none" stroke="#0E3B4A" stroke-width="2.4"/><path d="M11 26l6-10h9l3 10M17 16l3 10h-9M20 26l6-10" fill="none" stroke="#E0315B" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/><path d="M15 13h5M25 13l1 3" stroke="#0E3B4A" stroke-width="2.4" stroke-linecap="round"/></svg>',
    trail: '<svg viewBox="0 0 40 40"><path d="M3 32l11-17 6 8 5-6 12 15z" fill="#1C5B6B"/><path d="M14 15l3.5 5.5-3.5-1.5-2.5 2z" fill="#fff"/><path d="M25 17l3 4-3-1-2 1.5z" fill="#fff"/><circle cx="31" cy="9" r="3.5" fill="#F5B531"/></svg>',
    gym: '<svg viewBox="0 0 40 40"><rect x="5" y="14" width="6" height="12" rx="2" fill="#0E3B4A"/><rect x="29" y="14" width="6" height="12" rx="2" fill="#0E3B4A"/><rect x="10" y="16" width="4" height="8" rx="1.5" fill="#1C5B6B"/><rect x="26" y="16" width="4" height="8" rx="1.5" fill="#1C5B6B"/><rect x="14" y="18.5" width="12" height="3" rx="1.5" fill="#E0315B"/></svg>',
    note: '<svg viewBox="0 0 40 40"><rect x="9" y="7" width="22" height="27" rx="4" fill="#FFE9A8"/><path d="M13 15h14M13 20h14M13 25h9" stroke="#C99A2E" stroke-width="2" stroke-linecap="round"/></svg>'
  };
  const WX = {
    sun: '<svg class="wx wx--sun" viewBox="0 0 32 32"><g class="wx-rays" stroke="#F5B531" stroke-width="2.4" stroke-linecap="round"><path d="M16 3v3M16 26v3M3 16h3M26 16h3M6.8 6.8l2.1 2.1M23.1 23.1l2.1 2.1M6.8 25.2l2.1-2.1M23.1 8.9l2.1-2.1"/></g><circle cx="16" cy="16" r="6.5" fill="#FFC56B"/></svg>',
    part: '<svg class="wx wx--part" viewBox="0 0 32 32"><g class="wx-sunb"><circle cx="12" cy="12" r="6" fill="#FFC56B"/></g><g class="wx-cloud"><path d="M10 26h14a5 5 0 0 0 .5-10A7 7 0 0 0 11 18.2 4 4 0 0 0 10 26z" fill="#fff" stroke="#C9D7DC" stroke-width="1.4"/></g></svg>',
    cloud: '<svg class="wx wx--cloud" viewBox="0 0 32 32"><g class="wx-cloud2"><path d="M18 14h7a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9 1" fill="#E3EBEE"/></g><g class="wx-cloud"><path d="M8 26h15a5.5 5.5 0 0 0 .5-11A7.5 7.5 0 0 0 9 17.6 4.3 4.3 0 0 0 8 26z" fill="#fff" stroke="#BFD3D8" stroke-width="1.4"/></g></svg>',
    rain: '<svg class="wx wx--rain" viewBox="0 0 32 32"><g class="wx-cloud"><path d="M8 20h15a5.5 5.5 0 0 0 .5-11A7.5 7.5 0 0 0 9 11.6 4.3 4.3 0 0 0 8 20z" fill="#fff" stroke="#BFD3D8" stroke-width="1.4"/></g><g stroke="#4D93A6" stroke-width="2" stroke-linecap="round"><path class="wx-drop" d="M11 23l-1 3"/><path class="wx-drop" d="M16 23l-1 3" style="animation-delay:.35s"/><path class="wx-drop" d="M21 23l-1 3" style="animation-delay:.7s"/></g></svg>'
  };
  const ic = x => ILL[x.type === 'sport' ? x.sport : x.type] || ILL.note;
  const typeName = { rdv: 'Rendez-vous', evt: 'Événement', course: 'Course', sport: 'Sport', task: 'Tâche' };
  const subOf = (x, i) => {
    if (x.type === 'sport') return x.sub;
    if (x.type === 'task') return x.d !== null && x.d < 0 && !x.done ? '<em class="late">en retard</em>' : 'Tâche';
    if (x.type === 'evt' && x.d2 != null) return 'Événement · jour ' + (i - x.d + 1) + '/' + (x.d2 - x.d + 1);
    return typeName[x.type] + (x.time ? ' · ' + x.time : '');
  };
  const CHK = '<svg viewBox="0 0 24 24"><path class="chk-path" d="M6 12.5l4 4 8-9"/></svg>';
  const RING = '<svg viewBox="0 0 36 36"><circle class="ring-bg" cx="18" cy="18" r="15"/><circle class="ring-fg" cx="18" cy="18" r="15"/><path class="ring-ok" d="M12 18.5l4 4 8-9"/></svg>';

  function itemHTML(x, i, k, sub) {
    const tail = x.type === 'task'
      ? `<button class="chk${x.done ? ' is-on' : ''}" data-check="${x.id}" aria-label="Fait">${CHK}</button>`
      : x.type === 'sport'
        ? `<button class="ring${x.done ? ' is-on' : ''}" data-done="${x.id}" aria-label="Séance faite">${RING}</button>`
        : (x.type === 'evt' && x.d2 != null && i === 0 ? '<span class="tag">Aujourd’hui</span>' : '');
    return `<div class="it it--${x.type}${x.done ? ' is-done' : ''}" data-id="${x.id}" style="--i:${k}">
      <span class="it__ic">${ic(x)}</span>
      <span class="it__body"><b>${x.title}</b><small>${sub != null ? sub : subOf(x, i)}</small></span>${tail}</div>`;
  }
  
  /* ---------- Écrans ---------- */
  function header(title, sub, tools = '') {
    return `<header class="hd"><div class="hd__t"><h1>${title}</h1><p>${sub}</p></div>${tools}</header>`;
  }
  const arrows = '<div class="hd__nav"><button class="nav-btn" data-nav="-1" aria-label="Précédent">‹</button><button class="nav-btn" data-nav="1" aria-label="Suivant">›</button></div>';

  function bento() {
    const next = S.items.filter(x => (x.type === 'rdv' || x.type === 'evt') && x.d >= 0).sort((a, b) => a.d - b.d)[0];
    const late = lateTasks().length;
    const todo = S.items.filter(x => x.type === 'task' && !x.done).length;
    const ses = S.items.find(x => x.type === 'sport' && x.d === 0);
    const w = S.wx[0];
    const pct = Math.round((1 - todo / 6) * 100);
    return `<div class="bento">
      <div class="bx bx--today press"><small>${cap(DFULL[T.getDay()])}</small><b class="bx__big">${T.getDate()}</b><span>${MO[T.getMonth()]}</span><span class="bx__wx">${WX[w.ic]}${w.mx}°</span></div>
      <div class="bx bx--next press"><small>Prochain</small><b>${next.title}</b><span>${dayLabel(next.d)}${next.time ? ' · ' + next.time : ''}</span></div>
      <div class="bx bx--tasks press" data-go="todoView"><div class="bx__ring" style="--p:${pct}"><b>${todo}</b></div><span>tâches à faire${late ? `<em class="late"> · ${late} en retard</em>` : ''}</span></div>
      <div class="bx bx--ses press" data-go="weekView"><small>Séance du jour</small><b>${ses ? ses.title : 'Repos'}</b><span>${ses ? ses.sub.split(' · ').slice(1).join(' · ') : ''}</span></div>
    </div>`;
  }

  function todayView() {
    const days = [];
    const start = S.showPast ? -2 : 0;
    for (let i = start; i < 7; i++) {
      const its = onDay(i).sort((a, b) => order[a.type] - order[b.type]);
      if (i === 0) its.unshift(...lateTasks().filter(x => !its.includes(x)));
      const d = dd(i), w = S.wx[i];
      days.push(`<section class="day${i === 0 ? ' is-today' : ''}${i < 0 ? ' is-past' : ''}" id="day${i}">
        <div class="day__hd"><span class="day__num">${d.getDate()}</span><div class="day__t"><b>${dayLabel(i)}</b><small>${DFULL[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]}</small></div>
        ${w ? `<span class="wxp">${WX[w.ic]}<span>${w.t}</span></span>` : ''}<button class="add press" data-add="${i}" aria-label="Ajouter">+</button></div>
        <div class="day__list">${its.length ? its.map((x, k) => itemHTML(x, i, k)).join('') : '<p class="empty">Rien de prévu</p>'}</div></section>`);
    }
    const strip = Array.from({ length: 7 }, (_, i) => {
      const d = dd(i); const n = onDay(i).length;
      return `<button class="st${i === S.sel ? ' is-sel' : ''}${i === 0 ? ' is-today' : ''}" data-sel="${i}"><small>${DL[d.getDay()]}</small><b>${d.getDate()}</b><i class="st__dots">${'<u></u>'.repeat(Math.min(n, 3))}</i></button>`;
    }).join('');
    return `${on('ptr') ? '<div class="ptr" id="ptr"><span class="ptr__sun">' + WX.sun + '</span><small>Tirer pour actualiser la météo</small></div>' : ''}
      <div class="bigdate"><span>${cap(DFULL[T.getDay()])}</span><b>${T.getDate()}</b><span>${MO[T.getMonth()]}</span></div>
      ${header('Cette semaine', `${dd(0).getDate()} ${MO[dd(0).getMonth()]} – ${dd(6).getDate()} ${MO[dd(6).getMonth()]}`)}
      ${bento()}
      <div class="strip"><span class="strip__pill" id="stripPill"></span>${strip}</div>
      ${S.showPast ? '' : '<button class="past press" data-past>Voir les 2 jours passés</button>'}
      <div class="days">${days.join('')}</div>`;
  }

  function monthView() {
    const base = new Date(T.getFullYear(), T.getMonth() + S.mOff, 1);
    const y = base.getFullYear(), m = base.getMonth();
    const first = (base.getDay() + 6) % 7;
    const nd = new Date(y, m + 1, 0).getDate();
    let cells = '';
    for (let k = 0; k < first; k++) cells += '<span class="mc mc--out"></span>';
    let count = 0;
    for (let n = 1; n <= nd; n++) {
      const d = new Date(y, m, n), i = idxOf(d);
      const its = onDay(i);
      const evts = its.filter(x => x.type === 'evt' || x.type === 'rdv');
      const dots = its.filter(x => x.type !== 'evt' && x.type !== 'rdv');
      count += evts.length;
      cells += `<button class="mc${i === 0 ? ' is-today' : ''}${i === S.mSel ? ' is-sel' : ''}${i < 0 ? ' is-past' : ''}" data-msel="${i}" style="--i:${n}">
        <b>${n}</b>${evts.slice(0, 1).map(x => `<span class="pill pill--${x.type}">${x.title}</span>`).join('')}
        <i class="mc__dots">${dots.slice(0, 3).map(x => `<u class="dot--${x.type}"></u>`).join('')}</i></button>`;
    }
    const sd = dd(S.mSel), its = onDay(S.mSel).sort((a, b) => order[a.type] - order[b.type]);
    return `${header(cap(MO[m]), `${y} · ${count} dates`, arrows)}
      <div class="cal" id="cal"><div class="cal__dow">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(x => `<span>${x}</span>`).join('')}</div><div class="cal__grid">${cells}</div>
      <div class="legend"><span><u class="dot--rdv"></u>Rendez-vous</span><span><u class="dot--evt"></u>Événement</span><span><u class="dot--sport"></u>Sport</span><span><u class="dot--task"></u>Tâche</span></div></div>
      <div class="msel" id="msel"><div class="sec"><h2>${cap(DFULL[sd.getDay()])} ${sd.getDate()} ${MO[sd.getMonth()]}</h2><small>${its.length ? its.length + ' chose' + (its.length > 1 ? 's' : '') + ' prévue' + (its.length > 1 ? 's' : '') : 'Rien de prévu'}</small></div>
      <div class="day__list">${its.map((x, k) => itemHTML(x, S.mSel, k)).join('')}</div></div>`;
  }

  function todoView() {
    const t = S.items.filter(x => x.type === 'task');
    const open = t.filter(x => !x.done);
    const late = open.filter(x => x.d !== null && x.d < 0);
    const week = open.filter(x => x.d !== null && x.d >= 0).sort((a, b) => a.d - b.d);
    const none = open.filter(x => x.d === null);
    const done = t.filter(x => x.done);
    let k = 0;
    const when = x => x.d === null ? 'Sans date' : x.d < 0 ? `<em class="late">en retard · ${DN[dd(x.d).getDay()]} ${dd(x.d).getDate()}</em>` : dayLabel(x.d);
    const row = x => `<div class="sw" data-sw="${x.id}"><div class="sw__bg"><span class="sw__ok">✓ Fait</span><span class="sw__tm">Demain →</span></div>${itemHTML(x, 0, k++, when(x))}</div>`;
    const sec = (title, arr) => arr.length ? `<div class="sec"><h2>${title}</h2><small>${arr.length}</small></div><div class="day__list">${arr.map(row).join('')}</div>` : '';
    return `${header('Tâches', `<span data-count="${open.length}">${open.length}</span> à faire${late.length ? ` · <em class="late"><span data-count="${late.length}">${late.length}</span> en retard</em>` : ''}`)}
      <label class="field"><span>+</span><input placeholder="Ajouter une tâche…" id="newTask" enterkeyhint="done"></label>
      ${sec('En retard', late)}${sec('Cette semaine', week)}${sec('Sans date', none)}
      ${done.length ? `<div class="sec"><h2>Faites</h2><small>${done.length}</small></div><div class="day__list">${done.map(x => itemHTML(x, 0, k++)).join('')}</div>` : ''}
      ${on('swipe') ? '<p class="hint">Astuce : glisse une tâche → pour « Fait », ← pour « Demain ».</p>' : ''}`;
  }

  function sportView() {
    const ses = S.items.filter(x => x.type === 'sport');
    const done = ses.filter(x => x.done);
    const mins = ses.reduce((a, x) => a + x.mins, 0);
    const h = m => Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0');
    const rows = Array.from({ length: 7 }, (_, i) => {
      const d = dd(i); const s = ses.filter(x => x.d === i);
      const ev = onDay(i).filter(x => x.type === 'evt')[0];
      return `<div class="sp${i === 0 ? ' is-today' : ''}"><div class="sp__d"><b>${DN[d.getDay()]} ${d.getDate()}</b>${i === 0 ? '<small>auj.</small>' : ''}</div>
        <div class="sp__c">${ev ? `<small class="sp__ev">${ev.title}</small>` : ''}${s.length ? s.map((x, k) => itemHTML(x, i, k)).join('') : '<span class="rest">Repos</span>'}</div></div>`;
    }).join('');
    const wx = S.wx.map((w, i) => `<div class="wxd"><small>${i === 0 ? 'Auj.' : DN[dd(i).getDay()]}</small>${WX[w.ic]}<b>${w.mx}°</b><span>${w.mn}°</span><em>${w.w} km/h</em></div>`).join('');
    return `${header('Sport', 'Cette semaine')}
      <div class="goal press"><span>🏁</span><div><b>Trail des Forts</b><small>Objectif de la saison</small></div><b class="goal__j">J-<span data-count="36">36</span></b></div>
      <div class="sec"><h2>Planifier</h2><small><span id="sesDone">${done.length}</span>/${ses.length} séances · ${h(mins)}</small></div>
      <div class="bar"><i style="width:${Math.round(done.length / ses.length * 100)}%"></i></div>
      <div class="splist">${rows}</div>
      <div class="sec"><h2>Météo</h2><small>pour choisir le bon moment</small></div>
      <div class="wxrow">${wx}</div>
      <div class="routine press"><span class="it__ic">${ILL.gym}</span><span class="it__body"><b>Routines</b><small>Étirements, gainage, mobilité… avec chrono</small></span><span class="chev">›</span></div>`;
  }

  const VIEWS = { todayView, agendaView: monthView, todoView, weekView: sportView };
  const TABS = ['todayView', 'agendaView', 'todoView', 'weekView'];

  /* ---------- Rendu ---------- */
  let lastView = null;
  function render(opts = {}) {
    const scr = $('#screen');
    const changed = lastView !== S.view;
    const dir = changed && lastView ? (TABS.indexOf(S.view) > TABS.indexOf(lastView) ? 1 : -1) : 0;
    scr.innerHTML = `<div class="view" data-v="${S.view}">${VIEWS[S.view]()}</div>`;
    const v = scr.firstChild;
    if (changed || opts.stagger) {
      if (changed) window.scrollTo(0, 0);
      if (on('tab') && dir) { v.classList.add(dir > 0 ? 'in-r' : 'in-l'); }
      if (on('stagger')) v.classList.add('stg');
      if (on('count')) countUp(v);
      if (on('month') && S.view === 'agendaView') v.classList.add('cal-in');
    }
    lastView = S.view;
    $$('.tab').forEach(b => b.classList.toggle('is-on', b.dataset.view === S.view));
    moveInk();
    if (S.view === 'todayView') requestAnimationFrame(() => movePill(false));
    if (S.view === 'todoView' && on('swipe')) bindSwipe();
    if (S.view === 'todayView' && on('ptr')) bindPtr();
  }

  function moveInk() {
    const ink = $('#tabInk'), b = $('.tab.is-on');
    if (!ink || !b) return;
    ink.style.width = b.offsetWidth + 'px';
    ink.style.transform = `translateX(${b.offsetLeft}px)`;
  }
  function movePill(anim) {
    const pill = $('#stripPill'), b = $('.st.is-sel');
    if (!pill || !b) return;
    pill.style.transition = anim && on('strip') ? '' : 'none';
    pill.style.width = b.offsetWidth + 'px';
    pill.style.height = b.offsetHeight + 'px';
    pill.style.transform = `translateX(${b.offsetLeft}px)`;
  }

  function countUp(root) {
    $$('[data-count]', root).forEach(el => {
      const n = +el.dataset.count; const t0 = performance.now(); const dur = 700;
      const step = t => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(n * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
      el.textContent = '0'; requestAnimationFrame(step);
    });
  }

  function burst(el, colors) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const box = document.createElement('div'); box.className = 'burst';
    box.style.left = r.left + r.width / 2 + 'px'; box.style.top = r.top + r.height / 2 + 'px';
    for (let k = 0; k < 10; k++) {
      const p = document.createElement('i');
      const a = (k / 10) * Math.PI * 2, dist = 22 + Math.random() * 14;
      p.style.setProperty('--x', Math.cos(a) * dist + 'px'); p.style.setProperty('--y', Math.sin(a) * dist + 'px');
      p.style.background = colors[k % colors.length];
      box.appendChild(p);
    }
    document.body.appendChild(box); setTimeout(() => box.remove(), 700);
  }
  function haptic() { try { navigator.vibrate && navigator.vibrate(8); } catch (e) {} }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('is-on');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('is-on'), 1800);
  }

  /* ---------- Actions ---------- */
  function completeTask(id, how) {
    const x = byId(id); if (!x) return;
    const row = $(`.it[data-id="${id}"]`);
    if (how === 'tomorrow') { x.d = x.d === null || x.d < 0 ? 1 : x.d + 1; toast('Reportée à ' + dayLabel(x.d).toLowerCase()); }
    else { x.done = !x.done; if (x.done) toast('Bravo, c’est fait'); }
    if (on('check') && row && x.done) {
      row.classList.add('is-checking'); haptic();
      burst(row.querySelector('.chk'), ['#E0315B', '#F5B531', '#1C5B6B', '#7BC27B']);
      const wrap = row.closest('.sw') || row;
      setTimeout(() => { wrap.style.height = wrap.offsetHeight + 'px'; wrap.classList.add('is-leaving'); requestAnimationFrame(() => { wrap.style.height = '0px'; }); }, 520);
      setTimeout(render, 900);
    } else render();
  }

  function toggleSession(id) {
    const x = byId(id); x.done = !x.done;
    const btn = $(`.ring[data-done="${id}"]`);
    if (on('ring') && btn && x.done) {
      btn.classList.add('is-on'); btn.closest('.it').classList.add('is-done'); haptic();
      setTimeout(() => burst(btn, ['#E0315B', '#F5B531', '#FF5C80']), 450);
      const ses = S.items.filter(s => s.type === 'sport');
      const bar = $('.bar i'); if (bar) bar.style.width = Math.round(ses.filter(s => s.done).length / ses.length * 100) + '%';
      const c = $('#sesDone'); if (c) { c.classList.add('roll'); setTimeout(() => { c.textContent = ses.filter(s => s.done).length; }, 150); }
      toast('Séance validée 💪');
      setTimeout(render, 1100);
    } else render();
  }

  function openSheet(day) {
    const sh = $('#sheet');
    sh.querySelector('.sheet__t').textContent = day != null ? 'Ajouter · ' + dayLabel(day).toLowerCase() : 'Ajouter';
    document.body.classList.add('sheet-open');
  }
  function closeSheet() { document.body.classList.remove('sheet-open'); }

  /* ---------- Gestes : glisser une tâche ---------- */
  function bindSwipe() {
    $$('.sw').forEach(sw => {
      const it = sw.querySelector('.it'); let x0 = 0, y0 = 0, dx = 0, drag = false, lock = null;
      sw.addEventListener('touchstart', e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; drag = true; lock = null; it.style.transition = 'none'; }, { passive: true });
      sw.addEventListener('touchmove', e => {
        if (!drag) return; const t = e.touches[0]; dx = t.clientX - x0; const dy = t.clientY - y0;
        if (lock === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (lock !== 'x') return;
        e.preventDefault();
        const r = dx * (Math.abs(dx) > 110 ? 0.6 : 1);
        it.style.transform = `translateX(${r}px)`;
        sw.classList.toggle('to-ok', dx > 0); sw.classList.toggle('to-tm', dx < 0);
        sw.classList.toggle('armed', Math.abs(dx) > 90);
      }, { passive: false });
      sw.addEventListener('touchend', () => {
        if (!drag) return; drag = false; it.style.transition = '';
        const id = sw.dataset.sw;
        if (lock === 'x' && Math.abs(dx) > 90) {
          haptic(); it.style.transform = `translateX(${dx > 0 ? 110 : -110}%)`;
          setTimeout(() => { sw.style.height = sw.offsetHeight + 'px'; sw.classList.add('is-leaving'); requestAnimationFrame(() => { sw.style.height = '0px'; }); }, 200);
          setTimeout(() => { if (dx > 0) { byId(id).done = true; toast('Bravo, c’est fait'); render(); } else completeTask(id, 'tomorrow'); }, 520);
        } else { it.style.transform = ''; sw.classList.remove('armed'); }
      });
    });
  }

  /* ---------- Geste : tirer pour actualiser ---------- */
  let ptrBound = false;
  function bindPtr() {
    if (ptrBound) return; ptrBound = true;
    let y0 = null, dy = 0;
    window.addEventListener('touchstart', e => { if (S.view === 'todayView' && window.scrollY <= 0 && !document.body.classList.contains('sheet-open')) { y0 = e.touches[0].clientY; dy = 0; } else y0 = null; }, { passive: true });
    window.addEventListener('touchmove', e => {
      if (y0 === null) return; dy = e.touches[0].clientY - y0; const p = $('#ptr'); if (!p) return;
      if (dy > 0) { const h = Math.min(90, dy * 0.5); p.style.height = h + 'px'; p.style.transition = 'none'; p.querySelector('.ptr__sun').style.transform = `rotate(${dy * 2}deg) scale(${Math.min(1, h / 60)})`; p.classList.toggle('armed', h > 60); }
    }, { passive: true });
    window.addEventListener('touchend', () => {
      const p = $('#ptr'); if (y0 === null || !p) return; y0 = null; p.style.transition = '';
      if (p.classList.contains('armed')) {
        p.classList.add('loading'); p.style.height = '64px'; p.querySelector('small').textContent = 'Actualisation…'; haptic();
        setTimeout(() => { p.querySelector('small').textContent = 'Météo à jour ✓'; }, 1100);
        setTimeout(() => { p.classList.remove('loading', 'armed'); p.style.height = '0px'; setTimeout(() => { if ($('#ptr')) $('#ptr small').textContent = 'Tirer pour actualiser la météo'; }, 300); }, 1700);
      } else { p.style.height = '0px'; }
    });
  }

  /* ---------- Clics ---------- */
  document.addEventListener('click', e => {
    const t = e.target.closest('button, [data-go], [data-sel], [data-close]');
    if (!t) return;
    if (t.dataset.view) { if (S.view !== t.dataset.view) { S.view = t.dataset.view; render(); } else window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (t.dataset.go) { S.view = t.dataset.go; render(); return; }
    if (t.dataset.check) { e.stopPropagation(); completeTask(t.dataset.check); return; }
    if (t.dataset.done) { e.stopPropagation(); toggleSession(t.dataset.done); return; }
    if (t.dataset.sel !== undefined) {
      S.sel = +t.dataset.sel; $$('.st').forEach(b => b.classList.toggle('is-sel', +b.dataset.sel === S.sel)); movePill(true);
      const sec = $('#day' + S.sel);
      if (sec) {
        const top = sec.getBoundingClientRect().top + window.scrollY - 70;
        window.scrollTo({ top, behavior: on('strip') ? 'smooth' : 'auto' });
        if (on('strip')) { sec.classList.remove('flash'); void sec.offsetWidth; sec.classList.add('flash'); }
      }
      return;
    }
    if (t.dataset.past !== undefined) { S.showPast = true; render({ stagger: true }); return; }
    if (t.dataset.add !== undefined) { openSheet(+t.dataset.add); return; }
    if (t.dataset.nav) {
      S.mOff += +t.dataset.nav;
      render();
      if (on('month')) { const g = $('#cal'); g.classList.add(+t.dataset.nav > 0 ? 'cal-r' : 'cal-l'); }
      return;
    }
    if (t.dataset.msel !== undefined) {
      S.mSel = +t.dataset.msel; render();
      if (on('month')) { const c = $('.mc.is-sel'); c && c.classList.add('pop'); const m = $('#msel'); m && m.classList.add('stg'); }
      return;
    }
    if (t.id === 'kFab') { document.body.classList.contains('sheet-open') ? closeSheet() : openSheet(null); return; }
    if (t.dataset.close !== undefined) { closeSheet(); return; }
    if (t.dataset.choice) { closeSheet(); toast(t.dataset.choice + ' : formulaire (maquette)'); return; }
  });
  document.addEventListener('keydown', e => {
    if (e.target.id === 'newTask' && e.key === 'Enter' && e.target.value.trim()) {
      S.items.push({ id: 'n' + Date.now(), type: 'task', title: e.target.value.trim(), d: null, done: false });
      render(); toast('Tâche ajoutée');
    }
  });
  addEventListener('resize', () => { moveInk(); movePill(false); });
  document.addEventListener('touchstart', () => {}, { passive: true }); // :active sur iPhone

  /* ---------- Coquille ---------- */
  function shell() {
    const ICONS = {
      todayView: '<path d="M4 11l8-6.5 8 6.5"/><path d="M6.5 9.5V19h11V9.5"/>',
      agendaView: '<rect x="4" y="5.5" width="16" height="14" rx="3"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
      todoView: '<rect x="4.5" y="4.5" width="15" height="15" rx="4"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
      weekView: '<circle cx="14.5" cy="5" r="1.8"/><path d="M8 20l3-5 3 2.5V21M6 12.5l3.5-3 4 1 2.5 3h3M11 15l1.5-4.5"/>'
    };
    const NAMES = { todayView: 'Accueil', agendaView: 'Mois', todoView: 'Tâches', weekView: 'Sport' };
    const app = $('#app');
    app.insertAdjacentHTML('beforeend', `
      <main id="screen"></main>
      <nav class="tabbar"><span class="tab-ink" id="tabInk"></span>${TABS.map(v => `<button class="tab" data-view="${v}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[v]}</svg><span>${NAMES[v]}</span></button>`).join('')}</nav>
      <button class="fab" id="kFab" aria-label="Ajouter"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
      <div class="scrim" data-close></div>
      <div class="sheet" id="sheet" role="dialog"><div class="sheet__grab"></div><h3 class="sheet__t">Ajouter</h3>
        <div class="choices">
          <button class="ch press" data-choice="Tâche" style="--i:0"><span><b>Tâche</b><small>À faire, avec ou sans date</small></span>${ILL.task}</button>
          <button class="ch press" data-choice="Rendez-vous" style="--i:1"><span><b>Rendez-vous</b><small>Un jour, une heure</small></span>${ILL.rdv}</button>
          <button class="ch press" data-choice="Événement" style="--i:2"><span><b>Événement</b><small>Sur un ou plusieurs jours</small></span>${ILL.evt}</button>
          <button class="ch press" data-choice="Séance" style="--i:3"><span><b>Séance</b><small>Sport, durée, moment</small></span>${ILL.run}</button>
        </div></div>
      <div class="toast" id="toast" role="status"></div>`);
    render();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { moveInk(); movePill(false); });
  }

  window.Carnet = { render, S, setView: v => { S.view = v; render(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', shell); else shell();
})();
