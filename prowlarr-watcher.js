import {createServer} from 'http';

// ── Config ────────────────────────────────────────────────────────────────────

const PROWLARR_URL = process.env.PROWLARR_URL;
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const INTERVAL = parseInt(process.env.INTERVAL || '60', 10) * 1000;
const HISTORY_TTL_HOURS = parseInt(process.env.HISTORY_TTL_HOURS || '24', 10);
const MAX_AGE_MINUTES = parseInt(process.env.MAX_AGE_MINUTES || '10', 10);
const UI_PORT = parseInt(process.env.UI_PORT || '3000', 10);

if (!PROWLARR_URL || !PROWLARR_API_KEY) {
    console.error('PROWLARR_URL and PROWLARR_API_KEY are required');
    process.exit(1);
}

let trackerDefs;
try {
    trackerDefs = JSON.parse(process.env.TRACKERS || '');
    if (!Array.isArray(trackerDefs) || trackerDefs.length === 0) throw new Error();
} catch {
    console.error('TRACKERS must be a valid non-empty JSON array: [{"id":22,"name":"LaCale","color":16711680}, ...]');
    process.exit(1);
}

// ── Logs ──────────────────────────────────────────────────────────────────────

const logBuffer = [];
const LOG_MAX = 50;

function log(msg) {
    const ts = new Date().toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit', second: '2-digit'});
    const line = `[${ts}] ${msg}`;
    console.log(line);
    logBuffer.push({ts, msg});
    if (logBuffer.length > LOG_MAX) logBuffer.shift();
}

// ── State ─────────────────────────────────────────────────────────────────────

function defaultTrackerState() {
    return {enabled: false, maxSizeGb: 0};
}

// ── History ───────────────────────────────────────────────────────────────────

