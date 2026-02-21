import {writeFile, mkdir} from 'fs/promises';
import {existsSync} from 'fs';

export function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${bytes.toFixed(2)} ${units[i]}`;
}

export function createHistory(ttlHours) {
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
            if (cleaned > 0) {
                console.log(`Cleaned ${cleaned} old entries from history`);
            }
        },
        get size() {
            return map.size;
        }
    };
}

export async function sendDiscordNotification(webhook, torrent, {trackerName, color}) {
    if (!webhook) return;
    try {
        await fetch(webhook, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                embeds: [{
                    title: trackerName,
                    description: torrent.name,
                    color,
                    fields: [
                        {name: 'Taille', value: formatSize(torrent.size), inline: true}
                    ],
                    timestamp: new Date().toISOString()
                }]
            })
        });
    } catch (err) {
        console.error('Discord notification failed:', err.message);
    }
}

export async function downloadTorrent(torrent, downloadDir) {
    const filePath = `${downloadDir}/${torrent.uid}.torrent`;
    try {
        const response = await fetch(torrent.downloadUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        await writeFile(filePath, buffer);
        console.log(`Downloaded: ${torrent.name}`);
        return true;
    } catch (err) {
        console.error(`Failed to download ${torrent.name}:`, err.message);
        return false;
    }
}

export function loadCommonConfig() {
    const historyTtlHours = parseInt(process.env.HISTORY_TTL_HOURS || '24', 10);
    const maxSizeGb = parseInt(process.env.MAX_SIZE_GB || '250', 10);
    return {
        discordWebhook: process.env.DISCORD_WEBHOOK,
        downloadDir: process.env.DOWNLOAD_DIR || '/downloads',
        interval: parseInt(process.env.INTERVAL || '10', 10) * 1000,
        historyTtlHours,
        maxSizeGb,
        trackerName: process.env.TRACKER_NAME,
        discordColor: parseInt(process.env.DISCORD_COLOR || '5763719', 10),
        historyTtl: historyTtlHours * 60 * 60 * 1000,
        maxSizeBytes: maxSizeGb * 1024 * 1024 * 1024,
    };
}

export async function startTracker(config, checkFn) {
    if (!existsSync(config.downloadDir)) {
        await mkdir(config.downloadDir, {recursive: true});
    }
    console.log(`${config.trackerName} Downloader started`);
    console.log(`Checking every ${config.interval / 1000}s`);
    console.log(`History TTL: ${config.historyTtlHours}h`);
    console.log(`Max torrent size: ${config.maxSizeGb} GB`);
    await checkFn();
    setInterval(checkFn, config.interval);
}
