const Charts = (() => {
  let weekChart    = null;
  let dailyChart   = null;
  let doughnutChart = null;

  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Read fresh before each chart is drawn, so charts follow the current theme
  function syncThemeDefaults() {
    Chart.defaults.color = css('--text-secondary');
    Chart.defaults.borderColor = css('--border-subtle');
  }

  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.animation.duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350;

  function fmtDur(secs) {
    const total = Math.round(secs / 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  function esc(str) {
    return String(str).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function isoDate(d) { return d.toLocaleDateString('sv'); }
  function sessionDay(s) { return new Date(s.startTime).toLocaleDateString('sv'); }

  function getDaysBetween(from, to) {
    const days = [];
    const cur = new Date(from);
    cur.setHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    while (cur <= end) {
      days.push(isoDate(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return days;
  }

  function getWeekBuckets(from, to) {
    const buckets = [];
    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    const dow = start.getDay();
    const offset = dow === 0 ? -6 : 1 - dow; // align to Monday
    start.setDate(start.getDate() + offset);

    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    const cur = new Date(start);

    while (cur <= end) {
      const weekStart = isoDate(cur);
      const weekEnd = new Date(cur);
      weekEnd.setDate(weekEnd.getDate() + 6);
      buckets.push({
        label: new Date(weekStart + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        startDate: weekStart,
        endDate: isoDate(weekEnd),
      });
      cur.setDate(cur.getDate() + 7);
    }
    return buckets;
  }

  function getMonthBuckets(from, to) {
    const buckets = [];
    const cur = new Date(from.getFullYear(), from.getMonth(), 1);
    const endMonth = new Date(to.getFullYear(), to.getMonth() + 1, 0);

    while (cur <= endMonth) {
      const prefix = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
      buckets.push({
        label: cur.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
        prefix,
      });
      cur.setMonth(cur.getMonth() + 1);
    }
    return buckets;
  }

  // Calls fn(date, seconds) once per clock hour a session overlaps.
  function forEachHourSlice(session, fn) {
    let cursor = new Date(session.startTime);
    let left = session.durationSeconds;
    while (left > 0) {
      const secsIntoHour = cursor.getMinutes() * 60 + cursor.getSeconds();
      const slice = Math.min(left, 3600 - secsIntoHour);
      fn(cursor, slice);
      left -= slice;
      cursor = new Date(cursor.getTime() + slice * 1000);
    }
  }

  function hourLabel(h) {
    if (h === 0) return '12am';
    if (h === 12) return '12pm';
    return h < 12 ? `${h}am` : `${h - 12}pm`;
  }

  // ── Shared chart pieces ────────────────────────────────────────────────────
  function legendHTML(cats) {
    return cats.map(c => `
      <span class="chart-legend__item">
        <span class="chart-legend__dot" style="background:${c.color}"></span>${esc(c.name)}
      </span>`).join('');
  }

  // Keeps the axis on round numbers, so it never reads 0.2h / 0.4h / 1.2h.
  function hourStep(maxHours) {
    if (maxHours <= 2) return 0.5;
    if (maxHours <= 5) return 1;
    if (maxHours <= 12) return 2;
    return undefined;
  }

  // Stacked bars: 2px surface gap between segments, 4px rounded top on the topmost only.
  function buildStackedDatasets(cats, valuesByCat, surface) {
    const count = cats.length ? valuesByCat[cats[0].id].length : 0;
    const topIndex = [];
    for (let i = 0; i < count; i++) {
      topIndex[i] = -1;
      cats.forEach((c, di) => { if (valuesByCat[c.id][i] > 0) topIndex[i] = di; });
    }
    return cats.map((c, di) => ({
      label: c.name,
      data: valuesByCat[c.id].map(v => (v > 0 ? v : null)),
      backgroundColor: c.color,
      hoverBackgroundColor: c.color,
      borderColor: surface,
      hoverBorderColor: surface,
      borderSkipped: false,
      inflateAmount: 0,
      maxBarThickness: 28,
      borderWidth: ctx => (topIndex[ctx.dataIndex] === di ? 0 : { top: 2 }),
      borderRadius: ctx => (topIndex[ctx.dataIndex] === di
        ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 }
        : 0),
    }));
  }

  function stackedOptions(maxHours, xTicks = {}) {
    const tooltipBg = css('--bg-elevated');
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: tooltipBg,
          borderColor: css('--border-default'),
          borderWidth: 1,
          padding: 12,
          cornerRadius: 10,
          titleColor: css('--text-primary'),
          titleFont: { weight: '600' },
          bodyColor: css('--text-secondary'),
          footerColor: css('--text-primary'),
          footerFont: { weight: '600' },
          boxWidth: 8,
          boxHeight: 8,
          boxPadding: 6,
          usePointStyle: true,
          itemSort: (a, b) => b.raw - a.raw,
          callbacks: {
            label: item => ` ${item.dataset.label}  ${fmtDur(item.raw * 3600)}`,
            labelColor: item => ({ backgroundColor: item.dataset.backgroundColor, borderColor: tooltipBg }),
            footer: items => (items.length > 1
              ? `Total  ${fmtDur(items.reduce((sum, i) => sum + i.raw, 0) * 3600)}`
              : ''),
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { color: css('--border-default') },
          ticks: { maxRotation: 0, autoSkipPadding: 16, ...xTicks },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          suggestedMax: 1,
          border: { display: false },
          grid: { color: css('--border-subtle') },
          ticks: {
            stepSize: hourStep(maxHours),
            padding: 8,
            callback: v => (v === 0 ? '0' : `${v}h`),
          },
        },
      },
    };
  }

  function maxStack(cats, valuesByCat) {
    if (!cats.length) return 0;
    return valuesByCat[cats[0].id].reduce((max, _, i) =>
      Math.max(max, cats.reduce((sum, c) => sum + valuesByCat[c.id][i], 0)), 0);
  }

  function setEmpty(canvas, isEmpty) {
    canvas.parentElement.classList.toggle('chart-wrap--empty', isEmpty);
  }

  function secsToHours(list) {
    return list.reduce((sum, s) => sum + s.durationSeconds, 0) / 3600;
  }

  function surfaceColor() { return css('--bg-surface'); }

  // ── Week chart (Dashboard) ─────────────────────────────────────────────────
  // Monday–Sunday of the current week, matching the "This week" total above it.
  function renderWeekChart(sessions, categories) {
    const ctx = document.getElementById('weekChart');
    if (!ctx) return;
    syncThemeDefaults();

    const monday = new Date();
    monday.setDate(monday.getDate() + (monday.getDay() === 0 ? -6 : 1 - monday.getDay()));
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return isoDate(d);
    });
    const todayIdx = days.indexOf(isoDate(new Date()));

    const valuesByCat = {};
    categories.filter(c => !c.archived).forEach(cat => {
      valuesByCat[cat.id] = days.map(day =>
        secsToHours(sessions.filter(s => s.categoryId === cat.id && sessionDay(s) === day)));
    });
    const cats = categories.filter(c => !c.archived && valuesByCat[c.id].some(v => v > 0));

    const legend = document.getElementById('weekLegend');
    if (legend) legend.innerHTML = legendHTML(cats);
    setEmpty(ctx, cats.length === 0);

    const primary = css('--text-primary');
    const secondary = css('--text-secondary');
    if (weekChart) weekChart.destroy();
    weekChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: days.map(d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })),
        datasets: buildStackedDatasets(cats, valuesByCat, surfaceColor()),
      },
      options: stackedOptions(maxStack(cats, valuesByCat), {
        color: c => (c.index === todayIdx ? primary : secondary),
        font: c => ({ weight: c.index === todayIdx ? '600' : '400' }),
      }),
    });
  }

  // ── Time chart (Analytics) ─────────────────────────────────────────────────
  // from / to are Date objects. Auto-groups: hourly 1d, daily ≤31d, weekly ≤90d, monthly >90d.
  function renderDailyChart(sessions, categories, from, to) {
    const ctx = document.getElementById('dailyChart');
    if (!ctx) return 'day';
    syncThemeDefaults();

    const fromStr = isoDate(from);
    const toStr = isoDate(to);
    const inRange = sessions.filter(s => { const d = sessionDay(s); return d >= fromStr && d <= toStr; });
    const active = categories.filter(c => !c.archived);
    const diffDays = Math.floor((to - from) / 86400000) + 1;

    let labels, computeValues, unit;

    if (diffDays === 1) {
      unit = 'hour';
      labels = Array.from({ length: 24 }, (_, h) => hourLabel(h));
      computeValues = list => {
        const hours = new Array(24).fill(0);
        list.forEach(s => forEachHourSlice(s, (date, secs) => {
          if (isoDate(date) === fromStr) hours[date.getHours()] += secs / 3600;
        }));
        return hours;
      };
    } else if (diffDays <= 31) {
      unit = 'day';
      const days = getDaysBetween(from, to);
      labels = days.map(d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      computeValues = list => days.map(day => secsToHours(list.filter(s => sessionDay(s) === day)));
    } else if (diffDays <= 90) {
      unit = 'week';
      const buckets = getWeekBuckets(from, to);
      labels = buckets.map(b => b.label);
      computeValues = list => buckets.map(b =>
        secsToHours(list.filter(s => { const d = sessionDay(s); return d >= b.startDate && d <= b.endDate; })));
    } else {
      unit = 'month';
      const buckets = getMonthBuckets(from, to);
      labels = buckets.map(b => b.label);
      computeValues = list => buckets.map(b => secsToHours(list.filter(s => sessionDay(s).startsWith(b.prefix))));
    }

    const valuesByCat = {};
    active.forEach(cat => { valuesByCat[cat.id] = computeValues(inRange.filter(s => s.categoryId === cat.id)); });
    const cats = active.filter(c => valuesByCat[c.id].some(v => v > 0));

    const legend = document.getElementById('dailyLegend');
    if (legend) legend.innerHTML = legendHTML(cats);
    setEmpty(ctx, cats.length === 0);

    if (dailyChart) dailyChart.destroy();
    dailyChart = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: buildStackedDatasets(cats, valuesByCat, surfaceColor()) },
      options: stackedOptions(maxStack(cats, valuesByCat)),
    });
    return unit;
  }

  // ── Doughnut chart (Analytics) ─────────────────────────────────────────────
  // rows: [{ name, color, secs }] already filtered to the selected range.
  function renderDoughnutChart(rows) {
    const ctx = document.getElementById('doughnutChart');
    if (!ctx) return;
    syncThemeDefaults();

    const surface = surfaceColor();
    const tooltipBg = css('--bg-elevated');
    setEmpty(ctx, rows.length === 0);

    if (doughnutChart) doughnutChart.destroy();
    doughnutChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: rows.map(r => r.name),
        datasets: [{
          data: rows.map(r => r.secs),
          backgroundColor: rows.map(r => r.color),
          hoverBackgroundColor: rows.map(r => r.color),
          borderColor: surface,
          hoverBorderColor: surface,
          borderWidth: 2,
          hoverOffset: 4,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '74%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: tooltipBg,
            borderColor: css('--border-default'),
            borderWidth: 1,
            padding: 12,
            cornerRadius: 10,
            bodyColor: css('--text-primary'),
            boxWidth: 8,
            boxHeight: 8,
            boxPadding: 6,
            usePointStyle: true,
            callbacks: {
              label: item => ` ${item.label}  ${fmtDur(item.raw)}`,
              labelColor: item => ({ backgroundColor: item.dataset.backgroundColor[item.dataIndex], borderColor: tooltipBg }),
            },
          },
        },
      },
    });
  }

  return { renderWeekChart, renderDailyChart, renderDoughnutChart, forEachHourSlice, hourLabel, fmtDur, esc };
})();
