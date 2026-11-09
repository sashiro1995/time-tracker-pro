// Long-term goal "journey": hours done toward a total (e.g. 1000h), recent pace, when that pace
// would finish, the pace an end date needs, milestones, and a cumulative chart.
// Everything is stated as a plain fact; nothing here says "behind" or "on track".
const Journey = (() => {
  const charts = new Map();      // canvas id -> Chart
  const pending = new Map();     // canvas id -> data to draw once the canvas is in the page
  const PACE_DAYS = 30;
  const MILESTONES = [0.1, 0.25, 0.5, 0.75, 1];

  const fmtDur = (...a) => Charts.fmtDur(...a);
  const esc = (...a) => Charts.esc(...a);

  function todayISO() { return new Date().toLocaleDateString('sv'); }
  function dayIndex(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }
  function isoFromIndex(i) {
    const d = new Date(i * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const dateOf = iso => new Date(iso + 'T00:00:00');
  const fmtDay   = iso => dateOf(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  // The year is shown only when it isn't this year
  const fmtShort = iso => dateOf(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(iso.slice(0, 4) !== todayISO().slice(0, 4) ? { year: 'numeric' } : {}),
  });
  const fmtMonth = iso => dateOf(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const fmtRate  = hoursPerDay => hoursPerDay >= 1 ? `${Math.round(hoursPerDay * 10) / 10}h/day` : `${Math.max(1, Math.round(hoursPerDay * 60))}m/day`;
  const fmtH     = secs => `${(Math.round(secs / 360) / 10).toLocaleString('en-US')}h`;

  // Sessions that count toward the goal: this category, from the "Count from" date if one is set
  function countedSessions(c, sessions) {
    const from = c.lifetimeStart || '';
    return sessions.filter(s => s.categoryId === c.id && (!from || toLocalDate(s.startTime) >= from));
  }

  function countedSecs(c, sessions) {
    return countedSessions(c, sessions).reduce((sum, s) => sum + s.durationSeconds, 0);
  }

  function compute(c, sessions) {
    const today = todayISO();
    const todayIdx = dayIndex(today);
    const targetSecs = (c.lifetimeTarget || 0) * 3600;
    const list = countedSessions(c, sessions);

    // Seconds per local day
    const perDay = new Map();
    list.forEach(s => {
      const d = toLocalDate(s.startTime);
      perDay.set(d, (perDay.get(d) || 0) + s.durationSeconds);
    });
    const days = [...perDay.keys()].sort();
    const doneSecs = list.reduce((sum, s) => sum + s.durationSeconds, 0);

    const startISO = c.lifetimeStart || days[0] || today;
    const startIdx = Math.min(dayIndex(startISO), todayIdx);

    // Pace: the last 30 days, or since the start if the goal is younger than that
    // (with nothing tracked yet and no start date, it's simply the last 30 days)
    const paceFloorIdx = (c.lifetimeStart || days.length) ? startIdx : todayIdx - (PACE_DAYS - 1);
    const windowStartIdx = Math.max(paceFloorIdx, todayIdx - (PACE_DAYS - 1));
    const windowDays = todayIdx - windowStartIdx + 1;
    let windowSecs = 0;
    perDay.forEach((secs, d) => { if (dayIndex(d) >= windowStartIdx && dayIndex(d) <= todayIdx) windowSecs += secs; });
    const paceSecsPerDay = windowSecs / windowDays;

    const remainingSecs = Math.max(0, targetSecs - doneSecs);
    const reached = targetSecs > 0 && remainingSecs === 0;

    const projectedISO = !reached && paceSecsPerDay > 0
      ? isoFromIndex(todayIdx + Math.ceil(remainingSecs / paceSecsPerDay))
      : null;

    let neededSecsPerDay = null;
    if (!reached && c.lifetimeDeadline && c.lifetimeDeadline >= today) {
      neededSecsPerDay = remainingSecs / (dayIndex(c.lifetimeDeadline) - todayIdx + 1);
    }

    // Cumulative total per day, and the day each milestone was passed
    const series = [];
    const milestones = MILESTONES.map(f => ({ fraction: f, secs: targetSecs * f, date: null }));
    let running = 0;
    for (let i = startIdx; i <= todayIdx; i++) {
      const iso = isoFromIndex(i);
      running += perDay.get(iso) || 0;
      series.push({ x: i - startIdx, y: running / 3600 });
      milestones.forEach(m => { if (!m.date && targetSecs > 0 && running >= m.secs) m.date = iso; });
    }

    return {
      c, today, startISO, startIdx, todayIdx, targetSecs, doneSecs, remainingSecs, reached,
      paceSecsPerDay, windowDays, projectedISO, neededSecsPerDay, series, milestones,
      reachedISO: milestones[milestones.length - 1].date,
    };
  }

  // Plain-text facts, as in the "Balanced bento" design: a bold figure, then what it means
  function factsHTML(j) {
    const c = j.c;
    const fact = (strong, note) => `<div class="journey__fact"><strong>${strong}</strong><span>${note}</span></div>`;
    if (j.reached) return `<div class="journey__facts">${fact('Reached', `on ${fmtDay(j.reachedISO)}`)}</div>`;

    const target = `${c.lifetimeTarget.toLocaleString('en-US')}h`;
    const facts = [];
    facts.push(j.paceSecsPerDay > 0
      ? fact(fmtRate(j.paceSecsPerDay / 3600), `over the last ${j.windowDays} day${j.windowDays === 1 ? '' : 's'}`)
      : fact('—', 'Nothing tracked in the last 30 days'));
    facts.push(j.projectedISO
      ? fact(`Finish around ${fmtMonth(j.projectedISO)}`, `${fmtH(j.remainingSecs)} to go at this pace`)
      : fact('No finish date yet', 'Track some time to see when you\'d finish'));
    if (j.neededSecsPerDay !== null) {
      facts.push(fact(fmtRate(j.neededSecsPerDay / 3600), `to reach ${target} by ${fmtDay(c.lifetimeDeadline)}`));
    } else if (c.lifetimeDeadline) {
      facts.push(fact(fmtDay(c.lifetimeDeadline), 'target date has passed'));
    }
    return `<div class="journey__facts">${facts.join('')}</div>`;
  }

  function legendHTML(j) {
    const deadline = j.c.lifetimeDeadline;
    return `
      <div class="journey__legend" aria-hidden="true">
        <span><i class="journey__key journey__key--line"></i>Actual</span>
        ${j.projectedISO ? '<span><i class="journey__key journey__key--dots"></i>At current pace</span>' : ''}
        ${deadline ? `<span><i class="journey__key journey__key--mark"></i>${fmtShort(deadline)} target date</span>` : ''}
      </div>`;
  }

  function milestonesHTML(j) {
    return `
      <ol class="journey__milestones" aria-label="Milestones">
        ${j.milestones.map(m => {
          const hours = Math.round(m.secs / 3600).toLocaleString('en-US');
          return `<li class="journey__milestone${m.date ? ' is-reached' : ''}">
            <span class="journey__milestone-dot" aria-hidden="true"></span>
            <span class="journey__milestone-hours">${hours}h</span>
            <span class="journey__milestone-date">${m.date ? fmtShort(m.date) : ''}</span>
          </li>`;
        }).join('')}
      </ol>`;
  }

  // opts.key: unique per place the card appears ("goals", "today")
  // opts.showTotal: include the "312h of 1000h" line and bar (off when the card already shows it)
  // opts.title: show the category name as a header
  function cardHTML(c, sessions, opts = {}) {
    const j = compute(c, sessions);
    const canvasId = `journey-${opts.key || 'x'}-${c.id}`;
    pending.set(canvasId, j);
    const pct = j.targetSecs ? Math.min(100, Math.round((j.doneSecs / j.targetSecs) * 100)) : 0;
    const since = c.lifetimeStart ? `since ${fmtDay(c.lifetimeStart)}` : 'all time';

    const total = `
      <div class="journey__total-block">
        <div class="journey__total"><strong>${fmtH(j.doneSecs)}</strong><span>of ${c.lifetimeTarget.toLocaleString('en-US')}h</span></div>
        <div class="goal-row__bar" title="${pct}%"><div class="goal-row__fill" style="width:${pct}%;background:${c.color}"></div></div>
        <div class="journey__since">${pct}% · ${since}</div>
      </div>`;

    return `
      <div class="journey${opts.compact ? ' journey--compact' : ''}${opts.showTotal === false ? ' journey--facts-only' : ''}" style="--journey-color:${c.color}">
        ${opts.label ? `<div class="journey__label"><span class="breakdown-item__dot" style="background:${c.color}"></span>${esc(c.name)} · ${c.lifetimeTarget.toLocaleString('en-US')} hours</div>` : ''}
        <div class="journey__top">
          ${opts.showTotal !== false ? total : ''}
          ${factsHTML(j)}
        </div>
        <div class="chart-wrap journey__chart">
          <canvas id="${canvasId}" role="img" aria-label="${esc(c.name)}: ${fmtH(j.doneSecs)} of ${c.lifetimeTarget}h over time${j.projectedISO ? `, around ${fmtMonth(j.projectedISO)} at the recent pace` : ''}"></canvas>
        </div>
        ${legendHTML(j)}
        ${milestonesHTML(j)}
      </div>`;
  }

  // Draws every journey chart now in the page; call after inserting cardHTML output.
  function mount(root = document) {
    charts.forEach((chart, id) => {
      if (!document.getElementById(id) || chart.canvas !== document.getElementById(id)) { chart.destroy(); charts.delete(id); }
    });
    root.querySelectorAll('canvas[id^="journey-"]').forEach(canvas => {
      const j = pending.get(canvas.id);
      if (!j) return;
      if (charts.has(canvas.id)) charts.get(canvas.id).destroy();
      charts.set(canvas.id, draw(canvas, j));
    });
  }

  function draw(canvas, j) {
    const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    Chart.defaults.color = css('--text-secondary');
    Chart.defaults.borderColor = css('--border-subtle');

    const color = j.c.color;
    const targetH = j.targetSecs / 3600;
    const todayX = j.todayIdx - j.startIdx;
    const doneH = j.doneSecs / 3600;

    // Show at least to today and the end date; the projection is drawn up to its finish
    // or clipped once it runs past three times the span so far.
    let maxX = Math.max(todayX, 7);
    if (j.c.lifetimeDeadline) maxX = Math.max(maxX, dayIndex(j.c.lifetimeDeadline) - j.startIdx);
    const projX = j.projectedISO ? dayIndex(j.projectedISO) - j.startIdx : null;
    const cap = Math.max(maxX, todayX * 3 + 30);
    if (projX !== null) maxX = Math.max(maxX, Math.min(projX, cap));

    const datasets = [{
      label: 'Done',
      data: j.series,
      borderColor: color,
      backgroundColor: color + '22',
      fill: true,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.15,
    }];

    if (projX !== null && !j.reached) {
      const endX = Math.min(projX, maxX);
      const endY = doneH + (j.paceSecsPerDay / 3600) * (endX - todayX);
      datasets.push({
        label: 'At recent pace',
        data: [{ x: todayX, y: doneH }, { x: endX, y: Math.min(endY, targetH) }],
        borderColor: color,
        borderDash: [2, 4],
        borderWidth: 2,
        // A dot at "now", and one at the finish when it fits on the chart
        pointRadius: [3, projX <= maxX ? 3 : 0],
        pointBackgroundColor: color,
        pointBorderWidth: 0,
        fill: false,
      });
    }

    datasets.push({
      label: 'Goal',
      data: [{ x: 0, y: targetH }, { x: maxX, y: targetH }],
      borderColor: css('--border-strong'),
      borderWidth: 1,
      pointRadius: 0,
      fill: false,
    });

    if (j.c.lifetimeDeadline) {
      const dx = dayIndex(j.c.lifetimeDeadline) - j.startIdx;
      datasets.push({
        label: 'End date',
        data: [{ x: dx, y: 0 }, { x: dx, y: targetH }],
        borderColor: css('--text-muted'),
        borderDash: [2, 4],
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
      });
    }

    const labelFor = x => fmtMonthOrDay(isoFromIndex(j.startIdx + Math.round(x)), maxX);

    return new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: item => item.dataset.label === 'Done' || item.dataset.label === 'At recent pace',
            callbacks: {
              title: items => items.length ? fmtDay(isoFromIndex(j.startIdx + Math.round(items[0].parsed.x))) : '',
              label: item => `${item.dataset.label}: ${Math.round(item.parsed.y).toLocaleString('en-US')}h`,
            },
          },
        },
        scales: {
          x: {
            type: 'linear', min: 0, max: maxX,
            grid: { display: false },
            // includeBounds off: no extra tick squeezed in at the very end
            ticks: { maxTicksLimit: 5, includeBounds: false, callback: v => labelFor(v) },
          },
          y: {
            min: 0, suggestedMax: targetH,
            ticks: { maxTicksLimit: 5, callback: v => `${v.toLocaleString('en-US')}h` },
          },
        },
      },
    });
  }

  function fmtMonthOrDay(iso, spanDays) {
    return spanDays > 120 ? fmtMonth(iso) : fmtShort(iso);
  }

  // One-line plain fact for small places (goal rows): "312h of 1000h · around Aug 2028"
  function hint(c, sessions) {
    const j = compute(c, sessions);
    if (j.reached) return `Reached ${fmtShort(j.reachedISO)}`;
    const parts = [`${fmtH(j.doneSecs)} of ${c.lifetimeTarget.toLocaleString('en-US')}h${c.lifetimeStart ? '' : ' all time'}`];
    if (j.projectedISO) parts.push(`around ${fmtMonth(j.projectedISO)}`);
    if (j.neededSecsPerDay !== null) parts.push(`${fmtRate(j.neededSecsPerDay / 3600)} for ${fmtShort(c.lifetimeDeadline)}`);
    return parts.join(' · ');
  }

  return { compute, countedSecs, cardHTML, mount, hint };
})();
