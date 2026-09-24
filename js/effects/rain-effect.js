/**
 * rain-effect.js — Seasonal Effects: 🌧️ Rainy Days
 * ─────────────────────────────────────────────────────────────────────────────
 * One <div> host (fixed, pointer-events:none) containing:
 *   • a CSS-only atmosphere (dark blue/grey haze, slowly drifting)   — GPU transforms
 *   • ONE <canvas> with 3 depth layers of rain (far / mid / near)    — no per-drop DOM
 *   • a faint lightning glow overlay (rare, very subtle)
 *
 * Contract (every effect implements the same interface so the manager stays generic):
 *   const fx = createRainEffect();   // factory registered with SeasonalEffectsManager
 *   fx.start();                      // mount + animate
 *   fx.stop();                       // unmount + release EVERYTHING (rAF, timers, listeners, DOM)
 *
 * Layering: host is `position:fixed; inset:0; z-index:-1; pointer-events:none`, i.e. BEHIND
 * all page content. See AI_HANDOFF.md → "Seasonal Effects" for the (tiny) requirement this
 * places on the page background.
 */

const HOST_ID = 'seasonalFx-rain';

// Depth layers: far = many/thin/slow/faint … near = few/long/fast/brighter.
// Counts are per 1,000,000 px² of viewport, then clamped, so phones and tablets both stay light.
const LAYERS = [
  { density: 70, min: 40,  max: 140, len: [8, 14],  speed: [520, 680],  width: 0.8, alpha: 0.16 }, // far
  { density: 34, min: 22,  max: 80,  len: [14, 22], speed: [780, 960],  width: 1.1, alpha: 0.24 }, // mid
  { density: 8,  min: 5,   max: 16,  len: [26, 42], speed: [1150, 1400], width: 1.7, alpha: 0.30 }, // near (larger foreground drops)
];
const SLANT = 0.16;            // horizontal drift per unit fall (wind)
const MAX_DPR = 1.5;           // cap canvas resolution — rain is soft, no need for 3x
const FRAME_MS = 1000 / 40;    // ~40 fps cap: smooth, and kinder to tablet batteries

