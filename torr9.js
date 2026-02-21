import {XMLParser} from 'fast-xml-parser';
import {loadCommonConfig, createHistory, downloadTorrent, sendDiscordNotification, startTracker} from './common.js';

const TORR9_PASSKEY = process.env.TORR9_PASSKEY;

if (!TORR9_PASSKEY) {
  console.error('TORR9_PASSKEY is required');
  process.exit(1);
}

const config = loadCommonConfig();
const history = createHistory(config.historyTtlHours);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'item' || name === 'torznab:attr',
});

async function checkTorrents() {
  try {
    const url = `https://api.torr9.xyz/api/v1/torznab?apikey=${TORR9_PASSKEY}&t=search&q=&limit=3`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`API error: HTTP ${response.status}`);
    }

    const xml = await response.text();
    const parsed = xmlParser.parse(xml);
    const items = parsed?.rss?.channel?.item ?? [];

    const newTorrents = items
        .map(item => {
          const attrs = item['torznab:attr'] ?? [];
          const uid = attrs.find(a => a['@_name'] === 'infohash')?.['@_value']?.toLowerCase() ?? '';
          return {uid, name: item.title, downloadUrl: item.link, size: Number(item.size ?? 0)};
        })
        .filter(t => t.uid && !history.has(t.uid) && t.size <= config.maxSizeBytes);

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
