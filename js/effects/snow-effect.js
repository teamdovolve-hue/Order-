/**
 * snow-effect.js — Weather + Effect Engine: ❄️ Snow  (v2 — layered depth)
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE.
 * [AI UPDATE 2026-09-25] DEPTH PASS — was one flat layer of identical dots.
 * Now 3 depth layers (far/mid/near) like rain-effect.js: far flakes are tiny,
 * slow, faint and never sway; near flakes are bigger, faster, brighter and get
 * a soft glow + gentle wind sway, so the snow reads as falling THROUGH space
 * rather than sliding across a flat plane. Same performance discipline as
 * before: low-end auto-detect, capped DPR, paused when the tab is hidden,
 * respects prefers-reduced-motion, pointer-events:none throughout, and the
 * SAME public contract (nothing outside this file changed).
 *
 * Variants (update({ variant })): 'light' | 'moderate' | 'heavy' | 'sleet'
 * scale particle density across all 3 layers; 'sleet' also speeds particles
 * up, shrinks them and flattens them into short streaks (icy, not fluffy).
 *
 * Contract: createSnowEffect() → { start(), stop(), update(flags) }.
 */
const HOST_ID = "seasonalFx-snow";
const MAX_DPR = 1.5;
const DENSITY_BY_VARIANT = { light: 26, moderate: 46, heavy: 74, sleet: 60 };

// Per-layer share of the total count + how each layer looks/moves.
// far: cheapest, most numerous, no sway, no glow — reads as "distant" snow.
// near: fewest, biggest, glows softly, sways with the wind — reads as "close".
const LAYERS = [
  { share: 0.5,  r: [0.8, 1.6], vy: [22, 45],  alpha: [0.35, 0.6],  sway: 0,    glow: false }, // far
  { share: 0.32, r: [1.6, 2.8], vy: [45, 80],  alpha: [0.5, 0.8],   sway: 10,   glow: false }, // mid
  { share: 0.18, r: [2.6, 4.2], vy: [70, 120], alpha: [0.75, 0.95], sway: 22,   glow: true  }, // near
];
const BASE_SLANT_VY_RATIO = 0.05; // gentle horizontal wind, scaled by fall speed (like rain's slant)