function createHistory(ttlHours) {
    const map = new Map();
    const ttl = ttlHours * 60 * 60 * 1000;
    return {
        has: (id) => map.has(id),
        add: (id) => map.set(id, Date.now()),
        clean() {
            const now = Date.now();
            let cleaned = 0;
            for (const [id, timestamp] of map) {
                if (now - timestamp > ttl) {
                    map.delete(id);
                    cleaned++;
                }
            }
            if (cleaned > 0) log(`Cleaned ${cleaned} old history entries`);
        },
        get size() {
            return map.size;
        },
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${bytes.toFixed(2)} ${units[i]}`;
}

async function sendDiscordNotification(trackerName, torrent, color) {
    if (!DISCORD_WEBHOOK) return;
    try {
        await fetch(DISCORD_WEBHOOK, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                embeds: [{
                    title: trackerName,
                    description: torrent.name,
                    color,
                    fields: [{name: 'Taille', value: formatSize(torrent.size), inline: true}],
                    timestamp: new Date().toISOString(),
                }],
            }),
        });
    } catch (err) {
        console.error('Discord notification failed:', err.message);
    }
}

// ── Prowlarr ──────────────────────────────────────────────────────────────────

const PROWLARR_HEADERS = {'Content-Type': 'application/json', 'X-Api-Key': PROWLARR_API_KEY};

async function fetchTorrents(prowlarrId) {
    const url = `${PROWLARR_URL}/prowlarr/api/v1/search?query=&indexerIds=${prowlarrId}&limit=10&offset=0`;
    const response = await fetch(url, {headers: PROWLARR_HEADERS});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function downloadViaProwlarr(guid, indexerId) {
    const response = await fetch(`${PROWLARR_URL}/prowlarr/api/v1/search`, {
        method: 'POST',
        headers: PROWLARR_HEADERS,
        body: JSON.stringify({guid, indexerId}),
    });
    if (response.status === 500) return 'already';
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return 'ok';
}

// ── Tracker runtime ───────────────────────────────────────────────────────────

const trackers = trackerDefs.map(def => ({
    id: def.id,
    name: def.name,
    color: def.color,
    history: createHistory(HISTORY_TTL_HOURS),
    stats: {count: 0, totalBytes: 0},
}));

let state = {};

async function checkTracker(tracker) {
    const ts = state[tracker.name] ?? defaultTrackerState();
    if (!ts.enabled) return;

    try {
        const items = await fetchTorrents(tracker.id);
        const maxBytes = ts.maxSizeGb > 0 ? ts.maxSizeGb * 1024 * 1024 * 1024 : Infinity;

        const newTorrents = items
            .map(item => {
                const uid = (item.infoHash ?? item.guid ?? '').toLowerCase();
                return {
                    uid,
                    guid: item.guid ?? '',
                    name: item.title ?? '',
                    size: Number(item.size ?? 0),
                    date: item.publishDate ? new Date(item.publishDate).getTime() : 0,
                };
            })
            .sort((a, b) => a.date - b.date)
            .filter(t => {
                if (!t.uid) return false;
                if (tracker.history.has(t.uid)) return false;
                if (t.size > maxBytes) return false;
                const ageMinutes = (Date.now() - t.date) / (1000 * 60);
                return ageMinutes <= MAX_AGE_MINUTES;
            })
            .slice(0, 4);

        if (newTorrents.length === 0) {
            log(`[${tracker.name}] No new torrents (history: ${tracker.history.size})`);
            return;
        }

        log(`[${tracker.name}] Found ${newTorrents.length} new torrent(s)`);

        for (const torrent of newTorrents) {
            tracker.history.add(torrent.uid);
            try {
                const result = await downloadViaProwlarr(torrent.guid, tracker.id);
                if (result === 'already') {
                    log(`[${tracker.name}] ~ Already in client: ${torrent.name}`);
                } else {
                    tracker.stats.count++;
                    tracker.stats.totalBytes += torrent.size;
                    log(`[${tracker.name}] ✓ ${torrent.name} (${formatSize(torrent.size)})`);
                    await sendDiscordNotification(tracker.name, torrent, tracker.color);
                }
            } catch (err) {
                log(`[${tracker.name}] ✗ Failed: ${torrent.name} — ${err.message}`);
            }
        }

        tracker.history.clean();
    } catch (err) {
        log(`[${tracker.name}] Check failed: ${err.message}`);
    }
}

async function runLoop() {
    const enabled = trackers.filter(t => state[t.name]?.enabled);
    if (enabled.length === 0) {
        log(`No trackers enabled — skipping`);
        return;
    }
    for (const tracker of enabled) {
        await checkTracker(tracker);
    }
}

// ── HTTP UI ───────────────────────────────────────────────────────────────────

const MAX_SIZE_OPTIONS = [
    {label: '10 GB', value: 10},
    {label: '50 GB', value: 50},
    {label: '100 GB', value: 100},
    {label: '200 GB', value: 200},
    {label: '250 GB', value: 250},
    {label: 'Illimité', value: 0},
];

// Couleur Discord (int) → hex CSS
function intToHex(n) {
    return '#' + n.toString(16).padStart(6, '0');
}

function renderHtml() {
    const rows = trackers.map(t => {
        const ts = state[t.name] ?? defaultTrackerState();
        const color = intToHex(t.color);
        const statusLabel = ts.enabled ? 'ON' : 'OFF';
        const btnLabel = ts.enabled ? 'Désactiver' : 'Activer';
        const btnClass = ts.enabled ? 'btn-disable' : 'btn-enable';
        const dotClass = ts.enabled ? 'dot-on' : 'dot-off';

        const options = MAX_SIZE_OPTIONS.map(opt =>
            `<option value="${opt.value}" ${ts.maxSizeGb === opt.value ? 'selected' : ''}>${opt.label}</option>`
        ).join('');

        return `<tr>
      <td><span class="tracker-badge" style="border-left:3px solid ${color};padding-left:8px;font-weight:600">${t.name}</span></td>
      <td><span class="dot ${dotClass}"></span><span class="status-text">${statusLabel}</span></td>
      <td><span class="badge">${t.history.size}</span></td>
      <td><span class="badge">${t.stats.count}</span></td>
      <td><span class="size-val">${formatSize(t.stats.totalBytes)}</span></td>
      <td><select onchange="setMaxSize('${t.name}', this.value)">${options}</select></td>
      <td><button class="${btnClass}" onclick="toggle('${t.name}')">${btnLabel}</button></td>
    </tr>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prowlarr Watcher</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
  h1 { color: #a78bfa; font-size: 1.4rem; margin-bottom: 20px; letter-spacing: 0.05em; }
  h2 { color: #8b949e; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.1em; margin: 24px 0 10px; }
  table { border-collapse: collapse; width: 100%; background: #161b22; border-radius: 8px; overflow: hidden; border: 1px solid #30363d; }
  th { background: #1c2128; padding: 10px 14px; text-align: left; color: #8b949e; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  td { padding: 10px 14px; border-bottom: 1px solid #21262d; font-size: 0.9rem; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #1c2128; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot-on { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
  .dot-off { background: #6e7681; }
  .status-text { vertical-align: middle; font-weight: 600; font-size: 0.85rem; }
  .badge { background: #21262d; border: 1px solid #30363d; border-radius: 12px; padding: 2px 8px; font-size: 0.8rem; color: #8b949e; }
  .size-val { color: #a78bfa; font-weight: 600; }
  select { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 4px 8px; font-size: 0.85rem; }
  select:focus { outline: none; border-color: #a78bfa; }
  button { border: none; border-radius: 6px; padding: 5px 12px; cursor: pointer; font-weight: 600; font-size: 0.82rem; transition: opacity .15s; }
  button:hover { opacity: 0.85; }
  .btn-disable { background: #da3633; color: white; }
  .btn-enable { background: #238636; color: white; }
  #logs { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 14px 16px; font-family: 'Consolas', 'Monaco', monospace; font-size: 0.82rem; height: 340px; overflow-y: auto; line-height: 1.6; }
  .log-time { color: #484f58; }
  .log-tracker { font-weight: 700; }
  .log-ok { color: #3fb950; }
  .log-fail { color: #f85149; }
  .log-skip { color: #e3b341; }
  .log-info { color: #58a6ff; }
  .log-quiet { color: #484f58; }
  .footer { margin-top: 10px; color: #484f58; font-size: 0.78rem; }
</style>
</head>
<body>
<h1>⬇ Prowlarr Watcher</h1>
<table>
  <thead>
    <tr>
      <th>Tracker</th><th>Statut</th><th>Cache</th><th>Téléchargés</th><th>Volume</th><th>Taille max</th><th>Action</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<p class="footer">Intervalle : ${INTERVAL / 1000}s · Âge max : ${MAX_AGE_MINUTES} min</p>
<h2>Logs</h2>
<div id="logs"></div>
<script>window._tc = ${JSON.stringify(Object.fromEntries(trackers.map(t => [t.name, intToHex(t.color)])))}</script>
<script>
async function toggle(name) {
  await fetch('/api/toggle/' + encodeURIComponent(name), {method: 'POST'});
  location.reload();
}
async function setMaxSize(name, value) {
  await fetch('/api/maxsize/' + encodeURIComponent(name), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({maxSizeGb: parseInt(value)})
  });
}
const TRACKER_COLORS = window._tc;
function formatLine(entry) {
  const ts = entry.ts, msg = entry.msg;
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let cls = 'log-info';
  if (msg.includes('\u2713')) cls = 'log-ok';
  else if (msg.includes('\u2717')) cls = 'log-fail';
  else if (msg.includes('~')) cls = 'log-skip';
  else if (msg.includes('No new') || msg.includes('No trackers')) cls = 'log-quiet';
  let escaped = esc(msg);
  Object.entries(TRACKER_COLORS).forEach(function(e) {
    escaped = escaped.split('[' + e[0] + ']').join('[<span style="color:' + e[1] + ';font-weight:700">' + e[0] + '</span>]');
  });
  return '<div><span class="log-time">[' + ts + ']</span> <span class="' + cls + '">' + escaped + '</span></div>';
}
async function refreshLogs() {
  const res = await fetch('/api/logs');
  const lines = await res.json();
  const el = document.getElementById('logs');
  const wasBottom = el.scrollHeight - el.clientHeight <= el.scrollTop + 10;
  el.innerHTML = lines.map(formatLine).join('');
  if (wasBottom) el.scrollTop = el.scrollHeight;
}
refreshLogs();
setInterval(refreshLogs, 3000);
</script>
</body>
</html>`;
}

function startHttpServer() {
    createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost`);

        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(renderHtml());
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/logs') {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify([...logBuffer]));
            return;
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/toggle/')) {
            const name = decodeURIComponent(url.pathname.slice('/api/toggle/'.length));
            if (!state[name]) state[name] = defaultTrackerState();
            state[name].enabled = !state[name].enabled;
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({name, enabled: state[name].enabled}));
            return;
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/maxsize/')) {
            const name = decodeURIComponent(url.pathname.slice('/api/maxsize/'.length));
            const body = await new Promise(resolve => {
                let data = '';
                req.on('data', chunk => {
                    data += chunk;
                });
                req.on('end', () => resolve(data));
            });
            const {maxSizeGb} = JSON.parse(body);
            if (!state[name]) state[name] = defaultTrackerState();
            state[name].maxSizeGb = maxSizeGb;
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({name, maxSizeGb}));
            return;
        }

        res.writeHead(404);
        res.end();
    }).listen(UI_PORT, () => {
        log(`UI available at http://localhost:${UI_PORT}`);
    });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

for (const t of trackers) {
    state[t.name] = defaultTrackerState();
}

log(`Prowlarr Watcher started`);
log(`Trackers: ${trackers.map(t => t.name).join(', ')}`);
log(`Interval: ${INTERVAL / 1000}s | History TTL: ${HISTORY_TTL_HOURS}h`);

startHttpServer();
await runLoop();
setInterval(runLoop, INTERVAL);
