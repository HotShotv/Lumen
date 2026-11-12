// The light around the screen edge: stacked soft strokes plus embers, swelling with the beat.
(() => {
  // drawn at half resolution: the upscale is what makes the glow soft, and it costs a quarter
  const RENDER_SCALE = 0.5;
  const EASE_IN_MS = 500;
  const EASE_OUT_MS = 900;
  const MAX_EMBERS = 140;

  // outer haze first, bright core last; widths in px at 100% thickness
  const LAYERS = [
    { width: 78, alpha: 0.04, color: "deep" },
    { width: 52, alpha: 0.07, color: "deep" },
    { width: 33, alpha: 0.12, color: "glow" },
    { width: 19, alpha: 0.22, color: "glow" },
    { width: 9.5, alpha: 0.5, color: "glow" },
    { width: 3.4, alpha: 0.95, color: "hot" },
  ];

  const rgba = ([r, g, b], a) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => { enabled: boolean, playing: boolean, thickness: number, palette: object }} read
   */
  function createEdgeLight(canvas, read) {
    const ctx = canvas.getContext("2d");
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = 0;
    let energy = 0;
    let spawnDebt = 0;
    const embers = [];

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * RENDER_SCALE));
      canvas.height = Math.max(1, Math.round(height * RENDER_SCALE));
    };
    new ResizeObserver(resize).observe(canvas);
    resize();

    const spawnEmber = () => {
      let d = Math.random() * 2 * (width + height);
      let x;
      let y;
      let nx = 0;
      let ny = 0;
      if (d < width) [x, y, ny] = [d, 0, 1];
      else if ((d -= width) < height) [x, y, nx] = [width, d, -1];
      else if ((d -= height) < width) [x, y, ny] = [width - d, height, -1];
      else [x, y, nx] = [0, d - width, 1];
      const speed = 10 + Math.random() * 34;
      embers.push({
        x,
        y,
        vx: nx * speed + (Math.random() - 0.5) * 18,
        // sparks drift up like heat, whichever edge they leave
        vy: ny * speed - 8 - Math.random() * 16,
        life: 0,
        ttl: 700 + Math.random() * 1300,
        size: 0.9 + Math.random() * 1.9,
      });
    };

    const draw = (now) => {
      frame = 0;
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      const state = read();
      const lit = state.enabled && state.playing;

      energy += ((lit ? 1 : 0) - energy) * Math.min(1, dt / (lit ? EASE_IN_MS : EASE_OUT_MS));

      const beat = lit ? window.LumenBeat.sample(now) : null;
      // no audio capture: breathe slowly instead of sitting still
      const pulse = beat ? beat.pulse : 0.2 + 0.2 * Math.sin(now / 900);
      const level = beat ? beat.level : 0.45;

      ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // paused and fully faded: stop drawing until the music comes back
      if (!lit && energy < 0.006 && embers.length === 0) {
        energy = 0;
        last = 0;
        return;
      }

      ctx.globalCompositeOperation = "lighter";
      const swell = (0.72 + 0.5 * pulse + 0.3 * level) * (state.thickness / 100);
      const brightness = energy * (0.62 + 0.3 * level + 0.25 * pulse);

      for (const layer of LAYERS) {
        ctx.lineWidth = layer.width * swell * 2; // half of each stroke falls off-screen
        ctx.strokeStyle = rgba(state.palette[layer.color], Math.min(1, layer.alpha * brightness));
        ctx.strokeRect(0, 0, width, height);
      }

      // more embers when the song is loud, a burst on every kick
      spawnDebt += energy * dt * (0.02 + 0.05 * level + 0.26 * pulse * pulse);
      while (spawnDebt >= 1) {
        spawnDebt -= 1;
        if (embers.length < MAX_EMBERS) spawnEmber();
      }
      for (let i = embers.length - 1; i >= 0; i--) {
        const ember = embers[i];
        ember.life += dt;
        if (ember.life >= ember.ttl) {
          embers.splice(i, 1);
          continue;
        }
        ember.x += (ember.vx * dt) / 1000;
        ember.y += (ember.vy * dt) / 1000;
        const fade = 1 - ember.life / ember.ttl;
        ctx.fillStyle = rgba(state.palette.hot, fade * fade * 0.9);
        ctx.beginPath();
        ctx.arc(ember.x, ember.y, ember.size * (0.6 + fade), 0, Math.PI * 2);
        ctx.fill();
      }

      frame = window.lumenFrame(draw);
    };

    const wake = () => {
      if (!frame) frame = window.lumenFrame(draw);
    };
    wake();
    return { wake };
  }

  window.LumenEdge = { createEdgeLight };
})();
