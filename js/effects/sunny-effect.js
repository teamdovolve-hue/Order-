/**
 * sunny-effect.js — Weather + Effect Engine: ☀️ Sunny / Clear Sky  (v2 — depth pass)
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE.
 * [AI UPDATE 2026-09-25] DEPTH PASS — was one warm wash + one layer of
 * identical floating dots. Now: a soft pulsing sun-glow disc + two faint
 * rotating light-ray sweeps behind it (depth cue: rays read as "far", the
 * glow as "near"), and TWO dust-mote layers (far: smaller/dimmer/slower,
 * near: bigger/brighter/faster) instead of one uniform layer. Night variant
 * swaps the sun for a calm starlight tint + a couple of twinkling stars
 * instead of pretending the sun is out. Still pure CSS, no canvas, no JS
 * per-frame work — this stays the lightest effect in the engine on purpose,
 * since "clear" is the most common daytime condition and must never distract
 * from the menu. Same public contract, nothing outside this file changed.
 *
 * Contract: createSunnyEffect() → { start(), stop(), update(flags) }.
 * flags: { isNight?: boolean }.
 */
const HOST_ID = "seasonalFx-sunny";
const FAR_COUNT = 7;   // small, dim, slow — background depth
const NEAR_COUNT = 6;  // bigger, brighter, faster — foreground depth
const STAR_COUNT = 10; // night only

export function createSunnyEffect() {
  let host = null;

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

      /* Sun glow disc — near-depth: soft, slow pulse, top of viewport */
      #${HOST_ID} .fx-sun{position:absolute;top:-8%;left:50%;width:46vmax;height:46vmax;
        transform:translateX(-50%);border-radius:50%;
        background:radial-gradient(circle,rgba(255,224,160,.30) 0%,rgba(255,214,140,.12) 35%,transparent 70%);
        animation:fxSunPulse 9s ease-in-out infinite;}
      #${HOST_ID}.fx-night .fx-sun{opacity:0;}

      /* Two faint rotating ray sweeps behind the glow — far-depth cue */
      #${HOST_ID} .fx-rays{position:absolute;top:-30%;left:50%;width:120vmax;height:120vmax;
        transform:translateX(-50%);opacity:.5;
        background:conic-gradient(from 0deg,transparent 0deg,rgba(255,230,180,.05) 6deg,transparent 12deg,
                   transparent 40deg,rgba(255,230,180,.05) 46deg,transparent 52deg,
                   transparent 80deg,rgba(255,230,180,.05) 86deg,transparent 92deg);
        animation:fxRaysSpin 90s linear infinite;}
      #${HOST_ID}.fx-night .fx-rays{opacity:0;}

      #${HOST_ID} .fx-dot{position:absolute;border-radius:50%;will-change:transform,opacity;
        background:radial-gradient(circle,rgba(255,230,170,.85),rgba(255,230,170,0) 70%);
        animation:fxSunFloat linear infinite;}
      #${HOST_ID} .fx-dot.far{filter:none;}
      #${HOST_ID}.fx-night .fx-dot{background:radial-gradient(circle,rgba(220,230,255,.9),rgba(220,230,255,0) 70%);}

      #${HOST_ID} .fx-star{position:absolute;border-radius:50%;background:#eaf0ff;opacity:0;
        animation:fxStarTwinkle ease-in-out infinite;}
      #${HOST_ID}:not(.fx-night) .fx-star{display:none;}

      @keyframes fxSunPulse{0%,100%{opacity:.85;transform:translateX(-50%) scale(1)}50%{opacity:1;transform:translateX(-50%) scale(1.04)}}
      @keyframes fxRaysSpin{from{transform:translateX(-50%) rotate(0deg)}to{transform:translateX(-50%) rotate(360deg)}}
      @keyframes fxSunFloat{
        0%{transform:translate3d(0,0,0);opacity:0}
        10%{opacity:.9}
        90%{opacity:.5}
        100%{transform:translate3d(var(--dx,20px),-110vh,0);opacity:0}
      }
      @keyframes fxStarTwinkle{0%,100%{opacity:.15}50%{opacity:.9}}
      @media (prefers-reduced-motion:reduce){
        #${HOST_ID} .fx-dot,#${HOST_ID} .fx-sun,#${HOST_ID} .fx-rays,#${HOST_ID} .fx-star{animation:none;opacity:0}
      }
    `;
    host.appendChild(style);
    host.insertAdjacentHTML("beforeend",
      '<div class="fx-wash"></div><div class="fx-rays"></div><div class="fx-sun"></div>');

    // Far dust-mote layer: smaller, dimmer, slower.
    for (let i = 0; i < FAR_COUNT; i++) {
      const dot = document.createElement("div");
      dot.className = "fx-dot far";
      const size = 1.5 + Math.random() * 1.8;
      dot.style.width = dot.style.height = `${size}px`;
      dot.style.left = `${Math.random() * 100}%`;
      dot.style.bottom = `-5%`;
      dot.style.opacity = "0.6";
      dot.style.setProperty("--dx", `${(Math.random() * 40 - 20).toFixed(0)}px`);
      dot.style.animationDuration = `${22 + Math.random() * 16}s`;
      dot.style.animationDelay = `${(Math.random() * -30).toFixed(1)}s`;
      host.appendChild(dot);
    }
    // Near dust-mote layer: bigger, brighter, faster — the original layer.
    for (let i = 0; i < NEAR_COUNT; i++) {
      const dot = document.createElement("div");
      dot.className = "fx-dot near";
      const size = 2.5 + Math.random() * 3.5;
      dot.style.width = dot.style.height = `${size}px`;
      dot.style.left = `${Math.random() * 100}%`;
      dot.style.bottom = `-5%`;
      dot.style.setProperty("--dx", `${(Math.random() * 60 - 30).toFixed(0)}px`);
      dot.style.animationDuration = `${13 + Math.random() * 10}s`;
      dot.style.animationDelay = `${(Math.random() * -20).toFixed(1)}s`;
      host.appendChild(dot);
    }
    // Night-only twinkling stars, hidden via CSS in daytime.
    for (let i = 0; i < STAR_COUNT; i++) {
      const star = document.createElement("div");
      star.className = "fx-star";
      const size = 1 + Math.random() * 1.6;
      star.style.width = star.style.height = `${size}px`;
      star.style.left = `${Math.random() * 100}%`;
      star.style.top = `${Math.random() * 55}%`;
      star.style.animationDuration = `${2.5 + Math.random() * 3}s`;
      star.style.animationDelay = `${(Math.random() * -4).toFixed(1)}s`;
      host.appendChild(star);
    }
    document.body.appendChild(host);
    requestAnimationFrame(() => { if (host) host.style.opacity = "1"; });
  }

  return {
    start() {
      if (host) return;
      buildDom(false);
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
