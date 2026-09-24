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
 *   2. Register it in REGISTRY below:   christmas: createChristmasEffect
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
import { createRainEffect } from "./rain-effect.js";

// key (field name under `effects` in Firestore)  →  factory returning { start(), stop() }
const REGISTRY = {
  rain: createRainEffect,
  // christmas: createChristmasEffect,
  // diwali:    createDiwaliEffect,
  // newyear:   createNewYearEffect,
  // holi:      createHoliEffect,
};

class SeasonalEffectsManager {
  constructor(registry) {
    this.registry = registry;
    this.active = new Map();   // key → running effect instance
    this.unsub = null;
  }

  init() {
    if (this.unsub) return;
    this.unsub = onSnapshot(
      doc(db, "settings", "seasonal_effects"),
      (snap) => this.apply((snap.exists() && snap.data().effects) || {}),
      (err) => { console.warn("[seasonal-effects] listener error — effects off:", err); this.apply({}); }
    );
  }

  /** Start effects that are ON and not running; stop running ones that are no longer ON. */
  apply(flags) {
    for (const key of Object.keys(this.registry)) {
      const shouldRun = flags[key] === true;
      const running = this.active.has(key);
      if (shouldRun && !running) {
        try {
          const fx = this.registry[key]();
          fx.start();
          this.active.set(key, fx);
        } catch (e) { console.error(`[seasonal-effects] ${key} failed to start:`, e); }
      } else if (!shouldRun && running) {
        try { this.active.get(key).stop(); } catch (e) { console.error(e); }
        this.active.delete(key);
      }
    }
  }

  destroy() {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    this.apply({});
  }
}

const manager = new SeasonalEffectsManager(REGISTRY);
export const initSeasonalEffects = () => manager.init();
export const destroySeasonalEffects = () => manager.destroy();
