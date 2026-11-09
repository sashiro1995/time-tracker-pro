// Trackers: "things that last". Three kinds share one model (see server.js Trackers API):
//   countdown  known end date        (free trial, warranty, passport)
//   runout     end learned over time (cat food, coffee beans, shampoo)
//   since      repeating chore       (water plants, clean litter box)
// Three layouts from the design handoff, picked with the toolbar switch and saved in settings.json:
//   timeline  grouped by date (Now / This week / ...)     table  one row each, sorted by date
//   cards     a grid the user arranges by dragging (order saved as settings.trackersOrder)
// Wording stays neutral: no "overdue", no red.
const Trackers = (() => {
  let trackers = [];
  let loaded = false;
  let prefsLoaded = false;
  let layout = 'timeline';
  let order = [];          // tracker ids in the user's card order
  let sortable = null;
  const LAYOUTS = ['timeline', 'cards', 'table'];
  let filterKind = 'all';
  let search = '';
  let showArchived = false;
  let drawerId = null;
  let editingCycleId = null;
  let modal = { mode: 'new', step: 1, kind: 'runout', editId: null, icon: null, color: null };

  const KINDS = {
    countdown: {
      label: 'Countdown', icon: 'calendar-clock',
      blurb: 'An end date you already know.',
      examples: 'Free trials, warranties, passport expiry',
      tip: 'Counts down to a date you set. When it comes, renew it for another round or end it.',
      placeholder: 'e.g. Netflix trial',
    },
    runout: {
      label: 'Runs out', icon: 'package',
      blurb: 'Learn how long something lasts.',
      examples: 'Cat food, coffee beans, water filters',
      tip: 'Press "Opened new one" each time you start a new bag or pack. The app learns how long one lasts and estimates the next.',
      placeholder: 'e.g. Cat food',
    },
    since: {
      label: 'Days since', icon: 'rotate-ccw',
      blurb: 'Keep track of the last time you did it.',
      examples: 'Watering plants, haircuts, fresh sheets',
      tip: 'Counts the days since you last did something. Press "Did it" and it starts again from zero.',
      placeholder: 'e.g. Water the plants',
    },
  };

  const ICONS = ['package', 'cat', 'dog', 'coffee', 'milk', 'pill', 'droplets', 'bath', 'shirt', 'scissors',
    'leaf', 'sprout', 'car', 'fuel', 'tv', 'film', 'credit-card', 'shield-check', 'plane', 'book-open',
    'globe', 'phone', 'dumbbell', 'sparkles', 'wrench', 'calendar-clock', 'rotate-ccw', 'hourglass'];
  // Data colors (like category colors), not theme colors
  const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#F97316', '#06B6D4', '#EF4444', '#84CC16', '#6366F1'];

  const esc = (...a) => Charts.esc(...a);
  const $ = id => document.getElementById(id);

  // ── Dates (local calendar days, YYYY-MM-DD) ───────────────────────────────
  const todayISO = () => new Date().toLocaleDateString('sv');
  function daysBetween(a, b) {
    const [ya, ma, da] = a.split('-').map(Number);
    const [yb, mb, db] = b.split('-').map(Number);
    return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
  }
  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('sv');
  }
  const asDate = iso => new Date(iso + 'T00:00:00');
  // The year is shown only when it isn't this year
  const otherYear = iso => iso.slice(0, 4) !== todayISO().slice(0, 4);
  const fmtShort = iso => asDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(otherYear(iso) ? { year: 'numeric' } : {}) });
  const fmtYear  = iso => asDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtMonth = iso => asDate(iso).toLocaleDateString('en-US', { month: 'short' });
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const money = n => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

  // ── What a tracker's numbers say right now ────────────────────────────────
  function cycleLengths(t) {
    return t.cycles.filter(c => c.end).map(c => daysBetween(c.start, c.end)).filter(n => n > 0);
  }
  function average(list) { return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null; }

  // num + unit are drawn as "2 days left"; when is the line under the name ("Nov 8 · fixed date")
  function status(t) {
    const today = todayISO();
    const last = t.cycles[t.cycles.length - 1];
    const lengths = cycleLengths(t);
    const s = { progress: null, estimate: false, soon: false, urgency: 9999, num: '', unit: '', when: '', detail: [], actions: [], sub: '' };

    // Cost per day across finished cycles that have a price
    const priced = t.cycles.filter(c => c.end && c.cost != null && daysBetween(c.start, c.end) > 0);
    const pricedDays = priced.reduce((sum, c) => sum + daysBetween(c.start, c.end), 0);
    s.costPerDay = pricedDays ? priced.reduce((sum, c) => sum + c.cost, 0) / pricedDays : null;
    s.totalSpent = t.cycles.reduce((sum, c) => sum + (c.cost || 0), 0);
    s.avg = lengths.length ? Math.round(average(lengths.slice(-5))) : null;

    if (!last) { s.num = '—'; return s; }

    if (t.kind === 'countdown') {
      const left = daysBetween(today, last.end);
      const length = Math.max(1, daysBetween(last.start, last.end));
      s.progress = Math.min(1, Math.max(0, (length - left) / length));
      if (left > 0) { s.num = String(left); s.unit = left === 1 ? 'day left' : 'days left'; }
      else if (left === 0) { s.num = 'Ends'; s.unit = 'today'; }
      else { s.num = fmtShort(last.end); s.unit = 'ended'; }
      s.when = `${fmtShort(last.end)} · fixed date`;
      s.detail.push(`${left < 0 ? 'Ended' : 'Ends'} ${fmtShort(last.end)}`);
      if (last.cost != null) s.detail.push(money(last.cost));
      s.sub = `Started ${fmtYear(last.start)}`;
      s.soon = left <= (t.remindDaysBefore ?? 7);
      s.urgency = left;
      s.actions = [
        { action: 'renew', label: 'Renewed', icon: 'refresh-cw', title: 'It continues: start the next period' },
        { action: 'end', label: 'Ended', icon: 'archive', title: 'Ended or cancelled: move it to Archived (an unstarted renewal is removed)' },
      ];
    }

    if (t.kind === 'runout') {
      s.estimate = true;
      const open = last.end ? null : last;
      if (open) {
        const age = daysBetween(open.start, today);
        s.sub = `Opened ${fmtYear(open.start)}`;
        if (s.avg) {
          const left = s.avg - age;
          s.progress = Math.min(1, age / s.avg);
          if (left > 0) { s.num = `~${left}`; s.unit = left === 1 ? 'day left' : 'days left'; }
          else { s.num = 'Due'; s.unit = 'about now'; }
          s.when = `Around ${fmtShort(addDays(open.start, s.avg))} · estimate`;
          s.detail.push(`Usually lasts ${plural(s.avg, 'day')}`);
          s.soon = left <= Math.max(t.remindDaysBefore ?? 2, Math.round(s.avg * 0.15));
          s.urgency = left;
        } else {
          s.num = String(age); s.unit = age === 1 ? 'day open' : 'days open';
          s.when = 'Learning · finish one to get an estimate';
          s.detail.push('Finish one to learn how long it lasts');
          s.urgency = 5000;
        }
        s.actions = [
          { action: 'new', label: 'Opened new one', icon: 'package-open', title: 'This one is finished and a new one is open' },
          { action: 'finish', label: 'Finished', icon: 'check', title: 'This one is finished, no new one yet' },
        ];
      } else {
        s.num = 'None'; s.unit = 'open';
        s.when = `Last one finished ${fmtShort(last.end)}`;
        s.sub = s.when;
        if (s.avg) s.detail.push(`Usually lasts ${plural(s.avg, 'day')}`);
        s.actions = [{ action: 'new', label: 'Opened new one', icon: 'package-open', title: 'Start a new one today' }];
        s.urgency = 6000;
      }
      if (s.costPerDay != null) s.detail.push(`${money(s.costPerDay)}/day`);
    }

    if (t.kind === 'since') {
      const days = daysBetween(last.start, today);
      const learned = lengths.length >= 2 ? s.avg : null;
      const interval = t.intervalDays || learned;
      s.interval = interval;
      s.estimate = !t.intervalDays && !!learned;
      if (days === 0) { s.num = 'Done'; s.unit = 'today'; }
      else { s.num = String(days); s.unit = days === 1 ? 'day since' : 'days since'; }
      s.sub = `Last done ${fmtYear(last.start)}`;
      s.when = interval ? `Usually every ${plural(interval, 'day')}${s.estimate ? ' · learned' : ''}` : `Last done ${fmtShort(last.start)}`;
      s.detail.push(interval ? `Usually every ${plural(interval, 'day')}` : `Last done ${fmtShort(last.start)}`);
      if (interval) {
        s.progress = Math.min(1, days / interval);
        s.soon = days >= interval - (t.remindDaysBefore ?? 0);
        s.urgency = interval - days;
      } else {
        s.urgency = 7000;
      }
      s.actions = [{ action: 'done', label: 'Did it', icon: 'check', title: 'Done today: start counting again' }];
    }

    s.big = `${s.num} ${s.unit}`.trim();
    return s;
  }

  // ── Small pieces ──────────────────────────────────────────────────────────
  function iconBoxHTML(t, size = 'md') {
    return `<span class="trk-icon trk-icon--${size}" style="--tracker-color:${t.color}" aria-hidden="true"><i data-lucide="${esc(t.icon || 'hourglass')}"></i></span>`;
  }

  function numberHTML(s) {
    return `<span class="trk-number">${esc(s.num)}<span>${esc(s.unit)}</span></span>`;
  }

  // Thin bar: solid for known dates, a dashed track for estimates. Full means the usual time has passed.
  function meterHTML(t, s) {
    const pct = s.progress == null ? 0 : Math.round(s.progress * 100);
    return `<span class="trk-meter${s.estimate ? ' trk-meter--estimate' : ''}" aria-hidden="true"><b style="width:${pct}%;background:${t.color}"></b></span>`;
  }

  function actionBtnHTML(t, a, cls = 'btn--ghost') {
    return `<button class="btn ${cls} btn--sm" data-tracker-act="${a.action}" data-tracker-id="${esc(t.id)}" title="${esc(a.title)}">
              <i data-lucide="${a.icon}"></i> ${a.label}
            </button>`;
  }

  // ── Trackers screen ───────────────────────────────────────────────────────
  async function load() {
    try {
      const data = await API.trackers.list();
      trackers = data.trackers || [];
      loaded = true;
    } catch (err) { console.error('Trackers load failed', err); }
    if (!prefsLoaded) {
      try {
        const st = await API.settings.get();
        if (LAYOUTS.includes(st.trackersLayout)) layout = st.trackersLayout;
        if (Array.isArray(st.trackersOrder)) order = st.trackersOrder;
        prefsLoaded = true;
        syncLayoutButtons();
      } catch (err) { console.error('Tracker settings load failed', err); }
    }
    return trackers;
  }

  function syncLayoutButtons() {
    const box = $('trackersLayout');
    if (!box) return;
    box.querySelectorAll('[data-layout]').forEach(b => {
      const on = b.dataset.layout === layout;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on);
    });
  }

  // Cards layout: the user's saved order first, new trackers after it (soonest first)
  function inUserOrder(list) {
    const pos = new Map(order.map((id, i) => [id, i]));
    return sorted(list).sort((a, b) => (pos.has(a.t.id) ? pos.get(a.t.id) : 1e6) - (pos.has(b.t.id) ? pos.get(b.t.id) : 1e6));
  }

  // After a drag, only the visible cards moved. Keep hidden ones (filtered out) in their places.
  async function saveDragOrder(listEl) {
    const moved = [...listEl.querySelectorAll('[data-card-id]')].map(el => el.dataset.cardId);
    const movedSet = new Set(moved);
    const full = inUserOrder(trackers.filter(t => !t.archived)).map(r => r.t.id);
    let k = 0;
    order = full.map(id => (movedSet.has(id) ? moved[k++] : id));
    try { await API.settings.update({ trackersOrder: order }); }
    catch (err) { console.error('Saving tracker order failed', err); }
  }

  function bindSortable() {
    if (sortable) { sortable.destroy(); sortable = null; }
    const grid = document.querySelector('#trackersList .trk-cards');
    if (!grid || typeof Sortable === 'undefined') return;
    sortable = Sortable.create(grid, {
      animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      filter: '[data-tracker-act]',
      preventOnFilter: false,
      ghostClass: 'trk-card--ghost',
      chosenClass: 'trk-card--chosen',
      dragClass: 'trk-card--dragging',
      onEnd: e => { if (e.oldIndex !== e.newIndex) saveDragOrder(grid); },
    });
  }

  async function refresh() {
    await load();
    render();
  }

  function sorted(list) {
    return list
      .map(t => ({ t, s: status(t) }))
      .sort((a, b) => (a.s.urgency - b.s.urgency) || (b.s.soon - a.s.soon) || a.t.name.localeCompare(b.t.name));
  }

  // Timeline groups by how soon each tracker's next moment is
  function groupFor(s) {
    const today = todayISO();
    if (s.urgency >= 5000) return { key: 'learning', label: 'Learning', note: 'No estimate yet' };
    if (s.urgency <= 0)    return { key: 'now', label: 'Now', note: 'Ready any time' };
    if (s.urgency <= 7)    return { key: 'week', label: 'This week', note: `${fmtShort(addDays(today, 1))}–${fmtShort(addDays(today, 7))}` };
    if (s.urgency <= 30)   return { key: 'month', label: 'This month', note: 'Within 30 days' };
    return { key: 'later', label: 'Later', note: 'More than a month' };
  }

  function rowHTML(t, s) {
    const main = s.actions[0];
    return `
      <article class="trk-row${s.soon ? ' trk-row--soon' : ''}" style="--tracker-color:${t.color}">
        <button class="trk-row__open" data-tracker-open="${esc(t.id)}" aria-label="Details for ${esc(t.name)}: ${esc(s.big)}"></button>
        <div class="trk-row__main">
          ${iconBoxHTML(t)}
          <div class="trk-row__text">
            <div class="trk-row__name">${esc(t.name)}</div>
            <div class="trk-kind">${KINDS[t.kind].label}</div>
            <div class="trk-row__when">${esc(s.when)}</div>
          </div>
        </div>
        <div class="trk-row__count">
          ${numberHTML(s)}
          ${meterHTML(t, s)}
        </div>
        <div class="trk-row__action">${main ? actionBtnHTML(t, main) : ''}</div>
      </article>`;
  }

  // Cards layout: one box per tracker, dragged around to set the order
  function cardHTML(t, s) {
    const main = s.actions[0];
    return `
      <article class="trk-card${s.soon ? ' trk-card--soon' : ''}" data-card-id="${esc(t.id)}" style="--tracker-color:${t.color}">
        <button class="trk-row__open" data-tracker-open="${esc(t.id)}" aria-label="Details for ${esc(t.name)}: ${esc(s.big)}"></button>
        <div class="trk-card__head">
          ${iconBoxHTML(t)}
          <div class="trk-row__text">
            <div class="trk-row__name">${esc(t.name)}</div>
            <div class="trk-kind">${KINDS[t.kind].label}</div>
          </div>
          <i class="trk-card__grip" data-lucide="grip-vertical" aria-hidden="true"></i>
        </div>
        <div class="trk-card__count">${numberHTML(s)}${meterHTML(t, s)}</div>
        <div class="trk-row__when">${esc(s.when)}</div>
        <div class="trk-card__action">${main ? actionBtnHTML(t, main) : ''}</div>
      </article>`;
  }

  // Table layout: compact rows, soonest first. The name opens the details.
  function tableHTML(rows) {
    return `
      <div class="trk-tablewrap">
        <table class="trk-table">
          <thead><tr><th scope="col">Tracker</th><th scope="col">Now</th><th scope="col">When</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead>
          <tbody>${rows.map(({ t, s }) => {
            const main = s.actions[0];
            return `
            <tr class="${s.soon ? 'is-soon' : ''}" style="--tracker-color:${t.color}">
              <td>
                <button class="trk-table__name" data-tracker-open="${esc(t.id)}" aria-label="Details for ${esc(t.name)}">
                  ${iconBoxHTML(t, 'sm')}
                  <span><span class="trk-row__name">${esc(t.name)}</span><span class="trk-kind">${KINDS[t.kind].label}</span></span>
                </button>
              </td>
              <td><div class="trk-table__count">${numberHTML(s)}${meterHTML(t, s)}</div></td>
              <td class="trk-table__when">${esc(s.when)}${s.detail.length ? `<small>${s.detail.map(esc).join(' · ')}</small>` : ''}</td>
              <td class="trk-table__action">${main ? actionBtnHTML(t, main) : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
  }

  function render() {
    const listEl = $('trackersList');
    if (!listEl) return;
    const active = trackers.filter(t => !t.archived);
    const archived = trackers.filter(t => t.archived);
    const isEmpty = !active.length && !archived.length;
    $('trackersToolbar').hidden = isEmpty;
    // First use: the three kind cards are the way in; the header button comes back after that
    $('btnNewTracker').style.display = isEmpty ? 'none' : '';

    if (isEmpty) {
      listEl.innerHTML = emptyStateHTML();
      lucide.createIcons({ nodes: [listEl] });
      return;
    }

    const q = search.trim().toLowerCase();
    const visible = active.filter(t => (filterKind === 'all' || t.kind === filterKind) && (!q || t.name.toLowerCase().includes(q)));

    let html = '';
    if (!visible.length) {
      html += `<div class="trk-noresults">
                 <h2>${active.length ? 'Nothing matches' : 'Everything is archived'}</h2>
                 <p class="muted-note">${active.length ? 'Try another filter or search.' : 'Restore one below, or add a new tracker.'}</p>
               </div>`;
    } else if (layout === 'cards' || layout === 'table') {
      const cards = layout === 'cards';
      const rows = cards ? inUserOrder(visible) : sorted(visible);
      html += `
        <div class="trk-list-head">
          <h2 class="trk-list-title">${cards ? 'Your trackers' : "What's next"} <span>${visible.length}</span></h2>
          <span class="trk-list-date">${cards ? 'Drag the cards into any order' : 'Soonest first'}</span>
        </div>
        ${cards ? `<div class="trk-cards">${rows.map(r => cardHTML(r.t, r.s)).join('')}</div>` : tableHTML(rows)}
        <p class="trk-footnote"><i data-lucide="info"></i> Estimates adjust as you log cycles. A full bar means the usual time has passed.</p>`;
    } else {
      // Group rows in order: Now, This week, This month, Later, Learning
      const groups = [];
      sorted(visible).forEach(r => {
        const g = groupFor(r.s);
        let bucket = groups.find(x => x.key === g.key);
        if (!bucket) { bucket = { ...g, rows: [] }; groups.push(bucket); }
        bucket.rows.push(r);
      });
      const order = ['now', 'week', 'month', 'later', 'learning'];
      groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

      html += `
        <div class="trk-list-head">
          <h2 class="trk-list-title">What's next <span>${visible.length}</span></h2>
          <span class="trk-list-date">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
        </div>
        <div class="trk-timeline">
          ${groups.map(g => `
            <div class="trk-timegroup">
              <div class="trk-timegroup__label">${g.label}<small>${esc(g.note)}</small></div>
              <div class="trk-timegroup__items">${g.rows.map(r => rowHTML(r.t, r.s)).join('')}</div>
            </div>`).join('')}
        </div>
        <p class="trk-footnote"><i data-lucide="info"></i> Estimates adjust as you log cycles. A full bar means the usual time has passed.</p>`;
    }

    if (archived.length) {
      html += `<button class="link-btn trackers-archived-toggle" data-archived-toggle aria-expanded="${showArchived}">
                 <i data-lucide="${showArchived ? 'chevron-down' : 'chevron-right'}"></i> Archived (${archived.length})
               </button>`;
      if (showArchived) {
        html += `<div class="goals-list--rows tracker-archived">${archived.map(t => `
          <div class="tracker-archived__row">
            ${iconBoxHTML(t, 'sm')}
            <span class="tracker-archived__name">${esc(t.name)}</span>
            <span class="trk-kind">${KINDS[t.kind].label}</span>
            <button class="btn btn--ghost btn--sm" data-tracker-open="${esc(t.id)}">Details</button>
            <button class="btn btn--ghost btn--sm" data-tracker-restore="${esc(t.id)}"><i data-lucide="archive-restore"></i> Restore</button>
          </div>`).join('')}</div>`;
      }
    }

    listEl.innerHTML = html;
    lucide.createIcons({ nodes: [listEl] });
    bindSortable();
  }

  function emptyStateHTML() {
    return `
      <div class="trk-empty">
        <div class="trk-empty__symbol" aria-hidden="true"><i data-lucide="hourglass"></i></div>
        <h2 class="trk-empty__title">A little less to keep in mind</h2>
        <p class="trk-empty__lead">Give the things that last a place of their own.<br>Choose a kind to create your first tracker.</p>
        <div class="trk-empty__kinds">
          ${Object.entries(KINDS).map(([kind, k]) => `
            <div class="trk-empty__kind">
              <button class="trk-empty__pick" data-empty-kind="${kind}" aria-describedby="trk-tip-${kind}">
                <span class="trk-empty__name">${k.label}</span>
                <span class="trk-empty__blurb">${k.blurb}</span>
              </button>
              <span class="trk-empty__info" tabindex="0" aria-label="About ${k.label}">
                <i data-lucide="info" aria-hidden="true"></i>
                <span class="trk-empty__tip" id="trk-tip-${kind}" role="tooltip">${k.tip}<br><em>${k.examples}</em></span>
              </span>
            </div>`).join('')}
        </div>
        <p class="muted-note">Start with one. Add more whenever you need them.</p>
      </div>`;
  }

  // ── Actions (with Undo) ───────────────────────────────────────────────────
  const ACTION_DONE = {
    renew: t => `${t.name}: next period started`,
    end: t => `${t.name} moved to Archived`,
    new: t => `${t.name}: new one started`,
    finish: t => `${t.name}: marked finished`,
    done: t => `${t.name}: counting from today`,
  };

  async function act(id, action) {
    const before = trackers.find(t => t.id === id);
    if (!before) return;
    const snapshot = JSON.parse(JSON.stringify(before));
    try {
      const updated = await API.trackers.act(id, action);
      trackers = trackers.map(t => (t.id === id ? updated : t));
      afterChange();
      App.showToast(ACTION_DONE[action](updated), 6000, {
        label: 'Undo',
        onClick: async () => {
          try {
            const restored = await API.trackers.update(id, { cycles: snapshot.cycles, archived: snapshot.archived });
            trackers = trackers.map(t => (t.id === id ? restored : t));
            afterChange();
          } catch (err) { console.error(err); }
        },
      });
    } catch (err) {
      console.error(err);
      App.showToast('That didn\'t work. Try again.', 4000);
    }
  }

  // Re-draw whatever is showing trackers right now
  function afterChange() {
    if (App.getCurrentScreen() === 'trackers') render();
    if (App.getCurrentScreen() === 'dashboard') App.refreshDashboard();
    if (drawerId) renderDrawer();
  }

  async function handleUpdate() {
    await load();
    afterChange();
  }

  // ── Detail drawer ─────────────────────────────────────────────────────────
  function openDrawer(id) {
    drawerId = id;
    editingCycleId = null;
    $('trackerDrawer').hidden = false;
    renderDrawer();
    $('trackerDrawer').querySelector('[data-drawer-close]')?.focus();
  }

  function closeDrawer() {
    drawerId = null;
    editingCycleId = null;
    const el = $('trackerDrawer');
    if (el) el.hidden = true;
  }

  function eyebrowFor(t) {
    const finished = cycleLengths(t).length;
    if (t.kind === 'countdown') return `Countdown · ${plural(t.cycles.length, 'period')}`;
    if (t.kind === 'runout') return `Runs out · ${plural(finished, 'completed cycle')}`;
    return `Days since · done ${plural(t.cycles.length, 'time')}`;
  }

  // Bars drawn in HTML so each can carry its value on top
  function historyBarsHTML(t) {
    const done = t.cycles.filter(c => c.end && daysBetween(c.start, c.end) > 0).slice(-8);
    if (!done.length) return '';
    const lengths = done.map(c => daysBetween(c.start, c.end));
    const max = Math.max(...lengths);
    return `
      <div class="drawer__section">
        <div class="drawer__section-head">
          <h3 class="drawer__section-title">${t.kind === 'since' ? 'Days between each time' : 'How long each one lasted'}</h3>
          <span class="muted-note">Days</span>
        </div>
        <div class="trk-bars" role="img" aria-label="${lengths.join(', ')} days">
          ${done.map((c, i) => `
            <div class="trk-bars__col">
              <span class="trk-bars__value">${lengths[i]}</span>
              <span class="trk-bars__bar" style="height:${Math.max(8, Math.round((lengths[i] / max) * 100))}%;background:${t.color}"></span>
              <span class="trk-bars__label">${fmtMonth(c.start)}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  function statsHTML(t, s) {
    const lengths = cycleLengths(t);
    const out = [];
    if (t.kind !== 'countdown' && lengths.length) {
      const stat = (label, value) => `<div class="drawer-stat"><div class="drawer-stat__label">${label}</div><div class="drawer-stat__value">${value}</div></div>`;
      out.push(`<div class="drawer-stats">
        ${stat('Average', plural(Math.round(average(lengths)), 'day'))}
        ${stat('Shortest', plural(Math.min(...lengths), 'day'))}
        ${stat('Longest', plural(Math.max(...lengths), 'day'))}
      </div>`);
    }
    if (s.totalSpent) {
      const count = t.cycles.filter(c => c.cost != null).length;
      const counted = t.kind === 'countdown' ? plural(count, 'period') : `${count} bought`;
      out.push(`<div class="drawer-costs">
        <div><div class="drawer-stat__label">Total spent · ${counted}</div><div class="drawer-costs__value">${money(s.totalSpent)}</div></div>
        ${s.costPerDay != null ? `<div><div class="drawer-stat__label">Cost per day</div><div class="drawer-costs__value">${money(s.costPerDay)}</div></div>` : ''}
      </div>`);
    }
    return out.join('');
  }

  // Plain settings rows: rhythm for chores, renewal for countdowns
  function settingsHTML(t, s) {
    const row = (label, value) => `<div class="drawer-row"><span>${label}</span><strong>${value}</strong></div>`;
    if (t.kind === 'since') {
      return `
        <div class="drawer__section">
          <h3 class="drawer__section-title">Usual rhythm</h3>
          ${row('Usual interval', t.intervalDays ? plural(t.intervalDays, 'day') : (s.interval ? `${plural(s.interval, 'day')} (learned)` : 'Learning'))}
          ${row('Shows as soon', !s.interval ? 'Once it has a rhythm' : (t.remindDaysBefore ? `${plural(t.remindDaysBefore, 'day')} before` : 'On the usual day'))}
          <p class="muted-note drawer__explain">Each time you press Did it, the count starts again.</p>
        </div>`;
    }
    if (t.kind === 'countdown') {
      const last = t.cycles[t.cycles.length - 1];
      return `
        <div class="drawer__section">
          <h3 class="drawer__section-title">Dates</h3>
          ${row(daysBetween(todayISO(), last.end) < 0 ? 'Ended' : 'Ends', fmtYear(last.end))}
          ${row('Renews for', t.intervalDays ? plural(t.intervalDays, 'day') : `${plural(Math.max(1, daysBetween(last.start, last.end)), 'day')} (same as now)`)}
          ${row('Shows as soon', (t.remindDaysBefore ?? 7) ? `${plural(t.remindDaysBefore ?? 7, 'day')} before` : 'On the day')}
        </div>`;
    }
    return '';
  }

  function cycleRowHTML(t, c) {
    if (c.id === editingCycleId) {
      return `
        <li class="cycle-row cycle-row--editing" data-cycle-id="${esc(c.id)}">
          <label class="cycle-row__field"><span class="form-label">${t.kind === 'since' ? 'Done on' : 'Start'}</span>
            <input class="form-input form-input--sm" type="date" data-cycle-start value="${c.start}" /></label>
          ${t.kind !== 'since' ? `<label class="cycle-row__field"><span class="form-label">End</span>
            <input class="form-input form-input--sm" type="date" data-cycle-end value="${c.end || ''}" /></label>` : ''}
          ${t.kind !== 'since' ? `<label class="cycle-row__field"><span class="form-label">Cost</span>
            <input class="form-input form-input--sm" type="number" min="0" step="0.01" data-cycle-cost value="${c.cost ?? ''}" /></label>` : ''}
          <div class="cycle-row__edit-actions">
            <button class="btn btn--ghost btn--sm" data-cycle-cancel>Cancel</button>
            <button class="btn btn--primary btn--sm" data-cycle-save>Save</button>
          </div>
        </li>`;
    }
    const when = t.kind === 'since' ? fmtYear(c.start) : `${fmtShort(c.start)} – ${c.end ? fmtYear(c.end) : 'now'}`;
    const days = t.kind === 'since' ? null : daysBetween(c.start, c.end || todayISO());
    const meta = [
      days == null ? '' : `${plural(Math.max(0, days), 'day')}${c.end ? '' : ' so far'}`,
      c.cost != null ? money(c.cost) : '',
    ].filter(Boolean).join(' · ');
    return `
      <li class="cycle-row" data-cycle-id="${esc(c.id)}">
        <span class="cycle-row__when">${when}</span>
        <strong class="cycle-row__meta">${meta}</strong>
        <span class="cycle-row__tools">
          <button class="btn btn--ghost btn--sm btn--icon" data-cycle-edit aria-label="Edit this entry"><i data-lucide="pencil"></i></button>
          <button class="btn btn--ghost btn--sm btn--icon" data-cycle-delete aria-label="Delete this entry"><i data-lucide="trash-2"></i></button>
        </span>
      </li>`;
  }

  function renderDrawer() {
    const t = trackers.find(x => x.id === drawerId);
    const body = $('trackerDrawerBody');
    if (!t || !body) { closeDrawer(); return; }
    const s = status(t);

    body.innerHTML = `
      <div class="drawer__top">
        <span class="drawer__eyebrow">${eyebrowFor(t)}${t.archived ? ' · Archived' : ''}</span>
        <button class="btn btn--ghost btn--icon drawer__close" data-drawer-close aria-label="Close details"><i data-lucide="x"></i></button>
      </div>

      <div class="drawer__hero" style="--tracker-color:${t.color}">
        <div class="drawer__title-row">
          ${iconBoxHTML(t)}
          <div>
            <h2 class="drawer__title" id="trackerDrawerTitle">${esc(t.name)}</h2>
            <div class="drawer__sub">${esc(s.sub)}</div>
          </div>
        </div>
        <div class="drawer__number">${numberHTML(s)}</div>
        ${meterHTML(t, s)}
        <div class="drawer__detail">${s.detail.map(esc).join(' · ')}</div>
        ${t.archived ? '' : `
          <div class="drawer__actions">
            ${s.actions.map((a, i) => actionBtnHTML(t, a, i === 0 ? 'btn--primary' : 'btn--ghost')).join('')}
          </div>`}
      </div>

      ${historyBarsHTML(t)}
      ${statsHTML(t, s)}
      ${settingsHTML(t, s)}

      <div class="drawer__section">
        <h3 class="drawer__section-title">${t.kind === 'since' ? 'History' : 'Cycle history'}</h3>
        <ol class="cycle-list">${[...t.cycles].reverse().map(c => cycleRowHTML(t, c)).join('')}</ol>
      </div>

      <footer class="drawer__foot">
        <button class="btn btn--ghost" data-tracker-edit><i data-lucide="pencil"></i> Edit tracker</button>
        <span class="drawer__foot-spacer"></span>
        ${t.archived
          ? `<button class="btn btn--ghost" data-tracker-restore="${esc(t.id)}"><i data-lucide="archive-restore"></i> Restore</button>`
          : `<button class="btn btn--ghost btn--quiet" data-tracker-archive><i data-lucide="archive"></i> Archive</button>`}
        <button class="btn btn--danger btn--icon" data-tracker-delete aria-label="Delete ${esc(t.name)}" title="Delete"><i data-lucide="trash-2"></i></button>
      </footer>`;

    lucide.createIcons({ nodes: [body] });
  }

  async function saveCycles(t, cycles) {
    const updated = await API.trackers.update(t.id, { cycles });
    trackers = trackers.map(x => (x.id === t.id ? updated : x));
    afterChange();
    return updated;
  }

  function bindDrawer() {
    const backdrop = $('trackerDrawer');
    backdrop.addEventListener('click', async e => {
      if (e.target === backdrop || e.target.closest('[data-drawer-close]')) { closeDrawer(); return; }
      const t = trackers.find(x => x.id === drawerId);
      if (!t) return;

      const actBtn = e.target.closest('[data-tracker-act]');
      if (actBtn) { actBtn.disabled = true; await act(actBtn.dataset.trackerId, actBtn.dataset.trackerAct); return; }

      const row = e.target.closest('[data-cycle-id]');
      if (e.target.closest('[data-cycle-edit]') && row) { editingCycleId = row.dataset.cycleId; renderDrawer(); return; }
      if (e.target.closest('[data-cycle-cancel]')) { editingCycleId = null; renderDrawer(); return; }
      if (e.target.closest('[data-cycle-save]') && row) {
        const start = row.querySelector('[data-cycle-start]').value;
        const end = row.querySelector('[data-cycle-end]')?.value || null;
        const costRaw = row.querySelector('[data-cycle-cost]')?.value;
        if (!start || (end && end < start)) { App.showToast('The end has to be on or after the start', 4000); return; }
        if (t.kind === 'countdown' && !end) { App.showToast('A countdown needs an end date', 4000); return; }
        const cycles = t.cycles.map(c => (c.id === row.dataset.cycleId
          ? { ...c, start, end: t.kind === 'since' ? c.end : end, cost: costRaw === undefined ? c.cost : (costRaw === '' ? null : Number(costRaw)) }
          : c));
        editingCycleId = null;
        try { await saveCycles(t, cycles); } catch (err) { console.error(err); }
        return;
      }
      if (e.target.closest('[data-cycle-delete]') && row) {
        if (t.cycles.length === 1) { App.showToast('This is its only entry. Delete the tracker instead.', 4000); return; }
        const before = t.cycles;
        try {
          await saveCycles(t, t.cycles.filter(c => c.id !== row.dataset.cycleId));
          App.showToast('Entry deleted', 6000, { label: 'Undo', onClick: () => saveCycles(t, before).catch(console.error) });
        } catch (err) { console.error(err); }
        return;
      }

      if (e.target.closest('[data-tracker-edit]')) { openModal({ editId: t.id }); return; }
      if (e.target.closest('[data-tracker-archive]')) { await setArchived(t.id, true); return; }
      if (e.target.closest('[data-tracker-restore]')) { await setArchived(t.id, false); return; }
      if (e.target.closest('[data-tracker-delete]')) {
        closeDrawer();
        const ok = await App.showDeleteConfirm(t.name, 0, '');
        if (!ok) { openDrawer(t.id); return; }
        try {
          await API.trackers.delete(t.id);
          trackers = trackers.filter(x => x.id !== t.id);
          afterChange();
        } catch (err) { console.error(err); }
      }
    });
  }

  async function setArchived(id, archived) {
    try {
      const updated = await API.trackers.update(id, { archived });
      trackers = trackers.map(t => (t.id === id ? updated : t));
      afterChange();
      App.showToast(archived ? `${updated.name} moved to Archived` : `${updated.name} restored`, 4000);
    } catch (err) { console.error(err); }
  }

  // ── New / edit window (2 steps) ───────────────────────────────────────────
  function openModal({ kind = null, editId = null } = {}) {
    const existing = editId ? trackers.find(t => t.id === editId) : null;
    const usedColors = trackers.map(t => (t.color || '').toLowerCase());
    modal = {
      mode: existing ? 'edit' : 'new',
      step: existing || kind ? 2 : 1,
      kind: existing ? existing.kind : (kind || 'runout'),
      editId,
      icon: existing ? existing.icon : KINDS[kind || 'runout'].icon,
      color: existing ? existing.color : (COLORS.find(c => !usedColors.includes(c.toLowerCase())) || COLORS[0]),
    };
    $('trackerModal').hidden = false;
    renderModal();
  }

  function closeModal() {
    const el = $('trackerModal');
    if (el) el.hidden = true;
  }

  function stepDotsHTML() {
    return `<span class="trk-stepdots" aria-hidden="true"><b class="${modal.step === 1 ? 'is-active' : ''}"></b><b class="${modal.step === 2 ? 'is-active' : ''}"></b></span>`;
  }

  function modalHeadHTML(eyebrow, title, sub) {
    return `
      <div class="trk-modal__head">
        <div>
          ${eyebrow ? `<div class="drawer__eyebrow">${eyebrow}</div>` : ''}
          <h2 class="trk-modal__title" id="trackerModalTitle">${title}</h2>
          ${sub ? `<p class="trk-modal__sub">${sub}</p>` : ''}
        </div>
        <button type="button" class="btn btn--ghost btn--icon btn--quiet" data-modal-cancel aria-label="Close"><i data-lucide="x"></i></button>
      </div>`;
  }

  function renderModal() {
    const form = $('trackerForm');
    const existing = modal.editId ? trackers.find(t => t.id === modal.editId) : null;

    if (modal.step === 1) {
      form.innerHTML = `
        ${modalHeadHTML('Step 1 of 2', 'What would you like to track?', 'Choose the kind that fits how it lasts.')}
        <div class="trk-options" role="radiogroup" aria-label="Kind of tracker">
          ${Object.entries(KINDS).map(([kind, k]) => `
            <button type="button" class="trk-option${modal.kind === kind ? ' is-selected' : ''}" role="radio" aria-checked="${modal.kind === kind}" data-pick-kind="${kind}">
              <span class="trk-icon trk-icon--lg" aria-hidden="true"><i data-lucide="${k.icon}"></i></span>
              <span class="trk-option__text">
                <strong>${k.label}</strong>
                <span>${k.blurb}</span>
                <small>${k.examples}</small>
              </span>
              <span class="trk-option__radio" aria-hidden="true">${modal.kind === kind ? '<i data-lucide="check"></i>' : ''}</span>
            </button>`).join('')}
        </div>
        <div class="trk-modal__foot">
          ${stepDotsHTML()}
          <button type="button" class="btn btn--primary" data-modal-next>Continue <i data-lucide="arrow-right"></i></button>
        </div>`;
      lucide.createIcons({ nodes: [form] });
      form.querySelector('.trk-option.is-selected')?.focus();
      return;
    }

    const k = KINDS[modal.kind];
    const today = todayISO();
    const remindOptions = [0, 1, 2, 3, 5, 7, 14];
    const remindText = n => modal.kind === 'countdown'
      ? (n === 0 ? 'On the day' : `${plural(n, 'day')} before`)
      : modal.kind === 'runout'
        ? (n === 0 ? 'When it\'s due' : `~${plural(n, 'day')} before`)
        : (n === 0 ? 'On the usual day' : `${plural(n, 'day')} before`);
    const remindValue = existing ? (existing.remindDaysBefore ?? (modal.kind === 'countdown' ? 7 : 0))
      : (modal.kind === 'countdown' ? 3 : modal.kind === 'runout' ? 2 : 0);

    const field = (id, label, input, { full = false, optional = false, hint = '' } = {}) => `
      <div class="trk-field${full ? ' trk-field--full' : ''}">
        <label class="form-label" for="${id}">${label}${optional ? ' <span class="form-label--optional">(optional)</span>' : ''}</label>
        ${input}
        ${hint ? `<small class="trk-field__hint">${hint}</small>` : ''}
      </div>`;

    let fields = field('trkName', 'Name', `<input class="form-input" id="trkName" type="text" maxlength="60" placeholder="${k.placeholder}" value="${esc(existing?.name || '')}" />`, { full: true });

    if (!existing) {
      if (modal.kind === 'countdown') {
        fields += field('trkStart', 'Started', `<input class="form-input" id="trkStart" type="date" value="${today}" />`);
        fields += field('trkEnd', 'Ends', `<input class="form-input" id="trkEnd" type="date" />`);
        fields += `<div class="trk-field trk-field--full"><div class="session-form__chips" role="group" aria-label="Length from the start date">
            <button type="button" class="btn-preset" data-length="7">7 days</button>
            <button type="button" class="btn-preset" data-length="14">14 days</button>
            <button type="button" class="btn-preset" data-length="30">30 days</button>
            <button type="button" class="btn-preset" data-length="365">1 year</button>
          </div></div>`;
      } else {
        fields += field('trkStart', modal.kind === 'runout' ? 'Opened on' : 'Last done', `<input class="form-input" id="trkStart" type="date" value="${today}" />`);
      }
      if (modal.kind !== 'since') {
        fields += field('trkCost', 'Cost', `<input class="form-input" id="trkCost" type="number" min="0" step="0.01" placeholder="${modal.kind === 'runout' ? 'Price of one' : 'e.g. 15.99'}" />`,
          { optional: true, hint: modal.kind === 'runout' ? 'Used for cost per day' : '' });
      }
    }

    if (modal.kind === 'since') {
      fields += field('trkInterval', 'Usually every', `<input class="form-input" id="trkInterval" type="number" min="1" step="1" placeholder="Days" value="${existing?.intervalDays ?? ''}" />`,
        { optional: true, hint: 'Leave empty and it learns from you' });
    } else if (modal.kind === 'countdown' && existing) {
      fields += field('trkInterval', 'Renews for', `<input class="form-input" id="trkInterval" type="number" min="1" step="1" placeholder="Same length as now" value="${existing?.intervalDays ?? ''}" />`,
        { optional: true, hint: 'Days. Empty keeps the same length.' });
    }

    fields += field('trkRemind', 'Show it as soon', `
      <select class="form-select" id="trkRemind">
        ${remindOptions.map(n => `<option value="${n}"${n === remindValue ? ' selected' : ''}>${remindText(n)}</option>`).join('')}
      </select>`, { hint: 'Moves it up the list and onto Today' });

    fields += `
      <div class="trk-field trk-field--full"><span class="form-label">Icon</span>
        <div class="icon-picker" role="radiogroup" aria-label="Icon">
          ${ICONS.map(icon => `<button type="button" class="icon-picker__btn${icon === modal.icon ? ' is-active' : ''}" role="radio"
              aria-checked="${icon === modal.icon}" aria-label="${icon.replace(/-/g, ' ')}" data-pick-icon="${icon}"><i data-lucide="${icon}"></i></button>`).join('')}
        </div></div>
      <div class="trk-field trk-field--full"><span class="form-label">Color</span>
        <div class="tracker-swatches" role="radiogroup" aria-label="Color">
          ${COLORS.map(c => `<button type="button" class="note-swatch${c.toLowerCase() === (modal.color || '').toLowerCase() ? ' is-active' : ''}" role="radio"
              aria-checked="${c.toLowerCase() === (modal.color || '').toLowerCase()}" data-pick-color="${c}" aria-label="Color ${c}" style="--swatch:${c}"></button>`).join('')}
        </div></div>`;

    form.innerHTML = `
      ${existing
        ? modalHeadHTML(KINDS[existing.kind].label, `Edit ${esc(existing.name)}`, '')
        : modalHeadHTML('Step 2 of 2', `New ${k.label.toLowerCase()}`, k.blurb)}
      <div class="trk-form-grid">${fields}</div>
      <p class="session-form__error" id="trkError" role="alert" hidden></p>
      <div class="trk-modal__foot">
        ${existing ? '<span></span>' : stepDotsHTML()}
        <div class="trk-modal__buttons">
          ${existing ? '<button type="button" class="btn btn--ghost" data-modal-cancel>Cancel</button>'
                     : '<button type="button" class="btn btn--ghost" data-modal-back><i data-lucide="arrow-left"></i> Back</button>'}
          <button type="submit" class="btn btn--primary">${existing ? 'Save' : 'Create tracker'}</button>
        </div>
      </div>`;
    lucide.createIcons({ nodes: [form] });
    $('trkName').focus();
  }

  function setModalError(msg) {
    const el = $('trkError');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  async function submitModal() {
    const name = $('trkName').value.trim();
    if (!name) { setModalError('Give it a name first.'); $('trkName').focus(); return; }
    const remindDaysBefore = Number($('trkRemind').value);
    const intervalRaw = $('trkInterval')?.value;
    const intervalDays = intervalRaw ? Math.max(1, Math.round(Number(intervalRaw))) : null;

    try {
      if (modal.mode === 'edit') {
        const body = { name, icon: modal.icon, color: modal.color, remindDaysBefore };
        if ($('trkInterval')) body.intervalDays = intervalDays;
        const updated = await API.trackers.update(modal.editId, body);
        trackers = trackers.map(t => (t.id === modal.editId ? updated : t));
      } else {
        const start = $('trkStart').value || todayISO();
        const end = $('trkEnd')?.value || null;
        if (start > todayISO()) { setModalError('The start can\'t be in the future.'); return; }
        if (modal.kind === 'countdown' && !end) { setModalError('When does it end? Pick a date or a length.'); $('trkEnd').focus(); return; }
        if (modal.kind === 'countdown' && end < start) { setModalError('The end has to be on or after the start.'); return; }
        const costRaw = $('trkCost')?.value;
        const created = await API.trackers.create({
          name, kind: modal.kind, icon: modal.icon, color: modal.color, start, end,
          cost: costRaw ? Number(costRaw) : null, intervalDays, remindDaysBefore,
        });
        trackers = trackers.filter(t => t.id !== created.id).concat(created);
      }
      closeModal();
      afterChange();
    } catch (err) {
      console.error(err);
      setModalError('Couldn\'t save. Check the dates and try again.');
    }
  }

  function bindModal() {
    const backdrop = $('trackerModal');
    const form = $('trackerForm');
    backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) closeModal(); });
    form.addEventListener('submit', e => { e.preventDefault(); submitModal(); });
    form.addEventListener('click', e => {
      const kind = e.target.closest('[data-pick-kind]');
      if (kind) {
        modal.kind = kind.dataset.pickKind;
        modal.icon = KINDS[modal.kind].icon;
        form.querySelectorAll('[data-pick-kind]').forEach(b => {
          const on = b === kind;
          b.classList.toggle('is-selected', on);
          b.setAttribute('aria-checked', on);
          b.querySelector('.trk-option__radio').innerHTML = on ? '<i data-lucide="check"></i>' : '';
        });
        lucide.createIcons({ nodes: [form] });
        return;
      }
      if (e.target.closest('[data-modal-next]')) { modal.step = 2; renderModal(); return; }
      if (e.target.closest('[data-modal-back]')) { modal.step = 1; renderModal(); return; }
      if (e.target.closest('[data-modal-cancel]')) { closeModal(); return; }
      const icon = e.target.closest('[data-pick-icon]');
      if (icon) {
        modal.icon = icon.dataset.pickIcon;
        form.querySelectorAll('[data-pick-icon]').forEach(b => {
          const on = b === icon;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-checked', on);
        });
        return;
      }
      const color = e.target.closest('[data-pick-color]');
      if (color) {
        modal.color = color.dataset.pickColor;
        form.querySelectorAll('[data-pick-color]').forEach(b => {
          const on = b === color;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-checked', on);
        });
        return;
      }
      const length = e.target.closest('[data-length]');
      if (length) {
        const start = $('trkStart').value || todayISO();
        $('trkEnd').value = addDays(start, Number(length.dataset.length));
        form.querySelectorAll('[data-length]').forEach(b => b.classList.toggle('is-active', b === length));
      }
    });
    // Double-click a kind to go straight to step 2
    form.addEventListener('dblclick', e => {
      if (e.target.closest('[data-pick-kind]')) { modal.step = 2; renderModal(); }
    });
    form.addEventListener('input', () => setModalError(''));
  }

  // ── Screen controls ───────────────────────────────────────────────────────
  function bindScreen() {
    $('btnNewTracker').addEventListener('click', () => openModal());

    $('trackersFilter').addEventListener('click', e => {
      const btn = e.target.closest('[data-kind]');
      if (!btn) return;
      filterKind = btn.dataset.kind;
      $('trackersFilter').querySelectorAll('.segmented__btn').forEach(b => b.classList.toggle('is-active', b === btn));
      render();
    });

    $('trackersSearch').addEventListener('input', e => { search = e.target.value; render(); });

    $('trackersLayout').addEventListener('click', e => {
      const btn = e.target.closest('[data-layout]');
      if (!btn || btn.dataset.layout === layout) return;
      layout = btn.dataset.layout;
      syncLayoutButtons();
      render();
      API.settings.update({ trackersLayout: layout }).catch(err => console.error('Saving tracker layout failed', err));
    });

    $('trackersList').addEventListener('click', async e => {
      const actBtn = e.target.closest('[data-tracker-act]');
      if (actBtn) { actBtn.disabled = true; await act(actBtn.dataset.trackerId, actBtn.dataset.trackerAct); return; }
      const open = e.target.closest('[data-tracker-open]');
      if (open) { openDrawer(open.dataset.trackerOpen); return; }
      const restore = e.target.closest('[data-tracker-restore]');
      if (restore) { await setArchived(restore.dataset.trackerRestore, false); return; }
      if (e.target.closest('[data-archived-toggle]')) { showArchived = !showArchived; render(); return; }
      const emptyKind = e.target.closest('[data-empty-kind]');
      if (emptyKind) openModal({ kind: emptyKind.dataset.emptyKind });
    });
  }

  // ── "Coming up" card on the Today page ────────────────────────────────────
  function comingUpHTML(max = 3) {
    const head = `
      <div class="card__head">
        <h2 class="card__title">Coming up</h2>
        <button class="link-btn" data-cu-open>View all <i data-lucide="arrow-right"></i></button>
      </div>`;
    const active = trackers.filter(t => !t.archived);
    if (!loaded || !active.length) {
      return `${head}
        <p class="coming-up__empty">Keep an eye on things that run out, expire, or need doing again: a free trial, a bag of cat food, watering the plants.</p>
        <button class="btn btn--ghost btn--sm" data-cu-new><i data-lucide="plus"></i> New tracker</button>`;
    }
    // Things marked soon, then anything else due within a month; a passport 900 days out stays off
    const rows = sorted(active).filter(r => r.s.soon || r.s.urgency <= 30).slice(0, max);
    if (!rows.length) {
      return `${head}<p class="coming-up__empty">Nothing due in the next 30 days.</p>`;
    }
    return `${head}
      <ul class="coming-up__list">
        ${rows.map(({ t, s }) => `
          <li class="coming-up__row" style="--tracker-color:${t.color}">
            ${iconBoxHTML(t, 'sm')}
            <button class="coming-up__text" data-cu-detail="${esc(t.id)}" aria-label="${esc(t.name)}: ${esc(s.big)}. Open details">
              <span class="coming-up__name">${esc(t.name)}</span>
              <span class="coming-up__big">${esc(s.big)}</span>
            </button>
            ${s.actions[0] ? actionBtnHTML(t, s.actions[0]) : ''}
          </li>`).join('')}
      </ul>`;
  }

  function bindComingUp(el) {
    el.addEventListener('click', async e => {
      const actBtn = e.target.closest('[data-tracker-act]');
      if (actBtn) { actBtn.disabled = true; await act(actBtn.dataset.trackerId, actBtn.dataset.trackerAct); return; }
      if (e.target.closest('[data-cu-open]')) { App.showScreen('trackers'); return; }
      if (e.target.closest('[data-cu-new]')) { App.showScreen('trackers'); openModal(); return; }
      const detail = e.target.closest('[data-cu-detail]');
      if (detail) { App.showScreen('trackers'); openDrawer(detail.dataset.cuDetail); }
    });
  }

  function closeAll() {
    closeModal();
    closeDrawer();
  }

  function init() {
    bindScreen();
    bindDrawer();
    bindModal();
  }

  return { init, load, refresh, handleUpdate, comingUpHTML, bindComingUp, closeAll };
})();
