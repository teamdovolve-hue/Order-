/**
 * app.js — Entry point
 * ─────────────────────────────────────────────────────────────
 * Boot sequence:
 *   1. Set table badge from ?table= URL param
 *   2. Init auth (wire OTP modal events)
 *   3. Init menu (real-time Firestore listener — no auth needed)
 *   4. Init search
 *   5. Init order history drawer
 *   6. Watch custom auth state → start/stop order status listener
 *   7. Wire Place Order button (gates on login via requireLogin)
 *   8. Wire overlay close buttons
 */

import { initMenu, filterBySearch }         from "./menu.js";
import { placeOrder, getTableId }           from "./order.js";
import { updateGreeting, initAuth,
         requireLogin, isLoggedIn }         from "./auth.js";
import { initHistory }                      from "./history.js";
import { initSearch }                       from "./search.js";
import { initOrderStatus, stopOrderStatus } from "./order-status.js";

document.addEventListener("DOMContentLoaded", () => {

  // 1. Table badge — from server-injected window.__TABLE_ID__
  const tableId = getTableId();          // null if not reached via /t/:n
  const badge   = document.getElementById("tableBadge");
  if (badge) badge.textContent = tableId ? tableId : "Table —";

  // 2. Auth — wire OTP modal, logout button; update greeting chip
  initAuth();

  // 3. Menu loads immediately (customers can browse before logging in)
  initMenu();

  // 4. Real-time search
  initSearch(filterBySearch);

  // 5. History drawer
  initHistory();

  // 6. Auth state watcher — start/stop order-status listener
  //    Fires on login / logout via the custom event dispatched by auth.js
  const _handleAuthChange = (user) => {
    updateGreeting();
    if (user) {
      initOrderStatus();   // subscribe to this customer's orders
    } else {
      stopOrderStatus();   // unsubscribe on logout
    }
  };

  window.addEventListener("customAuthStateChanged", (e) => {
    _handleAuthChange(e.detail?.user ?? null);
  });

  // Also handle the already-logged-in state on page load
  if (isLoggedIn()) {
    initOrderStatus();
  }

  // 7. Place Order — prompts login if needed, then submits
  document.getElementById("placeOrderBtn")
    ?.addEventListener("click", () => {
      requireLogin(() => placeOrder());
    });

  // 8. Retry on menu load error
  document.getElementById("retryBtn")
    ?.addEventListener("click", () => {
      document.getElementById("errorState")?.classList.add("hidden");
      initMenu();
    });

  // 9. Success overlay close
  document.getElementById("overlayCloseBtn")
    ?.addEventListener("click", () => {
      document.getElementById("successOverlay")?.classList.add("hidden");
      const btn = document.getElementById("placeOrderBtn");
      if (btn) { btn.disabled = false; btn.textContent = "Place Order →"; }
    });

  // 10. Error overlay close
  document.getElementById("errorOverlayCloseBtn")
    ?.addEventListener("click", () => {
      document.getElementById("errorOverlay")?.classList.add("hidden");
    });

});
