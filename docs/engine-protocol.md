# Engine protocol

Lumen drives an external music player, if one is configured, through a loopback-only
HTTP server. This document is the contract: what the player sends, what it receives,
and what Lumen does when the link drops.

Nothing here is reachable from the network. The listener binds `127.0.0.1:38917`.

## Transport

```
GET  /to-engine      text/event-stream, long lived, commands flowing out
POST /from-engine    application/json, one message per request, state flowing in
GET  /app/*          Lumen's own page (served instead of file:// when the port is up)
GET  /media?f=<path> a background file that is in the vault
```

CORS is `*`, but every request is checked first: only a missing `Origin`, `Origin:
null`, or a `file://` origin is accepted. A browser page sending its own `https://`
origin gets `403`. This is what stops a website from commandeering the player.

Requests are bounded at 2 MB. A body over the limit is dropped, not parsed.

## Commands, Lumen -> player

Each frame on `/to-engine` is one JSON object on a `data:` line:

```
data: {"cmd":"toggle"}

```

| command | payload | meaning |
| --- | --- | --- |
| `toggle` | - | play/pause |
| `next` | - | next track |
| `previous` | - | previous track |
| `seek` | `ms` (integer) | absolute position |
| `volume` | `level` (0..1) | set output level |
| `like` | - | toggle like on the current track |
| `shuffle` | - | toggle shuffle |
| `repeat` | - | cycle repeat mode |
| `pick` | `index` (integer) | play queue entry at index |
| `search` | `id`, `query` | search; reply with the same `id` |
| `playResult` | `id`, `index` | play result `index` from search `id` |
| `playlists` | - | ask for the playlist list |
| `openPlaylist` | `id` | ask for a playlist's tracks |
| `playPlaylist` | `id`, `shuffle` | play a playlist |
| `playPlaylistTrack` | `id`, `index` | play one entry |
| `deletePlaylist` | `id` | delete |
| `renamePlaylist` | `id`, `title` | rename |
| `trackAction` | `source`, `index`, `action` | `source`: `queue` \| `suggest` \| `playlist`; `action`: `play` \| `playNext` \| `addToQueue` \| `remove` |
| `import` | `url` | import a public playlist link |

The player ignores commands it does not implement. Lumen sends `pick` only when it has
a queue, and `search` only when the link is up.

## Messages, player -> Lumen

`POST /from-engine` with a JSON body whose `kind` names the message.

### `state` (required, the one that matters)

Sent whenever the track, position, queue or transport changes. The first one received
switches the page from the fallback to the engine.

```json
{
  "kind": "state",
  "playing": true,
  "positionMs": 116000,
  "positionAt": 1762900000000,
  "durationMs": 219000,
  "repeat": "off",
  "shuffle": false,
  "volume": 0.8,
  "liked": false,
  "canLike": true,
  "queue": [
    { "id": "abc", "title": "Track", "artists": "Artist", "album": "Album",
      "coverUrl": "https://...", "durationMs": 219000 }
  ],
  "queueOffset": 0,
  "queueIndex": 0,
  "queueLength": 74,
  "currentIndex": 0,
  "track": { "id": "abc", "title": "Track", "artists": "Artist", "album": "Album",
             "coverUrl": "https://...", "durationMs": 219000 }
}
```

`positionAt` is when the position was measured, as Unix milliseconds. Lumen runs it
forward from there while `playing` is true, so the bar stays smooth without the player
having to post continuously.

`queue` may be a window into a longer list; `queueOffset` says where the window starts,
`queueLength` how long the real list is.

An empty `track` (`"track": null`) means nothing is loaded: the page shows its idle
state while staying on the engine.

### `lyrics`

```json
{ "kind": "lyrics", "trackId": "abc", "lines": [ /* see below */ ] }
```

Each line, as Lumen expects it:

```json
{
  "text": "the whole line",
  "startMs": 10120,
  "endMs": 12900,
  "words": [ { "text": "the", "startMs": 10120, "endMs": 10330 } ]
}
```

`words` is optional. With it, the line fills in word by word; without it, the line
lights up whole at `startMs`.

### `playlists`

```json
{ "kind": "playlists", "error": null,
  "items": [ { "id": "p1", "title": "Drift", "trackCount": 74, "coverUrl": null } ] }
```

### `playlistTracks`

```json
{ "kind": "playlistTracks", "id": "p1", "title": "Drift",
  "tracks": [ /* track objects as above */ ] }
```

### `suggestions`

```json
{ "kind": "suggestions", "forId": "abc", "tracks": [ /* track objects */ ] }
```

`forId` must match the playing track, or Lumen discards the set.

### `search`

```json
{ "kind": "search", "id": 3, "query": "resonance", "error": null,
  "tracks": [ /* track objects */ ] }
```

`id` is the one Lumen sent with the `search` command. Results for an older id are
ignored.

### `video`

```json
{ "kind": "video", "trackId": "abc", "videoIds": ["dQw4w9WgXcQ"] }
```

Up to five candidate video ids, best first. Lumen tries them in order and falls back
to the still backdrop when all of them refuse to play.

### `import`

```json
{ "kind": "import", "status": "completed", "title": "Playlist", "total": 40,
  "imported": 37, "skipped": 3, "error": null }
```

`status`: `reading` \| `matching` \| `finalizing` \| `completed` \| `failed`.

### `hide`

```json
{ "kind": "hide" }
```

Sent when the user presses the player's own close button while it is linked. Lumen
hides the window instead of letting the app quit, and takes ownership: it will close
the process on quit.

### `notice`

```json
{ "kind": "notice", "text": "something happened" }
```

Shown briefly in the page. Text is clipped to 200 characters.

## Lifecycle

```
Lumen starts
  |-- port free?  yes -> page served from /app/, video backdrop available
  |                no  -> page opened from disk, video backdrop unavailable
  |-- engine.config.json has an exe? -> start it, then hide its window
  |-- wait for GET /to-engine
        |-- connected -> engine mode: full queue, search, playlists
        |-- dropped   -> fall back to Windows now-playing, retry every 4s
```

While the link is up, Lumen re-checks every 20 s that the player is still running and
restarts it if it vanished. A player that Lumen started is closed when Lumen quits. A
player the user started is left alone.

## Writing an adapter

An adapter is a page (or a small process) inside the player that:

1. opens `EventSource("http://127.0.0.1:38917/to-engine")` and applies each command,
2. posts `state` on every change, `positionAt` included,
3. posts `lyrics` when it has word timings, and anything else it supports.

An adapter written as a page inside an Electron or Chromium app satisfies the origin
check, because that page's origin is `file://` or `null`.
