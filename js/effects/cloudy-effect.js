/**
 * cloudy-effect.js — Weather + Effect Engine: ☁️ Cloudy
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE.
 * Pure CSS gradient cloud banks that drift slowly — the same lightweight
 * technique already used inside rain-effect.js's atmosphere layer, extracted
 * here as its own effect so "just cloudy, no rain" has a real look instead of
 * reusing the rain effect at zero intensity.
 *
 * Variants (via update({ variant })): 'few' | 'scattered' | 'broken' |
 * 'overcast' | 'storm' — control how dense/dark the cloud layer reads.
 * 'storm' is used for squall/tornado conditions: a darker tint and a subtle
 * amber warning edge, WITHOUT a cartoon tornado or distracting animation.
 *
 * Contract: createCloudyEffect() → { start(), stop(), update(flags) }.
 * flags: { variant?: string, isNight?: boolean }.
 */
const HOST_ID = "seasonalFx-cloudy";

const OPACITY_BY_VARIANT = { few: 0.35, scattered: 0.55, broken: 0.75, overcast: 0.9, storm: 0.85 };

export function createCloudyEffect() {
  let host = null;

  function buildDom() {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;opacity:0;transition:opacity 1.2s ease;";

    const style = document.createElement("style");
    style.textContent = `
      #${HOST_ID} .fx-haze{position:absolute;inset:0;
        background:linear-gradient(180deg,rgba(90,100,120,.28) 0%,rgba(110,118,132,.12) 45%,transparent 100%);}
      #${HOST_ID}.fx-night .fx-haze{background:linear-gradient(180deg,rgba(20,24,38,.42) 0%,rgba(24,28,42,.20) 45%,transparent 100%);}
      #${HOST_ID} .fx-cloud{position:absolute;top:-22%;left:-30%;width:160%;height:62%;
        background:radial-gradient(ellipse 45% 55% at 30% 58%,rgba(150,158,172,.34),transparent 100%),
                   radial-gradient(ellipse 40% 50% at 72% 42%,rgba(130,140,158,.30),transparent 100%);
        will-change:transform;animation:fxCloudDrift2 80s ease-in-out infinite alternate;}
      #${HOST_ID} .fx-cloud.b{top:-30%;opacity:.7;animation-duration:105s;animation-direction:alternate-reverse;}
      #${HOST_ID}.fx-storm .fx-haze{background:linear-gradient(180deg,rgba(50,46,58,.42) 0%,rgba(60,54,66,.18) 45%,transparent 100%);}
      #${HOST_ID}.fx-storm .fx-edge{position:absolute;inset:0;box-shadow:inset 0 0 60px rgba(180,120,30,.10);}
      @keyframes fxCloudDrift2{from{transform:translate3d(-4%,0,0)}to{transform:translate3d(4%,3%,0)}}
      @media (prefers-reduced-motion:reduce){#${HOST_ID} .fx-cloud{animation:none}}
    `;
    host.appendChild(style);
    host.insertAdjacentHTML(
      "beforeend",
      '<div class="fx-haze"></div><div class="fx-cloud"></div><div class="fx-cloud b"></div><div class="fx-edge"></div>'
    );
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
      const variant = (flags && flags.variant) || "scattered";
      const opacity = OPACITY_BY_VARIANT[variant] != null ? OPACITY_BY_VARIANT[variant] : 0.55;
      host.style.setProperty("--fx-opacity", String(opacity));
      host.querySelectorAll(".fx-cloud").forEach((el) => { el.style.opacity = String(opacity); });
      host.classList.toggle("fx-storm", variant === "storm");
      host.classList.toggle("fx-night", !!(flags && flags.isNight));
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
