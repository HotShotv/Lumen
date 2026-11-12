// Lumen: an ambient desktop wallpaper that is also a music player.
// One frameless window pinned to the desktop, a tray icon, and two sources of music:
//   - a player running hidden as the engine and linked over a local connection (full
//     player: queue, search, song picking, likes), or
//   - whatever Windows reports as playing (play, pause, skip, seek only).

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  net,
  screen,
  session,
  desktopCapturer,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { attachToDesktop } = require("./attach");
const { NowPlaying } = require("./nowplaying");
const { fetchSyncedLyrics } = require("./lyrics");
const { EngineBridge, ORIGIN } = require("./bridge");
const { Engine, engineConfig } = require("./engine");

const ENGINE_CONFIG = engineConfig();
const HISTORY_SIZE = 9;
// how soon after the link drops Lumen checks that its engine is still there, and how
// often it looks again while there is none
const ENGINE_RECHECK_MS = 4000;
const ENGINE_WATCH_MS = 20000;
const ENGINE_APP_ID = ENGINE_CONFIG.appId;
// covers come from other sites; only these hosts are fetched (engine.config.json)
const COVER_HOSTS = new RegExp(
  `(^|\\.)(${ENGINE_CONFIG.coverHosts
    .map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})$`,
);
const MAX_COVER_BYTES = 4 * 1024 * 1024;
const DEFAULT_SETTINGS = {
  edgeLight: true,
  thickness: 100,
  lyrics: false,
  playerBar: true,
  recentList: true,
  /** above the desktop icons, so the wallpaper can be clicked; false pins it behind them */
  interactive: true,
  /** how much the backdrop is darkened (percent) and blurred (px) */
  dim: 30,
  blur: 30,
  /** show the song's music video as the background when it has one */
  musicVideo: true,
  /**
   * https address of the public page that holds YouTube's player (see player-page/);
   * null frames YouTube directly, which label videos refuse under a local address.
   * Set in settings.json; the wallpaper page cannot change it.
   */
  playerPage: null,
  /** every background that has been chosen, so they are quick to switch between */
  wallpapers: [],
  /** start the engine hidden with Lumen and use it as the music player */
  startEngine: false,
  /** absolute path of an image or video; null uses the cover art, blurred */
  wallpaperPath: null,
  /** the player bar stands upright on the right, and which of its parts are switched off */
  barVertical: false,
  barHidden: [],
  /** the equalizer widget (needs a linked player) */
  equalizer: false,
  /** where each part sits: { name: { x, y, s } }, x and y as fractions of the screen */
  layout: {},
};
const MAX_VAULT = 60;
const MEDIA_FILTERS = [
  { name: "Images and videos", extensions: ["mp4", "webm", "png", "jpg", "jpeg", "webp", "gif"] },
];

let settings = { ...DEFAULT_SETTINGS };
/** @type {BrowserWindow | null} */
let window = null;
/** @type {Tray | null} */
let tray = null;
/** @type {NowPlaying | null} */
let nowPlaying = null;
const bridge = new EngineBridge();
const engine = new Engine();

/** what the page shows right now */
let current = { active: false };
/** the last thing Windows reported, kept so it can take over when the engine unlinks */
let windowsState = { active: false };
/** true once a linked engine has reported its state */
let engineLive = false;
/** @type {{ key: string, title: string, artist: string, cover: string | null }[]} */
let history = [];
let lyrics = { key: null, lrc: null, lines: null };
/** the engine's playlists and suggested songs, kept so a page that loads late has them */
let playlistsData = null;
let suggestionsData = null;
let eqData = null;
let videoData = null;
let searchId = 0;
let quitting = false;

const userFile = (name) => path.join(app.getPath("userData"), name);

