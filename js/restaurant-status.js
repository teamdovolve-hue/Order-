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
 */

import { db }              from "./firebase-config.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// Top-level layout elements to hide when ordering is disabled
// Tracks the current status so call sites can check before submitting orders.
// Starts FALSE (fail-closed): ordering is blocked until Firestore confirms it
// is enabled. This prevents orders from slipping through during the async load
// window and keeps the offline screen visible until status is confirmed.
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

  onSnapshot(
    statusRef,
    (snap) => {
      // If the document doesn't exist yet, default to ON (safe fallback)
      const enabled = snap.exists()
        ? snap.data().onlineOrderingEnabled !== false
        : true;
      _applyStatus(enabled);
    },
    (err) => {
      // On listener error (permissions, network) default to ON so customers
      // are never permanently locked out due to a Firestore hiccup
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
