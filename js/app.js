/**
 * app.js — Entry point
 * ─────────────────────────────────────────────────────────────
 * Boot sequence:
 *   1. Set table badge from URL (auto-set by QR code)
 *   2. Show customer greeting if returning visitor
 *   3. Init menu (fetch + render from Firestore)
 *   4. Init order history drawer
 *   5. Wire all buttons
 */

import { initMenu }                from "./menu.js";
import { placeOrder, getTableId }  from "./order.js";
import { updateGreeting }          from "./customer.js";
import { initHistory }             from "./history.js";

document.addEventListener("DOMContentLoaded", () => {

  // 1. Table badge — value comes from ?table=T4 in the QR URL
  const tableId = getTableId();
  const badge   = document.getElementById("tableBadge");
  if (badge) badge.textContent = `Table ${tableId}`;

  // 2. Greeting chip (visible if customer already submitted their info)
  updateGreeting();

  // 3. Menu
  initMenu();

  // 4. History drawer
  initHistory();

  // 5. Place Order
  document.getElementById("placeOrderBtn")
    ?.addEventListener("click", placeOrder);

  // 6. Retry on menu load error
  document.getElementById("retryBtn")
    ?.addEventListener("click", () => {
      document.getElementById("errorState")?.classList.add("hidden");
      initMenu();
    });

  // 7. Success overlay close
  document.getElementById("overlayCloseBtn")
    ?.addEventListener("click", () => {
      document.getElementById("successOverlay")?.classList.add("hidden");
      const btn = document.getElementById("placeOrderBtn");
      if (btn) btn.textContent = "Place Order →";
    });

  // 8. Error overlay close
  document.getElementById("errorOverlayCloseBtn")
    ?.addEventListener("click", () => {
      document.getElementById("errorOverlay")?.classList.add("hidden");
    });

});
