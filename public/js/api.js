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
