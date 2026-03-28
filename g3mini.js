import {loadCommonConfig, createHistory, downloadTorrent, sendDiscordNotification, startTracker} from './common.js';

const G3MINI_API_KEY = process.env.G3MINI_API_KEY;

if (!G3MINI_API_KEY) {
    console.error('G3MINI_API_KEY is required');
    process.exit(1);
}

const config = loadCommonConfig();
const history = createHistory(config.historyTtlHours);

async function checkTorrents() {
    try {
        const url = `https://gemini-tracker.org/api/torrents/filter?perPage=3`;
        const response = await fetch(url, {
            headers: {Authorization: `Bearer ${G3MINI_API_KEY}`},
        });

        if (!response.ok) {
            throw new Error(`API error: HTTP ${response.status}`);
        }

        const data = await response.json();
        const items = data?.data ?? [];

        const newTorrents = items
            .map(item => {
                const attrs = item.attributes ?? {};
                const uid = attrs.name;
                return {uid, name: attrs.name, downloadUrl: attrs.download_link, size: Number(attrs.size ?? 0)};
            })
            .filter(t => t.uid && t.downloadUrl && !history.has(t.uid) && t.size <= config.maxSizeBytes);

        if (newTorrents.length === 0) {
            console.log(`[${new Date().toISOString()}] No new torrents (${history.size} in history)`);
            return;
        }

        console.log(`[${new Date().toISOString()}] Found ${newTorrents.length} new torrent(s)`);

        for (const torrent of newTorrents) {
            const success = await downloadTorrent(torrent, config.downloadDir);
            if (success) {
                await sendDiscordNotification(config.discordWebhook, torrent, {
                    trackerName: config.trackerName,
                    color: config.discordColor,
                });
                history.add(torrent.uid);
                console.log(`Added to history: ${torrent.uid} (total: ${history.size})`);
            }
        }

        history.clean();
    } catch (err) {
        console.error('Check failed:', err.message);
    }
}

startTracker(config, checkTorrents);
