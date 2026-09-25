/**
 * sunny-effect.js — Weather + Effect Engine: ☀️ Sunny / Clear Sky
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE.
 * Pure CSS: a warm gradient wash + a handful of slow-drifting light particles.
 * No canvas needed — this is the lightest effect in the engine on purpose,
 * since "clear" is the most common daytime condition and must never distract
 * from the menu. Night variant (isNight) swaps the warm wash for a calm
 * starlight tint instead of pretending the sun is out.
 *
 * Contract: createSunnyEffect() → { start(), stop(), update(flags) }.
 * flags: { isNight?: boolean }.
 */
const HOST_ID = "seasonalFx-sunny";
const PARTICLE_COUNT = 10; // tiny — CSS-animated, not per-frame JS

export function createSunnyEffect() {
  let host = null;
  let reducedMQ = null;

  function buildDom(isNight) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.className = isNight ? "fx-night" : "";
    host.style.cssText =
      "position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;opacity:0;transition:opacity 1.2s ease;";

    const style = document.createElement("style");
    style.textContent = `
      #${HOST_ID} .fx-wash{position:absolute;inset:0;
        background:radial-gradient(ellipse 80% 55% at 50% -10%,rgba(255,214,140,.22),transparent 60%),
                   linear-gradient(180deg,rgba(255,236,196,.10) 0%,transparent 40%);}
      #${HOST_ID}.fx-night .fx-wash{
        background:radial-gradient(ellipse 80% 55% at 50% -10%,rgba(140,160,255,.10),transparent 60%),
                   linear-gradient(180deg,rgba(30,36,60,.18) 0%,transparent 45%);}
      #${HOST_ID} .fx-dot{position:absolute;border-radius:50%;will-change:transform,opacity;
        background:radial-gradient(circle,rgba(255,230,170,.85),rgba(255,230,170,0) 70%);
        animation:fxSunFloat linear infinite;}
      #${HOST_ID}.fx-night .fx-dot{background:radial-gradient(circle,rgba(220,230,255,.9),rgba(220,230,255,0) 70%);}
      @keyframes fxSunFloat{
        0%{transform:translate3d(0,0,0);opacity:0}
        10%{opacity:.9}
        90%{opacity:.5}
        100%{transform:translate3d(var(--dx,20px),-110vh,0);opacity:0}
      }
      @media (prefers-reduced-motion:reduce){#${HOST_ID} .fx-dot{animation:none;opacity:0}}
    `;
    host.appendChild(style);
    const wash = document.createElement("div");
    wash.className = "fx-wash";
    host.appendChild(wash);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const dot = document.createElement("div");
      dot.className = "fx-dot";
      const size = 2 + Math.random() * 3;
      dot.style.width = dot.style.height = `${size}px`;
      dot.style.left = `${Math.random() * 100}%`;
      dot.style.bottom = `-5%`;
      dot.style.setProperty("--dx", `${(Math.random() * 60 - 30).toFixed(0)}px`);
      dot.style.animationDuration = `${14 + Math.random() * 12}s`;
      dot.style.animationDelay = `${(Math.random() * -20).toFixed(1)}s`;
      host.appendChild(dot);
    }
    document.body.appendChild(host);
    requestAnimationFrame(() => { if (host) host.style.opacity = "1"; });
  }

  function applyMotionPreference() {
    // CSS media query handles reduced motion automatically; nothing to wire in JS.
  }

  return {
    start() {
      if (host) return;
      buildDom(false);
      reducedMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
      applyMotionPreference();
    },
    update(flags) {
      if (!host) return;
      const isNight = !!(flags && flags.isNight);
      host.classList.toggle("fx-night", isNight);
    },
    stop() {
      if (!host) return;
      const el = host;
      host = null;
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 1300);
    },
  };
}
