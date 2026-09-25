/**
 * snow-effect.js — Weather + Effect Engine: ❄️ Snow
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE.
 * ONE lightweight canvas of drifting snow particles (multiple sizes/speeds)
 * over a soft cool-toned atmosphere. Follows the same performance discipline
 * as rain-effect.js: low-end auto-detect, capped DPR, paused when the tab is
 * hidden, respects prefers-reduced-motion, pointer-events:none throughout.
 *
 * Variants (update({ variant })): 'light' | 'moderate' | 'heavy' | 'sleet'
 * scale particle density; 'sleet' also speeds particles up and shrinks them.
 *
 * Contract: createSnowEffect() → { start(), stop(), update(flags) }.
 */
const HOST_ID = "seasonalFx-snow";
const MAX_DPR = 1.5;
const DENSITY_BY_VARIANT = { light: 26, moderate: 46, heavy: 74, sleet: 60 };

export function createSnowEffect() {
  let host, canvas, ctx;
  let rafId = 0, lastT = 0, running = false;
  let w = 0, h = 0, dpr = 1;
  let flakes = [];
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
      #${HOST_ID} canvas{position:absolute;inset:0;width:100%;height:100%;}
    `;
    host.appendChild(style);
    const atmos = document.createElement("div");
    atmos.className = "fx-atmos";
    host.appendChild(atmos);
    canvas = document.createElement("canvas");
    host.appendChild(canvas);
    document.body.appendChild(host);
    ctx = canvas.getContext("2d", { alpha: true });
    requestAnimationFrame(() => { if (host) host.style.opacity = "1"; });
  }

  function seed(n) {
    const isSleet = variant === "sleet";
    flakes = new Array(n).fill(0).map(() => ({
      x: rand(0, w),
      y: rand(-h, h),
      r: isSleet ? rand(1, 2) : rand(1.5, 4),
      vy: isSleet ? rand(220, 320) : rand(30, 90),
      vx: rand(-12, 12),
      sway: rand(0, Math.PI * 2),
      alpha: rand(0.4, 0.9),
    }));
  }

  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, lowEnd ? 1 : MAX_DPR);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const area = (w * h) / 1e6;
    const base = DENSITY_BY_VARIANT[variant] || DENSITY_BY_VARIANT.moderate;
    const n = Math.max(16, Math.round(base * Math.max(0.6, area) * qf));
    seed(n);
  }

  function frame(t) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    if (t - lastT < 1000 / FPS - 1) return;
    const dt = Math.min((t - lastT) / 1000, 0.05);
    lastT = t;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (const f of flakes) {
      f.sway += dt * 1.2;
      f.y += f.vy * dt;
      f.x += (f.vx + Math.sin(f.sway) * 14) * dt;
      if (f.y > h + 5) { f.y = -5; f.x = rand(0, w); }
      if (f.x > w + 5) f.x = -5;
      if (f.x < -5) f.x = w + 5;
      ctx.globalAlpha = f.alpha;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
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
      host = canvas = ctx = null; flakes = [];
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 1300);
    },
  };
}
