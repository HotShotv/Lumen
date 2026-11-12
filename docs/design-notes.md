# Design notes

The interface has two jobs that pull against each other: be a wallpaper you glance at,
and be a player you operate. Everything below comes from looking at the running app and
deciding what belongs to which job.

## Layers, back to front

```
backdrop    the wallpaper, dimmed and blurred; the album art stands in when no file is set
edge light  a ring that samples the cover and moves with the audio
clock       date and time, largest object on screen at rest
fan         covers, the playing one in front
list        queue, playlists or recent tracks
bar         transport, seek, volume, search, lyrics
tray        the ring icon; every toggle lives here too
```

## The rule that keeps it readable

**The wallpaper wins at rest. The artwork wins on change.**

At rest, the eye should land on the time. That is what a wallpaper is for. When the
track changes, the artwork and the bar get the attention for a few hundred milliseconds
and then hand it back. Everything else is furniture and should behave like furniture.

## Decisions already made

- **The backdrop is the wallpaper, blurred, not a solid overlay.** Ghosting the image
  through the interface is what makes the player feel embedded rather than pasted on.
  A fixed dark scrim would flatten that, so contrast is handled per region instead.
- **Cover fan over a grid.** Depth reads without a single piece of chrome. The
  recession is what tells you the queue continues.
- **The bar is low and muted.** It is the one persistent object that must never shout
  while nothing is happening.
- **Transport lives in one place.** Three surfaces can all play and pause if you let
  them; the bar owns playback, the list owns selection, the tray owns settings.
- **Anything can be switched off.** The bar is a set of parts, not a monolith. Some
  people want a clock and a cover and nothing else.
- **Layout is data, not code.** Every part has `{ x, y, s }` in settings; the editor is
  just a way to write it.

## Known weak points

Honest list, current as of this snapshot.

1. **Contrast is positional.** Text over the blurred backdrop can land on a bright
   region and lose. A scrim tied to the blur radius, rather than a fixed overlay, is the
   fix that does not cost the wallpaper its presence.
2. **The bar's seek line has no handle.** It reads as a divider until you drag it.
3. **Time labels are small.** At 1:56 / 3:39 on a light backdrop they are the first
   thing to disappear.
4. **The fan is asymmetric.** Covers recede one way; the dots below imply centred.
   Pick one reading, not both.
5. **The tray menu is long.** It is the only place several settings exist, and it has
   outgrown a context menu.
6. **No keyboard path.** Every control is a pointer target.

## Sizing

The layout is fraction-based, so it survives a resolution change, but the parts are
sized in pixels with a scale factor. On a 4K panel the clock is proportionally small.
The scale exists; it is not yet driven by DPI.

## Colour

The palette comes from the cover, not from a fixed theme: three tones (`glow`, `deep`,
`hot`) are extracted and written to CSS custom properties. The edge light and the pulse
read from the same three, so the whole screen moves with the artwork instead of
fighting it.
