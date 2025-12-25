import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

const API_KEY = process.env.API_KEY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/downloads';
const INTERVAL = parseInt(process.env.INTERVAL || '10', 10) * 1000;

if (!API_KEY) {
  console.error('API_KEY is required');
  process.exit(1);
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(2)} ${units[i]}`;
}

async function sendDiscordNotification(torrent) {
  if (!DISCORD_WEBHOOK) return;

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: 'Nouveau torrent',
          description: torrent.name,
          color: 5763719,
          fields: [
            { name: 'Type', value: torrent.type || 'N/A', inline: true },
            { name: 'Taille', value: formatSize(torrent.size), inline: true }
          ],
          timestamp: new Date().toISOString()
        }]
      })
    });
  } catch (err) {
    console.error('Discord notification failed:', err.message);
  }
}

async function downloadTorrent(torrent) {
  const filePath = `${DOWNLOAD_DIR}/${torrent.id}.torrent`;

  try {
    const response = await fetch(torrent.download_url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(filePath, buffer);

    console.log(`Downloaded: ${torrent.name}`);
    await sendDiscordNotification(torrent);
    return true;
  } catch (err) {
    console.error(`Failed to download ${torrent.name}:`, err.message);
    return false;
  }
}

async function checkTorrents() {
  try {
    const url = `https://www.sharewood.tv/api/${API_KEY}/last-torrents?free=1&limit=3`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`API error: HTTP ${response.status}`);
    }

    const torrents = await response.json();
    const newTorrents = torrents.filter(t => t.is_downloaded);

    if (newTorrents.length === 0) {
      console.log(`[${new Date().toISOString()}] No new torrents`);
      return;
    }

    console.log(`[${new Date().toISOString()}] Found ${newTorrents.length} new torrent(s)`);

    for (const torrent of newTorrents) {
      await downloadTorrent(torrent);
    }
  } catch (err) {
    console.error('Check failed:', err.message);
  }
}

async function main() {
  if (!existsSync(DOWNLOAD_DIR)) {
    await mkdir(DOWNLOAD_DIR, { recursive: true });
  }

  console.log('Sharewood Freeleech Downloader started');
  console.log(`Checking every ${INTERVAL / 1000}s`);

  await checkTorrents();
  setInterval(checkTorrents, INTERVAL);
}

main();
