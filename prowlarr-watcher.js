import {createServer} from 'http';
import {readFile} from 'fs/promises';
import {join} from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const PROWLARR_URL = process.env.PROWLARR_URL;
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const INTERVAL = parseInt(process.env.INTERVAL || '60', 10) * 1000;
const HISTORY_TTL_HOURS = parseInt(process.env.HISTORY_TTL_HOURS || '24', 10);
const MAX_AGE_MINUTES = parseInt(process.env.MAX_AGE_MINUTES || '10', 10);
const UI_PORT = parseInt(process.env.UI_PORT || '3000', 10);
const EXCLUDED_CATEGORIES = new Set(
    (process.env.EXCLUDED_CATEGORIES || '').split(',').flatMap(s => {
        const n = parseInt(s.trim(), 10);
        return isNaN(n) ? [] : [n];
    })
);

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
    return {enabled: false, maxSizeGb: 0, excludedCategories: new Set(EXCLUDED_CATEGORIES)};
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

// ── Categories ────────────────────────────────────────────────────────────────

// trackerCategories: Map<trackerId (number), categories[]>
const trackerCategories = new Map();

async function fetchIndexerCategories() {
    try {
        const response = await fetch(`${PROWLARR_URL}/prowlarr/api/v1/indexer`, {headers: PROWLARR_HEADERS});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const indexers = await response.json();
        for (const indexer of indexers) {
            trackerCategories.set(indexer.id, indexer.capabilities?.categories ?? []);
        }
        log(`Categories loaded for ${trackerCategories.size} indexer(s)`);
    } catch (err) {
        log(`Warning: could not fetch indexer categories (${err.message})`);
    }
}

// ── Category filtering ────────────────────────────────────────────────────────

function flatCategoryIds(categories) {
    return categories.flatMap(c => [c.id, ...(c.subCategories ?? []).map(s => s.id)]);
}

function isCategoryExcluded(categoryIds, excludedSet) {
    return categoryIds.some(id =>
        excludedSet.has(id) ||
        excludedSet.has(Math.floor(id / 1000) * 1000)
    );
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
        const excluded = ts.excludedCategories;

        const newTorrents = items
            .map(item => {
                const uid = (item.infoHash ?? item.guid ?? '').toLowerCase();
                return {
                    uid,
                    guid: item.guid ?? '',
                    name: item.title ?? '',
                    size: Number(item.size ?? 0),
                    date: item.publishDate ? new Date(item.publishDate).getTime() : 0,
                    categories: item.categories ?? [],
                };
            })
            .sort((a, b) => a.date - b.date)
            .filter(t => {
                if (!t.uid) return false;
                if (tracker.history.has(t.uid)) return false;
                if (t.size > maxBytes) return false;
                const ageMinutes = (Date.now() - t.date) / (1000 * 60);
                if (ageMinutes > MAX_AGE_MINUTES) return false;
                if (excluded.size > 0 && isCategoryExcluded(flatCategoryIds(t.categories), excluded)) return false;
                return true;
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

async function serveStatic(res, filename, contentType) {
    try {
        const data = await readFile(join(process.cwd(), 'public', filename));
        res.writeHead(200, {'Content-Type': contentType});
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end();
    }
}

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
        const excludedCount = ts.excludedCategories.size;

        const options = MAX_SIZE_OPTIONS.map(opt =>
            `<option value="${opt.value}" ${ts.maxSizeGb === opt.value ? 'selected' : ''}>${opt.label}</option>`
        ).join('');

        return `<tr id="row-${t.name}">
      <td><span class="tracker-badge" style="border-left:3px solid ${color};padding-left:8px;font-weight:600">${t.name}</span></td>
      <td><span class="dot ${dotClass}"></span><span class="status-text">${statusLabel}</span></td>
      <td><span class="badge">${t.history.size}</span></td>
      <td><span class="badge">${t.stats.count}</span></td>
      <td><span class="size-val">${formatSize(t.stats.totalBytes)}</span></td>
      <td><select onchange="setMaxSize('${t.name}', this.value)">${options}</select></td>
      <td><button class="btn-cat" onclick="toggleCatPanel('${t.name}')">Catégories${excludedCount > 0 ? ` <span class="badge-excl">${excludedCount}</span>` : ''}</button></td>
      <td><button class="${btnClass}" onclick="toggle('${t.name}')">${btnLabel}</button></td>
    </tr>
    <tr id="cat-${t.name}" class="cat-row" style="display:none">
      <td colspan="8"><div class="cat-inner cat-panel"></div></td>
    </tr>`;
    }).join('\n');

    // Sérialiser trackerCategories et exclusions pour le JS client
    const categoriesData = {};
    const excludedData = {};
    for (const t of trackers) {
        const cats = trackerCategories.get(t.id) ?? [];
        categoriesData[t.name] = cats;
        excludedData[t.name] = [...(state[t.name]?.excludedCategories ?? new Set(EXCLUDED_CATEGORIES))];
    }

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prowlarr Watcher</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<h1>⬇ Prowlarr Watcher</h1>
<table>
  <thead>
    <tr>
      <th>Tracker</th><th>Statut</th><th>Cache</th><th>Téléchargés</th><th>Volume</th><th>Taille max</th><th>Catégories</th><th>Action</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<p class="footer">Intervalle : ${INTERVAL / 1000}s · Âge max : ${MAX_AGE_MINUTES} min</p>
<h2>Logs</h2>
<div id="logs"></div>
<script>
window._tc = ${JSON.stringify(Object.fromEntries(trackers.map(t => [t.name, intToHex(t.color)])))};
window._categories = ${JSON.stringify(categoriesData)};
window._excluded = ${JSON.stringify(excludedData)};
</script>
<script src="/app.js"></script>
</body>
</html>`;
}

async function readBody(req) {
    return new Promise(resolve => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
        });
        req.on('end', () => resolve(data));
    });
}

function startHttpServer() {
    createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost`);

        if (req.method === 'GET' && url.pathname === '/style.css') {
            return serveStatic(res, 'style.css', 'text/css');
        }

        if (req.method === 'GET' && url.pathname === '/app.js') {
            return serveStatic(res, 'app.js', 'application/javascript');
        }

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
            const {maxSizeGb} = JSON.parse(await readBody(req));
            if (!state[name]) state[name] = defaultTrackerState();
            state[name].maxSizeGb = maxSizeGb;
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({name, maxSizeGb}));
            return;
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/categories/')) {
            const name = decodeURIComponent(url.pathname.slice('/api/categories/'.length));
            const {excludedCategories} = JSON.parse(await readBody(req));
            if (!state[name]) state[name] = defaultTrackerState();
            state[name].excludedCategories = new Set(excludedCategories);
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({name, excludedCategories}));
            return;
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/categories/')) {
            const name = decodeURIComponent(url.pathname.slice('/api/categories/'.length));
            const tracker = trackers.find(t => t.name === name);
            const cats = tracker ? (trackerCategories.get(tracker.id) ?? []) : [];
            const excluded = [...(state[name]?.excludedCategories ?? new Set(EXCLUDED_CATEGORIES))];
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({categories: cats, excludedCategories: excluded}));
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
if (EXCLUDED_CATEGORIES.size > 0) {
    log(`Global excluded categories: ${[...EXCLUDED_CATEGORIES].join(', ')}`);
}

startHttpServer();
await fetchIndexerCategories();
await runLoop();
setInterval(runLoop, INTERVAL);
