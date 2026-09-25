/**
 * cloudy-effect.js — Weather + Effect Engine: ☁️ Cloudy  (v2 — layered depth)
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE.
 * [AI UPDATE 2026-09-25] DEPTH PASS — was 2 identical cloud blobs drifting at
 * slightly different speeds. Now 3 cloud banks at 3 depths (far/mid/near),
 * each a different size/opacity/blur/speed, plus a slow independent light
 * layer for 'few' (sun breaking through gaps) and a darker rolling shadow
 * band for 'overcast'/'storm'. Still pure CSS gradients (no `filter:blur` —
 * same reasoning as rain-effect.js's header comment: expensive on phones),
 * zero per-particle DOM, zero canvas. Same public contract, nothing outside
 * this file changed.
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

      /* 3 depth banks: far = smallest/faintest/slowest-feeling-but-widest sweep,
         near = biggest/darkest-edge/fastest drift -- classic parallax cue. */
      #${HOST_ID} .fx-cloud{position:absolute;left:-30%;width:160%;will-change:transform;}
      #${HOST_ID} .fx-cloud.far{top:-30%;height:50%;opacity:.55;
        background:radial-gradient(ellipse 42% 50% at 28% 55%,rgba(160,168,182,.22),transparent 100%),
                   radial-gradient(ellipse 38% 46% at 74% 45%,rgba(150,158,172,.20),transparent 100%);
        animation:fxCloudDrift1 130s ease-in-out infinite alternate;}
      #${HOST_ID} .fx-cloud.mid{top:-24%;height:58%;
        background:radial-gradient(ellipse 45% 55% at 30% 58%,rgba(150,158,172,.34),transparent 100%),
                   radial-gradient(ellipse 40% 50% at 72% 42%,rgba(130,140,158,.30),transparent 100%);
        animation:fxCloudDrift2 80s ease-in-out infinite alternate;}
      #${HOST_ID} .fx-cloud.near{top:-16%;height:66%;opacity:.9;
        background:radial-gradient(ellipse 50% 58% at 34% 60%,rgba(120,128,144,.40),transparent 100%),
                   radial-gradient(ellipse 44% 52% at 68% 40%,rgba(104,114,132,.36),transparent 100%);
        animation:fxCloudDrift3 52s ease-in-out infinite alternate-reverse;}

      /* 'few': a soft moving light shaft implies sun breaking between clouds */
      #${HOST_ID} .fx-ray{position:absolute;top:-10%;left:20%;width:34%;height:80%;opacity:0;
        background:linear-gradient(100deg,rgba(255,236,196,.16),transparent 55%);
        transition:opacity 1s ease;animation:fxRayDrift 46s ease-in-out infinite alternate;}
      #${HOST_ID}.fx-few .fx-ray{opacity:1;}

      /* 'overcast'/'storm': a slow, darker shadow band rolling underneath everything */
      #${HOST_ID} .fx-shadow{position:absolute;inset:-10% -30%;opacity:0;
        background:radial-gradient(ellipse 60% 40% at 40% 30%,rgba(40,44,54,.22),transparent 70%);
        transition:opacity 1.2s ease;animation:fxShadowDrift 100s linear infinite;}
      #${HOST_ID}.fx-overcast .fx-shadow,#${HOST_ID}.fx-storm .fx-shadow{opacity:1;}

      #${HOST_ID}.fx-storm .fx-haze{background:linear-gradient(180deg,rgba(50,46,58,.42) 0%,rgba(60,54,66,.18) 45%,transparent 100%);}
      #${HOST_ID}.fx-storm .fx-edge{position:absolute;inset:0;box-shadow:inset 0 0 60px rgba(180,120,30,.10);}

      @keyframes fxCloudDrift1{from{transform:translate3d(-3%,0,0)}to{transform:translate3d(3%,2%,0)}}
      @keyframes fxCloudDrift2{from{transform:translate3d(-4%,0,0)}to{transform:translate3d(4%,3%,0)}}
      @keyframes fxCloudDrift3{from{transform:translate3d(-5%,0,0)}to{transform:translate3d(5%,-2%,0)}}
      @keyframes fxRayDrift{from{transform:translate3d(-6%,0,0) rotate(0deg)}to{transform:translate3d(6%,0,0) rotate(2deg)}}
      @keyframes fxShadowDrift{from{transform:translate3d(-6%,0,0)}to{transform:translate3d(6%,0,0)}}
      @media (prefers-reduced-motion:reduce){#${HOST_ID} .fx-cloud,#${HOST_ID} .fx-ray,#${HOST_ID} .fx-shadow{animation:none}}
    `;
    host.appendChild(style);
    host.insertAdjacentHTML(
      "beforeend",
      '<div class="fx-haze"></div>' +
      '<div class="fx-shadow"></div>' +
      '<div class="fx-cloud far"></div><div class="fx-cloud mid"></div><div class="fx-cloud near"></div>' +
      '<div class="fx-ray"></div><div class="fx-edge"></div>'
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
      // Depth banks scale together but keep their own relative opacity (far
      // stays faintest, near stays darkest) -- multiply each layer's base by
      // the variant factor instead of forcing every layer to the same value.
      const scale = opacity / OPACITY_BY_VARIANT.scattered;
      host.querySelectorAll(".fx-cloud.far").forEach((el) => { el.style.opacity = String(Math.min(1, 0.55 * scale)); });
      host.querySelectorAll(".fx-cloud.mid").forEach((el) => { el.style.opacity = String(Math.min(1, opacity)); });
      host.querySelectorAll(".fx-cloud.near").forEach((el) => { el.style.opacity = String(Math.min(1, 0.9 * scale)); });
      host.classList.toggle("fx-few", variant === "few");
      host.classList.toggle("fx-overcast", variant === "overcast");
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
