/**
 * rain-sound.js — 🌧️ synthesized rain ambience (Web Audio, NO audio files)
 * ─────────────────────────────────────────────────────────────────────────────
 * Loaded lazily by rain-effect.js only when Admin enables "Rain Sound" (effects.rainSound).
 * Rain = two looping pink-noise layers (soft body + high patter) with slow random swells,
 * plus rare, soft, low thunder that rain-effect.js triggers a moment after each lightning flash.
 *
 *   const s = createRainSound();
 *   s.start();          // MUST be called synchronously from a user gesture (tap) — autoplay rules
 *   s.thunder(1.4);     // rumble in ~1.4 s
 *   s.suspend(); s.resume();   // tab hidden / visible
 *   s.stop();           // fade out, then release the AudioContext and every node/timer
 */
const VOL = 0.2;   // master volume — deliberately gentle (restaurant setting)

export function createRainSound() {
  let ctx = null, master = null, patter = null, body = null, noiseBuf = null;
  let srcs = [], timers = [], alive = false;

  function makePink(sec) {
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {                       // Paul Kellet pink-noise filter
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    // Short crossfade so the loop point never clicks.
    const xf = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < xf; i++) { const k = i / xf; d[i] = d[i] * k + d[len - xf + i] * (1 - k); }
    return buf;
  }

  function loop(offset) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf; s.loop = true;
    s.start(0, offset);
    srcs.push(s);
    return s;
  }

  function filt(type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
    return f;
  }

  return {
    /** Call synchronously inside a tap handler. Returns a promise that resolves once running. */
    start() {
      if (alive) return Promise.resolve();
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return Promise.reject(new Error('no WebAudio'));
      ctx = new AC();
      const resumed = ctx.resume ? ctx.resume() : Promise.resolve();
      alive = true;

      noiseBuf = makePink(4);
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);

      // Soft body of the rain
      body = ctx.createGain(); body.gain.value = 0.55;
      loop(0).connect(filt('highpass', 260)).connect(filt('lowpass', 2600)).connect(body);
      body.connect(master);

      // High patter (drops on surfaces) — gain gets random swells below
      patter = ctx.createGain(); patter.gain.value = 0.12;
      loop(1.7).connect(filt('bandpass', 5200, 0.8)).connect(patter);
      patter.connect(master);

      // Slow, natural intensity variation (tiny cost: a few automation calls per second)
      timers.push(setInterval(() => {
        if (!ctx || ctx.state !== 'running') return;
        patter.gain.setTargetAtTime(0.07 + Math.random() * 0.17, ctx.currentTime, 0.09);
      }, 150));
      timers.push(setInterval(() => {
        if (!ctx || ctx.state !== 'running') return;
        body.gain.setTargetAtTime(0.45 + Math.random() * 0.2, ctx.currentTime, 1.2);
      }, 3500));

      master.gain.linearRampToValueAtTime(VOL, ctx.currentTime + 1.8);   // gentle fade-in
      return resumed;
    },

    /** Soft distant rumble, `delay` seconds from now (matches light-before-sound). */
    thunder(delay = 1.2) {
      if (!alive || !ctx || ctx.state !== 'running') return;
      const t0 = ctx.currentTime + delay;
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      const lp = filt('lowpass', 210);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(1.5, t0 + 0.7);
      g.gain.setTargetAtTime(0, t0 + 0.9, 1.5);
      s.connect(lp).connect(g).connect(master);
      s.start(t0, Math.random() * 2);
      s.stop(t0 + 8);
      s.onended = () => { try { s.disconnect(); lp.disconnect(); g.disconnect(); } catch (_) {} };
    },

    suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); },
    resume()  { if (ctx && ctx.state === 'suspended') ctx.resume(); },

    stop() {
      if (!alive) return;
      alive = false;
      timers.forEach(clearInterval); timers = [];
      const c = ctx, m = master, ss = srcs;
      ctx = master = patter = body = noiseBuf = null; srcs = [];
      try {
        m.gain.cancelScheduledValues(c.currentTime);
        m.gain.setTargetAtTime(0, c.currentTime, 0.12);        // quick fade-out
      } catch (_) {}
      setTimeout(() => {
        ss.forEach(s => { try { s.stop(); s.disconnect(); } catch (_) {} });
        try { c.close(); } catch (_) {}
      }, 700);
    },
  };
}
