/**
 * seasonal-effects-manager.js — Seasonal Effects (Customer Panel)
 * ─────────────────────────────────────────────────────────────────────────────
 * Listens (realtime) to Firestore  settings/seasonal_effects  { effects: { rain: true, … } }
 * — written by the Billing/Admin panel's "✨ Effects" tab (js/effects-admin.js) — and starts /
 * stops the matching effect modules. The Customer Panel never knows about individual effects;
 * it only calls  initSeasonalEffects()  once.
 *
 * ADDING A FUTURE EFFECT (e.g. Christmas):
 *   1. Create js/effects/christmas-effect.js exporting  createChristmasEffect()  →
 *      { start(), stop() }   (stop() must release ALL resources: rAF, timers, listeners, DOM).
 *   2. Register a lazy loader in REGISTRY below:   christmas: () => import("./christmas-effect.js").then(m => m.createChristmasEffect())
 *   3. In the Admin panel js/effects-admin.js flip that entry from `soon:true` to `soon:false`
 *      (key must equal the registry key). No other Customer Panel change is needed.
 *
 * Rules: missing doc / missing key / listener error ⇒ effect stays OFF. Multiple effects may be
 * enabled at once; each is started/stopped independently.
 *
 * Wiring in the Customer Panel app.js (once, at startup — works logged-in or not because
 * `settings/*` is public-read):
 *     import { initSeasonalEffects } from "./effects/seasonal-effects-manager.js";
 *     initSeasonalEffects();
 */
import { db } from "../firebase-config.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// key (field name under `effects` in Firestore)  →  LOADER returning a Promise of { start(), stop() }.
// Effect code is loaded with dynamic import() ONLY when that effect is switched ON, so it never adds
// to the initial download / parse cost of the menu.
const REGISTRY = {
  rain: () => import("./rain-effect.js").then((m) => m.createRainEffect()),
  // christmas: () => import("./christmas-effect.js").then((m) => m.createChristmasEffect()),
  // diwali:    () => import("./diwali-effect.js").then((m) => m.createDiwaliEffect()),
};

// Run decorative work only after the page/menu has had its chance to paint.
function whenIdle(fn) {
  const go = () => ("requestIdleCallback" in window
    ? requestIdleCallback(fn, { timeout: 2500 })
    : setTimeout(fn, 1200));
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}

class SeasonalEffectsManager {
  constructor(registry) {
    this.registry = registry;
    this.active = new Map();   // key → running effect instance
    this.pending = new Set();  // keys currently being loaded
    this.flags = {};           // latest desired state (guards async load races)
    this.unsub = null;
  }

  init() {
    if (this.unsub || this._scheduled) return;
    this._scheduled = true;
    whenIdle(() => this._listen());   // Firestore listener + effect code start AFTER first paint
  }

  _listen() {
    if (this.unsub) return;
    this.unsub = onSnapshot(
      doc(db, "settings", "seasonal_effects"),
      (snap) => this.apply((snap.exists() && snap.data().effects) || {}),
      (err) => { console.warn("[seasonal-effects] listener error — effects off:", err); this.apply({}); }
    );
  }

  /** Start effects that are ON and not running; stop running ones that are no longer ON. */
  apply(flags) {
    this.flags = flags;
    for (const key of Object.keys(this.registry)) {
      const shouldRun = flags[key] === true;
      const running = this.active.has(key);
      if (shouldRun && !running && !this.pending.has(key)) {
        this.pending.add(key);
        Promise.resolve().then(() => this.registry[key]()).then((fx) => {
          this.pending.delete(key);
          if (this.flags[key] !== true) return;      // switched OFF while loading
          fx.start();
          this.active.set(key, fx);
          if (fx.update) fx.update(this.flags);   // optional extras (e.g. rainSound)
        }).catch((e) => { this.pending.delete(key); console.error(`[seasonal-effects] ${key} failed to start:`, e); });
      } else if (!shouldRun && running) {
        try { this.active.get(key).stop(); } catch (e) { console.error(e); }
        this.active.delete(key);
      }
    }
    // Let running effects read extra flags (e.g. effects.rainSound) — unknown keys are otherwise ignored.
    for (const fx of this.active.values()) { try { if (fx.update) fx.update(flags); } catch (e) { console.error(e); } }
  }

  destroy() {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    this._scheduled = false;
    this.apply({});
  }
}

const manager = new SeasonalEffectsManager(REGISTRY);
export const initSeasonalEffects = () => manager.init();
export const destroySeasonalEffects = () => manager.destroy();
