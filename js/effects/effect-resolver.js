/**
 * effect-resolver.js — Weather + Effect Engine (Customer Panel)
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE.
 *
 * ONE centralized function that decides which effect (if any) should be
 * active, given the Admin panel's config doc and the latest weather reading.
 * Nothing else in the Customer Panel should re-implement this priority order.
 *
 * Priority (highest wins):
 *   1. config.effectsEnabled === false           → no effect ("Global OFF")
 *   2. config.manualEffectId is set               → that exact effect
 *   3. config.automaticWeatherEnabled === true    → weather-mapped effect
 *   4. otherwise                                   → no effect
 *
 * `config` is the Firestore settings/seasonal_effects doc, shape:
 *   { effectsEnabled: boolean, automaticWeatherEnabled: boolean,
 *     manualEffectId: string|null, effects: { rainSound: boolean } }
 * Missing fields default to the pre-existing behaviour (effectsEnabled
 * defaults to true, automaticWeatherEnabled defaults to false, manualEffectId
 * defaults to null) so older/partial docs don't unexpectedly disable
 * everything.
 *
 * `weather` is the last normalized weather reading from weather-service.js
 * (or null if unavailable) — see weather-normalizer.js for its shape.
 *
 * Returns: { key: string|null, variant?: string, isNight?: boolean, source: 'manual'|'weather'|'none' }
 * `key` is a registry key in seasonal-effects-manager.js, or null for "no effect".
 */
export function resolveActiveEffect(config, weather) {
  const cfg = config || {};
  const effectsEnabled = cfg.effectsEnabled !== false; // default true
  const automaticWeatherEnabled = cfg.automaticWeatherEnabled === true; // default false
  const manualEffectId = typeof cfg.manualEffectId === "string" && cfg.manualEffectId ? cfg.manualEffectId : null;

  if (!effectsEnabled) {
    return { key: null, source: "none" };
  }

  if (manualEffectId) {
    return { key: manualEffectId, source: "manual" };
  }

  if (automaticWeatherEnabled && weather && weather.effect) {
    return { key: weather.effect, variant: weather.variant, isNight: weather.isNight, source: "weather" };
  }

  return { key: null, source: "none" };
}
