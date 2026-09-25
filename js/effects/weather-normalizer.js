/**
 * weather-normalizer.js — Weather + Effect Engine (Customer Panel)
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE.
 *
 * Turns an OpenWeather "condition id" (json.weather[0].id — see
 * https://openweathermap.org/weather-conditions) into ONE internal effect id
 * that the SeasonalEffectsManager registry knows how to render. This is the
 * ONLY place condition-id → effect-id logic lives — nothing else in the
 * Customer Panel should branch on OpenWeather ids/strings directly.
 *
 * Internal effect ids (registry keys in seasonal-effects-manager.js):
 *   'sunny'   'cloudy'   'rain'   'snow'   'fog'   (+ festival keys, unrelated)
 *
 * Several OpenWeather conditions intentionally map to the SAME internal
 * effect because the *visual treatment* is the same family even though
 * OpenWeather models them as distinct ids (e.g. every rain/drizzle/
 * thunderstorm id → 'rain', which already includes lightning/thunder — see
 * rain-effect.js). Where a finer visual distinction is worth it, a `variant`
 * string is returned alongside the effect id and the effect module reads it
 * via update({ variant }) to tint/adjust itself (see fog-effect.js, which
 * supports mist/fog/haze/smoke/dust/sand/ash variants).
 */

// id ranges per OpenWeather's documented groups:
//  2xx Thunderstorm · 3xx Drizzle · 5xx Rain · 6xx Snow · 7xx Atmosphere · 800 Clear · 80x Clouds
export function normalizeWeather({ condId, main, icon } = {}) {
  const isNight = typeof icon === "string" && icon.endsWith("n");
  const id = typeof condId === "number" ? condId : null;

  // ── Thunderstorm (2xx) — rain effect already includes lightning + thunder ──
  if (id !== null && id >= 200 && id < 300) {
    return { effect: "rain", variant: "thunderstorm", isNight };
  }

  // ── Drizzle (3xx) ──
  if (id !== null && id >= 300 && id < 400) {
    return { effect: "rain", variant: "drizzle", isNight };
  }

  // ── Rain (5xx) — light/moderate/heavy/extreme/freezing all → rain family ──
  if (id !== null && id >= 500 && id < 600) {
    let variant = "moderate";
    if (id === 500 || id === 520) variant = "light";
    else if (id === 501 || id === 521) variant = "moderate";
    else if (id === 502 || id === 503 || id === 522) variant = "heavy";
    else if (id === 504 || id === 531) variant = "extreme";
    else if (id === 511) variant = "freezing";
    return { effect: "rain", variant, isNight };
  }

  // ── Snow (6xx) — includes sleet (611-616) ──
  if (id !== null && id >= 600 && id < 700) {
    let variant = "moderate";
    if (id === 600 || id === 620) variant = "light";
    else if (id === 602 || id === 622) variant = "heavy";
    else if (id >= 611 && id <= 616) variant = "sleet";
    return { effect: "snow", variant, isNight };
  }

  // ── Atmosphere (7xx): mist/fog/haze/smoke/dust/sand/ash/squall/tornado ──
  if (id !== null && id >= 700 && id < 800) {
    if (id === 731 || id === 761) return { effect: "fog", variant: "dust", isNight };
    if (id === 751) return { effect: "fog", variant: "sand", isNight };
    if (id === 762) return { effect: "fog", variant: "ash", isNight };
    if (id === 711) return { effect: "fog", variant: "smoke", isNight };
    if (id === 721) return { effect: "fog", variant: "haze", isNight };
    if (id === 701) return { effect: "fog", variant: "mist", isNight };
    if (id === 741) return { effect: "fog", variant: "fog", isNight };
    // 771 squall / 781 tornado — subtle warning atmosphere only, no gimmicks
    if (id === 771 || id === 781) return { effect: "cloudy", variant: "storm", isNight };
    return { effect: "fog", variant: "mist", isNight };
  }

  // ── Clear (800) ──
  if (id === 800) {
    return { effect: "sunny", variant: "clear", isNight };
  }

  // ── Clouds (80x) ──
  if (id !== null && id > 800 && id < 900) {
    let variant = "scattered";
    if (id === 801) variant = "few";
    else if (id === 802) variant = "scattered";
    else if (id === 803) variant = "broken";
    else if (id === 804) variant = "overcast";
    return { effect: "cloudy", variant, isNight };
  }

  // Unknown / missing condition id — fall back to the OpenWeather `main`
  // string, then to a neutral clear-sky look rather than no effect at all.
  const m = (main || "").toLowerCase();
  if (m.includes("rain") || m.includes("drizzle")) return { effect: "rain", variant: "moderate", isNight };
  if (m.includes("thunder")) return { effect: "rain", variant: "thunderstorm", isNight };
  if (m.includes("snow")) return { effect: "snow", variant: "moderate", isNight };
  if (m.includes("cloud")) return { effect: "cloudy", variant: "scattered", isNight };
  if (m) return { effect: "fog", variant: "mist", isNight };
  return { effect: "sunny", variant: "clear", isNight };
}
