// Ties the scene together: listens for the player state, settings, lyrics and search
// results from the main process, keeps the clock, covers, list, player bar and edge
// light in step, and sends clicks on the controls back.
//
// Two kinds of state arrive. With a player linked as the engine (state.engine) there is a
// real queue, and songs can be picked, searched and liked. Otherwise the state is what
// Windows reports for some other player: one track, and play/pause/skip/seek only.
(() => {
  const $ = (id) => document.getElementById(id);
  const MAX_ROWS = 8;
  const MAX_DOTS = 8;
  const SPREAD = 2; // covers on each side of the playing one
  const SEARCH_DEBOUNCE_MS = 350;
  const BROWSE_IDLE_MS = 7000; // a scrolled fan drifts back to the playing song
  const DRAG_START_PX = 6;
  const WHEEL_STEP_MS = 110;
  const LINK = /^https?:\/\/\S+$/i;
  // without a queue: the playing track in front, older ones alternating outwards
  const HISTORY_FAN = [0, -1, 1, -2, 2];
  const SOURCES = [

    [/spotify/i, "Spotify"],
    [/applemusic|itunes/i, "Apple Music"],
    [/chrome/i, "Chrome"],
    [/msedge|edge/i, "Edge"],
    [/firefox/i, "Firefox"],
  ];

  let settings = {
    edgeLight: true,
    thickness: 100,
    lyrics: false,
    playerBar: true,
    recentList: true,
    interactive: true,
    barVertical: false,
    barHidden: [],
    equalizer: false,
    layout: {},
    dim: 30,
    blur: 30,
    musicVideo: true,
  };
  let state = { active: false, history: [] };
  let palette = window.LumenColor.DEFAULT;
  let paletteKey = null;
  let search = { id: null, timer: 0 };
  // how far the fan is scrolled away from the playing song; fractional mid-drag
  let browse = 0;
  let browseTimer = 0;
  let draggedAt = 0;
  // while the seek line is being dragged: where the handle is, in ms
  let scrub = null;
  // how many rows each left-hand list is scrolled down
  const scrolls = { queue: 0, playlists: 0, suggest: 0 };
  const scrollTimers = {};
  let suggestions = null;
  // the volume to come back to when the speaker button un-mutes
  let lastVolume = 1;
  let volumeDragging = false;
  let playlistsAsked = false;
  // the playlist opened in the left panel (null: the library view with suggestions);
  // tracks is null while it loads
  let view = null;
  let playlists = null;
  let importNote = "";

  const lyricsView = window.LumenLyrics.createLyricScroller({
    view: $("lm-scroll"),
    list: $("lm-lines"),
    // a click on a line jumps the song to it
    onSeek: (ms) => {
      state = { ...state, positionMs: ms, positionAt: Date.now() };
      window.lumen.command("seek", ms);
    },
  });
  const edge = window.LumenEdge.createEdgeLight($("edge"), () => ({
    enabled: settings.edgeLight,
    playing: Boolean(state.active && state.playing),
    thickness: settings.thickness,
    palette,
  }));

  // ---- helpers ----

  const formatTime = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };

  // the player reports a position and when it measured it; run that forward while playing
  const positionNow = () => {
    if (!state.active) return 0;
    let position = state.positionMs || 0;
    if (state.playing && state.positionAt) position += Date.now() - state.positionAt;
    return state.durationMs > 0 ? Math.min(position, state.durationMs) : position;
  };


  const sourceName = () => SOURCES.find(([pattern]) => pattern.test(state.app || ""))?.[1];

  function setPalette(next) {
    palette = next;
    const root = document.documentElement.style;
    for (const name of ["glow", "deep", "hot"]) {
      root.setProperty(`--${name}`, next[name].map(Math.round).join(", "));
    }
  }

  // the light's colour follows the cover; a cover from another site has to be fetched
  // by the main process first, or its pixels can't be read
  async function updatePalette() {
    if (!state.active || !state.cover || paletteKey === state.key) return;
    const key = state.key;
    paletteKey = key;
    const source = state.cover.startsWith("data:")
      ? state.cover
      : await window.lumen.coverData(state.cover);
    if (!source || state.key !== key) return;
    const probe = new Image();
    probe.onload = () => {
      if (state.key === key) setPalette(window.LumenColor.paletteFromImage(probe));
    };
    probe.src = source;
  }

  function coverElement(cover) {
    if (!cover) {
      const blank = document.createElement("span");
      blank.className = "blank";
      return blank;
    }
    const image = document.createElement("img");
    image.alt = "";
    image.draggable = false;
    image.loading = "lazy";
    image.src = cover;
    return image;
  }

  function textBlock(title, artist) {
    const text = document.createElement("span");
    text.className = "text";
    const titleEl = document.createElement("span");
    titleEl.className = "title";
    titleEl.textContent = title;
    const artistEl = document.createElement("span");
    artistEl.className = "artist";
    artistEl.textContent = artist;
    text.append(titleEl, artistEl);
    return text;
  }

  // What a click on a cover or row does: with the engine it plays that queue entry;
  // on the Windows fallback there is only one track, so nothing is clickable.
  function makeClickable(element, item) {
    delete element.dataset.pick;

    element.title = "";
    if (state.engine && Number.isInteger(item.index) && !item.current) {
      element.dataset.pick = String(item.index);
      element.title = `Play ${item.title}`;
    }
    element.classList.toggle("link", Boolean(element.dataset.pick));
  }

  // ---- what to show in the fan and the list ----

  // every entry: { key, title, artist, cover, slot (position in the fan), index?, current }
  function allFanItems() {
    if (!state.active) return [];
    if (state.engine) {
      return (state.queue || []).map((track, i) => {
        const index = state.queueOffset + i;
        return { ...track, index, slot: index - state.queueIndex, current: index === state.queueIndex };
      });
    }
    const tracks = [
      { key: state.key, title: state.title, artist: state.artist, cover: state.cover },
      ...(state.history || []).filter((item) => item.key !== state.key),
    ];
    return tracks
      .slice(0, HISTORY_FAN.length)
      .map((track, i) => ({ ...track, slot: HISTORY_FAN[i], current: i === 0 }));
  }

  // "shown" is where a card sits right now: its slot, moved by the scroll offset
  function fanItems() {
    return allFanItems()
      .map((item) => ({ ...item, shown: item.slot - browse }))
      .filter((item) => Math.abs(item.shown) < SPREAD + 1);
  }

  function setBrowse(value, settle) {
    const slots = allFanItems().map((item) => item.slot);
    const min = slots.length ? Math.min(...slots) : 0;
    const max = slots.length ? Math.max(...slots) : 0;
    browse = Math.min(max, Math.max(min, value));
    clearTimeout(browseTimer);
    if (settle && browse !== 0) {
      browseTimer = setTimeout(() => {
        browse = 0;
        renderFlow();
      }, BROWSE_IDLE_MS);
    }
    renderFlow();
  }

  function allListItems() {
    if (!state.active) return [];
    if (state.engine) {
      return (state.queue || [])
        .map((track, i) => {
          const index = state.queueOffset + i;
          return { ...track, index, current: index === state.queueIndex };
        })
        .filter((item) => item.index >= state.queueIndex);
    }
    return [
      { key: state.key, title: state.title, artist: state.artist, cover: state.cover, current: true },
      ...(state.history || []).filter((item) => item.key !== state.key),
    ];
  }

  // how many rows each left-hand list shows, from the height of the screen
  function rowBudget() {
    const total = Math.max(6, Math.min(12, Math.floor((window.innerHeight * 0.7 - 140) / 46)));
    const playlistRows = Math.max(2, Math.floor(total * 0.28));
    const suggestRows = Math.max(2, Math.floor(total * 0.3));
    return {
      queue: Math.max(3, total - playlistRows - suggestRows),
      playlists: playlistRows,
      suggest: suggestRows,
      opened: total,
    };
  }

  const sectionItems = {
    queue: () => (view ? view.tracks || [] : allListItems()),
    playlists: () => (state.engine && !view ? playlists?.items || [] : []),
    suggest: () => (state.engine && state.active && !view ? suggestions?.tracks || [] : []),
  };
  const listItems = () => {
    const budget = view ? rowBudget().opened : rowBudget().queue;
    return sectionItems.queue().slice(scrolls.queue, scrolls.queue + budget);
  };

  function setSectionScroll(section, value) {
    const shown = section === "queue" && view ? rowBudget().opened : rowBudget()[section];
    // stop while a few rows are still showing
    const max = Math.max(0, sectionItems[section]().length - Math.min(shown, 3));
    scrolls[section] = Math.min(max, Math.max(0, value));
    clearTimeout(scrollTimers[section]);
    // a scrolled queue or suggestion list drifts back; an opened playlist stays put
    if (scrolls[section] !== 0 && !(section === "queue" && view)) {
      scrollTimers[section] = setTimeout(() => {
        scrolls[section] = 0;
        renderSections();
      }, BROWSE_IDLE_MS * 2);
    }
    renderSections();
  }

  // ---- pieces ----

  function renderClock() {
    const now = new Date();
    $("clock-date").textContent = now
      .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      .replace(",", "");
    $("clock-time").textContent =
      `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, "0")}`;
  }

  function renderBackdrop() {
    const video = $("backdrop-video");
    const image = $("backdrop-image");
    const cover = $("backdrop-cover");
    const url = settings.wallpaperUrl;

    video.hidden = !(url && settings.wallpaperIsVideo);
    image.hidden = !(url && !settings.wallpaperIsVideo);
    if (!video.hidden && video.dataset.url !== url) {
      video.dataset.url = url;
      video.src = url;
    }
    if (video.hidden && video.dataset.url) {
      video.removeAttribute("src");
      video.load();
      delete video.dataset.url;
    }
    if (!image.hidden && image.dataset.url !== url) {
      image.dataset.url = url;
      image.src = url;
    }

    // blur the chosen wallpaper, scaled up a little so the soft edge stays off-screen
    const blur = settings.blur > 0 ? `blur(${settings.blur}px)` : "";
    const scale = settings.blur > 0 ? `scale(${1 + settings.blur / 250})` : "";
    for (const media of [video, image]) {
      media.style.filter = blur;
      media.style.transform = scale;
    }
    // the cover-art background follows the same Blur setting
    cover.style.filter = `blur(${settings.blur}px) saturate(1.4)`;
    cover.style.transform = `scale(${1.04 + settings.blur / 120})`;
    $("backdrop-shade").style.background = `rgba(0, 0, 0, ${settings.dim / 100})`;

    const currentCover = state.active ? state.cover : null;
    cover.hidden = Boolean(url) || !currentCover;
    if (!cover.hidden && cover.dataset.key !== state.key) {
      cover.dataset.key = state.key;
      cover.src = currentCover;
    }
  }

  const cards = new Map();
  function renderFlow() {
    const flow = $("flow");
    const items = fanItems();
    // a song can sit in a queue twice, so its place is part of the card's identity
    const idOf = (item) => (Number.isInteger(item.index) ? `${item.index}:${item.key}` : item.key);
    const wanted = new Map(items.map((item) => [idOf(item), item]));

    for (const [id, card] of cards) {
      if (!wanted.has(id)) {
        card.remove();
        cards.delete(id);
      }
    }
    for (const [id, item] of wanted) {
      let card = cards.get(id);
      if (!card) {
        card = document.createElement("div");
        card.className = "card";
        card.append(coverElement(item.cover), textBlock(item.title, item.artist));
        flow.appendChild(card);
        cards.set(id, card);
      } else if (item.cover && card.firstChild.tagName !== "IMG") {
        card.firstChild.replaceWith(coverElement(item.cover));
      }
      const shown = item.shown;
      const distance = Math.abs(shown);
      card.classList.toggle("front", Math.round(shown) === 0);
      makeClickable(card, item);
      card.style.zIndex = String(10 - Math.round(distance));
      // cards past the edge of the fan fade out instead of popping
      card.style.opacity = String(Math.min(1, SPREAD + 1 - distance));
      card.style.transform = `translate(-50%, -50%) translateX(${shown * 58}%) translateZ(${-distance * 130}px) rotateY(${-shown * 34}deg) scale(${1 - 0.14 * Math.min(1, distance)})`;
    }

    // dots: where the playing song is in the queue, or just "first of the recent ones"
    const total = state.engine ? state.queueLength || 0 : items.length;
    const count = Math.min(MAX_DOTS, total);
    // the dot marks the cover in the middle of the fan, so it moves as the fan is scrolled
    const middle = Math.min(Math.max(0, total - 1), Math.max(0, Math.round(state.queueIndex + browse)));
    const active =
      state.engine && total > MAX_DOTS
        ? Math.round((middle / (total - 1)) * (MAX_DOTS - 1))
        : state.engine
          ? middle
          : 0;
    $("dots").replaceChildren(
      ...Array.from({ length: count }, (_, i) => {
        const dot = document.createElement("span");
        if (i === active) dot.className = "on";
        return dot;
      }),
    );
  }

  function renderList() {
    const name = sourceName();
    const opened = Boolean(view);
    $("recent-back").hidden = !opened;
    $("recent-badge").hidden = opened;
    $("playlist-actions").hidden = !opened || !view.tracks;
    if (opened) {
      $("recent-title").textContent = view.title;
      $("recent-source").textContent = view.tracks
        ? `${view.tracks.length} songs · Playlist`
        : "Opening…";
    } else {
      $("recent-title").textContent = !state.engine
        ? "Recently Played"
        : state.active
          ? "Continue Playing"
          : "Your Library";
      $("recent-source").textContent = state.engine
        ? state.active
          ? "Up next"
          : "From the player"
        : name
          ? `From ${name}`
          : "On this PC";
    }
    $("recent-list").replaceChildren(
      ...listItems().map((item) => {
        const row = document.createElement("div");
        row.className = item.current ? "row active" : "row";
        row.append(coverElement(item.cover), textBlock(item.title, item.artist));
        if (view) {
          // a song in the opened playlist: clicking plays it with the playlist as the queue
          row.dataset.plTrack = String(item.index);
          row.classList.add("link");
          row.title = `Play ${item.title}`;
          if (state.active && item.key === state.key) row.classList.add("active");
        } else {
          makeClickable(row, item);
          if (state.engine && Number.isInteger(item.index)) row.dataset.queueIndex = String(item.index);
        }
        return row;
      }),
    );
    if (view && !view.tracks) {
      const note = document.createElement("div");
      note.className = "empty-note";
      note.textContent = "Opening the playlist…";
      $("recent-list").replaceChildren(note);
    }
  }

  function renderPlaylistRows() {
    const items = sectionItems.playlists();
    $("playlists-title").hidden = items.length === 0;
    const rows = items.slice(scrolls.playlists, scrolls.playlists + rowBudget().playlists);
    $("playlist-list").replaceChildren(
      ...rows.map((item) => {
        const row = document.createElement("div");
        row.className = "row link";
        row.dataset.plId = item.id;
        row.title = `Open ${item.title}`;
        const count = item.trackCount === null ? "Playlist" : `${item.trackCount} songs`;
        row.append(coverElement(item.cover), textBlock(item.title, count));
        return row;
      }),
    );
  }

  function renderSuggestRows() {
    const items = sectionItems.suggest();
    $("suggest-title").hidden = items.length === 0;
    const start = scrolls.suggest;
    const rows = items.slice(start, start + rowBudget().suggest);
    $("suggest-list").replaceChildren(
      ...rows.map((track, i) => {
        const row = document.createElement("div");
        row.className = "row link";
        row.dataset.suggest = String(start + i);
        row.title = `Play ${track.title}`;
        row.append(coverElement(track.cover), textBlock(track.title, track.artist));
        return row;
      }),
    );
  }

  const renderExtras = () => {
    renderPlaylistRows();
    renderSuggestRows();
  };
  function renderSections() {
    renderList();
    renderExtras();
  }

  function openPlaylistView(item) {
    view = { id: item.id, title: item.title, tracks: null };
    scrolls.queue = 0;
    renderSections();
    chooseStage();
    window.lumen.openPlaylist(item.id);
  }

  function closePlaylistView() {
    view = null;
    scrolls.queue = 0;
    renderSections();
    chooseStage();
  }

  function applyPlaylistTracks(data) {
    if (!view || !data || data.id !== view.id) return;
    view = { ...view, title: data.title, tracks: data.tracks.map((t, index) => ({ ...t, index })) };
    renderList();
  }

  function renderBar() {
    const bar = $("bar");
    bar.classList.toggle("paused", !state.playing);
    bar.classList.toggle("idle", !state.active);
    $("bar-title").textContent = state.active ? state.title || "" : "Nothing playing";
    // some players put their own name in the album field
    const album =
      state.album && !SOURCES.some(([pattern]) => pattern.test(state.album)) ? state.album : "";
    $("bar-subtitle").textContent = state.active
      ? [state.artist, album].filter(Boolean).join(" — ")
      : state.engine
        ? "Search for a song to start"
        : "Start a song in your music app";
    const cover = $("bar-cover");
    if (state.active && state.cover) cover.src = state.cover;
    cover.style.visibility = state.active && state.cover ? "visible" : "hidden";

    const volume = Number.isFinite(state.volume) ? state.volume : 1;
    if (!volumeDragging) showVolume(volume);
    $("btn-volume").setAttribute("aria-pressed", String(volume === 0));

    $("btn-lyrics").setAttribute("aria-pressed", String(Boolean(settings.lyrics)));
    $("btn-like").setAttribute("aria-pressed", String(Boolean(state.liked)));
    $("btn-like").hidden = !state.canLike;
    $("btn-shuffle").setAttribute("aria-pressed", String(Boolean(state.shuffle)));
    $("btn-repeat").setAttribute("aria-pressed", String(Boolean(state.repeat && state.repeat !== "off")));
    $("repeat-one").toggleAttribute("hidden", state.repeat !== "one");

    // what each button does, shown on hover
    const tips = {
      "btn-previous": "Previous song",
      "btn-toggle": state.playing ? "Pause" : "Play",
      "btn-next": "Next song",
      "btn-like": state.liked ? "Remove from liked songs" : "Like this song",
      "btn-shuffle": state.shuffle ? "Shuffle is on" : "Shuffle",
      "btn-repeat":
        state.repeat === "one"
          ? "Repeating this song"
          : state.repeat && state.repeat !== "off"
            ? "Repeating the queue"
            : "Repeat",
      "btn-search": "Search songs, playlists, import",
      "btn-lyrics": settings.lyrics ? "Hide lyrics" : "Show lyrics",
      "btn-settings": "Settings",
    };
    for (const [id, tip] of Object.entries(tips)) {
      $(id).dataset.tip = tip;
      $(id).setAttribute("aria-label", tip);
    }
  }

  function showVolume(level) {
    const percent = Math.round(Math.min(1, Math.max(0, level)) * 100);
    const input = $("volume-input");
    input.value = String(percent);
    $("volume-fill").style.height = `${percent}%`;
    $("volume-value").textContent = String(percent);
    const wide = $("lm-volume-input");
    wide.value = String(percent);
    wide.style.setProperty("--fill", `${percent}%`);
    $("lm-mute").setAttribute("aria-pressed", String(percent === 0));
  }

  // the engine reports the volume back; show a change at once and tell it
  function setVolume(level) {
    const clamped = Math.min(1, Math.max(0, level));
    if (clamped > 0) lastVolume = clamped;
    state = { ...state, volume: clamped };
    showVolume(clamped);
    $("btn-volume").setAttribute("aria-pressed", String(clamped === 0));
    window.lumen.command("volume", clamped);
  }

  // the lyric mode screen: cover, song and controls on the left (all of it mirrors
  // the player bar, whose buttons it presses)
  function renderLyricMode() {
    const box = $("lyricmode");
    box.classList.toggle("paused", !state.playing);
    const cover = $("lm-cover");
    if (state.active && state.cover && cover.dataset.src !== state.cover) {
      cover.dataset.src = state.cover;
      cover.src = state.cover;
    }
    $("lm-title").textContent = state.active ? state.title || "" : "";
    $("lm-artist").textContent = state.active ? state.artist || "" : "";
    $("lm-shuffle").setAttribute("aria-pressed", String(Boolean(state.shuffle)));
    $("lm-repeat").setAttribute("aria-pressed", String(Boolean(state.repeat && state.repeat !== "off")));
    for (const id of ["lm-shuffle", "lm-repeat", "lm-volume"]) $(id).hidden = !state.engine;
  }

  function renderNowBar() {
    $("np-title").textContent = state.active ? state.title || "" : "Nothing playing";
    const album =
      state.album && !SOURCES.some(([pattern]) => pattern.test(state.album)) ? state.album : "";
    $("np-subtitle").textContent = state.active
      ? [state.artist, album].filter(Boolean).join(" — ")
      : state.engine
        ? "Search for a song to start"
        : "Start a song in your music app";
    const cover = $("np-cover");
    if (state.active && state.cover && cover.dataset.src !== state.cover) {
      cover.dataset.src = state.cover;
      cover.src = state.cover;
    }
    cover.style.visibility = state.active && state.cover ? "visible" : "hidden";
  }

  // lyric mode fades in and out: the scene fades away, swaps, and fades back
  const SWAP_MS = 280;
  let shownLyrics = false;
  let swapTimer = 0;
  const wantsLyrics = () => Boolean(state.active) && Boolean(settings.lyrics) && lyricsView.hasLines();

  function chooseStage() {
    const active = Boolean(state.active);
    if (wantsLyrics() !== shownLyrics && !swapTimer) {
      $("scene").classList.add("swap");
      swapTimer = setTimeout(() => {
        swapTimer = 0;
        shownLyrics = wantsLyrics();
        chooseStage();
        $("scene").classList.remove("swap");
      }, SWAP_MS);
    }
    const showLyrics = shownLyrics;
    document.body.classList.toggle("lyric-mode", showLyrics);
    $("lyricmode").hidden = !showLyrics;
    $("clock").hidden = showLyrics;
    $("flow").hidden = !active || showLyrics;
    $("dots").hidden = !active || showLyrics;
    const library = state.engine && (Boolean(view) || (playlists?.items?.length || 0) > 0);
    $("recent").hidden = !settings.recentList || (!active && !library) || showLyrics;
    // the bar stays up when idle: it is the way into search and the settings;
    // lyric mode has its own controls
    $("bar").hidden = !settings.playerBar || showLyrics;
    // upright bar: the song and seek line get a bar of their own
    $("nowbar").hidden = !settings.playerBar || !settings.barVertical || showLyrics;
  }

  function renderPanel() {
    for (const input of document.querySelectorAll("#panel [data-setting]")) {
      const value = settings[input.dataset.setting];
      if (input.type === "checkbox") input.checked = Boolean(value);
      else if (document.activeElement !== input) input.value = String(value);
    }
    for (const output of document.querySelectorAll("#panel output")) {
      const input = document.querySelector(`#panel [data-setting="${output.dataset.for}"]`);
      output.textContent = `${settings[output.dataset.for]}${input?.dataset.unit ?? ""}`;
    }
    $("panel-cover").disabled = !settings.wallpaperUrl;
    $("panel-vertical").checked = Boolean(settings.barVertical);
    for (const box of document.querySelectorAll("#panel [data-bar-button]")) {
      box.checked = !(settings.barHidden || []).includes(box.dataset.barButton);
    }
    $("lyrics-note").textContent = state.engine
      ? "From the player, timed word by word"
      : "Looks songs up on lrclib.net";
  }

  function render() {
    void updatePalette();
    document.body.classList.toggle("clickable", Boolean(settings.interactive));
    document.body.classList.toggle("engine", Boolean(state.engine));
    if (!state.engine && !$("search").hidden) setSearchOpen(false);
    applyLayout();
    applyBar();
    showEq();
    renderBackdrop();
    renderFlow();
    if (view && !state.engine) view = null; // the link went away
    renderList();
    renderBar();
    renderLyricMode();
    renderNowBar();
    renderClip();
    renderVault();
    renderPanel();
    chooseStage();
    edge.wake();
  }

  // ---- search (engine only) ----

  function setSearchOpen(open) {
    if (open && !$("rename").hidden) setRenameOpen(false);
    $("search").hidden = !open;
    $("btn-search").setAttribute("aria-expanded", String(open));
    // typing needs keyboard focus, which the wallpaper otherwise refuses
    window.lumen.keyboard(open);
    if (open) {
      setPanelOpen(false);
      setTimeout(() => $("search-input").focus(), 60);
      if (!$("search-input").value.trim()) showPlaylists();
      void window.lumen.playlists();
    } else {
      $("search-input").blur();
    }
  }

  function showPlaylists() {
    const note = importNote || (playlists?.error ? `Could not load playlists: ${playlists.error}` : "");
    const items = playlists?.items || [];
    $("search-note").textContent =
      note ||
      (items.length > 0
        ? "Your playlists. Paste a Spotify playlist link above to import one."
        : "Search for a song, or paste a Spotify playlist link to import it.");
    $("search-results").replaceChildren(
      ...items.map((item) => {
        const row = document.createElement("div");
        row.className = "row link";
        row.dataset.playlist = item.id;
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = item.trackCount === null ? "" : `${item.trackCount} songs`;
        row.append(coverElement(item.cover), textBlock(item.title, "Playlist"), count);
        return row;
      }),
    );
  }

  async function startImport(url) {
    importNote = "Reading the playlist…";
    showPlaylists();
    const sent = await window.lumen.importPlaylist(url);
    if (!sent) {
      importNote = "Could not start the import: it needs an https link and a linked player.";
      showPlaylists();
    } else {
      $("search-input").value = "";
    }
  }

  function applyImport(update) {
    if (!update) return;
    const name = update.title ? `"${update.title}"` : "the playlist";
    if (update.status === "failed") {
      importNote = `Import failed: ${update.error || "unknown error"}`;
    } else if (update.status === "completed") {
      const left = update.skipped > 0 ? `, ${update.skipped} not found` : "";
      importNote = `Imported ${name}: ${update.imported} of ${update.total} songs${left}. Playing it now.`;
    } else if (update.status === "finalizing") {
      importNote = `Saving ${name}…`;
    } else {
      importNote =
        update.total > 0
          ? `Importing ${name}: matched ${update.imported + update.skipped} of ${update.total} songs…`
          : "Reading the playlist…";
    }
    if (!$("search").hidden && !$("search-input").value.trim()) showPlaylists();
  }

  function applyPlaylists(next) {
    playlists = next;
    if (!$("search").hidden && !$("search-input").value.trim()) showPlaylists();
    // a playlist that was deleted or renamed while it is open
    if (view && next?.items) {
      const still = next.items.find((p) => p.id === view.id);
      if (!still) view = null;
      else view = { ...view, title: still.title };
    }
    renderSections();
    chooseStage();
  }

  function applySuggestions(next) {
    suggestions = next;
    scrolls.suggest = 0;
    renderExtras();
  }

  // ---- right-click menus and small notices ----

  function closeMenu() {
    $("menu").hidden = true;
    $("menu").replaceChildren();
  }

  function openMenu(event, title, entries) {
    const menu = $("menu");
    const draw = (head, list) => {
      menu.replaceChildren();
      const heading = document.createElement("div");
      heading.className = "menu-title";
      heading.textContent = head;
      menu.append(heading);
      for (const entry of list) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = entry.label;
        if (entry.danger) button.className = "danger";
        button.addEventListener("click", (click) => {
          click.stopPropagation();
          if (entry.confirm) {
            // a second step for anything that cannot be undone
            draw(entry.confirm.text, [
              { label: entry.confirm.label, danger: true, run: entry.run },
              { label: "Cancel", run: () => {} },
            ]);
          } else {
            closeMenu();
            entry.run();
          }
        });
        menu.append(button);
      }
    };
    draw(title, entries);
    menu.hidden = false;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - box.height - 8))}px`;
  }

  let renaming = null;
  function setRenameOpen(open, item) {
    if (open) {
      setPanelOpen(false);
      if (!$("search").hidden) setSearchOpen(false);
    }
    $("rename").hidden = !open;
    // typing needs keyboard focus, which the wallpaper otherwise refuses
    window.lumen.keyboard(open);
    if (open) {
      renaming = item;
      $("rename-input").value = item.title;
      setTimeout(() => {
        $("rename-input").focus();
        $("rename-input").select();
      }, 60);
    } else {
      renaming = null;
      $("rename-input").blur();
    }
  }

  let toastTimer = 0;
  function applyNotice(notice) {
    if (!notice?.text) return;
    $("toast").textContent = notice.text;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
  }

  function onContextMenu(event) {
    event.preventDefault();
    if (!settings.interactive || !state.engine) return;
    const playlist = event.target.closest("[data-pl-id]");
    const suggest = event.target.closest("[data-suggest]");
    const inPlaylist = event.target.closest("[data-pl-track]");
    const queued = event.target.closest("#recent-list [data-queue-index]");

    if (playlist) {
      const id = playlist.dataset.plId;
      const item = playlists?.items?.find((p) => p.id === id);
      if (!item) return;
      openMenu(event, item.title, [
        { label: "Open", run: () => openPlaylistView(item) },
        { label: "Play", run: () => window.lumen.playPlaylist(id, false) },
        { label: "Shuffle play", run: () => window.lumen.playPlaylist(id, true) },
        { label: "Rename…", run: () => setRenameOpen(true, item) },
        {
          label: "Delete playlist",
          danger: true,
          confirm: { text: `Delete "${item.title}"? This can't be undone.`, label: "Delete" },
          run: () => window.lumen.playlistAction(id, "delete"),
        },
      ]);
    } else if (suggest) {
      const index = Number(suggest.dataset.suggest);
      const track = suggestions?.tracks?.[index];
      if (!track) return;
      openMenu(event, track.title, [
        { label: "Play", run: () => window.lumen.trackAction("suggest", index, "play") },
        { label: "Play next", run: () => window.lumen.trackAction("suggest", index, "playNext") },
        { label: "Add to queue", run: () => window.lumen.trackAction("suggest", index, "addToQueue") },
      ]);
    } else if (inPlaylist && view?.tracks) {
      const index = Number(inPlaylist.dataset.plTrack);
      const track = view.tracks[index];
      if (!track) return;
      openMenu(event, track.title, [
        { label: "Play", run: () => window.lumen.playPlaylistTrack(view.id, index) },
        { label: "Play next", run: () => window.lumen.trackAction("playlist", index, "playNext") },
        { label: "Add to queue", run: () => window.lumen.trackAction("playlist", index, "addToQueue") },
      ]);
    } else if (queued && !queued.classList.contains("active")) {
      const index = Number(queued.dataset.queueIndex);
      const track = (state.queue || [])[index - state.queueOffset];
      if (!track) return;
      openMenu(event, track.title, [
        { label: "Play", run: () => window.lumen.trackAction("queue", index, "play") },
        { label: "Remove from queue", danger: true, run: () => window.lumen.trackAction("queue", index, "remove") },
      ]);
    }
  }

  async function runSearch() {
    const query = $("search-input").value.trim();
    if (!query) {
      search.id = null;
      showPlaylists();
      return;
    }
    if (LINK.test(query)) {
      search.id = null;
      $("search-results").replaceChildren();
      $("search-note").textContent = "Press Enter to import this playlist and play it.";
      return;
    }
    if (query.length < 2) {
      search.id = null;
      $("search-results").replaceChildren();
      $("search-note").textContent = "Type at least two letters.";
      return;
    }
    $("search-note").textContent = "Searching…";
    search.id = await window.lumen.search(query);
    if (search.id === null) $("search-note").textContent = "The player is not linked right now.";
  }

  function applySearch(result) {
    if (!result || result.id !== search.id) return; // an older request: ignore
    $("search-note").textContent = result.error
      ? `Search failed: ${result.error}`
      : result.tracks.length === 0
        ? "Nothing found."
        : "";
    $("search-results").replaceChildren(
      ...result.tracks.map((track, index) => {
        const row = document.createElement("div");
        row.className = "row link";
        row.dataset.result = String(index);
        const duration = document.createElement("span");
        duration.className = "duration";
        duration.textContent = track.durationMs > 0 ? formatTime(track.durationMs) : "";
        row.append(coverElement(track.cover), textBlock(track.title, track.artist), duration);
        return row;
      }),
    );
  }

  // ---- controls ----

  const change = (patch) => {
    // show it at once; the main process confirms with a settings event
    settings = { ...settings, ...patch };
    render();
    window.lumen.updateSettings(patch);
  };

  function setPanelOpen(open) {
    $("panel").hidden = !open;
    $("btn-settings").setAttribute("aria-expanded", String(open));
    if (open && !$("search").hidden) setSearchOpen(false);
    if (open && !$("rename").hidden) setRenameOpen(false);
  }

  function wireControls() {
    $("btn-previous").addEventListener("click", () => window.lumen.command("previous"));
    $("btn-next").addEventListener("click", () => window.lumen.command("next"));
    $("btn-toggle").addEventListener("click", () => {
      if (!state.active) return;
      // flip the picture straight away; the real state follows within a moment
      const position = positionNow();
      state = { ...state, playing: !state.playing, positionMs: position, positionAt: Date.now() };
      render();
      window.lumen.command("toggle");
    });
    // the seek line: click to jump, or press and drag; the song moves on release
    const wireSeek = (track) => {
    const msAt = (event) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      return Math.round(ratio * state.durationMs);
    };
    track.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !state.active || !(state.durationMs > 0)) return;
      track.setPointerCapture(event.pointerId);
      scrub = { id: event.pointerId, ms: msAt(event) };
      track.classList.add("scrubbing");
    });
    track.addEventListener("pointermove", (event) => {
      if (scrub && event.pointerId === scrub.id) scrub.ms = msAt(event);
    });
    const release = (event) => {
      if (!scrub || event.pointerId !== scrub.id) return;
      const target = event.type === "pointercancel" ? null : msAt(event);
      scrub = null;
      track.classList.remove("scrubbing");
      if (target === null) return;
      state = { ...state, positionMs: target, positionAt: Date.now() };
      window.lumen.command("seek", target);
    };
    track.addEventListener("pointerup", release);
    track.addEventListener("pointercancel", release);
    };
    wireSeek($("bar-track"));
    wireSeek($("lm-track"));
    wireSeek($("np-track"));
    $("btn-like").addEventListener("click", () => window.lumen.command("like"));
    $("btn-shuffle").addEventListener("click", () => window.lumen.command("shuffle"));
    $("btn-repeat").addEventListener("click", () => window.lumen.command("repeat"));
    $("btn-lyrics").addEventListener("click", () => change({ lyrics: !settings.lyrics }));
    $("btn-settings").addEventListener("click", () => setPanelOpen($("panel").hidden));
    $("btn-search").addEventListener("click", () => setSearchOpen($("search").hidden));

    $("search-input").addEventListener("input", () => {
      clearTimeout(search.timer);
      search.timer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
    });
    $("search-input").addEventListener("keydown", (event) => {
      if (event.key === "Escape") setSearchOpen(false);
      else if (event.key === "Enter") {
        clearTimeout(search.timer);
        const text = $("search-input").value.trim();
        if (LINK.test(text)) void startImport(text);
        else void runSearch();
      }
    });
    $("search-results").addEventListener("click", (event) => {
      const playlist = event.target.closest("[data-playlist]");
      if (playlist) {
        const item = playlists?.items?.find((p) => p.id === playlist.dataset.playlist);
        setSearchOpen(false);
        if (item) openPlaylistView(item);
        return;
      }
      const row = event.target.closest("[data-result]");
      if (!row || search.id === null) return;
      window.lumen.playResult(search.id, Number(row.dataset.result));
      setSearchOpen(false);
    });

    $("panel").addEventListener("input", (event) => {
      const input = event.target.closest("[data-setting]");
      if (!input) return;
      change({
        [input.dataset.setting]: input.type === "checkbox" ? input.checked : Number(input.value),
      });
    });
    $("panel-choose").addEventListener("click", () => window.lumen.chooseWallpaper());
    $("panel-cover").addEventListener("click", () => window.lumen.clearWallpaper());
    $("panel-behind").addEventListener("click", () => {
      setPanelOpen(false);
      change({ interactive: false });
    });
    $("panel-quit").addEventListener("click", () => window.lumen.quit());
    $("recent-back").addEventListener("click", closePlaylistView);

    // lyric mode's buttons press the bar's, so each action has one implementation
    for (const [wide, bar] of [
      ["lm-previous", "btn-previous"],
      ["lm-toggle", "btn-toggle"],
      ["lm-next", "btn-next"],
      ["lm-shuffle", "btn-shuffle"],
      ["lm-repeat", "btn-repeat"],
      ["lm-mute", "btn-volume"],
    ]) {
      $(wide).addEventListener("click", () => $(bar).click());
    }
    $("lm-exit").addEventListener("click", () => change({ lyrics: false }));
    const wideVolume = $("lm-volume-input");
    wideVolume.addEventListener("pointerdown", () => (volumeDragging = true));
    wideVolume.addEventListener("pointerup", () => (volumeDragging = false));
    wideVolume.addEventListener("pointercancel", () => (volumeDragging = false));
    wideVolume.addEventListener("input", () => setVolume(Number(wideVolume.value) / 100));

    const volumeInput = $("volume-input");
    volumeInput.addEventListener("pointerdown", () => {
      volumeDragging = true;
      $("volume").classList.add("dragging");
    });
    const endVolumeDrag = () => {
      volumeDragging = false;
      $("volume").classList.remove("dragging");
    };
    volumeInput.addEventListener("pointerup", endVolumeDrag);
    volumeInput.addEventListener("pointercancel", endVolumeDrag);
    volumeInput.addEventListener("input", () => setVolume(Number(volumeInput.value) / 100));
    $("btn-volume").addEventListener("click", () => {
      const level = Number.isFinite(state.volume) ? state.volume : 1;
      setVolume(level > 0 ? 0 : lastVolume || 0.5);
    });
    // the wheel over the speaker changes the volume 5% a notch
    $("volume").addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const level = Number.isFinite(state.volume) ? state.volume : 1;
        setVolume(level - Math.sign(event.deltaY) * 0.05);
      },
      { passive: false },
    );
    $("pl-play").addEventListener("click", () => view && window.lumen.playPlaylist(view.id, false));
    $("pl-shuffle").addEventListener("click", () => view && window.lumen.playPlaylist(view.id, true));
    $("rename-input").addEventListener("keydown", (event) => {
      if (event.key === "Escape") setRenameOpen(false);
      else if (event.key === "Enter" && renaming) {
        const title = $("rename-input").value.trim();
        if (title && title !== renaming.title) {
          window.lumen.playlistAction(renaming.id, "rename", title);
        }
        setRenameOpen(false);
      }
    });
    document.addEventListener("contextmenu", onContextMenu);

    document.addEventListener("click", (event) => {
      // a click outside an open right-click menu only closes it
      if (!$("menu").hidden) {
        const inside = event.target.closest("#menu");
        closeMenu();
        if (!inside) return;
      }
      if (!$("rename").hidden && !event.target.closest("#rename")) setRenameOpen(false);
      // a click anywhere else closes whichever panel is open
      if (!$("panel").hidden && !event.target.closest("#panel, #btn-settings")) setPanelOpen(false);
      if (!$("search").hidden && !event.target.closest("#search, #btn-search")) setSearchOpen(false);

      // the click that ends a drag of the fan is not a choice
      if (Date.now() - draggedAt < 300 && event.target.closest("#flow")) return;
      const target = event.target.closest("#stage .link");
      if (target?.dataset.plId) {
        const item = playlists?.items?.find((p) => p.id === target.dataset.plId);
        if (item) openPlaylistView(item);
        return;
      }
      if (target?.dataset.suggest) {
        window.lumen.trackAction("suggest", Number(target.dataset.suggest), "play");
        return;
      }
      if (target?.dataset.plTrack && view?.tracks) {
        window.lumen.playPlaylistTrack(view.id, Number(target.dataset.plTrack));
        return;
      }
      if (target?.dataset.pick) window.lumen.command("pick", Number(target.dataset.pick));

      // the playing song's card, scrolled off-centre: bring the fan back to it
      else if (browse !== 0 && event.target.closest(".card")) setBrowse(0, false);
    });
  }

  // The fan scrolls with the wheel (one cover per notch) and drags sideways; a cover
  // brought to the front this way is played by clicking it.
  function wireFlow() {
    const flow = $("flow");
    let drag = null;
    let wheelAt = 0;

    flow.addEventListener(
      "wheel",
      (event) => {
        if (editing) return; // the layout editor uses the wheel to resize
        event.preventDefault();
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        const now = Date.now();
        if (!delta || now - wheelAt < WHEEL_STEP_MS) return;
        wheelAt = now;
        setBrowse(Math.round(browse) + Math.sign(delta), true);
      },
      { passive: false },
    );

    let listWheelAt = 0;
    $("recent").addEventListener(
      "wheel",
      (event) => {
        if (editing) return;
        event.preventDefault();
        const now = Date.now();
        if (!event.deltaY || now - listWheelAt < 60) return;
        listWheelAt = now;
        const section = event.target.closest("[data-section]")?.dataset.section || "queue";
        setSectionScroll(section, scrolls[section] + Math.sign(event.deltaY));
      },
      { passive: false },
    );

    flow.addEventListener("pointerdown", (event) => {
      if (editing || event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, from: browse, moved: false };
    });
    flow.addEventListener("pointermove", (event) => {
      if (editing || !drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) < DRAG_START_PX) return;
        drag.moved = true;
        flow.setPointerCapture(drag.id);
        flow.classList.add("dragging");
      }
      // one card's sideways step is 58% of its width (see renderFlow)
      const step = (flow.querySelector(".card")?.offsetWidth || 240) * 0.58;
      setBrowse(drag.from - dx / step, false);
    });
    const finish = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      if (!moved) return;
      flow.classList.remove("dragging");
      draggedAt = Date.now();
      setBrowse(Math.round(browse), true);
    };
    flow.addEventListener("pointerup", finish);
    flow.addEventListener("pointercancel", finish);
  }

  // ---- music video background ----

  // YouTube's own embedded player, muted and without controls, framed in the backdrop.
  // Framed directly, or through the public player page when one is set up (label videos
  // only play under a public address); the page passes messages both ways unchanged.
  const YOUTUBE = "https://www.youtube.com";
  const playerOrigin = () => (settings.playerPage ? new URL(settings.playerPage).origin : YOUTUBE);
  let clip = null; // { key, videoIds } for the playing song: candidates, best first
  let clipTry = 0; // which candidate is being shown
  let clipSyncedAt = 0;
  let clipPlayerState = null; // what the player last reported: 1 playing, 2 paused
  let clipShown = null; // the video id loaded in the frame

  const clipFrame = () => $("backdrop-clip");
  const tellClip = (func, args = []) => {
    if (!clipShown) return;
    clipFrame().contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), playerOrigin());
  };

  function renderClip() {
    const frame = clipFrame();
    const wanted =
      settings.musicVideo &&
      settings.canShowVideo &&
      state.active &&
      clip &&
      clip.key === state.key
        ? clip.videoIds?.[clipTry] || null
        : null;
    if (wanted === clipShown) {
      // same video: just keep it paused or playing along with the song
      if (clipShown && !state.playing) hideClipThenPause();
      else if (clipShown && clipPlayerState === 2 && state.playing) tellClip("playVideo");
      return;
    }
    clipShown = wanted;
    clipPlayerState = null;
    frame.classList.remove("on");
    if (wanted) {
      const query = new URLSearchParams({
        autoplay: "1",
        mute: "1",
        controls: "0",
        disablekb: "1",
        fs: "0",
        rel: "0",
        iv_load_policy: "3",
        cc_load_policy: "0",
        vq: "hd1080",
        playsinline: "1",
        loop: "1",
        playlist: wanted,
        enablejsapi: "1",
        start: String(Math.floor(positionNow() / 1000)),
        origin: location.origin,
      });
      frame.hidden = false;
      frame.src = settings.playerPage
        ? `${settings.playerPage}${settings.playerPage.includes("?") ? "&" : "?"}v=${wanted}&t=${query.get("start")}`
        : `${YOUTUBE}/embed/${wanted}?${query}`;
    } else {
      frame.hidden = true;
      frame.removeAttribute("src");
    }
  }

  // the video leaves the screen before it pauses, so the paused player is never seen
  let clipPauseTimer = 0;
  function hideClipThenPause() {
    clipFrame().classList.remove("on");
    clearTimeout(clipRevealTimer);
    if (clipPlayerState !== 1 || clipPauseTimer) return;
    clipPauseTimer = setTimeout(() => {
      clipPauseTimer = 0;
      if (!state.playing) tellClip("pauseVideo");
    }, 280);
  }

  // and comes back a moment after it is really playing again
  let clipRevealTimer = 0;
  function revealClip() {
    clearTimeout(clipRevealTimer);
    clipRevealTimer = setTimeout(() => {
      if (clipShown && state.playing && clipPlayerState === 1) clipFrame().classList.add("on");
    }, 700);
  }

  function applyVideo(next) {
    clip = next;
    clipTry = 0;
    renderClip();
  }

  // ask the player to report its state, so the video fades in only once it really plays
  clipFrame().addEventListener("load", () => {
    // the player page asks the player itself
    if (!clipShown || settings.playerPage) return;
    clipFrame().contentWindow?.postMessage(
      JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
      YOUTUBE,
    );
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== playerOrigin() || event.source !== clipFrame().contentWindow) return;
    let data;
    try {
      data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!data) return;
    if (data.event === "onError") {
      // the owner does not allow this video outside YouTube: try the next candidate,
      // and with none left keep the normal background
      clipTry += 1;
      renderClip();
      return;
    }
    // keep the picture where the music is: the player reports its time a few times a
    // second, and a drift of more than a second is corrected (not more often than every 3 s)
    const videoTime = data.info?.currentTime;
    if (typeof videoTime === "number" && state.playing && !scrub) {
      const drift = videoTime - positionNow() / 1000;
      if (Math.abs(drift) > 1 && Date.now() - clipSyncedAt > 3000) {
        clipSyncedAt = Date.now();
        tellClip("seekTo", [positionNow() / 1000 + 0.25, true]);
      }
    }
    const playerState = data.event === "onStateChange" ? data.info : data.info?.playerState;
    if (playerState === 1 || playerState === 2) clipPlayerState = playerState;
    if (playerState === 1) {
      // no captions over the wallpaper
      tellClip("unloadModule", ["captions"]);
      tellClip("setOption", ["captions", "track", {}]);
      if (state.playing) revealClip();
      else hideClipThenPause();
    } else if (playerState === 2) {
      clipFrame().classList.remove("on");
      if (state.playing) tellClip("playVideo");
    }
  });

  // ---- the vault of saved backgrounds ----

  let vaultKey = "";
  function renderVault() {
    const items = settings.vault || [];
    const key = JSON.stringify([items.map((item) => item.path), settings.wallpaperUrl]);
    if (key === vaultKey) return;
    vaultKey = key;
    $("vault").replaceChildren(
      ...items.map((item) => {
        const tile = document.createElement("div");
        tile.className = item.url === settings.wallpaperUrl ? "tile current" : "tile";
        tile.title = item.name;
        tile.dataset.path = item.path;
        let media;
        if (item.isVideo) {
          media = document.createElement("video");
          media.muted = true;
          media.preload = "metadata";
          media.src = `${item.url}#t=0.5`;
          const kind = document.createElement("span");
          kind.className = "kind";
          kind.textContent = "VIDEO";
          tile.append(kind);
        } else {
          media = document.createElement("img");
          media.loading = "lazy";
          media.alt = "";
          media.src = item.url;
        }
        const forget = document.createElement("button");
        forget.type = "button";
        forget.className = "forget";
        forget.textContent = "×";
        forget.title = "Forget this background";
        tile.prepend(media);
        tile.append(forget);
        return tile;
      }),
    );
  }

  // ---- equalizer (the player's own, driven through the link) ----

  let eq = null; // the last state from the engine
  let eqTab = null; // enhance | genre | accent | custom; null follows the active preset
  let eqDragging = false;
  let eqSendTimer = 0;
  let eqBuilt = 0; // how many band sliders exist

  const sameGains = (a, b) => a.length === b.length && a.every((gain, i) => Math.abs(gain - b[i]) < 0.01);
  const formatDb = (db) => (db > 0 ? `+${db}` : String(db));
  const formatHz = (hz) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));

  // shown by the Equalizer switch, once the engine has reported its equalizer
  function showEq() {
    const visible = Boolean(settings.equalizer && state.engine && eq);
    if ($("eq").hidden === !visible) return;
    $("eq").hidden = !visible;
    if (visible) renderEq();
  }

  function activeCategory() {
    if (!eq) return "enhance";
    if (eq.custom.some((preset) => sameGains(preset.gains, eq.gains))) return "custom";
    return eq.presets.find((preset) => sameGains(preset.gains, eq.gains))?.category || "enhance";
  }

  function buildEqBands() {
    const holder = $("eq-bands");
    holder.replaceChildren(
      ...eq.bands.map((hz, index) => {
        const band = document.createElement("div");
        band.className = "eq-band";
        const db = document.createElement("span");
        db.className = "db";
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = String(eq.min);
        slider.max = String(eq.max);
        slider.step = "0.5";
        slider.addEventListener("pointerdown", () => (eqDragging = true));
        slider.addEventListener("pointerup", () => (eqDragging = false));
        slider.addEventListener("pointercancel", () => (eqDragging = false));
        slider.addEventListener("input", () => {
          const gains = [...document.querySelectorAll("#eq-bands input")].map((box) => Number(box.value));
          db.textContent = formatDb(Number(slider.value));
          if (!eq.enabled) window.lumen.eq("enabled", true);
          clearTimeout(eqSendTimer);
          eqSendTimer = setTimeout(() => window.lumen.eq("gains", gains), 60);
        });
        const label = document.createElement("span");
        label.textContent = formatHz(hz);
        band.append(db, slider, label);
        return band;
      }),
    );
    eqBuilt = eq.bands.length;
  }

  function renderEq() {
    if (!eq) {
      $("eq").classList.remove("on");
      return;
    }
    const labels = eq.labels || {};
    $("eq-title").textContent = labels.title || "Equalizer";
    $("eq-hint").textContent = labels.hint || "";
    $("eq-enabled").checked = eq.enabled;
    $("eq").classList.toggle("on", eq.enabled);

    if (eqBuilt !== eq.bands.length) buildEqBands();
    if (!eqDragging) {
      document.querySelectorAll("#eq-bands .eq-band").forEach((band, i) => {
        const value = eq.gains[i] ?? 0;
        band.querySelector("input").value = String(value);
        band.querySelector(".db").textContent = formatDb(value);
      });
    }

    const current = eqTab || activeCategory();
    const tabs = [
      ["enhance", labels.enhance || "Enhance"],
      ["genre", labels.genre || "Genres"],
      ["accent", labels.accent || "Accents"],
      ["custom", labels.custom || "Mine"],
    ];
    $("eq-tabs").replaceChildren(
      ...tabs.map(([id, name]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = name;
        button.dataset.tab = id;
        if (id === current) button.className = "on";
        return button;
      }),
    );

    const body = $("eq-body");
    if (current === "custom") {
      const mine = document.createElement("div");
      mine.className = "mine";
      const row = document.createElement("div");
      row.className = "save-row";
      const input = document.createElement("input");
      input.id = "eq-name";
      input.type = "text";
      input.maxLength = 24;
      input.placeholder = labels.placeholder || "Preset name";
      input.spellcheck = false;
      // typing must survive the redraws the equalizer's own updates cause
      input.value = $("eq-body").querySelector("#eq-name")?.value || "";
      const save = document.createElement("button");
      save.type = "button";
      save.dataset.save = "1";
      save.textContent = eq.custom.length >= eq.maxCustom ? labels.full || "Preset limit reached" : labels.save || "Save current";
      save.disabled = eq.custom.length >= eq.maxCustom;
      row.append(input, save);
      mine.append(row);
      for (const preset of eq.custom) {
        const item = document.createElement("div");
        item.className = "mine-item";
        const pick = document.createElement("button");
        pick.type = "button";
        pick.className = sameGains(preset.gains, eq.gains) ? "preset on" : "preset";
        pick.dataset.preset = preset.id;
        pick.textContent = preset.name;
        const del = document.createElement("button");
        del.type = "button";
        del.className = "del";
        del.dataset.del = preset.id;
        del.title = labels.remove || "Delete preset";
        del.textContent = "×";
        item.append(pick, del);
        mine.append(item);
      }
      if (eq.custom.length === 0) {
        const note = document.createElement("div");
        note.className = "note";
        note.textContent = labels.empty || "Tune the bands and save the curve to reuse it later";
        mine.append(note);
      }
      if (!body.querySelector("#eq-name") || document.activeElement?.id !== "eq-name") body.replaceChildren(mine);
    } else {
      body.replaceChildren(
        ...eq.presets
          .filter((preset) => preset.category === current)
          .map((preset) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = sameGains(preset.gains, eq.gains) ? "preset on" : "preset";
            button.dataset.preset = preset.id;
            button.textContent = preset.name;
            return button;
          }),
      );
    }
  }

  function applyEq(next) {
    eq = next;
    showEq();
    if (!$("eq").hidden) renderEq();
  }

  function wireEq() {
    // the preset name box needs keyboard focus, which the wallpaper otherwise refuses
    $("eq-body").addEventListener("pointerdown", (event) => {
      if (event.target.id !== "eq-name") return;
      window.lumen.keyboard(true);
      setTimeout(() => event.target.focus(), 60);
    });
    $("eq-body").addEventListener("focusout", (event) => {
      if (event.target.id === "eq-name") window.lumen.keyboard(false);
    });
    $("eq-enabled").addEventListener("change", (event) => window.lumen.eq("enabled", event.target.checked));
    $("eq-tabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-tab]")?.dataset.tab;
      if (!tab) return;
      eqTab = tab;
      renderEq();
    });
    $("eq-body").addEventListener("click", (event) => {
      const preset = event.target.closest("[data-preset]")?.dataset.preset;
      const remove = event.target.closest("[data-del]")?.dataset.del;
      if (preset) window.lumen.eq("preset", preset);
      else if (remove) window.lumen.eq("delete", remove);
      else if (event.target.closest("[data-save]")) {
        const name = $("eq-name")?.value.trim();
        if (name) {
          window.lumen.eq("save", name);
          $("eq-name").value = "";
        }
      }
    });
    $("eq-body").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.id === "eq-name") {
        const name = event.target.value.trim();
        if (name) {
          window.lumen.eq("save", name);
          event.target.value = "";
        }
      }
    });
  }

  // ---- player bar options ----

  const BAR_PARTS = ["previous","toggle","next","cover","info","time","like","shuffle","repeat","volume","search","lyrics"];

  function applyBar() {
    document.body.classList.toggle("bar-vertical", Boolean(settings.barVertical));
    for (const name of BAR_PARTS) {
      document.body.classList.toggle(`bar-hide-${name}`, (settings.barHidden || []).includes(name));
    }
  }

  // turning the bar puts it back at its starting place for the new direction
  function setBarVertical(vertical) {
    const layout = { ...settings.layout };
    delete layout.bar;
    settings = { ...settings, layout };
    change({ barVertical: vertical, layout });
  }

  function wireBarOptions() {
    $("panel-vertical").addEventListener("change", (event) => setBarVertical(event.target.checked));
    $("vault").addEventListener("click", (event) => {
      const tile = event.target.closest(".tile");
      if (!tile) return;
      if (event.target.closest(".forget")) window.lumen.forgetWallpaper(tile.dataset.path);
      else window.lumen.useWallpaper(tile.dataset.path);
    });
    $("layout-rotate").addEventListener("click", () => setBarVertical(!settings.barVertical));
    $("panel").addEventListener("change", (event) => {
      const part = event.target.dataset?.barButton;
      if (!part) return;
      const hidden = new Set(settings.barHidden || []);
      if (event.target.checked) hidden.delete(part);
      else hidden.add(part);
      change({ barHidden: [...hidden] });
    });
  }

  // ---- layout editor ----

  const MIN_SCALE = 0.25;
  const MAX_SCALE = 4;
  let editing = false;
  let layoutKey = "";

  const partOf = (element) => element?.closest?.("[data-layout]");
  const spotOf = (name) => ({ x: 0, y: 0, s: 1, ...(settings.layout?.[name] || {}) });

  // x and y are fractions of the screen, so the same layout fits any resolution
  function applyLayout() {
    const key = `${JSON.stringify(settings.layout || {})}|${innerWidth}x${innerHeight}`;
    if (key === layoutKey) return;
    layoutKey = key;
    for (const element of document.querySelectorAll("[data-layout]")) {
      const spot = spotOf(element.dataset.layout);
      element.style.setProperty("--lx", `${spot.x * innerWidth}px`);
      element.style.setProperty("--ly", `${spot.y * innerHeight}px`);
      element.style.setProperty("--ls", String(spot.s));
    }
  }
  window.addEventListener("resize", applyLayout);

  const saveLayout = (layout) => change({ layout });

  function setEditing(on) {
    editing = on;
    if (on) {
      browse = 0;
      clearTimeout(browseTimer);
      renderFlow();
    }
    document.body.classList.toggle("editing", on);
    $("layout-bar").hidden = !on;
    $("layout-name").textContent = "";
    if (on) {
      setPanelOpen(false);
      if (!$("search").hidden) setSearchOpen(false);
      closeMenu();
    }
  }

  function wireLayout() {
    let drag = null;
    let wheelTimer = 0;
    const pick = (part) => {
      for (const other of document.querySelectorAll("[data-layout].picked")) other.classList.remove("picked");
      part?.classList.add("picked");
      const spot = part ? spotOf(part.dataset.layout) : null;
      $("layout-name").textContent = part
        ? `${part.dataset.name} · ${Math.round(spot.s * 100)}%`
        : "";
    };
    const write = (part, spot) => {
      settings = { ...settings, layout: { ...settings.layout, [part.dataset.layout]: spot } };
      layoutKey = "";
      applyLayout();
      pick(part);
    };

    // capture phase: while editing, nothing else may react to the pointer
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!editing || event.button !== 0) return;
        const part = partOf(event.target);
        if (!part) return;
        event.preventDefault();
        event.stopPropagation();
        const spot = spotOf(part.dataset.layout);
        drag = { part, id: event.pointerId, startX: event.clientX, startY: event.clientY, spot };
        pick(part);
        document.body.setPointerCapture?.(event.pointerId);
      },
      true,
    );
    document.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const clamp = (value) => Math.min(1.5, Math.max(-1.5, value));
      write(drag.part, {
        ...drag.spot,
        x: clamp(drag.spot.x + (event.clientX - drag.startX) / innerWidth),
        y: clamp(drag.spot.y + (event.clientY - drag.startY) / innerHeight),
      });
    });
    const finish = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      saveLayout(settings.layout);
    };
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);

    document.addEventListener(
      "wheel",
      (event) => {
        if (!editing) return;
        const part = partOf(event.target);
        if (!part) return;
        event.preventDefault();
        event.stopPropagation();
        const spot = spotOf(part.dataset.layout);
        const factor = event.deltaY < 0 ? 1.06 : 1 / 1.06;
        write(part, { ...spot, s: Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(spot.s * factor * 1000) / 1000)) });
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => saveLayout(settings.layout), 300);
      },
      { capture: true, passive: false },
    );

    // double-click puts one part back where it started
    document.addEventListener(
      "dblclick",
      (event) => {
        if (!editing) return;
        const part = partOf(event.target);
        if (!part) return;
        const layout = { ...settings.layout };
        delete layout[part.dataset.layout];
        settings = { ...settings, layout };
        layoutKey = "";
        applyLayout();
        pick(part);
        saveLayout(layout);
      },
      true,
    );

    // clicks while editing are only for dragging
    document.addEventListener(
      "click",
      (event) => {
        if (editing && partOf(event.target)) {
          event.stopPropagation();
          event.preventDefault();
        }
      },
      true,
    );

    $("layout-reset").addEventListener("click", () => {
      settings = { ...settings, layout: {} };
      layoutKey = "";
      applyLayout();
      pick(null);
      saveLayout({});
    });
    $("layout-done").addEventListener("click", () => setEditing(false));
    $("panel-layout").addEventListener("click", () => {
      if (!settings.interactive) return;
      setEditing(true);
    });
    window.lumen.onEditLayout(() => setEditing(true));
  }

  // ---- wiring ----

  function applyState(next) {
    const before = `${state.key}:${state.queueIndex}`;
    // for the music video: was the song moved, paused or resumed?
    const expected = positionNow();
    const wasPlaying = Boolean(state.playing);
    const sameSong = next && next.active && next.key === state.key;
    if (sameSong && clipShown) {
      const jumped = Math.abs((next.positionMs || 0) - expected) > 2500;
      if (jumped) tellClip("seekTo", [(next.positionMs || 0) / 1000, true]);
      if (Boolean(next.playing) !== wasPlaying) tellClip(next.playing ? "playVideo" : "pauseVideo");
    }
    const wasShown = `${Boolean(state.engine)}:${Boolean(state.active)}`;
    state = next || { active: false, history: [] };
    if (`${Boolean(state.engine)}:${Boolean(state.active)}` !== wasShown) renderExtras();
    // a new song puts the fan back on it
    if (`${state.key}:${state.queueIndex}` !== before) {
      browse = 0;
      clearTimeout(browseTimer);
      if (!view) scrolls.queue = 0;
      clearTimeout(scrollTimers.queue);
    }
    if (state.engine && !playlistsAsked) {
      playlistsAsked = true;
      void window.lumen.playlists();
    }
    render();
  }

  function applySettings(next) {
    settings = { ...settings, ...next };
    if (!settings.interactive) {
      setPanelOpen(false);
      if (!$("search").hidden) setSearchOpen(false);
    }
    render();
  }

  function applyLyrics(next) {
    let lines = [];
    if (next && (!next.key || next.key === state.key)) {
      if (next.lines) lines = window.LumenLyrics.fromEngineLines(next.lines);
      else if (next.lrc) lines = window.LumenLyrics.parseLrc(next.lrc);
    }
    lyricsView.setLines(lines);
    chooseStage();
  }

  function frame() {
    if (state.active) {
      const position = scrub ? scrub.ms : positionNow();
      if (!$("bar").hidden) {
        const ratio = state.durationMs > 0 ? position / state.durationMs : 0;
        $("bar-progress").style.width = `${Math.min(100, ratio * 100)}%`;
        $("bar-time").textContent =
          state.durationMs > 0 ? `${formatTime(position)} / ${formatTime(state.durationMs)}` : "";
      }
      if (!$("nowbar").hidden) {
        const share = state.durationMs > 0 ? position / state.durationMs : 0;
        $("np-progress").style.width = `${Math.min(100, share * 100)}%`;
        $("np-time").textContent =
          state.durationMs > 0 ? `${formatTime(position)} / ${formatTime(state.durationMs)}` : "";
      }
      if (!$("lyricmode").hidden) {
        lyricsView.update(position);
        const ratio = state.durationMs > 0 ? position / state.durationMs : 0;
        $("lm-progress").style.width = `${Math.min(100, ratio * 100)}%`;
        $("lm-now").textContent = formatTime(position);
        $("lm-total").textContent = state.durationMs > 0 ? formatTime(state.durationMs) : "";
      }
    } else {
      $("bar-progress").style.width = "0%";
      $("bar-time").textContent = "";
    }
    window.lumenFrame(frame);
  }

  renderClock();
  setInterval(renderClock, 1000);
  setPalette(palette);
  wireControls();
  wireFlow();
  wireLayout();
  wireBarOptions();
  wireEq();

  window.lumen.onState(applyState);
  window.lumen.onSettings(applySettings);
  window.lumen.onLyrics(applyLyrics);
  window.lumen.onSearch(applySearch);
  window.lumen.onPlaylists(applyPlaylists);
  window.lumen.onSuggestions(applySuggestions);
  window.lumen.onPlaylistTracks(applyPlaylistTracks);
  window.lumen.onNotice(applyNotice);
  window.lumen.onEq(applyEq);
  window.lumen.onVideo(applyVideo);
  // keep the playlist list fresh: the engine's playlists can change outside Lumen
  setInterval(() => {
    if (state.engine) void window.lumen.playlists();
  }, 60000);
  window.lumen.onImport(applyImport);
  window.lumen.initial().then((initial) => {
    applySettings(initial.settings);
    applyState(initial.state);
    applyLyrics(initial.lyrics);
    if (initial.playlists) applyPlaylists(initial.playlists);
    if (initial.suggestions) applySuggestions(initial.suggestions);
    if (initial.video) applyVideo(initial.video);
    if (initial.eq) applyEq(initial.eq);
  });
  window.lumenFrame(frame);
})();
