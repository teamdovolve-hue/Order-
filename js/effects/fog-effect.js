/**
 * fog-effect.js — Weather + Effect Engine: 🌫️ Mist / Fog / Haze / Smoke / Dust / Sand / Ash
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE.
 * [AI UPDATE 2026-09-25] DEPTH PASS — was 2 bands drifting at slightly
 * different speeds/opacities. Now 3 bands at 3 depths (far/mid/near) with
 * their own height, opacity, drift speed AND direction, plus a slow rolling
 * "billow" (a softly moving radial highlight inside the near band) so the fog
 * reads as rolling volume rather than a flat gradient sliding sideways.
 * Deliberately still ZERO canvas / zero per-particle DOM — every "atmosphere"
 * OpenWeather condition (group 7xx) is visually similar low-contrast haze, and
 * the original spec for this effect ("do NOT create heavy particle systems")
 * still applies; the added depth here is pure CSS layering, same cost class
 * as before. Contract, variants and tint table are unchanged.
 *
 * Variants: 'mist' | 'fog' (cool grey) · 'haze' | 'smoke' (warm grey) ·
 *           'dust' | 'sand' (warm tan) · 'ash' (dark grey).
 *
 * Contract: createFogEffect() → { start(), stop(), update(flags) }.
 * flags: { variant?: string, isNight?: boolean }.
 */
const HOST_ID = "seasonalFx-fog";

const TINTS = {
  mist: "rgba(150,168,190,.30)",
  fog: "rgba(140,158,180,.38)",
  haze: "rgba(180,168,140,.28)",
  smoke: "rgba(120,116,112,.34)",
  dust: "rgba(196,168,120,.30)",
  sand: "rgba(206,176,120,.34)",
  ash: "rgba(110,108,112,.36)",
};

export function createFogEffect() {
  let host = null;

  function buildDom() {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;opacity:0;transition:opacity 1.4s ease;";

    const style = document.createElement("style");
    style.textContent = `
      /* 3 depth bands: far sits high/thin/faint and drifts slowest, near sits
         low/tall/densest and drifts fastest -- the speed+size gradient across
         bands IS the depth cue (classic parallax), no blur filters needed. */
      #${HOST_ID} .fx-layer{position:absolute;left:-25%;right:-25%;bottom:0;
        background:linear-gradient(0deg,var(--fx-tint,rgba(150,168,190,.30)),transparent);
        will-change:transform;}
      #${HOST_ID} .fx-layer.far{height:38%;opacity:.5;bottom:30%;
        animation:fxFogDrift 100s ease-in-out infinite alternate;}
      #${HOST_ID} .fx-layer.mid{height:52%;opacity:.75;
        animation:fxFogDrift2 62s ease-in-out infinite alternate-reverse;}
      #${HOST_ID} .fx-layer.near{height:64%;opacity:.95;
        animation:fxFogDrift3 40s ease-in-out infinite alternate;}
      /* Rolling billow: a soft moving highlight inside the near band, giving
         the fog a sense of internal motion/volume instead of a flat wash. */
      #${HOST_ID} .fx-billow{position:absolute;left:-40%;right:-40%;bottom:0;height:50%;
        background:radial-gradient(ellipse 40% 70% at 30% 100%,rgba(255,255,255,.10),transparent 70%),
                   radial-gradient(ellipse 34% 60% at 75% 100%,rgba(255,255,255,.07),transparent 70%);
        animation:fxFogBillow 34s ease-in-out infinite alternate;}
      #${HOST_ID}.fx-night{filter:brightness(.75);}
      @keyframes fxFogDrift{from{transform:translate3d(-2%,0,0)}to{transform:translate3d(2%,0,0)}}
      @keyframes fxFogDrift2{from{transform:translate3d(-4%,0,0)}to{transform:translate3d(4%,0,0)}}
      @keyframes fxFogDrift3{from{transform:translate3d(-6%,0,0)}to{transform:translate3d(6%,0,0)}}
      @keyframes fxFogBillow{from{transform:translate3d(-5%,0,0)}to{transform:translate3d(5%,0,0)}}
      @media (prefers-reduced-motion:reduce){#${HOST_ID} .fx-layer,#${HOST_ID} .fx-billow{animation:none}}
    `;
    host.appendChild(style);
    host.insertAdjacentHTML("beforeend",
      '<div class="fx-layer far"></div><div class="fx-layer mid"></div>' +
      '<div class="fx-layer near"></div><div class="fx-billow"></div>');
    document.body.appendChild(host);
    requestAnimationFrame(() => { if (host) host.style.opacity = "1"; });
  }

  return {
    start() {
      if (host) return;
      buildDom();
    },
    update(flags) {
      if (!host) return;
      const variant = (flags && flags.variant) || "mist";
      host.style.setProperty("--fx-tint", TINTS[variant] || TINTS.mist);
      host.classList.toggle("fx-night", !!(flags && flags.isNight));
    },
    stop() {
      if (!host) return;
      const el = host;
      host = null;
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 1400);
    },
  };
}
