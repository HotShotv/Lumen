// Synced lyrics from LRCLIB (https://lrclib.net), a free public lyrics database.
// Only the track title, artist and length are sent.

const { net } = require("electron");

const API = "https://lrclib.net/api";
const HEADERS = { "User-Agent": "Lumen/0.1 (desktop wallpaper)" };
const TIMEOUT_MS = 8000;
const MAX_CACHE = 60;

/** @type {Map<string, string | null>} track key -> LRC text, or null when none exists */
const cache = new Map();

async function getJson(url) {
  const response = await net.fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`lrclib ${response.status}`);
  return response.json();
}

// players often decorate titles: "Song (Slowed)", "Song - Remastered 2011"
function plainTitle(title) {
  return title
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, " ")
    .replace(/\s+-\s+.*$/, "")
    .trim();
}

/**
 * @param {{ key: string, title: string, artist: string, durationMs: number }} track
 * @returns {Promise<string | null>} LRC text with timestamps, or null
 */
async function fetchSyncedLyrics(track) {
  if (cache.has(track.key)) return cache.get(track.key);

  let lrc = null;
  try {
    const exact = new URLSearchParams({ track_name: track.title, artist_name: track.artist });
    if (track.durationMs > 0) exact.set("duration", String(Math.round(track.durationMs / 1000)));
    const hit = await getJson(`${API}/get?${exact}`);
    lrc = hit?.syncedLyrics ?? null;

    if (!lrc) {
      const loose = new URLSearchParams({
        track_name: plainTitle(track.title) || track.title,
        artist_name: track.artist,
      });
      const results = (await getJson(`${API}/search?${loose}`)) ?? [];
      lrc = results.find((item) => item.syncedLyrics)?.syncedLyrics ?? null;
    }
  } catch {
    // offline or the service is down: no lyrics this time, and try again next play
    return null;
  }

  cache.set(track.key, lrc);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return lrc;
}

module.exports = { fetchSyncedLyrics };
