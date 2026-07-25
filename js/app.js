/**
 * app.js — Entry point
 * ─────────────────────────────────────────────────────────────
 * Boot sequence:
 *   1. Set table badge from URL
 *   2. Init login system (wire events; show screen if first visit)
 *   3. Init menu (fetch + render from Firestore)
 *   4. Init search
 *   5. Init order history drawer
 *   6. Init real-time order status (requires login)
 *   7. Wire all buttons
 */

import { initMenu, filterBySearch }      from "./menu.js";
import { placeOrder, getTableId }        from "./order.js";
import { updateGreeting }                from "./customer.js";
import { initHistory }                   from "./history.js";
import { initLogin, isLoggedIn, requireLogin } from "./login.js";
import { initSearch }                          from "./search.js";
import { initOrderStatus }                     from "./order-status.js";

document.addEventListener("DOMContentLoaded", () => {

  // 1. Table badge — from ?table=T4 in QR URL
  const tableId = getTableId();
  const badge   = document.getElementById("tableBadge");
  if (badge) badge.textContent = `Table ${tableId}`;

  // 2. Login system — wire events
  initLogin();

  // 3. Menu (loads in background while login screen may be showing)
  initMenu();

  // 4. Search — filters menu in real-time
  initSearch(filterBySearch);

  // 5. History drawer
  initHistory();

  // 6. Show login on first visit; start order status after login resolves
  if (isLoggedIn()) {
    updateGreeting();
    initOrderStatus();
  } else {
    // Show login screen immediately on page load
    requireLogin(() => {
      updateGreeting();
      initOrderStatus();
    });
  }

  // 7. Place Order button — also gates on login via cart.js → requireCustomer
  document.getElementById("placeOrderBtn")
    ?.addEventListener("click", placeOrder);

  // 8. Retry on menu load error
  document.getElementById("retryBtn")
    ?.addEventListener("click", () => {
      document.getElementById("errorState")?.classList.add("hidden");
      initMenu();
    });

  // 10. Success overlay close
  document.getElementById("overlayCloseBtn")
    ?.addEventListener("click", () => {
      document.getElementById("successOverlay")?.classList.add("hidden");
      const btn = document.getElementById("placeOrderBtn");
      if (btn) btn.textContent = "Place Order →";
    });

  // 11. Error overlay close
  document.getElementById("errorOverlayCloseBtn")
    ?.addEventListener("click", () => {
      document.getElementById("errorOverlay")?.classList.add("hidden");
    });

});
