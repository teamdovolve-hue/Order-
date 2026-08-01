/**
 * restaurant-status.js
 * ─────────────────────────────────────────────────────────────
 * Listens to settings/restaurant_status { onlineOrderingEnabled: boolean }
 * in Firestore and toggles the ordering offline screen in real-time.
 *
 * Called once from app.js: initRestaurantStatus()
 *
 * Behaviour:
 *   • onlineOrderingEnabled = true  (or document missing) → menu visible
 *   • onlineOrderingEnabled = false → offline screen shown, menu hidden
 *   • Operator toggle in Billing Panel propagates within seconds via onSnapshot
 *   • No page refresh needed — menu reappears automatically when re-enabled
 *
 * Loading vs disabled states:
 *   • #orderingOfflineScreen starts HIDDEN (class="hidden" in HTML).
 *   • It is only shown after the Firestore SERVER (not IndexedDB cache) confirms
 *     onlineOrderingEnabled = false.  This prevents the offline screen from
 *     appearing permanently due to stale cached data or a slow connection.
 *   • If the server does not respond within FIRESTORE_TIMEOUT_MS, we default
 *     to ON so customers are never permanently locked out by a network hiccup.
 *
 * [AI UPDATE 2026-08-01] Fixed regression: paused screen shown permanently when
 * IndexedDB cache had a stale onlineOrderingEnabled=false value.
 *   1. #orderingOfflineScreen now starts hidden (index.html change).
 *   2. includeMetadataChanges:true so we can distinguish cache vs server data.
 *   3. Stale cached false values are ignored; only server-confirmed false shows paused.
 *   4. 8-second fallback timer defaults to ON if Firestore never responds.
 */

import { db }              from "./firebase-config.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// How long (ms) to wait for a server-confirmed snapshot before defaulting to ON.
const FIRESTORE_TIMEOUT_MS = 8000;

// Tracks the current ordering status.  Starts false (ordering blocked) until
// Firestore server confirms it is enabled — but the UI is NOT fail-closed:
// #orderingOfflineScreen is hidden by default in HTML and only shown after the
// server explicitly returns false.
let _orderingEnabled = false;

/** Returns true when online ordering is currently enabled. */
export function isOrderingEnabled() { return _orderingEnabled; }

// Top-level layout elements to hide when ordering is disabled
const MAIN_SELECTORS = [
  ".app-header",
  ".search-wrap",
  ".category-nav",
  ".main-content",
  ".cart-bar",
];

export function initRestaurantStatus() {
  const statusRef = doc(db, "settings", "restaurant_status");

  // Fallback: if Firestore does not deliver a server-confirmed snapshot within
  // FIRESTORE_TIMEOUT_MS, default to ON.  This covers slow connections where
  // the SDK is still connecting but has not thrown an error.
  let _serverResponded = false;
  const fallbackTimer = setTimeout(() => {
    if (!_serverResponded) {
      console.warn(
        "[restaurant-status] Firestore server did not respond within",
        FIRESTORE_TIMEOUT_MS,
        "ms — defaulting to ON."
      );
      _applyStatus(true);
    }
  }, FIRESTORE_TIMEOUT_MS);

  onSnapshot(
    statusRef,
    // includeMetadataChanges:true fires the callback twice per server round-trip:
    // once immediately from the local IndexedDB cache (snap.metadata.fromCache=true)
    // and once when the server responds (snap.metadata.fromCache=false).
    // We use this to distinguish loading state from a real disabled state.
    { includeMetadataChanges: true },
    (snap) => {
      // If the document doesn't exist, default to ON (safe fallback)
      const enabled = snap.exists()
        ? snap.data().onlineOrderingEnabled !== false
        : true;

      // ── Cache-only snapshot ────────────────────────────────────────────────
      // If the data comes from the local IndexedDB cache and says "disabled",
      // do NOT apply the paused state yet.  The cache may be stale (e.g. the
      // Billing Panel enabled ordering after the last cache write).  Wait for
      // the server snapshot to arrive before locking out customers.
      //
      // If the cache says "enabled", it is safe to apply immediately — showing
      // the menu to a customer who should be blocked is a minor issue; showing
      // a "paused" screen to a customer who should be ordering is far worse.
      if (snap.metadata.fromCache && !enabled) {
        // Stay in the current UI state (paused screen hidden, main UI visible)
        // until the server confirms.
        return;
      }

      // ── Server-confirmed snapshot (or cache saying enabled) ────────────────
      clearTimeout(fallbackTimer);
      _serverResponded = true;
      _applyStatus(enabled);
    },
    (err) => {
      // On listener error (permissions, network) default to ON so customers
      // are never permanently locked out due to a Firestore hiccup.
      clearTimeout(fallbackTimer);
      _serverResponded = true;
      console.warn(
        "[restaurant-status] Listener error — defaulting to ON:",
        err.message
      );
      _applyStatus(true);
    }
  );
}

function _applyStatus(enabled) {
  _orderingEnabled = enabled;

  const offlineScreen = document.getElementById("orderingOfflineScreen");
  if (!offlineScreen) return;

  if (enabled) {
    // Restore main UI
    offlineScreen.classList.add("hidden");
    MAIN_SELECTORS.forEach((sel) => {
      document.querySelector(sel)?.classList.remove("ors-hidden");
    });
  } else {
    // Hide main UI and show offline screen
    offlineScreen.classList.remove("hidden");
    MAIN_SELECTORS.forEach((sel) => {
      document.querySelector(sel)?.classList.add("ors-hidden");
    });
  }
}
