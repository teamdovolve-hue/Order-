/**
 * fog-effect.js — Weather + Effect Engine: 🌫️ Mist / Fog / Haze / Smoke / Dust / Sand / Ash
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE.
 * ONE soft, low-opacity, slow-moving atmosphere layer shared by every
 * "atmosphere" OpenWeather condition (group 7xx). These conditions are all
 * visually similar — reduced-contrast haze — so per spec ("do NOT create
 * heavy particle systems") they share one lightweight CSS implementation and
 * differ only by tint/opacity via `variant`.
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
      #${HOST_ID} .fx-layer{position:absolute;left:-20%;right:-20%;bottom:0;height:60%;
        background:linear-gradient(0deg,var(--fx-tint,rgba(150,168,190,.30)),transparent);
        will-change:transform;animation:fxFogDrift 60s ease-in-out infinite alternate;}
      #${HOST_ID} .fx-layer.b{bottom:20%;height:40%;opacity:.7;animation-duration:80s;animation-direction:alternate-reverse;}
      #${HOST_ID}.fx-night{filter:brightness(.75);}
      @keyframes fxFogDrift{from{transform:translate3d(-3%,0,0)}to{transform:translate3d(3%,0,0)}}
      @media (prefers-reduced-motion:reduce){#${HOST_ID} .fx-layer{animation:none}}
    `;
    host.appendChild(style);
    host.insertAdjacentHTML("beforeend", '<div class="fx-layer"></div><div class="fx-layer b"></div>');
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
