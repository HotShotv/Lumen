// The only bridge between the wallpaper page and the main process: events in, and a
// short list of named actions out. main.js validates every action.

const { contextBridge, ipcRenderer } = require("electron");

const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("lumen", {
  initial: () => ipcRenderer.invoke("lumen:initial"),
  onState: subscribe("state"),
  onSettings: subscribe("settings"),
  onLyrics: subscribe("lyrics"),
  /** play | pause | toggle | next | previous | seek (with milliseconds) */
  command: (name, argument) => ipcRenderer.send("lumen:command", name, argument),
  updateSettings: (patch) => ipcRenderer.send("lumen:update-settings", patch),
  chooseWallpaper: () => ipcRenderer.send("lumen:choose-wallpaper"),
  clearWallpaper: () => ipcRenderer.send("lumen:clear-wallpaper"),

  quit: () => ipcRenderer.send("lumen:quit"),
  /** engine only: asks the linked player to search; resolves to a request id, results arrive via onSearch */
  search: (query) => ipcRenderer.invoke("lumen:search", query),
  onSearch: subscribe("search"),
  playResult: (id, index) => ipcRenderer.send("lumen:play-result", id, index),
  /** engine only: the player's playlists (arrive via onPlaylists), playing one, importing a link */
  playlists: () => ipcRenderer.invoke("lumen:playlists"),
  onPlaylists: subscribe("playlists"),
  playPlaylist: (id, shuffle) => ipcRenderer.send("lumen:play-playlist", id, shuffle === true),
  openPlaylist: (id) => ipcRenderer.send("lumen:open-playlist", id),
  onPlaylistTracks: subscribe("playlistTracks"),
  playPlaylistTrack: (id, index) => ipcRenderer.send("lumen:play-playlist-track", id, index),
  /** action: "delete" or "rename" (with the new title) */
  playlistAction: (id, action, title) => ipcRenderer.send("lumen:playlist-action", id, action, title),
  /** source: queue | suggest | playlist; action: play | playNext | addToQueue | remove */
  trackAction: (source, index, action) => ipcRenderer.send("lumen:track-action", source, index, action),
  onSuggestions: subscribe("suggestions"),
  onNotice: subscribe("notice"),
  /** the equalizer: state and presets from the player (onEq), and changes sent back */
  onEq: subscribe("eq"),
  eq: (action, value) => ipcRenderer.send("lumen:eq", action, value),
  /** the playing song's music video: { key, videoId } */
  onVideo: subscribe("video"),
  /** the vault of saved backgrounds */
  useWallpaper: (file) => ipcRenderer.send("lumen:use-wallpaper", file),
  forgetWallpaper: (file) => ipcRenderer.send("lumen:forget-wallpaper", file),
  /** the tray menu asked to open the layout editor */
  onEditLayout: subscribe("edit-layout"),
  importPlaylist: (url) => ipcRenderer.invoke("lumen:import", url),
  onImport: subscribe("import"),
  /** a remote cover as a data url, so its colours can be read */
  coverData: (url) => ipcRenderer.invoke("lumen:cover-data", url),
  /** lets the wallpaper take keyboard focus while a text box is in use */
  keyboard: (wanted) => ipcRenderer.send("lumen:keyboard", wanted),
});
