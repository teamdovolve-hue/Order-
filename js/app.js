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
 * [AI UPDATE 2026-09-24] PWA upgrade. New boot step "0a" (after auth, before the table chip):
 * initTableGate() applies the 3-hour TABLE session (js/table-session.js) — a scanned /t/:n
 * starts one, an installed app re-opened later reuses it while valid, and an expired one shows
 * the "scan your table" screen. That is completely separate from login: nothing here touches
 * the customer session, cart, history or coupons. initPwaInstall() (step 5h) adds the install
 * popup/banner + service worker.
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
// [AI UPDATE 2026-09-12] "My Offers" drawer — customer's loyalty/personalized coupons
import { initOffers }                       from "./offers.js";
import { initSearch }                       from "./search.js";
import { initOrderStatus, stopOrderStatus } from "./order-status.js";
import { initRestaurantStatus,
         isOrderingEnabled }                from "./restaurant-status.js";
import { initReview, openReview,
         closeReview }                      from "./review.js";
// [AI UPDATE 2026-08-02] Phase 1 — Item Details Sheet
import { initItemSheet }                    from "./item-sheet.js";
// [AI UPDATE 2026-08-02] Phase 2 — Floating Category FAB
import { initCategoryFab }                  from "./category-fab.js";
// [AI UPDATE 2026-08-03] Phase 3 — Intelligent Home Screen
import { initHomeSections }                 from "./home-sections.js";
// Variant picker — intercepts +/- on group cards with multiple variants
import { initVariantPicker }                from "./variant-picker.js";
// [AI UPDATE 2026-09-18] Smart Assistant — rule-based customer chat widget
import { initSmartAssistant }               from "./smart-assistant.js";
// [AI UPDATE 2026-09-21] Voice Assistant — mic button beside Search (Deepgram STT + Groq NLU via /api/voice/*)
import { initVoiceAssistant }               from "./voice-assistant.js";
// [AI UPDATE 2026-09-24] PWA — 3-hour table session gate + install prompt
import { syncTrustedTime }                  from "./table-session.js";
import { initTableGate }                    from "./table-gate.js";
import { initPwaInstall }                   from "./pwa-install.js";

document.addEventListener("DOMContentLoaded", async () => {

  // Firebase Auth restores the persisted customer identity asynchronously.
  // Resolve it before inspecting the URL so an edited /t/:n path can never
  // become the active table while a server-owned table session exists.
  //
  // Safety: race with a 4-second timeout so a slow/blocked Firebase response
  // (e.g. domain not yet in Auth authorized list, CDN hiccup) never freezes
  // the page — customers can still browse the menu; login is only required
  // when they actually tap "Place Order".
  // [AI UPDATE 2026-09-24] Learn the real time (server Date header) in parallel with auth so the
  // 3-hour table session is judged against a trustworthy clock. Never throws / never blocks >2.5 s.
  const _timeSync = syncTrustedTime();
  initAuth();
  initRestaurantStatus();
  await Promise.race([
    waitForAuthReady(),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  if (isLoggedIn()) await loadActiveTableAssignment().catch(() => {});

  // ── 0a. Table session (3 h) — [AI UPDATE 2026-09-24] ──────────
  //   Scanned QR (/t/:n) → new session; installed app re-opened → reuse while valid;
  //   expired → "scan your table" overlay. Login is NOT affected. Guarded: a failure here
  //   must never stop the core panel booting (legacy behaviour then applies).
  await _timeSync;
  try { initTableGate(); } catch (err) { console.warn("[table-session] init failed:", err); }

  // ── 0. Table ID — no gate, always proceeds ───────────────────
  //   Returns "Table N" for valid QR URLs, "Unknown" for direct access.
  //   Removed QR gate so testing without a QR code still works.

  const tableId = getTableId();

  // ── 1. Table badge ────────────────────────────────────────────
  const badge = document.getElementById("tableBadge");
  // [AI UPDATE 2026-09-24] getTableId() is null while the "scan your table" screen is up.
  if (badge) badge.textContent = tableId || "—";

  // ── 2. Menu ───────────────────────────────────────────────────
  initMenu();

  // ── 3. Search ─────────────────────────────────────────────────
  initSearch(filterBySearch);

  // ── 4. History ────────────────────────────────────────────────
  initHistory();

  // ── 4b. Offers ────────────────────────────────────────────────
  // [AI UPDATE 2026-09-12] Wires the 🎟️ header button → coupons drawer
  initOffers();

  // ── 5. Review sheet ───────────────────────────────────────────
  initReview();

  // ── 5b. Item Details Sheet ────────────────────────────────────
  // [AI UPDATE 2026-08-02] Phase 1 — wire item sheet DOM events
  initItemSheet();

  // ── 5c. Category FAB ──────────────────────────────────────────
  // [AI UPDATE 2026-08-02] Phase 2 — floating category jump button
  initCategoryFab();

  // ── 5d. Home Sections ─────────────────────────────────────────
  // [AI UPDATE 2026-08-03] Phase 3 — registers renderer with menu.js
  initHomeSections();

  // ── 5e. Variant Picker ────────────────────────────────────────
  // Intercepts +/- on group cards; shows "add/remove which variant?" sheet
  initVariantPicker();

  // ── 5f. Smart Assistant ───────────────────────────────────────
  // [AI UPDATE 2026-09-18] Wires the 🤖 floating button → chat panel
  initSmartAssistant();

  // ── 5g. Voice Assistant ───────────────────────────────────────
  // [AI UPDATE 2026-09-21] Wires the mic button beside Search → voice panel. Reuses the
  // cart / offers / history code above through their existing entry points.
  // Guarded: an add-on feature must never be able to stop the core panel's boot sequence below.
  try { initVoiceAssistant(); } catch (err) { console.warn("[voice] init failed:", err); }

  // ── 5h. PWA install prompt + service worker ───────────────────
  // [AI UPDATE 2026-09-24] Real `beforeinstallprompt` flow only; shows nothing when
  // installation isn't available or the app is already installed. Guarded like the voice add-on.
  try { initPwaInstall(); } catch (err) { console.warn("[pwa] init failed:", err); }

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
