/**
 * rain-effect.js — Seasonal Effects: 🌧️ Rainy Days  (v2 — richer, still featherweight)
 * ─────────────────────────────────────────────────────────────────────────────
 * One <div> host (fixed, pointer-events:none, z-index:-1) containing:
 *   • CSS-only atmosphere: haze + 2 soft cloud banks (NO blur filter — pure gradients) + low mist
 *   • ONE <canvas>: 3 depth layers of rain, wind gusts, and tiny ground splashes/ripples
 *   • lightning: sky flash + a real jagged bolt (drawn once per strike on a 2nd canvas) + optional thunder sound
 *
 * What's new vs v1 (all canvas/CSS, zero per-particle DOM):
 *   – Wind gusts: slant breathes smoothly, so the rain sways instead of falling like a flat sheet
 *   – Splashes: near/mid drops "land" at different depths and spawn a small ripple ring
 *   – Near layer gets a soft glow pass; far layer stays ultra-cheap
 *   – Low-end auto-detect + adaptive quality: if frames get expensive it thins the rain / drops to 30fps
 *   – Cheaper atmosphere: removed `filter:blur(28px)` (big GPU/memory cost on phones)
 *
 * Contract: createRainEffect() → { start(), stop(), update?(flags) }; stop() releases EVERYTHING
 * (incl. the optional sound button + audio). update(flags) lets the manager pass Firestore flags
 * (used for effects.rainSound — see rain-sound.js).
 * Layering rules (unchanged): see AI_HANDOFF.md → "Seasonal Effects".
 */

const HOST_ID = 'seasonalFx-rain';

// Counts are per 1,000,000 px² of viewport, then clamped, so phones and tablets both stay light.
// ground: [min,max] fraction of viewport height where a drop lands (null = falls off-screen, no splash)
const LAYERS = [
  { density: 64, min: 36, max: 120, len: [8, 14],  speed: [520, 680],   width: 0.8, alpha: 0.16, ground: null,        glow: false }, // far
  { density: 32, min: 20, max: 70,  len: [14, 22], speed: [780, 960],   width: 1.1, alpha: 0.24, ground: [0.55, 1.0], glow: false }, // mid
  { density: 8,  min: 5,  max: 15,  len: [26, 42], speed: [1150, 1400], width: 1.6, alpha: 0.32, ground: [0.45, 1.0], glow: true  }, // near
];
const BASE_SLANT = 0.16;       // average horizontal drift per unit fall (wind)
const GUST = 0.07;             // how much gusts swing the slant (±)
const MAX_SLANT = BASE_SLANT + GUST + 0.03;
const MAX_SPLASH = 22;         // ring buffer — hard cap on ripples alive at once
const SPLASH_LIFE = 0.32;      // seconds
const MAX_DPR = 1.5;

