// Works out who is on the app's port, so we only ever close our own leftover copy.
const net  = require('net');
const http = require('http');
const { execSync } = require('child_process');

function isPortInUse(port) {
  return new Promise(resolve => {
    const sock = net.createConnection(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

function getJSON(port, route) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 1500 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// 'free', 'ours' (a Time Tracker Pro server), or 'other' (anything else)
async function classifyPort(port) {
  if (!(await isPortInUse(port))) return 'free';
  const version = await getJSON(port, '/api/app/version');
  const cats    = await getJSON(port, '/api/categories');
  const isOurs  = typeof version?.version === 'string' && Array.isArray(cats?.categories);
  return isOurs ? 'ours' : 'other';
}

function listeningPids(port) {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    const pids = out.split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(cols => cols[3] === 'LISTENING' && cols[1]?.endsWith(`:${port}`))
      .map(cols => cols[4]);
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

function killPort(port) {
  listeningPids(port).forEach(pid => {
    try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {}
  });
}

// The name of the program on the port, for the message we show. Null if it can't be found.
function portOwnerName(port) {
  const [pid] = listeningPids(port);
  if (!pid) return null;
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
    return out.split('"')[1] || null;
  } catch {
    return null;
  }
}

module.exports = { classifyPort, killPort, portOwnerName };