export function createRainEffect() {
  let host, canvas, ctx, lightning;
  let rafId = 0, lastT = 0, running = false;
  let w = 0, h = 0, dpr = 1;
  let layers = [];
  let lightningTimer = 0, lightningAnim = null;
  let reducedMQ = null, reduced = false;

  // ── setup helpers ────────────────────────────────────────────────────────
  function buildDom() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;' +
      'opacity:0;transition:opacity 1.2s ease;';

    // Atmosphere (pure CSS): dark blue-grey wash + two slow drifting cloud banks.
    const style = document.createElement('style');
    style.textContent = `
      #${HOST_ID} .fx-haze{position:absolute;inset:0;
        background:linear-gradient(180deg,rgba(18,28,48,.55) 0%,rgba(22,30,44,.28) 45%,rgba(14,20,32,.38) 100%);}
      #${HOST_ID} .fx-cloud{position:absolute;top:-25%;left:-30%;width:160%;height:65%;
        background:radial-gradient(ellipse at 30% 60%,rgba(70,86,112,.34),transparent 62%),
                   radial-gradient(ellipse at 72% 40%,rgba(52,68,94,.30),transparent 60%);
        filter:blur(28px);will-change:transform;animation:fxCloudDrift 70s ease-in-out infinite alternate;}
      #${HOST_ID} .fx-cloud.b{top:-32%;opacity:.7;animation-duration:95s;animation-direction:alternate-reverse;}
      #${HOST_ID} .fx-flash{position:absolute;inset:0;opacity:0;will-change:opacity;
        background:radial-gradient(ellipse at 50% 0%,rgba(190,210,255,.55),rgba(120,150,210,.18) 45%,transparent 75%);}
      #${HOST_ID} canvas{position:absolute;inset:0;width:100%;height:100%;}
      @keyframes fxCloudDrift{from{transform:translate3d(-4%,0,0)}to{transform:translate3d(4%,3%,0)}}
      @media (prefers-reduced-motion:reduce){#${HOST_ID} .fx-cloud{animation:none}}
    `;
    host.appendChild(style);
    host.insertAdjacentHTML('beforeend',
      '<div class="fx-haze"></div><div class="fx-cloud"></div><div class="fx-cloud b"></div>');
    canvas = document.createElement('canvas');
    host.appendChild(canvas);
    lightning = document.createElement('div');
    lightning.className = 'fx-flash';
    host.appendChild(lightning);
    document.body.appendChild(host);
    ctx = canvas.getContext('2d', { alpha: true });
    requestAnimationFrame(() => { if (host) host.style.opacity = '1'; }); // fade in
  }

  const rand = (a, b) => a + Math.random() * (b - a);

  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const area = (w * h) / 1e6;
    // Typed arrays per layer: x, y, len, speed — no objects allocated per frame.
    layers = LAYERS.map(cfg => {
      const n = Math.max(cfg.min, Math.min(cfg.max, Math.round(cfg.density * area)));
      const L = { cfg, n, x: new Float32Array(n), y: new Float32Array(n),
                  len: new Float32Array(n), v: new Float32Array(n) };
      for (let i = 0; i < n; i++) seed(L, i, true);
      return L;
    });
  }

  function seed(L, i, anywhere) {
    L.x[i]   = rand(-h * SLANT, w);
    L.y[i]   = anywhere ? rand(-h, h) : rand(-60, -10);
    L.len[i] = rand(L.cfg.len[0], L.cfg.len[1]);
    L.v[i]   = rand(L.cfg.speed[0], L.cfg.speed[1]);
  }

  // ── animation ────────────────────────────────────────────────────────────
  function frame(t) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    if (t - lastT < FRAME_MS) return;
    const dt = Math.min((t - lastT) / 1000, 0.05); // clamp after tab switches/jank
    lastT = t;

    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    for (const L of layers) {
      ctx.lineWidth = L.cfg.width;
      ctx.strokeStyle = `rgba(175,200,235,${L.cfg.alpha})`;
      ctx.beginPath();                       // ONE path + ONE stroke per layer
      for (let i = 0; i < L.n; i++) {
        const dy = L.v[i] * dt;
        L.y[i] += dy;
        L.x[i] += dy * SLANT;
        if (L.y[i] > h + 40) { seed(L, i, false); L.x[i] = rand(-h * SLANT, w); }
        const x = L.x[i], y = L.y[i], l = L.len[i];
        ctx.moveTo(x, y);
        ctx.lineTo(x + l * SLANT, y + l);
      }
      ctx.stroke();
    }
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

  // ── lightning: rare, ultra-subtle double flicker ─────────────────────────
  function scheduleLightning() {
    clearTimeout(lightningTimer);
    if (reduced) return;
    lightningTimer = setTimeout(() => {
      if (!document.hidden && lightning && lightning.animate) {
        lightningAnim = lightning.animate(
          [{ opacity: 0 }, { opacity: 0.16 }, { opacity: 0.03 }, { opacity: 0.11 }, { opacity: 0 }],
          { duration: 900, easing: 'ease-out' });
      }
      scheduleLightning();
    }, rand(14000, 38000));
  }

  // ── lifecycle wiring ─────────────────────────────────────────────────────
  function onVisibility() { document.hidden ? stopLoop() : startLoop(); }
  let resizeRaf = 0;
  function onResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { if (host) resize(); });
  }
  function applyMotionPreference() {
    reduced = !!(reducedMQ && reducedMQ.matches);
    if (reduced) {           // keep the calm atmosphere, drop rain + lightning motion
      stopLoop();
      clearTimeout(lightningTimer);
      ctx && ctx.clearRect(0, 0, w, h);
    } else {
      startLoop();
      scheduleLightning();
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
    stop() {
      if (!host) return;
      stopLoop();
      clearTimeout(lightningTimer);
      cancelAnimationFrame(resizeRaf);
      if (lightningAnim) { lightningAnim.cancel(); lightningAnim = null; }
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (reducedMQ) {
        reducedMQ.removeEventListener ? reducedMQ.removeEventListener('change', applyMotionPreference)
                                      : reducedMQ.removeListener(applyMotionPreference);
      }
      const el = host;
      host = canvas = ctx = lightning = null; layers = [];
      el.style.opacity = '0';                  // fade out, then remove
      setTimeout(() => el.remove(), 1300);
    },
  };
}