function log(message) {
  try {
    fs.appendFileSync(userFile("lumen.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(userFile(name), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  try {
    fs.writeFileSync(userFile(name), JSON.stringify(value));
  } catch (error) {
    log(`could not save ${name}: ${error.message}`);
  }
}

function send(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

// ---- settings ----

// what the page needs to know about settings: the wallpaper as a url it can load
/** true when the page is served by Lumen's own server (false: opened as a file) */
let servedLocally = false;
// a background file as a url the page can load, whichever way the page was opened
const mediaUrl = (file) =>
  servedLocally ? `${ORIGIN}/media?f=${encodeURIComponent(file)}` : pathToFileURL(file).href;

function publicSettings() {
  const wallpaperExists = settings.wallpaperPath && fs.existsSync(settings.wallpaperPath);
  return {
    ...settings,
    wallpaperUrl: wallpaperExists ? mediaUrl(settings.wallpaperPath) : null,
    // the music video needs the page to be a served one: YouTube's player refuses files
    canShowVideo: servedLocally,
    playerPage: /^https:\/\/[^\s"'<>]+$/.test(settings.playerPage || "") ? settings.playerPage : null,
    wallpaperIsVideo: wallpaperExists && /\.(mp4|webm)$/i.test(settings.wallpaperPath),
    // the vault: saved backgrounds that still exist on disk
    vault: (settings.wallpapers || [])
      .filter((file) => typeof file === "string" && fs.existsSync(file))
      .map((file) => ({
        path: file,
        url: mediaUrl(file),
        isVideo: /\.(mp4|webm)$/i.test(file),
        name: path.basename(file),
      })),
  };
}

function updateSettings(patch) {
  settings = { ...settings, ...patch };
  writeJson("settings.json", settings);
  send("settings", publicSettings());
  refreshTray();
  if ("lyrics" in patch) void loadLyrics();
  if ("interactive" in patch) void reattach();
  if (patch.startEngine) void keepEngine();
}

// what the wallpaper page is allowed to change, and the shape each value must have
const LAYOUT_PARTS = ["clock", "recent", "fan", "dots", "bar", "nowbar", "equalizer", "lyricsLeft", "lyrics"];
const validLayout = (value) =>
  value !== null &&
  typeof value === "object" &&
  Object.entries(value).every(
    ([name, spot]) =>
      LAYOUT_PARTS.includes(name) &&
      spot &&
      Number.isFinite(spot.x) &&
      Math.abs(spot.x) <= 1.5 &&
      Number.isFinite(spot.y) &&
      Math.abs(spot.y) <= 1.5 &&
      Number.isFinite(spot.s) &&
      spot.s >= 0.25 &&
      spot.s <= 4,
  );

const BAR_PARTS = ["previous","toggle","next","cover","info","time","like","shuffle","repeat","volume","search","lyrics"];

const SETTING_RULES = {
  barVertical: (v) => typeof v === "boolean",
  equalizer: (v) => typeof v === "boolean",
  barHidden: (v) => Array.isArray(v) && v.length <= BAR_PARTS.length && v.every((name) => BAR_PARTS.includes(name)),
  layout: validLayout,
  edgeLight: (v) => typeof v === "boolean",
  lyrics: (v) => typeof v === "boolean",
  recentList: (v) => typeof v === "boolean",
  interactive: (v) => typeof v === "boolean",
  thickness: (v) => Number.isFinite(v) && v >= 40 && v <= 200,
  dim: (v) => Number.isFinite(v) && v >= 0 && v <= 85,
  blur: (v) => Number.isFinite(v) && v >= 0 && v <= 100,
  musicVideo: (v) => typeof v === "boolean",
};

async function chooseWallpaper() {
  const picked = await dialog.showOpenDialog({
    title: "Choose images or videos",
    properties: ["openFile", "multiSelections"],
    filters: MEDIA_FILTERS,
  });
  if (!picked.canceled && picked.filePaths[0]) {
    // everything picked goes into the vault; the first one becomes the background
    const wallpapers = [...new Set([...(settings.wallpapers || []), ...picked.filePaths])].slice(-MAX_VAULT);
    updateSettings({ wallpaperPath: picked.filePaths[0], wallpapers });
  }
}

// ---- state ----

function publishState() {
  send("state", { ...current, history });
  refreshTray();
}

async function loadLyrics() {
  // a linked engine sends its own lyrics, timed word by word
  if (engineLive) return;
  if (!settings.lyrics || !current.active) {
    lyrics = { key: null, lrc: null, lines: null };
    send("lyrics", lyrics);
    return;
  }
  const { key, title, artist, durationMs } = current;
  if (lyrics.key === key) return;
  lyrics = { key, lrc: null, lines: null };
  send("lyrics", lyrics);
  const lrc = await fetchSyncedLyrics({ key, title, artist, durationMs });
  // the track, or the source, may have changed while the request was out
  if (current.key !== key || engineLive) return;
  lyrics = { key, lrc, lines: null };
  send("lyrics", lyrics);
}

function rememberTrack(track) {
  history = [
    { key: track.key, title: track.title, artist: track.artist, cover: track.cover ?? null },
    ...history.filter((item) => item.key !== track.key),
  ].slice(0, HISTORY_SIZE);
  writeJson("history.json", history);
}

function showWindowsState() {
  const previousKey = current.active ? current.key : null;
  current = windowsState;
  publishState();
  if (current.active && current.key !== previousKey) void loadLyrics();
}

function onWindowsState(state) {
  if (!state.active) {
    windowsState = { active: false };
  } else {
    const sameTrack = windowsState.active && windowsState.key === state.key;
    // the helper only sends the cover when it changes
    const cover = state.cover ?? (sameTrack ? windowsState.cover : null) ?? null;
    windowsState = { ...state, cover };
    if (!engineLive && (!sameTrack || state.cover)) rememberTrack(windowsState);
  }
  if (!engineLive) showWindowsState();
}

// ---- the engine ----

const toPageTrack = (track) => ({
  key: track.id,
  title: track.title,
  artist: track.artists,
  cover: track.coverUrl || null,
  durationMs: track.durationMs,
});

function onEngineMessage(message) {
  if (message.kind === "state") {
    engineLive = true;
    const track = message.track;
    current = track
      ? {
          active: true,
          engine: true,
          app: ENGINE_APP_ID,
          key: track.id,
          title: track.title,
          artist: track.artists,
          album: track.album || "",
          cover: track.coverUrl || null,
          playing: Boolean(message.playing),
          positionMs: message.positionMs || 0,
          positionAt: message.positionAt || Date.now(),
          durationMs: message.durationMs || track.durationMs || 0,
          queue: (message.queue || []).map(toPageTrack),
          queueOffset: message.queueOffset || 0,
          queueIndex: message.currentIndex ?? -1,
          queueLength: message.queueLength || 0,
          repeat: message.repeat || "off",
          shuffle: Boolean(message.shuffle),
          volume: Number.isFinite(message.volume) ? message.volume : 1,
          liked: Boolean(message.liked),
          canLike: Boolean(message.canLike),
        }
      : { active: false, engine: true, app: ENGINE_APP_ID };
    publishState();
  } else if (message.kind === "lyrics") {
    lyrics = { key: message.trackId ?? null, lrc: null, lines: message.lines || [] };
    send("lyrics", lyrics);
  } else if (message.kind === "hide") {
    // the player's close button, pressed while linked: keep it running, out of sight.
    // Lumen now owns it, so it also closes it when Lumen quits.
    engine.startedHere = true;
    void engine.hide();
  } else if (message.kind === "playlists") {
    playlistsData = {
      error: message.error || null,
      items: (message.items || []).map((item) => ({
        id: String(item.id),
        title: String(item.title || "Untitled"),
        trackCount: Number.isFinite(item.trackCount) ? item.trackCount : null,
        cover: item.coverUrl || null,
      })),
    };
    send("playlists", playlistsData);
  } else if (message.kind === "suggestions") {
    suggestionsData = { forId: message.forId ?? null, tracks: (message.tracks || []).map(toPageTrack) };
    send("suggestions", suggestionsData);
  } else if (message.kind === "playlistTracks") {
    send("playlistTracks", {
      id: String(message.id),
      title: String(message.title || "Playlist"),
      tracks: (message.tracks || []).map(toPageTrack),
    });
  } else if (message.kind === "eq") {
    const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
    const bands = (Array.isArray(message.bands) ? message.bands : []).slice(0, 10).map((hz) => num(hz));
    const gains = (list) => (Array.isArray(list) ? list : []).slice(0, 10).map((gain) => num(gain));
    const text = (value, max = 60) => String(value ?? "").slice(0, max);
    const labels = message.labels && typeof message.labels === "object" ? message.labels : {};
    eqData = {
      enabled: message.enabled === true,
      gains: gains(message.gains),
      bands,
      min: num(message.min, -12),
      max: num(message.max, 12),
      maxCustom: num(message.maxCustom, 12),
      presets: (Array.isArray(message.presets) ? message.presets : []).slice(0, 60).map((preset) => ({
        id: text(preset.id, 40),
        category: ["enhance", "genre", "accent"].includes(preset.category) ? preset.category : "enhance",
        name: text(preset.name),
        gains: gains(preset.gains),
      })),
      custom: (Array.isArray(message.custom) ? message.custom : []).slice(0, 20).map((preset) => ({
        id: text(preset.id, 80),
        name: text(preset.name, 40),
        gains: gains(preset.gains),
      })),
      labels: Object.fromEntries(Object.entries(labels).slice(0, 20).map(([key, value]) => [key, text(value, 120)])),
    };
    send("eq", eqData);
  } else if (message.kind === "video") {
    const videoIds = (Array.isArray(message.videoIds) ? message.videoIds : [])
      .filter((id) => typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id))
      .slice(0, 5);
    videoData = { key: message.trackId ?? null, videoIds };
    send("video", videoData);
  } else if (message.kind === "notice") {
    send("notice", { text: String(message.text || "").slice(0, 200) });
  } else if (message.kind === "import") {
    log(`import: ${message.status}${message.error ? ` (${message.error})` : ""}`);
    send("import", {
      status: message.status,
      title: message.title || "",
      total: message.total || 0,
      imported: message.imported || 0,
      skipped: message.skipped || 0,
      error: message.error || null,
    });
  } else if (message.kind === "search") {
    send("search", {
      id: message.id,
      query: message.query,
      error: message.error || null,
      tracks: (message.tracks || []).map(toPageTrack),
    });
  }
}

function onEngineLink(linked) {
  log(`engine link: ${linked ? "connected" : "lost"}`);
  if (linked) return; // its first state message switches the page over
  engineLive = false;
  suggestionsData = null;
  send("suggestions", null);
  videoData = null;
  send("video", null);
  eqData = null;
  send("eq", null);
  lyrics = { key: null, lrc: null, lines: null };
  send("lyrics", lyrics);
  showWindowsState();
  // the engine was closed or crashed: bring it back without anyone opening it
  setTimeout(() => void keepEngine(), ENGINE_RECHECK_MS);
}

let engineStarting = false;
async function keepEngine() {
  if (quitting || engineStarting || bridge.linked || !settings.startEngine) return;
  engineStarting = true;
  try {
    await startEngine();
  } finally {
    engineStarting = false;
  }
}

async function startEngine() {
  if (!settings.startEngine) return;
  log(`engine: ${await engine.ensureRunningHidden()}`);
  refreshTray();
}

/** One place for every player command, whichever source is live. */
function playerCommand(name, argument) {
  if (engineLive && bridge.linked) {
    if (["toggle", "next", "previous", "repeat", "shuffle", "like"].includes(name)) {
      bridge.send({ cmd: name });
    } else if (name === "seek" && Number.isFinite(argument) && argument >= 0) {
      bridge.send({ cmd: "seek", ms: Math.round(argument) });
    } else if (name === "pick" && Number.isInteger(argument) && argument >= 0) {
      bridge.send({ cmd: "pick", index: argument });
    } else if (name === "volume" && Number.isFinite(argument)) {
      bridge.send({ cmd: "volume", level: Math.min(1, Math.max(0, argument)) });
    }
    return;
  }
  if (["play", "pause", "toggle", "next", "previous"].includes(name)) nowPlaying?.send(name);
  else if (name === "seek" && Number.isFinite(argument) && argument >= 0) {
    nowPlaying?.send("seek", argument);
  }
}

// covers come from other sites; the page needs their pixels to pick the light's colour,
// which a plain <img> from another origin does not allow
async function coverData(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !COVER_HOSTS.test(parsed.hostname)) return null;
    const response = await net.fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return null;
    const type = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    if (!type.startsWith("image/")) return null;
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function registerPageActions() {
  ipcMain.on("lumen:command", (_event, name, argument) => playerCommand(name, argument));
  ipcMain.on("lumen:update-settings", (_event, patch) => {
    if (!patch || typeof patch !== "object") return;
    const accepted = {};
    for (const [key, value] of Object.entries(patch)) {
      if (SETTING_RULES[key]?.(value)) accepted[key] = value;
    }
    if (Object.keys(accepted).length > 0) updateSettings(accepted);
  });
  ipcMain.on("lumen:choose-wallpaper", () => void chooseWallpaper());
  ipcMain.on("lumen:clear-wallpaper", () => updateSettings({ wallpaperPath: null }));
  // the page may only switch to, or forget, a background that is already in the vault
  ipcMain.on("lumen:use-wallpaper", (_event, file) => {
    if ((settings.wallpapers || []).includes(file)) updateSettings({ wallpaperPath: file });
  });
  ipcMain.on("lumen:forget-wallpaper", (_event, file) => {
    if (!(settings.wallpapers || []).includes(file)) return;
    updateSettings({
      wallpapers: settings.wallpapers.filter((item) => item !== file),
      ...(settings.wallpaperPath === file ? { wallpaperPath: null } : {}),
    });
  });
  ipcMain.on("lumen:quit", () => app.quit());

  ipcMain.handle("lumen:search", (_event, query) => {
    if (typeof query !== "string" || query.length > 200) return null;
    if (!(engineLive && bridge.linked)) return null;
    searchId += 1;
    bridge.send({ cmd: "search", id: searchId, query });
    return searchId;
  });
  ipcMain.on("lumen:play-result", (_event, id, index) => {
    if (Number.isInteger(id) && Number.isInteger(index) && index >= 0) {
      bridge.send({ cmd: "playResult", id, index });
    }
  });
  // the engine's playlists, and its importer for a playlist link
  ipcMain.handle("lumen:playlists", () =>
    engineLive && bridge.linked ? bridge.send({ cmd: "playlists" }) : false,
  );
  const validId = (id) => typeof id === "string" && id.length > 0 && id.length < 200;
  ipcMain.on("lumen:play-playlist", (_event, id, shuffle) => {
    if (validId(id)) bridge.send({ cmd: "playPlaylist", id, shuffle: shuffle === true });
  });
  ipcMain.on("lumen:open-playlist", (_event, id) => {
    if (validId(id)) bridge.send({ cmd: "openPlaylist", id });
  });
  ipcMain.on("lumen:play-playlist-track", (_event, id, index) => {
    if (validId(id) && Number.isInteger(index) && index >= 0) {
      bridge.send({ cmd: "playPlaylistTrack", id, index });
    }
  });
  ipcMain.on("lumen:playlist-action", (_event, id, action, title) => {
    if (!validId(id)) return;
    if (action === "delete") bridge.send({ cmd: "deletePlaylist", id });
    else if (action === "rename" && typeof title === "string" && title.trim() && title.length <= 200) {
      bridge.send({ cmd: "renamePlaylist", id, title: title.trim() });
    }
  });
  ipcMain.on("lumen:track-action", (_event, source, index, action) => {
    if (!["queue", "suggest", "playlist"].includes(source)) return;
    if (!["play", "playNext", "addToQueue", "remove"].includes(action)) return;
    if (Number.isInteger(index) && index >= 0) bridge.send({ cmd: "trackAction", source, index, action });
  });
  ipcMain.handle("lumen:import", (_event, url) => {
    if (typeof url !== "string" || url.length > 600 || !/^https:\/\//i.test(url)) return false;
    if (!(engineLive && bridge.linked)) return false;
    return bridge.send({ cmd: "import", url });
  });
  // the equalizer: every value is checked here, since the player applies what it is told
  ipcMain.on("lumen:eq", (_event, action, value) => {
    const idOk = typeof value === "string" && value.length > 0 && value.length < 100;
    if (action === "enabled" && typeof value === "boolean") bridge.send({ cmd: "eqEnabled", on: value });
    else if (
      action === "gains" &&
      Array.isArray(value) &&
      value.length === 10 &&
      value.every((gain) => Number.isFinite(gain) && gain >= -12 && gain <= 12)
    ) {
      bridge.send({ cmd: "eqGains", gains: value });
    } else if (action === "preset" && idOk) bridge.send({ cmd: "eqPreset", id: value });
    else if (action === "save" && typeof value === "string" && value.trim() && value.length <= 24) {
      bridge.send({ cmd: "eqSave", name: value.trim() });
    } else if (action === "delete" && idOk) bridge.send({ cmd: "eqDelete", id: value });
  });

  ipcMain.handle("lumen:cover-data", (_event, url) =>
    typeof url === "string" ? coverData(url) : null,
  );

  // typing needs keyboard focus, which the wallpaper normally refuses so it never
  // steals it from the app you are using
  ipcMain.on("lumen:keyboard", (_event, wanted) => {
    if (!window || window.isDestroyed()) return;
    window.setFocusable(Boolean(wanted));
    if (wanted) window.focus();
    else window.blur();
  });
}

// ---- window ----

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // pinned to the desktop Chromium thinks the window is covered; keep it drawing
      backgroundThrottling: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => {
    window = null;
    if (!quitting) app.quit();
  });

  window.webContents.on("did-finish-load", async () => {
    if (!window || window.isDestroyed()) return;
    send("settings", publicSettings());
    publishState();
    send("lyrics", lyrics);
    window.showInactive();
    const result = await attachToDesktop(window, settings.interactive);
    log(`attach: ${result}`);
    // system-audio capture needs a "user gesture"; this call counts as one
    window?.webContents
      .executeJavaScript("window.lumenStartAudio && window.lumenStartAudio()", true)
      .then((outcome) => log(`audio: ${outcome}`))
      .catch((error) => log(`audio error: ${error.message}`));
  });

  // served from Lumen's own loopback server when it is up; as a plain file otherwise
  void bridge.ready.then((listening) => {
    if (!window || window.isDestroyed()) return;
    servedLocally = listening;
    log(`page: ${listening ? "served locally" : "opened as a file"}`);
    if (listening) void window.loadURL(`${ORIGIN}/app/index.html`);
    else void window.loadFile(path.join(__dirname, "renderer", "index.html"));
  });
}

async function reattach() {
  if (!window || window.isDestroyed()) return;
  log(`reattach: ${await attachToDesktop(window, settings.interactive)}`);
}

// ---- tray ----

function trayIcon() {
  // a small glowing ring, drawn here so the app ships no image files
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - 15.5, y - 15.5);
      const ring = Math.max(0, 1 - Math.abs(distance - 10.5) / 3.2);
      const offset = (y * size + x) * 4;
      pixels[offset] = 60; // blue
      pixels[offset + 1] = 150; // green
      pixels[offset + 2] = 255; // red
      pixels[offset + 3] = Math.round(255 * Math.min(1, ring * 1.4));
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

function refreshTray() {
  if (!tray) return;
  const playingLabel = current.active
    ? `${current.title} — ${current.artist}`.slice(0, 60)
    : "Nothing playing";
  const toggle = (label, key) => ({
    label,
    type: "checkbox",
    checked: Boolean(settings[key]),
    click: (item) => updateSettings({ [key]: item.checked }),
  });
  tray.setToolTip(`Lumen · ${playingLabel}`.slice(0, 120));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: playingLabel, enabled: false },
      {
        label: current.playing ? "Pause" : "Play",
        enabled: Boolean(current.active),
        click: () => playerCommand("toggle"),
      },
      { label: "Next", enabled: Boolean(current.active), click: () => playerCommand("next") },
      {
        label: "Previous",
        enabled: Boolean(current.active),
        click: () => playerCommand("previous"),
      },
      { type: "separator" },
      {
        label: engineLive ? "Music from the linked player" : "Music from Windows' now-playing",
        enabled: false,
      },
      toggle("Start the player hidden with Lumen", "startEngine"),
      { label: "Show the player's window", click: () => void engine.show() },
      { label: "Hide the player's window", click: () => void engine.hide() },
      { type: "separator" },
      toggle("Edge light", "edgeLight"),
      toggle("Lyrics", "lyrics"),
      toggle("Player bar", "playerBar"),
      toggle("Queue / recently played list", "recentList"),
      toggle("Equalizer", "equalizer"),
      toggle("Clickable (sits above desktop icons)", "interactive"),
      { type: "separator" },
      { label: "Choose wallpaper…", click: () => void chooseWallpaper() },
      {
        label: "Use cover art as wallpaper",
        type: "checkbox",
        checked: !settings.wallpaperPath,
        click: () => updateSettings({ wallpaperPath: null }),
      },
      { type: "separator" },
      {
        label: "Edit layout…",
        click: () => {
          if (!settings.interactive) updateSettings({ interactive: true });
          send("edit-layout");
        },
      },
      { label: "Pin to desktop again", click: () => void reattach() },
      { label: "Quit Lumen", click: () => app.quit() },
    ]),
  );
}