export function createRainEffect() {
  let host, canvas, ctx, lightning, boltCv, boltCtx;
  let rafId = 0, lastT = 0, running = false;
  let w = 0, h = 0, dpr = 1;
  let layers = [];
  let lightningTimer = 0, lightningAnim = null, boltAnim = null, echoTimer = 0;
  let reducedMQ = null, reduced = false;

  // adaptive quality: 0 = full, 1 = lighter, 2 = lightest
  const lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 2;
  let quality = lowEnd ? 1 : 0;
  const QF = [1, 0.7, 0.45];             // share of drops drawn
  const FPS = [40, 32, 26];              // frame cap per quality level
  let costEma = 0, costN = 0;

  // splash ring buffer (typed arrays — no allocations per frame)
  const sx = new Float32Array(MAX_SPLASH), sy = new Float32Array(MAX_SPLASH);
  const sa = new Float32Array(MAX_SPLASH), ss = new Float32Array(MAX_SPLASH);
  let sHead = 0;

  // ── setup ────────────────────────────────────────────────────────────────
  function buildDom() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;' +
      'opacity:0;transition:opacity 1.2s ease;';

    const style = document.createElement('style');
    style.textContent = `
      #${HOST_ID} .fx-haze{position:absolute;inset:0;
        background:linear-gradient(180deg,rgba(18,28,48,.58) 0%,rgba(22,30,44,.26) 45%,rgba(14,20,32,.40) 100%);}
      #${HOST_ID} .fx-cloud{position:absolute;top:-22%;left:-30%;width:160%;height:62%;
        background:radial-gradient(ellipse 45% 55% at 30% 58%,rgba(74,92,120,.36),transparent 100%),
                   radial-gradient(ellipse 40% 50% at 72% 42%,rgba(56,72,100,.32),transparent 100%);
        will-change:transform;animation:fxCloudDrift 70s ease-in-out infinite alternate;}
      #${HOST_ID} .fx-cloud.b{top:-30%;opacity:.7;animation-duration:95s;animation-direction:alternate-reverse;}
      #${HOST_ID} .fx-mist{position:absolute;left:0;right:0;bottom:0;height:34%;
        background:linear-gradient(0deg,rgba(120,146,180,.13),transparent);}
      #${HOST_ID} .fx-flash{position:absolute;inset:0;opacity:0;will-change:opacity;
        background:radial-gradient(ellipse at 50% 0%,rgba(190,210,255,.55),rgba(120,150,210,.18) 45%,transparent 75%);}
      #${HOST_ID} canvas{position:absolute;inset:0;width:100%;height:100%;}
      #${HOST_ID} canvas.fx-bolt{opacity:0;will-change:opacity;}
      @keyframes fxCloudDrift{from{transform:translate3d(-4%,0,0)}to{transform:translate3d(4%,3%,0)}}
      @media (prefers-reduced-motion:reduce){#${HOST_ID} .fx-cloud{animation:none}}
    `;
    host.appendChild(style);
    host.insertAdjacentHTML('beforeend',
      '<div class="fx-haze"></div><div class="fx-cloud"></div><div class="fx-cloud b"></div><div class="fx-mist"></div>');
    canvas = document.createElement('canvas');
    host.appendChild(canvas);
    boltCv = document.createElement('canvas');           // bolt canvas: idle (blank + invisible) between strikes
    boltCv.className = 'fx-bolt';
    host.appendChild(boltCv);
    lightning = document.createElement('div');
    lightning.className = 'fx-flash';
    host.appendChild(lightning);
    document.body.appendChild(host);
    ctx = canvas.getContext('2d', { alpha: true });
    boltCtx = boltCv.getContext('2d');
    requestAnimationFrame(() => { if (host) host.style.opacity = '1'; }); // fade in
  }

  const rand = (a, b) => a + Math.random() * (b - a);

  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, lowEnd ? 1 : MAX_DPR);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    boltCv.width = Math.round(w); boltCv.height = Math.round(h);
    const area = (w * h) / 1e6;
    layers = LAYERS.map(cfg => {
      const n = Math.max(cfg.min, Math.min(cfg.max, Math.round(cfg.density * area)));
      const L = { cfg, n, x: new Float32Array(n), y: new Float32Array(n), len: new Float32Array(n),
                  v: new Float32Array(n), g: new Float32Array(n) };
      for (let i = 0; i < n; i++) seed(L, i, true);
      return L;
    });
    sa.fill(0);
  }

  function seed(L, i, anywhere) {
    L.x[i]   = rand(-h * MAX_SLANT, w);
    L.y[i]   = anywhere ? rand(-h, h * 0.9) : rand(-80, -10);
    L.len[i] = rand(L.cfg.len[0], L.cfg.len[1]);
    L.v[i]   = rand(L.cfg.speed[0], L.cfg.speed[1]);
    const g = L.cfg.ground;
    L.g[i]   = g ? h * rand(g[0], g[1]) : h + 40;   // landing depth (splash) or off-screen exit
  }

  function splash(x, y) {
    sx[sHead] = x; sy[sHead] = y; sa[sHead] = SPLASH_LIFE; ss[sHead] = rand(0.8, 1.25);
    sHead = (sHead + 1) % MAX_SPLASH;
  }

  // ── animation ────────────────────────────────────────────────────────────
  function frame(t) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    if (t - lastT < 1000 / FPS[quality] - 1) return;
    const dt = Math.min((t - lastT) / 1000, 0.05); // clamp after tab switches/jank
    lastT = t;
    const t0 = performance.now();

    // Wind gust: two slow sines → natural sway (cheap: 2 sin per frame, not per drop)
    const slant = BASE_SLANT + GUST * Math.sin(t * 0.00042) + 0.03 * Math.sin(t * 0.0013 + 1.7);

    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    const qf = QF[quality];

    for (const L of layers) {
      const cfg = L.cfg, hasGround = !!cfg.ground;
      const act = Math.max(1, Math.ceil(L.n * qf));
      // advance + collect
      for (let i = 0; i < act; i++) {
        const dy = L.v[i] * dt;
        L.y[i] += dy;
        L.x[i] += dy * slant;
        if (L.y[i] >= L.g[i]) {
          if (hasGround && L.y[i] < h) splash(L.x[i], L.g[i]);
          seed(L, i, false);
        }
      }
      // near layer: soft glow pass first (wider, fainter) — one extra stroke only for ~10 drops
      if (cfg.glow) {
        ctx.lineWidth = cfg.width * 3.2;
        ctx.strokeStyle = `rgba(150,180,225,${cfg.alpha * 0.28})`;
        ctx.beginPath();
        for (let i = 0; i < act; i++) { ctx.moveTo(L.x[i], L.y[i]); ctx.lineTo(L.x[i] + L.len[i] * slant, L.y[i] + L.len[i]); }
        ctx.stroke();
      }
      ctx.lineWidth = cfg.width;
      ctx.strokeStyle = `rgba(178,203,238,${cfg.alpha})`;
      ctx.beginPath();                       // ONE path + ONE stroke per layer
      for (let i = 0; i < act; i++) {
        ctx.moveTo(L.x[i], L.y[i]);
        ctx.lineTo(L.x[i] + L.len[i] * slant, L.y[i] + L.len[i]);
      }
      ctx.stroke();
    }

    // Splashes: flat ripple rings, 2 alpha buckets → 2 strokes total
    ctx.lineWidth = 1;
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? 'rgba(190,212,242,.15)' : 'rgba(190,212,242,.30)';
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < MAX_SPLASH; i++) {
        if (sa[i] <= 0) continue;
        const age = 1 - sa[i] / SPLASH_LIFE;             // 0 → 1
        if ((age < 0.5) === !!pass) continue;
        const r = (1.5 + age * 9) * ss[i];
        ctx.moveTo(sx[i] + r, sy[i]);
        ctx.ellipse(sx[i], sy[i], r, r * 0.34, 0, 0, 6.2832);
        any = true;
      }
      if (any) ctx.stroke();
    }
    for (let i = 0; i < MAX_SPLASH; i++) if (sa[i] > 0) sa[i] -= dt;

    // Adaptive quality: if average frame work stays heavy, thin the rain (never raises again → no flip-flop)
    costEma = costEma ? costEma * 0.94 + (performance.now() - t0) * 0.06 : (performance.now() - t0);
    if (++costN > 90 && quality < 2 && costEma > 5.5) { quality++; costN = 0; costEma = 0; }
  }

  function startLoop() {
    if (running || reduced || document.hidden) return;
    running = true; lastT = 0;
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // ── lightning: sky flash + jagged bolt + thunder (all one-off draws, zero per-frame cost) ──
  // Midpoint-displacement polyline from (x0,y0) down to (x1,y1)
  function bolt(x0, y0, x1, y1, jitter, out) {
    const pts = [[x0, y0], [x1, y1]];
    for (let pass = 0; pass < 5; pass++) {
      for (let i = pts.length - 2; i >= 0; i--) {
        const a = pts[i], b = pts[i + 1];
        pts.splice(i + 1, 0, [(a[0] + b[0]) / 2 + rand(-jitter, jitter), (a[1] + b[1]) / 2 + rand(-jitter * 0.3, jitter * 0.3)]);
      }
      jitter *= 0.55;
    }
    out.push(pts);
    return pts;
  }

  function drawBolt(power) {
    if (!boltCtx) return;
    const c = boltCtx;
    c.clearRect(0, 0, w, h);
    const x0 = rand(0.12, 0.88) * w;
    const y1 = h * rand(0.3, 0.5 + 0.2 * power);            // stronger strike reaches further down
    const paths = [];
    const main = bolt(x0, -10, x0 + rand(-0.18, 0.18) * w, y1, w * 0.07, paths);
    for (let k = 0; k < 2; k++) {                            // 1–2 short branches off the main bolt
      const at = main[Math.floor(rand(0.25, 0.7) * main.length)];
      bolt(at[0], at[1], at[0] + rand(-0.22, 0.22) * w, at[1] + h * rand(0.1, 0.22), w * 0.04, paths);
    }
    c.lineCap = c.lineJoin = 'round';
    const pass = (lw, col) => {
      c.lineWidth = lw; c.strokeStyle = col;
      c.beginPath();
      paths.forEach((pts, idx) => {
        c.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      });
      c.stroke();
    };
    pass(9,   'rgba(150,180,255,.10)');                      // outer glow
    pass(4,   'rgba(190,210,255,.30)');
    pass(1.6, 'rgba(255,255,255,.95)');                      // hot core
  }

  function strike() {
    if (document.hidden || !lightning || !lightning.animate) return;
    const dist = Math.random();                              // 0 = right overhead, 1 = far away
    const power = 1 - dist * 0.75;                           // 1 … 0.25 → flash brightness + sound loudness
    const pk = 0.28 + 0.34 * power;                          // sky-flash peak opacity (was 0.20 flat)

    if (lightningAnim) lightningAnim.cancel();
    lightningAnim = lightning.animate(
      [{ opacity: 0 }, { opacity: pk, offset: 0.06 }, { opacity: pk * 0.25, offset: 0.14 },
       { opacity: pk * 0.9, offset: 0.22 }, { opacity: pk * 0.1, offset: 0.4 },
       { opacity: pk * 0.35, offset: 0.48 }, { opacity: 0 }],
      { duration: 900, easing: 'ease-out' });

    if (power > 0.45 && boltCv && boltCv.animate) {          // distant strikes = only a glow behind the clouds
      drawBolt(power);
      if (boltAnim) boltAnim.cancel();
      boltAnim = boltCv.animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 0.15, offset: 0.2 },
         { opacity: 0.9, offset: 0.3 }, { opacity: 0, offset: 0.65 }, { opacity: 0 }],
        { duration: 600, easing: 'linear' });
      boltAnim.onfinish = () => { if (boltCtx) boltCtx.clearRect(0, 0, w, h); };
    }

    // light first, sound after — the farther away, the longer the gap
    if (sndOn && snd) snd.thunder(0.35 + dist * 2.6, power);
  }

  function scheduleLightning(first) {
    clearTimeout(lightningTimer);
    if (reduced) return;
    lightningTimer = setTimeout(() => {
      strike();
      if (Math.random() < 0.28) {                            // sometimes a quick second strike
        clearTimeout(echoTimer);
        echoTimer = setTimeout(strike, rand(450, 1300));
      }
      scheduleLightning();
    }, first ? rand(6000, 10000) : rand(14000, 34000));      // was 16–42 s; first one arrives quickly
  }

  // ── optional rain SOUND (Admin flag effects.rainSound; customer opts in; off by default) ──
  const SND_KEY = 'fx_rain_sound';
  let soundAllowed = false, soundBtn = null, snd = null, sndOn = false, armed = false;
  const lsGet = () => { try { return localStorage.getItem(SND_KEY); } catch (_) { return null; } };
  const lsSet = (v) => { try { localStorage.setItem(SND_KEY, v); } catch (_) {} };

  function paintBtn() {
    if (!soundBtn) return;
    soundBtn.textContent = sndOn ? '🔊' : '🔇';
    soundBtn.setAttribute('aria-pressed', String(sndOn));
    soundBtn.title = sndOn ? 'Rain sound on — tap to mute'
                           : (armed ? 'Tap anywhere to resume rain sound' : 'Turn on rain sound');
    soundBtn.classList.toggle('on', sndOn);
  }

  let sndMod = null;                              // rain-sound.js module (tiny, loaded once)
  function loadSoundModule() {
    return sndMod ? Promise.resolve(sndMod)
      : import('./rain-sound.js').then((m) => (sndMod = m));
  }

  function enableSound() {                       // called from a user gesture
    if (sndOn || snd || !soundAllowed || !host) return;
    const begin = () => {
      const engine = snd = sndMod.createRainSound();       // fresh engine each time (single-use)
      engine.start().then(() => {
        if (snd !== engine) { engine.stop(); return; }     // muted / turned off meanwhile
        sndOn = true; armed = false; lsSet('1'); paintBtn();
      }).catch(() => { if (snd === engine) snd = null; sndOn = false; paintBtn(); });
    };
    if (sndMod) begin();                                   // sync → keeps the user-gesture activation
    else loadSoundModule().then(() => { if (soundAllowed && host && !snd) begin(); });
  }

  function disableSound(persist) {
    disarm();
    if (snd) { snd.stop(); snd = null; }
    sndOn = false;
    if (persist) lsSet('0');
    paintBtn();
  }

  function onFirstGesture() { disarm(); enableSound(); }
  function arm() {                                // remembered "on": resume on next tap anywhere
    if (armed) return;
    armed = true;
    document.addEventListener('pointerdown', onFirstGesture, { once: true, capture: true, passive: true });
    document.addEventListener('keydown', onFirstGesture, { once: true, capture: true });
  }
  function disarm() {
    armed = false;
    document.removeEventListener('pointerdown', onFirstGesture, true);
    document.removeEventListener('keydown', onFirstGesture, true);
  }

  function mountSoundBtn() {
    if (soundBtn) return;
    if (!document.getElementById('seasonalFx-rain-snd-css')) {
      const st = document.createElement('style');
      st.id = 'seasonalFx-rain-snd-css';
      st.textContent = `
        #seasonalFx-rain-snd{position:fixed;left:18px;bottom:calc(152px + env(safe-area-inset-bottom,0px));z-index:65;
          width:40px;height:40px;border-radius:50%;border:1.5px solid var(--accent,#f5a623);
          background:rgba(23,25,35,.92);color:#fff;font-size:18px;line-height:1;cursor:pointer;
          display:flex;align-items:center;justify-content:center;padding:0;opacity:.85;
          -webkit-tap-highlight-color:transparent;box-shadow:0 2px 10px rgba(0,0,0,.35)}
        #seasonalFx-rain-snd.on{opacity:1;background:var(--accent,#f5a623)}
        body:not(:has(#cartBar:not(.hidden))) #seasonalFx-rain-snd{bottom:calc(86px + env(safe-area-inset-bottom,0px))}`;
      document.head.appendChild(st);
    }
    soundBtn = document.createElement('button');
    soundBtn.id = 'seasonalFx-rain-snd';
    soundBtn.type = 'button';
    soundBtn.setAttribute('aria-label', 'Rain sound');
    soundBtn.addEventListener('click', () => { sndOn ? disableSound(true) : enableSound(); });
    document.body.appendChild(soundBtn);
    loadSoundModule();                            // tiny module; pre-load so the tap can start audio instantly
    if (lsGet() === '1') arm();
    paintBtn();
  }

  function unmountSoundBtn() {
    disableSound(false);
    if (soundBtn) { soundBtn.remove(); soundBtn = null; }
    const st = document.getElementById('seasonalFx-rain-snd-css'); if (st) st.remove();
  }

  function updateFlags(flags) {                   // called by SeasonalEffectsManager on every snapshot
    soundAllowed = !!flags && flags.rainSound === true;
    if (!host) return;
    soundAllowed ? mountSoundBtn() : unmountSoundBtn();
  }

  // ── lifecycle wiring ─────────────────────────────────────────────────────
  function onVisibility() {
    if (document.hidden) { stopLoop(); if (sndOn && snd) snd.suspend(); }
    else { startLoop(); if (sndOn && snd) snd.resume(); }
  }
  let resizeRaf = 0;
  function onResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { if (host) resize(); });
  }
  function applyMotionPreference() {
    reduced = !!(reducedMQ && reducedMQ.matches);
    if (reduced) {           // keep the calm atmosphere, drop rain + lightning motion
      stopLoop();
      clearTimeout(lightningTimer); clearTimeout(echoTimer);
      ctx && ctx.clearRect(0, 0, w, h);
    } else {
      startLoop();
      scheduleLightning(true);
    }
  }

  return {
    start() {
      if (host) return;                       // idempotent
      buildDom();
      reducedMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
      resize();
      window.addEventListener('resize', onResize, { passive: true });
      window.addEventListener('orientationchange', onResize, { passive: true });
      document.addEventListener('visibilitychange', onVisibility);
      reducedMQ.addEventListener ? reducedMQ.addEventListener('change', applyMotionPreference)
                                 : reducedMQ.addListener(applyMotionPreference);
      applyMotionPreference();
    },
    update: updateFlags,
    stop() {
      if (!host) return;
      unmountSoundBtn();
      stopLoop();
      clearTimeout(lightningTimer); clearTimeout(echoTimer);
      cancelAnimationFrame(resizeRaf);
      if (lightningAnim) { lightningAnim.cancel(); lightningAnim = null; }
      if (boltAnim) { boltAnim.cancel(); boltAnim = null; }
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (reducedMQ) {
        reducedMQ.removeEventListener ? reducedMQ.removeEventListener('change', applyMotionPreference)
                                      : reducedMQ.removeListener(applyMotionPreference);
      }
      const el = host;
      host = canvas = ctx = lightning = boltCv = boltCtx = null; layers = [];
      el.style.opacity = '0';                  // fade out, then remove
      setTimeout(() => el.remove(), 1300);
    },
  };
}