export function createSnowEffect() {
  let host, canvas, ctx;
  let rafId = 0, lastT = 0, running = false;
  let w = 0, h = 0, dpr = 1;
  let layers = []; // [{ cfg, flakes:[{x,y,r,vy,vx,sway,alpha}] }]
  let variant = "moderate";
  let reducedMQ = null;

  const lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 2;
  const qf = lowEnd ? 0.6 : 1;
  const FPS = lowEnd ? 30 : 45;

  const rand = (a, b) => a + Math.random() * (b - a);

  function buildDom() {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;opacity:0;transition:opacity 1.2s ease;";

    const style = document.createElement("style");
    style.textContent = `
      #${HOST_ID} .fx-atmos{position:absolute;inset:0;
        background:linear-gradient(180deg,rgba(200,215,235,.20) 0%,rgba(210,220,235,.08) 45%,transparent 100%);}
      #${HOST_ID}.fx-night .fx-atmos{background:linear-gradient(180deg,rgba(40,48,68,.35) 0%,rgba(40,48,68,.12) 45%,transparent 100%);}
      #${HOST_ID} .fx-haze{position:absolute;left:0;right:0;bottom:0;height:22%;
        background:linear-gradient(0deg,rgba(220,230,245,.16),transparent);}
      #${HOST_ID} canvas{position:absolute;inset:0;width:100%;height:100%;}
    `;
    host.appendChild(style);
    const atmos = document.createElement("div");
    atmos.className = "fx-atmos";
    host.appendChild(atmos);
    const haze = document.createElement("div");
    haze.className = "fx-haze";
    host.appendChild(haze);
    canvas = document.createElement("canvas");
    host.appendChild(canvas);
    document.body.appendChild(host);
    ctx = canvas.getContext("2d", { alpha: true });
    requestAnimationFrame(() => { if (host) host.style.opacity = "1"; });
  }

  function seedLayer(cfg, n) {
    const isSleet = variant === "sleet";
    const flakes = new Array(n);
    for (let i = 0; i < n; i++) {
      const vy = rand(cfg.vy[0], cfg.vy[1]) * (isSleet ? 3.4 : 1);
      flakes[i] = {
        x: rand(0, w),
        y: rand(-h, h),
        r: isSleet ? Math.max(0.8, rand(cfg.r[0], cfg.r[1]) * 0.55) : rand(cfg.r[0], cfg.r[1]),
        vy,
        vx: 0,
        sway: rand(0, Math.PI * 2),
        swayAmp: isSleet ? 0 : cfg.sway,
        alpha: rand(cfg.alpha[0], cfg.alpha[1]),
      };
    }
    return flakes;
  }

  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, lowEnd ? 1 : MAX_DPR);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const area = (w * h) / 1e6;
    const base = DENSITY_BY_VARIANT[variant] || DENSITY_BY_VARIANT.moderate;
    const total = Math.max(24, Math.round(base * Math.max(0.6, area) * qf));
    layers = LAYERS.map((cfg) => ({ cfg, flakes: seedLayer(cfg, Math.max(4, Math.round(total * cfg.share))) }));
  }

  function frame(t) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    if (t - lastT < 1000 / FPS - 1) return;
    const dt = Math.min((t - lastT) / 1000, 0.05);
    lastT = t;

    // Gentle shared wind gust — same "two slow sines" trick as rain-effect.js,
    // cheap (computed once per frame, not per flake) but gives the whole scene
    // one coherent drift instead of every flake wandering independently.
    const gust = Math.sin(t * 0.00035) * 0.6 + Math.sin(t * 0.0011 + 1.1) * 0.4;

    ctx.clearRect(0, 0, w, h);
    const isSleet = variant === "sleet";

    for (const L of layers) {
      const cfg = L.cfg;
      ctx.fillStyle = `rgba(255,255,255,${cfg.glow ? 1 : 0.92})`;
      for (const f of L.flakes) {
        f.sway += dt * 1.1;
        const wind = BASE_SLANT_VY_RATIO * f.vy * gust + (f.swayAmp ? Math.sin(f.sway) * f.swayAmp : 0) * dt * 6;
        f.y += f.vy * dt;
        f.x += (wind) * dt * (f.swayAmp ? 1 : 6); // far layer still drifts a touch with the gust even at swayAmp 0
        if (f.y > h + 6) { f.y = -6; f.x = rand(0, w); }
        if (f.x > w + 6) f.x = -6;
        if (f.x < -6) f.x = w + 6;

        ctx.globalAlpha = f.alpha;
        if (isSleet) {
          // short streak instead of a dot — reads as icy/fast rather than fluffy
          ctx.beginPath();
          ctx.moveTo(f.x, f.y);
          ctx.lineTo(f.x, f.y - f.r * 3.2);
          ctx.lineWidth = f.r;
          ctx.strokeStyle = ctx.fillStyle;
          ctx.stroke();
        } else if (cfg.glow) {
          // near layer: soft glow halo behind a crisp core — the "depth" cue
          const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 2.6);
          g.addColorStop(0, `rgba(255,255,255,${f.alpha})`);
          g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(f.x, f.y, f.r * 2.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(255,255,255,${Math.min(1, f.alpha + 0.15)})`;
          ctx.beginPath();
          ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function startLoop() {
    if (running) return;
    running = true;
    lastT = performance.now();
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  function onVisibility() {
    if (document.hidden) stopLoop(); else startLoop();
  }
  let resizeRaf = 0;
  function onResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { if (host) resize(); });
  }
  function applyMotionPreference() {
    if (reducedMQ && reducedMQ.matches) {
      stopLoop();
      ctx && ctx.clearRect(0, 0, w, h);
    } else {
      startLoop();
    }
  }

  return {
    start() {
      if (host) return;
      buildDom();
      reducedMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
      resize();
      window.addEventListener("resize", onResize, { passive: true });
      window.addEventListener("orientationchange", onResize, { passive: true });
      document.addEventListener("visibilitychange", onVisibility);
      reducedMQ.addEventListener ? reducedMQ.addEventListener("change", applyMotionPreference)
                                  : reducedMQ.addListener(applyMotionPreference);
      applyMotionPreference();
    },
    update(flags) {
      const nextVariant = (flags && flags.variant) || "moderate";
      if (host) host.classList.toggle("fx-night", !!(flags && flags.isNight));
      if (nextVariant !== variant) {
        variant = nextVariant;
        if (host && w && h) resize();
      }
    },
    stop() {
      if (!host) return;
      stopLoop();
      cancelAnimationFrame(resizeRaf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      if (reducedMQ) {
        reducedMQ.removeEventListener ? reducedMQ.removeEventListener("change", applyMotionPreference)
                                       : reducedMQ.removeListener(applyMotionPreference);
      }
      const el = host;
      host = canvas = ctx = null; layers = [];
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 1300);
    },
  };
}