// ---- app ----

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    settings = { ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) };
    // a background chosen before the vault existed belongs in it
    if (settings.wallpaperPath && !(settings.wallpapers || []).includes(settings.wallpaperPath)) {
      settings.wallpapers = [...(settings.wallpapers || []), settings.wallpaperPath];
    }
    history = readJson("history.json", []);

    // the page asks to capture "the screen" only to get its audio: system sound, never the microphone
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => callback({ video: sources[0], audio: "loopback" }))
        .catch(() => callback({}));
    });

    registerPageActions();
    ipcMain.handle("lumen:initial", () => ({
      settings: publicSettings(),
      state: { ...current, history },
      lyrics,
      playlists: playlistsData,
      suggestions: suggestionsData,
      video: videoData,
      eq: eqData,
    }));

    bridge.on("message", onEngineMessage);
    bridge.on("link", onEngineLink);
    bridge.on("error", (error) => log(`bridge error: ${error.message}`));
    bridge.staticRoot = path.join(__dirname, "renderer");
    bridge.allowMedia = (file) =>
      (settings.wallpapers || []).includes(file) || file === settings.wallpaperPath;
    bridge.start();

    createWindow();
    tray = new Tray(trayIcon());
    refreshTray();

    nowPlaying = new NowPlaying(onWindowsState);
    nowPlaying.start();
    void keepEngine();
    setInterval(() => void keepEngine(), ENGINE_WATCH_MS);

    // explorer restarts and display changes drop the window off the desktop layer
    screen.on("display-metrics-changed", () => {
      if (!window || window.isDestroyed()) return;
      window.setBounds(screen.getPrimaryDisplay().bounds);
      void reattach();
    });
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    nowPlaying?.stop();
    bridge.stop();
    // a player Lumen started hidden would otherwise keep playing with no window
    if (engine.startedHere) {
      event.preventDefault();
      engine.closeIfStartedHere().finally(() => app.quit());
    }
  });
  app.on("window-all-closed", () => app.quit());
}
