/**
 * rain-sound.js — 🌧️ synthesized rain ambience (Web Audio, NO audio files)
 * ─────────────────────────────────────────────────────────────────────────────
 * Loaded lazily by rain-effect.js only when Admin enables "Rain Sound" (effects.rainSound).
 * Rain = two looping pink-noise layers (soft body + high patter) with slow random swells,
 * plus thunder (crack + rolling rumble) that rain-effect.js triggers a moment after each lightning flash.
 * Thunder has its own bus (not scaled by the gentle rain master) and keeps mid-range content so it is
 * audible on phone speakers, which can't reproduce deep bass.
 *
 *   const s = createRainSound();
 *   s.start();          // MUST be called synchronously from a user gesture (tap) — autoplay rules
 *   s.thunder(1.4, 0.8); // thunder in ~1.4 s; power 0..1 (1 = close & loud crack, 0.2 = far & soft)
 *   s.suspend(); s.resume();   // tab hidden / visible
 *   s.stop();           // fade out, then release the AudioContext and every node/timer
 */
const VOL = 0.2;   // master volume — deliberately gentle (restaurant setting)

export function createRainSound() {
  let ctx = null, master = null, thunderBus = null, patter = null, body = null, noiseBuf = null;
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
      thunderBus = ctx.createGain();            // thunder skips the (deliberately quiet) rain master
      thunderBus.gain.value = 1;
      thunderBus.connect(ctx.destination);

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

    /**
     * Thunder `delay` seconds from now (light-before-sound). power 0..1: 1 = close (sharp crack + loud
     * rolling rumble, short delay), ~0.2 = distant (soft, muffled, long rumble).
     */
    thunder(delay = 1.2, power = 0.6) {
      if (!alive || !ctx || ctx.state !== 'running') return;
      const p = Math.max(0.15, Math.min(1, power));
      const t0 = ctx.currentTime + delay;
      const nodes = [];
      const noise = (offset) => {
        const s = ctx.createBufferSource();
        s.buffer = noiseBuf; s.loop = true;
        s.start(t0, offset);
        nodes.push(s);
        return s;
      };

      // 1) CRACK — only for close strikes: a very short, bright burst (mid/high noise, fast decay)
      if (p > 0.55) {
        const c = noise(Math.random() * 3);
        const cf = filt('bandpass', 1300, 0.6);
        const cg = ctx.createGain();
        const cp = (p - 0.4) * 1.5;                          // ≈0.1 .. 0.9
        cg.gain.setValueAtTime(0, t0);
        cg.gain.linearRampToValueAtTime(cp * 1.7, t0 + 0.012);
        cg.gain.setTargetAtTime(0, t0 + 0.02, 0.09);
        c.connect(cf).connect(cg).connect(thunderBus);
        c.stop(t0 + 1);
        nodes.push(cf, cg);
      }

      // 2) ROLLING RUMBLE — low-passed noise; the filter closes over time (bright boom → dark rumble)
      const r = noise(Math.random() * 3);
      const lp = filt('lowpass', 700 + p * 700, 0.8);
      lp.frequency.setValueAtTime(700 + p * 700, t0);
      lp.frequency.setTargetAtTime(130, t0 + 0.3, 1.5 + (1 - p));
      const g = ctx.createGain();
      const peak = 0.2 + p * 0.4;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.1 + (1 - p) * 0.5);
      let t = t0 + 0.6;
      const bumps = 2 + Math.floor(Math.random() * 3);      // secondary rolls, like real thunder echoing
      for (let i = 0; i < bumps; i++) {
        t += 0.4 + Math.random() * 0.8;
        g.gain.linearRampToValueAtTime(peak * (0.4 + Math.random() * 0.5), t);
      }
      g.gain.setTargetAtTime(0, t, 1.2 + p * 0.8);           // long tail
      r.connect(lp).connect(g).connect(thunderBus);
      r.stop(t + 7);
      nodes.push(lp, g);

      r.onended = () => nodes.forEach(n => { try { n.disconnect(); } catch (_) {} });
    },

    suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); },
    resume()  { if (ctx && ctx.state === 'suspended') ctx.resume(); },

    stop() {
      if (!alive) return;
      alive = false;
      timers.forEach(clearInterval); timers = [];
      const c = ctx, m = master, tb = thunderBus, ss = srcs;
      ctx = master = thunderBus = patter = body = noiseBuf = null; srcs = [];
      try {
        m.gain.cancelScheduledValues(c.currentTime);
        m.gain.setTargetAtTime(0, c.currentTime, 0.12);        // quick fade-out
        tb.gain.setTargetAtTime(0, c.currentTime, 0.12);
      } catch (_) {}
      setTimeout(() => {
        ss.forEach(s => { try { s.stop(); s.disconnect(); } catch (_) {} });
        try { c.close(); } catch (_) {}
      }, 700);
    },
  };
}
