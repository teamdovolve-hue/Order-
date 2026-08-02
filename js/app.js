/**
 * app.js — Entry point
 * ─────────────────────────────────────────────────────────────
 * Boot sequence:
 *   0. Validate table from URL (/t/:n) — show error page if invalid
 *   1. Set table badge
 *   2. Init auth (wire temporary phone-login events)
 *   3. Init menu (real-time Firestore listener — no auth needed)
 *   4. Init search
 *   5. Init order history drawer
 *   6. Wire review sheet
 *   7. Watch custom auth state → start/stop order status listener
 *   8. Wire "View Details" button → Order Review Sheet → requireLogin → placeOrder
 *   9. Wire overlay close buttons
 *
 * [AI UPDATE 2026-08-01] Step 8: cart bar button now opens the Order Review Sheet
 * (review.js) instead of triggering requireLogin/placeOrder directly. The review
 * sheet's "Place Order →" button continues to the existing requireLogin/placeOrder
 * flow — no order creation logic was changed.
 */

import { initMenu, filterBySearch }         from "./menu.js";
import { placeOrder, getTableId,
         loadActiveTableAssignment }        from "./order.js";
import { updateGreeting, initAuth,
         requireLogin, isLoggedIn,
         waitForAuthReady }                 from "./auth.js";
import { initHistory }                      from "./history.js";
import { initSearch }                       from "./search.js";
import { initOrderStatus, stopOrderStatus } from "./order-status.js";
import { initRestaurantStatus,
         isOrderingEnabled }                from "./restaurant-status.js";
import { initReview, openReview,
         closeReview }                      from "./review.js";
// [AI UPDATE 2026-08-02] Phase 1 — Item Details Sheet
import { initItemSheet }                    from "./item-sheet.js";

document.addEventListener("DOMContentLoaded", async () => {

  // Firebase Auth restores the persisted customer identity asynchronously.
  // Resolve it before inspecting the URL so an edited /t/:n path can never
  // become the active table while a server-owned table session exists.
  //
  // Safety: race with a 4-second timeout so a slow/blocked Firebase response
  // (e.g. domain not yet in Auth authorized list, CDN hiccup) never freezes
  // the page — customers can still browse the menu; login is only required
  // when they actually tap "Place Order".
  initAuth();
  initRestaurantStatus();
  await Promise.race([
    waitForAuthReady(),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  if (isLoggedIn()) await loadActiveTableAssignment().catch(() => {});

  // ── 0. Table gate ─────────────────────────────────────────────
  //   Check this before anything else.  If the customer didn't arrive
  //   via a valid /t/1…/t/10 QR URL, replace the page with the correct
  //   error screen and stop.  Nothing else initialises.

  const tableId    = getTableId();
  const isTableUrl = /^\/t\//.test(window.location.pathname);

  if (!tableId) {
    _showGatePage(isTableUrl ? "invalid" : "scan");
    return;
  }

  // ── 1. Table badge ────────────────────────────────────────────
  const badge = document.getElementById("tableBadge");
  if (badge) badge.textContent = tableId;

  // ── 2. Menu ───────────────────────────────────────────────────
  initMenu();

  // ── 3. Search ─────────────────────────────────────────────────
  initSearch(filterBySearch);

  // ── 4. History ────────────────────────────────────────────────
  initHistory();

  // ── 5. Review sheet ───────────────────────────────────────────
  initReview();

  // ── 5b. Item Details Sheet ────────────────────────────────────
  // [AI UPDATE 2026-08-02] Phase 1 — wire item sheet DOM events
  initItemSheet();

  // ── 6. Auth state watcher ─────────────────────────────────────
  const _handleAuthChange = async (user) => {
    updateGreeting();
    if (user) {
      await loadActiveTableAssignment();
      initOrderStatus();
    } else {
      stopOrderStatus();
    }
  };

  window.addEventListener("customAuthStateChanged", (e) => {
    _handleAuthChange(e.detail?.user ?? null);
  });

  if (isLoggedIn()) initOrderStatus();

  // ── 8. View Details → Order Review Sheet ─────────────────────
  //   [AI UPDATE 2026-08-01] Cart bar button now opens the review sheet.
  //   Inside the review sheet the customer taps "Place Order →" which
  //   calls requireLogin → placeOrder — the existing flow unchanged.
  document.getElementById("placeOrderBtn")
    ?.addEventListener("click", () => {
      if (!isOrderingEnabled()) return; // offline screen is already visible
      openReview(() => {
        // Close review FIRST so the login modal (if needed) is never obscured
        // by the review sheet. Both modals use the same z-index layer.
        closeReview();
        requireLogin(() => {
          // Re-check after auth completes: status may have changed during
          // the login flow (e.g. operator disabled ordering while signing in)
          if (!isOrderingEnabled()) return;
          placeOrder();
        });
      });
    });

  // ── 9. Retry on menu load error ──────────────────────────────
  document.getElementById("retryBtn")
    ?.addEventListener("click", () => {
      document.getElementById("errorState")?.classList.add("hidden");
      initMenu();
    });

  // ── 10. Success overlay close ─────────────────────────────────
  document.getElementById("overlayCloseBtn")
    ?.addEventListener("click", () => {
      document.getElementById("successOverlay")?.classList.add("hidden");
      // placeOrderBtn text is "View Details" — keep it; cart is already
      // empty so the bar will be hidden by refreshCartUI in clearCart().
    });

  // ── 11. Error overlay close ───────────────────────────────────
  document.getElementById("errorOverlayCloseBtn")
    ?.addEventListener("click", () => {
      document.getElementById("errorOverlay")?.classList.add("hidden");
    });

});

// ── Gate-page renderer ────────────────────────────────────────
//   Replaces the entire <body> so no menu/auth code can run.

function _showGatePage(type) {
  const isScan = type === "scan";

  const icon    = isScan ? "📷" : "🚫";
  const heading = isScan ? "Scan Your Table QR" : "Invalid QR Code";
  const body    = isScan
    ? "Please scan the QR code printed on your table to view the menu and place an order."
    : "This QR code is not recognised. Please scan the QR code printed on your table.";

  document.body.innerHTML = `
    <style>
      body {
        margin: 0;
        min-height: 100dvh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #1A1E29;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        padding: 24px;
        box-sizing: border-box;
      }
      .gate-card {
        background: #242838;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 20px;
        padding: 44px 32px;
        max-width: 360px;
        width: 100%;
        text-align: center;
      }
      .gate-icon  { font-size: 56px; margin-bottom: 20px; }
      .gate-title { font-size: 22px; font-weight: 800; color: #fff; margin: 0 0 12px; }
      .gate-body  { font-size: 14px; color: rgba(255,255,255,0.5); line-height: 1.65; margin: 0; }
    </style>
    <div class="gate-card">
      <div class="gate-icon">${icon}</div>
      <h1 class="gate-title">${heading}</h1>
      <p class="gate-body">${body}</p>
    </div>`;
}
