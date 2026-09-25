/**
 * weather-service.js — Weather + Effect Engine (Customer Panel)
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE.
 *
 * Fetches /api/weather (server-side OpenWeather proxy — see api/weather.js)
 * and normalizes the result via weather-normalizer.js. Never throws: any
 * failure resolves to `null`, and the caller (seasonal-effects-manager.js)
 * keeps whatever effect was previously showing rather than flashing the UI.
 *
 * Client-side caching (on top of the server's own cache — see api/weather.js):
 *   sessionStorage, TTL 10 minutes, keyed by rounded coordinates. This is what
 *   stops the Customer Panel calling the endpoint on every menu navigation —
 *   within one browser tab session, repeat calls inside the TTL are free.
 *
 * Restaurant location: read from Firestore settings/restaurant_location
 * { lat, lon } (public-read, same as every other `settings/*` doc — see
 * firebase-config.js / effects-admin.js on the Admin side, which is where the
 * restaurant owner sets this). Falls back to no lat/lon (server uses its own
 * default) if the doc doesn't exist yet.
 */
import { db } from "../firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { normalizeWeather } from "./weather-normalizer.js";

const CACHE_KEY = "fx_weather_cache_v1";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FETCH_TIMEOUT_MS = 5000;

let locationPromise = null;

function readLocation() {
  if (locationPromise) return locationPromise;
  locationPromise = getDoc(doc(db, "settings", "restaurant_location"))
    .then((snap) => {
      const d = snap.exists() ? snap.data() : null;
      const lat = d && typeof d.lat === "number" ? d.lat : null;
      const lon = d && typeof d.lon === "number" ? d.lon : null;
      return lat !== null && lon !== null ? { lat, lon } : null;
    })
    .catch(() => null);
  return locationPromise;
}

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.expiresAt !== "number") return null;
    if (parsed.expiresAt < Date.now()) return null;
    return parsed.normalized || null;
  } catch (_) {
    return null;
  }
}

function writeCache(normalized) {
  try {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ normalized, expiresAt: Date.now() + CACHE_TTL_MS })
    );
  } catch (_) {
    // sessionStorage unavailable (private mode / quota) — fine, just skip caching
  }
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Returns the last-known normalized weather effect, or `null` if none is
 * available yet / the request failed and there is no usable cache.
 * Shape: { effect, variant, isNight } — see weather-normalizer.js.
 */
export async function getWeatherEffect() {
  const cached = readCache();
  if (cached) return cached;

  try {
    const loc = await readLocation();
    const qs = loc ? `?lat=${loc.lat}&lon=${loc.lon}` : "";
    const res = await fetchWithTimeout(`/api/weather${qs}`, FETCH_TIMEOUT_MS);
    if (!res || !res.ok) return null;
    const data = await res.json();
    if (!data || data.ok !== true) return null;
    const normalized = normalizeWeather(data);
    writeCache(normalized);
    return normalized;
  } catch (_) {
    return null; // network error, timeout, bad JSON — never break the panel
  }
}
