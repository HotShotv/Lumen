// Beat detection from the PC's own audio output (never the microphone).
// main.js answers the capture request with system-audio loopback.
(() => {
  const FFT_SIZE = 1024;
  const BASS = [1, 6]; // roughly 40-250 Hz
  const BODY = [1, 96];
  const KICK_RATIO = 1.28;
  const KICK_FLOOR = 8;
  const KICK_GAP_MS = 130;
  const PULSE_DECAY_MS = 190;

  let analyser = null;
  let bins = new Uint8Array(0);
  let bassAverage = 0;
  let peak = 40;
  let pulse = 0;
  let level = 0;
  let lastKickAt = 0;
  let lastSampleAt = 0;

  const average = (from, to) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += bins[i];
    return sum / (to - from);
  };

  /** Called by main.js once the window is up. Resolves to a short status for the log. */
  async function start() {
    if (analyser) return "already running";
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      // only the sound is wanted: drop the picture straight away
      stream.getVideoTracks().forEach((track) => track.stop());
      if (stream.getAudioTracks().length === 0) return "no audio track";

      const context = new AudioContext();
      const node = context.createAnalyser();
      node.fftSize = FFT_SIZE;
      node.smoothingTimeConstant = 0.55;
      // analyser only: nothing is connected to the speakers, so there is no echo
      context.createMediaStreamSource(stream).connect(node);
      bins = new Uint8Array(node.frequencyBinCount);
      analyser = node;
      return "listening to system audio";
    } catch (error) {
      return `unavailable: ${error.message}`;
    }
  }

  /** Call once per frame. Null until system audio is available. */
  function sample(now) {
    if (!analyser) return null;
    const dt = lastSampleAt ? Math.min(100, now - lastSampleAt) : 16;
    lastSampleAt = now;
    analyser.getByteFrequencyData(bins);

    const bass = average(BASS[0], BASS[1]);
    const body = average(BODY[0], BODY[1]);

    // a kick is bass well above its own recent average
    if (bass > bassAverage * KICK_RATIO + KICK_FLOOR && now - lastKickAt > KICK_GAP_MS) {
      pulse = 1;
      lastKickAt = now;
    } else {
      pulse *= Math.exp(-dt / PULSE_DECAY_MS);
    }
    bassAverage += (bass - bassAverage) * Math.min(1, dt / 420);

    // levelled against a slowly falling peak, so quiet songs still move the light
    peak = Math.max(body, peak - dt * 0.004, 24);
    level += (Math.min(1, body / peak) - level) * Math.min(1, dt / 140);

    return { pulse, level };
  }

  window.LumenBeat = { start, sample };
  window.lumenStartAudio = start;
})();
