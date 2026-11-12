// Synced lyrics: the line before, the line being sung and the line after. The other two
// are faded; in the sung line each word lights up as it is sung. Lines come either from
// the engine, which times every word, or from LRC text (LRCLIB), which only times lines.
(() => {
  const TIMESTAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const LAST_LINE_MS = 5000;
  // without word times, the words are spread over this share of the line
  const WORD_SPAN = 0.82;
  // a word starts to light up slightly before its time, the way the player does it
  const LEAD_RATIO = 0.1;
  const MIN_WORD_MS = 120;
  // how far past either end of a word the highlight's soft edge travels (percent)
  const EDGE = 14;
  const NOTE = "♪";

  /** @returns {{ timeMs: number, text: string, endMs: number }[]} */
  function parseLrc(lrc) {
    const lines = [];
    for (const raw of (lrc || "").split(/\r?\n/)) {
      TIMESTAMP.lastIndex = 0;
      const stamps = [];
      let match;
      let end = 0;
      while ((match = TIMESTAMP.exec(raw)) && match.index === end) {
        const fraction = match[3] ? Number(match[3].padEnd(3, "0")) : 0;
        stamps.push(Number(match[1]) * 60000 + Number(match[2]) * 1000 + fraction);
        end = TIMESTAMP.lastIndex;
      }
      const text = raw.slice(end).trim();
      for (const timeMs of stamps) lines.push({ timeMs, text });
    }
    lines.sort((a, b) => a.timeMs - b.timeMs);
    lines.forEach((line, index) => {
      line.endMs = lines[index + 1]?.timeMs ?? line.timeMs + LAST_LINE_MS;
    });
    return lines;
  }

  /** Lines as the engine sends them, some with a start and end time for every word. */
  function fromEngineLines(source) {
    const lines = (source || [])
      .filter((line) => Number.isFinite(line?.timeMs))
      .map((line) => ({
        timeMs: line.timeMs,
        text: line.isInstrumental ? "" : String(line.text || "").trim(),
        endMs: line.durationMs > 0 ? line.timeMs + line.durationMs : 0,
        wordTimes: (line.words || [])
          .filter((word) => String(word?.text || "").trim() && Number.isFinite(word.timeMs))
          .map((word) => ({
            timeMs: word.timeMs,
            endMs: Number.isFinite(word.endMs) ? word.endMs : 0,
            text: String(word.text).trim(),
          })),
      }))
      .sort((a, b) => a.timeMs - b.timeMs);
    lines.forEach((line, index) => {
      const next = lines[index + 1]?.timeMs ?? line.timeMs + LAST_LINE_MS;
      if (!line.endMs || line.endMs > next) line.endMs = next;
    });
    return lines;
  }

  /**
   * The words of a line, each with when it starts and ends and whether a space follows.
   * @returns {{ text: string, startMs: number, endMs: number, space: boolean }[]}
   */
  function wordsOf(line) {
    if (!line?.text) return [];
    if (line.wordTimes?.length) {
      // timed pieces can be syllables, so the line's own text decides where spaces go
      let cursor = 0;
      return line.wordTimes.map((word, index) => {
        const at = line.text.indexOf(word.text, cursor);
        let space = true;
        if (at >= 0) {
          cursor = at + word.text.length;
          space = cursor >= line.text.length || /\s/.test(line.text[cursor]);
        }
        const following = line.wordTimes[index + 1]?.timeMs ?? line.endMs;
        let endMs = word.endMs > word.timeMs ? word.endMs : following;
        if (!(endMs > word.timeMs)) endMs = word.timeMs + MIN_WORD_MS;
        return { text: word.text, startMs: word.timeMs, endMs, space };
      });
    }
    // only the line is timed: share its length out by how long each word is
    const parts = line.text.split(/\s+/).filter(Boolean);
    const letters = parts.reduce((total, part) => total + part.length, 0) || 1;
    const span = Math.max(MIN_WORD_MS * parts.length, (line.endMs - line.timeMs) * WORD_SPAN);
    let startMs = line.timeMs;
    return parts.map((text) => {
      const length = (span * text.length) / letters;
      const word = { text, startMs, endMs: startMs + length, space: true };
      startMs += length;
      return word;
    });
  }

  /**
   * The whole song's lyrics as a column that scrolls to keep the sung line in the middle.
   * The sung line lights up word by word; the others are faded.
   * @param {{ view: HTMLElement, list: HTMLElement, onSeek: (ms: number) => void }} parts
   */
  function createLyricScroller({ view, list, onSeek }) {
    let lines = [];
    /** @type {HTMLElement[]} */
    let elements = [];
    let active = -2;
    /** @type {{ startMs: number, endMs: number, element: HTMLElement, shown: number }[]} */
    let words = [];
    let lastHeight = 0;

    list.addEventListener("click", (event) => {
      const element = event.target.closest(".lyric-line");
      const line = element && lines[Number(element.dataset.index)];
      if (line) onSeek(line.timeMs);
    });

    const plain = (index) => {
      const element = elements[index];
      if (!element) return;
      element.classList.remove("active");
      element.textContent = lines[index].text || NOTE;
    };

    const setLines = (next) => {
      lines = next;
      active = -2;
      words = [];
      lastHeight = 0;
      elements = lines.map((line, index) => {
        const element = document.createElement("div");
        element.className = line.text ? "lyric-line" : "lyric-line note";
        element.dataset.index = String(index);
        element.textContent = line.text || NOTE;
        return element;
      });
      list.replaceChildren(...elements);
      list.style.transform = "translateY(0)";
    };

    /** Moves the column so the sung line is centred; snap skips the glide. */
    function place(snap) {
      const element = elements[Math.max(0, active)];
      if (!element) return;
      lastHeight = view.clientHeight;
      const offset = element.offsetTop + element.offsetHeight / 2 - lastHeight / 2;
      if (snap) list.style.transition = "none";
      list.style.transform = `translateY(${-offset}px)`;
      if (snap) {
        void list.offsetWidth;
        list.style.transition = "";
      }
    }

    function activate(index, snap) {
      plain(active);
      active = index;
      words = [];
      const element = elements[index];
      if (element) {
        element.classList.add("active");
        const parts = wordsOf(lines[index]);
        if (parts.length > 0) {
          element.textContent = "";
          words = parts.map((word) => {
            const span = document.createElement("span");
            span.className = "word";
            span.textContent = word.text;
            element.append(span, word.space ? " " : "");
            return { startMs: word.startMs, endMs: word.endMs, element: span, shown: NaN };
          });
        }
      }
      // fade by distance from the sung line
      elements.forEach((item, i) => item.style.setProperty("--d", String(Math.min(4, Math.abs(i - index)))));
      place(snap);
    }

    /** Call every frame with the playback position. */
    const update = (nowMs) => {
      let index = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].timeMs <= nowMs) index = i;
        else break;
      }
      if (index !== active) {
        // a jump of more than a few lines (a seek) snaps instead of gliding all the way
        activate(index, lastHeight === 0 || Math.abs(index - active) > 6);
      } else if (view.clientHeight !== lastHeight && view.clientHeight > 0) {
        place(true);
      }

      for (const word of words) {
        const length = Math.max(MIN_WORD_MS, word.endMs - word.startMs);
        const progress = (nowMs - word.startMs + length * LEAD_RATIO) / length;
        // from fully dim (-EDGE) to fully lit (100 + EDGE)
        const percent = Math.round(Math.min(1, Math.max(0, progress)) * (100 + 2 * EDGE) - EDGE);
        if (percent !== word.shown) {
          word.shown = percent;
          word.element.style.setProperty("--p", String(percent));
        }
      }
    };

    return { setLines, update, hasLines: () => lines.length > 0 };
  }

  window.LumenLyrics = { parseLrc, fromEngineLines, createLyricScroller };
})();
