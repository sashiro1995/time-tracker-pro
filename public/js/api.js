const API = {
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async del(path) {
    const res = await fetch(path, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  timer: {
    status:  ()          => API.get('/api/timer/status'),
    start:   (body)      => API.post('/api/timer/start', body),
    startGET:(dur, cat)  => API.get(`/api/timer/start?duration=${dur}&category=${cat}`),
    pause:   (catId)     => API.get(catId ? `/api/timer/pause?category=${encodeURIComponent(catId)}` : '/api/timer/pause'),
    stop:    (catId)     => API.get(catId ? `/api/timer/stop?category=${encodeURIComponent(catId)}`  : '/api/timer/stop'),
  },
  timers: {
    list: () => API.get('/api/timers'),
  },
  categories: {
    list:        ()              => API.get('/api/categories'),
    create:      (body)          => API.post('/api/categories', body),
    update:      (id, b)         => API.put(`/api/categories/${id}`, b),
    delete:      (id)            => API.del(`/api/categories/${id}`),
    uploadSound:      (id, name, data) => API.post(`/api/categories/${id}/sound`, { name, data }),
    clearSound:       (id)            => API.del(`/api/categories/${id}/sound`),
    setDefaultDuration:(id, duration) => API.post(`/api/categories/${id}/default-duration`, { duration }),
    reorder:           (ids)          => API.put('/api/categories/reorder', { ids }),
  },
  notes: {
    list:   ()      => API.get('/api/notes'),
    create: (body)  => API.post('/api/notes', body),
    update: (id, b) => API.put(`/api/notes/${id}`, b),
    delete: (id)    => API.del(`/api/notes/${id}`),
  },
  trackers: {
    list:   ()            => API.get('/api/trackers'),
    create: (body)        => API.post('/api/trackers', body),
    update: (id, b)       => API.put(`/api/trackers/${encodeURIComponent(id)}`, b),
    delete: (id)          => API.del(`/api/trackers/${encodeURIComponent(id)}`),
    act:    (id, action, extra = {}) => API.post(`/api/trackers/${encodeURIComponent(id)}/act`, { action, ...extra }),
  },
  logs: {
    list:   (params) => API.get('/api/logs' + (params ? '?' + new URLSearchParams(params) : '')),
    create: (body)   => API.post('/api/logs', body),
    update: (id, b)  => API.put(`/api/logs/${id}`, b),
    delete: (id)     => API.del(`/api/logs/${id}`),
  },
  settings: {
    get:    ()     => API.get('/api/settings'),
    update: (body) => API.put('/api/settings', body),
  },
  analytics: {
    summary: () => API.get('/api/analytics/summary'),
  },
  app: {
    version: () => API.get('/api/app/version'),
  },
  stopwatch: {
    status:      ()              => API.get('/api/stopwatch/status'),
    arm:         (body)          => API.post('/api/stopwatch/arm', body),
    toggle:      (category)      => API.get(`/api/stopwatch/toggle${category ? '?category=' + category : ''}`),
    pause:       ()              => API.get('/api/stopwatch/pause'),
    stop:        ()              => API.get('/api/stopwatch/stop'),
  },
};

// The stretches of a session that were actually worked, as [{ start: Date, seconds }].
// A session paused 1:15–2:15 inside 1:00–3:00 gives 1:00 (15m) and 2:15 (45m).
function sessionSegments(s) {
  const pauses = (s.pauses || []).filter(p => p.start && p.end);
  if (!pauses.length) return [{ start: new Date(s.startTime), seconds: s.durationSeconds }];
  const segments = [];
  let cursor = new Date(s.startTime).getTime();
  let left = s.durationSeconds;
  pauses.forEach(p => {
    const secs = Math.min(left, Math.max(0, (new Date(p.start).getTime() - cursor) / 1000));
    if (secs > 0) segments.push({ start: new Date(cursor), seconds: secs });
    left -= secs;
    cursor = Math.max(cursor, new Date(p.end).getTime());
  });
  if (left > 0) segments.push({ start: new Date(cursor), seconds: left });
  return segments;
}
