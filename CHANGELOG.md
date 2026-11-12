# Changelog

## 1.0.0 — 2026-11-12

First release.

**Wallpaper**

- One frameless window pinned to the desktop layer, drawn by Electron.
- Backdrop from any image or video, or the playing track's cover art.
- Separate dim and blur controls; both apply to the cover-art backdrop too.
- A vault of up to 60 saved backgrounds, switchable from the settings panel.

**Player**

- Player bar, horizontal or upright on the right.
- Every part of the bar can be switched off: previous, play, next, cover, title and
  seek, time, like, shuffle, repeat, volume, search, lyrics.
- Cover fan with wheel, drag and click, drifting back to the playing track when idle.
- Queue, playlists and suggestions in the left list.
- Layout editor: move and resize clock, list, fan, dots, bar and lyric parts; saved to
  settings.

**Look**

- Edge light around the screen, coloured from the cover and driven by system audio
  loopback. The microphone is never touched.
- Palette extraction into three tones shared by the light, the glow and the pulse.
- Word-by-word lyrics when the linked player supplies timings, line-by-line from LRCLIB
  otherwise.

**Sources**

- Linked player over a loopback protocol: queue, search, picking, playlists,
  suggestions, likes, volume, word-timed lyrics.
- Windows now-playing fallback: one track, play, pause, skip, seek.
- The linked player is configured through `engine.config.json`, not compiled in.

**Platform**

- Tray icon with the full settings surface and a pin-to-desktop reset.
- Single instance, restart of the engine if it disappears, ordered teardown on quit.
- Primary monitor only. Clickable mode sits above desktop icons; pinned mode is display
  only, because Windows does not deliver clicks to that layer.
