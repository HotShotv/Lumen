// Picks the light's colour from the cover art: the cover's most vivid hue, pushed bright.

// A window pinned behind the desktop icons is never "on screen" to Chromium, so
// requestAnimationFrame runs unpaced there (hundreds of times a second). Every
// animation in Lumen uses this ~60fps timer instead.
window.lumenFrame = (callback) => setTimeout(() => callback(performance.now()), 16);

(() => {
  const SAMPLE = 28;
  const DEFAULT = { glow: [255, 138, 48], deep: [214, 84, 20], hot: [255, 226, 170] };

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function hslToRgb(h, s, l) {
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
  }

  /** @param {HTMLImageElement} image a loaded image */
  function paletteFromImage(image) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SAMPLE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
      const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);

      // vote by hue, weighted so vivid mid-tones count and greys, blacks and whites barely do
      const BUCKETS = 24;
      const weight = new Float32Array(BUCKETS);
      const saturation = new Float32Array(BUCKETS);
      let total = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        const vote = s * s * (1 - Math.abs(l - 0.5) * 1.6);
        if (vote <= 0) continue;
        const bucket = Math.min(BUCKETS - 1, Math.floor(h * BUCKETS));
        weight[bucket] += vote;
        saturation[bucket] += s * vote;
        total += vote;
      }

      let best = 0;
      for (let i = 1; i < BUCKETS; i++) if (weight[i] > weight[best]) best = i;
      // a black-and-white cover gets white light instead of an arbitrary hue
      if (total / (SAMPLE * SAMPLE) < 0.012) {
        return { glow: [235, 235, 240], deep: [150, 150, 160], hot: [255, 255, 255] };
      }

      const hue = (best + 0.5) / BUCKETS;
      const vivid = Math.max(0.82, saturation[best] / weight[best]);
      return {
        glow: hslToRgb(hue, vivid, 0.58),
        deep: hslToRgb(hue, vivid, 0.42),
        hot: hslToRgb(hue, Math.min(1, vivid + 0.1), 0.84),
      };
    } catch {
      return DEFAULT;
    }
  }

  window.LumenColor = { DEFAULT, paletteFromImage };
})();
