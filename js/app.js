/**
 * app.js — Entry point
 * ─────────────────────────────────────────────────────────────
 * Bootstraps the QR Menu Panel:
 *   1. Sets the Table ID badge from the URL
 *   2. Initialises the menu (fetch + render)
 *   3. Wires the "Place Order" and overlay close buttons
 */

import { initMenu }              from "./menu.js";
import { placeOrder, getTableId } from "./order.js";

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {

  // 1. Show table badge
  const tableId = getTableId();
  const badge   = document.getElementById("tableBadge");
  if (badge) badge.textContent = `Table ${tableId}`;

  // 2. Load menu from Firestore
  initMenu();

  // 3. Place Order button
  document.getElementById("placeOrderBtn")?.addEventListener("click", placeOrder);

  // 4. Retry button on load-error
  document.getElementById("retryBtn")?.addEventListener("click", () => {
    document.getElementById("errorState")?.classList.add("hidden");
    initMenu();
  });

  // 5. Success overlay — close → back to menu
  document.getElementById("overlayCloseBtn")?.addEventListener("click", () => {
    document.getElementById("successOverlay")?.classList.add("hidden");
    // Reset Place Order button text
    const btn = document.getElementById("placeOrderBtn");
    if (btn) btn.textContent = "Place Order →";
  });

  // 6. Error overlay — close
  document.getElementById("errorOverlayCloseBtn")?.addEventListener("click", () => {
    document.getElementById("errorOverlay")?.classList.add("hidden");
  });

});
