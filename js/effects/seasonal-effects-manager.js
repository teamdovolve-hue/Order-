/**
 * seasonal-effects-manager.js — Weather + Manual Effect Engine (Customer Panel)
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] REWRITTEN — was boolean-map "seasonal effects"
 * (`effects: { rain: true }`, multiple could run at once). Now a single
 * centralized Weather + Effect engine:
 *
 *   Weather Service  ->  Weather Normalizer  ->  Effect Resolver  ->  Active Effect
 *        (fetch)          (condition->id)         (priority)         (renderer)
 *
 * Firestore doc  settings/seasonal_effects , written by the Admin panel's
 * "Effects" tab (js/effects-admin.js):
 *   {
 *     effectsEnabled: boolean,           // global master switch (default true)
 *     automaticWeatherEnabled: boolean,  // OpenWeather drives the effect (default false)
 *     manualEffectId: string|null,       // explicit override -- wins over weather
 *     effects: { rainSound: boolean },   // kept: opt-in sound toggle for the rain effect
 *     updatedAt: number,
 *   }
 * See effect-resolver.js for the exact priority rule. Only ONE effect renders
 * at a time (no stacking) -- this manager enforces that by construction: it
 * tracks a single `activeKey` and swaps modules rather than a map of booleans.
 *
 * Restaurant location for the weather lookup lives in a separate doc,
 * settings/restaurant_location { lat, lon } (also public-read, edited from the
 * same Admin tab) -- see weather-service.js.
 *
 * ADDING A FUTURE EFFECT (weather or festival):
 *   1. Create js/effects/<name>-effect.js exporting create<Name>Effect() ->
 *      { start(), stop(), update?(flags) }. stop() must release EVERYTHING
 *      (rAF, timers, listeners, DOM).
 *   2. Register a lazy loader in REGISTRY below.
 *   3. For a festival effect, also add it to the Admin panel's EFFECTS list
 *      (js/effects-admin.js) with `soon:false` -- the `key` must match.
 *   4. For a weather effect, also give it a case in weather-normalizer.js.
 *
 * Rules: missing doc / listener error / weather fetch failure => fail safe to
 * "no effect" (or keep the previously active effect for a transient weather
 * hiccup -- see `lastWeather` below). Never blocks or delays the menu -- the
 * Firestore listener AND the first weather fetch both happen only after the
 * page has had its chance to paint (whenIdle).
 *
 * Wiring in the Customer Panel app.js (once, at startup):
 *     import { initSeasonalEffects } from "./effects/seasonal-effects-manager.js";
 *     initSeasonalEffects();
 */
import { db } from "../firebase-config.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getWeatherEffect } from "./weather-service.js";
import { resolveActiveEffect } from "./effect-resolver.js";

// registry key -> LOADER returning a Promise of { start(), stop(), update?(flags) }.
// Loaded with dynamic import() ONLY when that effect actually needs to render,
// so it never adds to the initial download/parse cost of the menu.
const REGISTRY = {
  rain: () => import("./rain-effect.js").then((m) => m.createRainEffect()),
  snow: () => import("./snow-effect.js").then((m) => m.createSnowEffect()),
  cloudy: () => import("./cloudy-effect.js").then((m) => m.createCloudyEffect()),
  sunny: () => import("./sunny-effect.js").then((m) => m.createSunnyEffect()),
  fog: () => import("./fog-effect.js").then((m) => m.createFogEffect()),
  // christmas: () => import("./christmas-effect.js").then((m) => m.createChristmasEffect()),
  // diwali:    () => import("./diwali-effect.js").then((m) => m.createDiwaliEffect()),
};

const WEATHER_POLL_MS = 10 * 60 * 1000; // matches server + client cache TTL -- cheap no-op most calls

// Run decorative work only after the page/menu has had its chance to paint.
function whenIdle(fn) {
  const go = () => ("requestIdleCallback" in window
    ? requestIdleCallback(fn, { timeout: 2500 })
    : setTimeout(fn, 1200));
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}

class EffectEngine {
  constructor(registry) {
    this.registry = registry;
    this.config = {};          // latest settings/seasonal_effects doc
    this.lastWeather = null;   // last successful normalized weather (kept on failure)
    this.activeKey = null;     // registry key currently running
    this.activeFx = null;      // running effect instance
    this.loadToken = 0;        // guards against races while an effect module is loading
    this.unsub = null;
    this.pollTimer = 0;
  }

  init() {
    if (this.unsub || this._scheduled) return;
    this._scheduled = true;
    whenIdle(() => {
      this._listenConfig();
      this._pollWeather(); // first fetch, then on an interval -- both idle-scheduled
      this.pollTimer = setInterval(() => this._pollWeather(), WEATHER_POLL_MS);
    });
  }

  _listenConfig() {
    if (this.unsub) return;
    this.unsub = onSnapshot(
      doc(db, "settings", "seasonal_effects"),
      (snap) => { this.config = snap.exists() ? snap.data() : {}; this._resolve(); },
      (err) => { console.warn("[weather-fx] config listener error -- effects off:", err); this.config = {}; this._resolve(); }
    );
  }

  async _pollWeather() {
    try {
      const w = await getWeatherEffect();
      if (w) this.lastWeather = w; // null (failed/stale) => keep previous valid effect, no flashing
    } catch (e) {
      console.warn("[weather-fx] weather fetch failed -- keeping previous effect:", e);
    }
    this._resolve();
  }

  _resolve() {
    const resolved = resolveActiveEffect(this.config, this.lastWeather);
    this._apply(resolved);
  }

  _apply(resolved) {
    const key = resolved.key;
    const flags = {
      variant: resolved.variant,
      isNight: resolved.isNight,
      rainSound: this.config && this.config.effects && this.config.effects.rainSound === true,
    };

    if (key === this.activeKey) {
      // Same effect still active -- just push updated flags (variant/night/sound may change).
      if (this.activeFx && this.activeFx.update) {
        try { this.activeFx.update(flags); } catch (e) { console.error(e); }
      }
      return;
    }

    // Switching effects (including switching to/from "none"): stop the old one first
    // so exactly one full-screen effect ever renders at a time.
    const myToken = ++this.loadToken;
    const prevFx = this.activeFx;
    this.activeKey = key;
    this.activeFx = null;
    if (prevFx) { try { prevFx.stop(); } catch (e) { console.error(e); } }

    if (!key || !this.registry[key]) return; // "no effect" -- nothing more to do

    Promise.resolve()
      .then(() => this.registry[key]())
      .then((fx) => {
        if (myToken !== this.loadToken) { try { fx.stop(); } catch (_) {} return; } // superseded while loading
        this.activeFx = fx;
        fx.start();
        if (fx.update) { try { fx.update(flags); } catch (e) { console.error(e); } }
      })
      .catch((e) => console.error(`[weather-fx] "${key}" failed to start:`, e));
  }

  destroy() {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = 0; }
    this._scheduled = false;
    this._apply({ key: null });
  }
}

const engine = new EffectEngine(REGISTRY);
export const initSeasonalEffects = () => engine.init();
export const destroySeasonalEffects = () => engine.destroy();
