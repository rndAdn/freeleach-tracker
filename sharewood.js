import {loadCommonConfig, createHistory, downloadTorrent, sendDiscordNotification, startTracker} from './common.js';

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('API_KEY is required');
  process.exit(1);
}

const config = loadCommonConfig();
const history = createHistory(config.historyTtlHours);

async function checkTorrents() {
  try {
    const url = `https://www.sharewood.tv/api/${API_KEY}/last-torrents?free=1&limit=3`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`API error: HTTP ${response.status}`);
    }

    const data = await response.json();
    const newTorrents = data
        .filter(t => !t.is_downloaded && !history.has(t.id) && t.size <= config.maxSizeBytes)
        .map(t => ({uid: t.id, name: t.name, downloadUrl: t.download_url, size: t.size}));

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
