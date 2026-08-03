/**
 * review.js
 * ─────────────────────────────────────────────────────────────
 * Order Review Sheet — shown when customer taps "View Details"
 * in the cart bar. Lets the customer review items, adjust
 * quantities, and confirm before the order is submitted.
 *
 * Public API:
 *   initReview()            — wire DOM events once on DOMContentLoaded
 *   openReview(onPlaceOrder) — show the sheet; onPlaceOrder() is called
 *                              when the customer taps "Place Order →"
 *   closeReview()           — hide the sheet
 *
 * [AI UPDATE 2026-08-01] New module — inserts the Review step between
 * cart bar "View Details" and the existing requireLogin / placeOrder flow.
 * No order-creation, auth, or cart logic was changed.
 */

import { cart, addItem, removeItem, cartExtras } from "./cart.js";

/** Callback supplied by app.js — called when customer taps "Place Order →" */
let _onPlaceOrder = null;

// ── Public ────────────────────────────────────────────────────

/** Wire static DOM events. Call once on DOMContentLoaded. */
export function initReview() {
  document.getElementById("reviewBackBtn")
    ?.addEventListener("click", closeReview);

  document.getElementById("reviewPlaceBtn")
    ?.addEventListener("click", () => {
      if (_onPlaceOrder) _onPlaceOrder();
    });

  // Tap backdrop to close
  document.getElementById("reviewModal")
    ?.querySelector(".review-backdrop")
    ?.addEventListener("click", closeReview);

  // Delegated +/− handlers inside the item list
  document.getElementById("reviewItems")
    ?.addEventListener("click", _onItemAction);
}

/**
 * Open the review sheet.
 * @param {function} onPlaceOrder - called when customer taps "Place Order →"
 */
export function openReview(onPlaceOrder) {
  _onPlaceOrder = onPlaceOrder;
  _render();
  document.getElementById("reviewModal")?.classList.remove("hidden");
}

/** Close the review sheet. */
export function closeReview() {
  document.getElementById("reviewModal")?.classList.add("hidden");
  _onPlaceOrder = null;
}

// ── Internal ──────────────────────────────────────────────────

/** Handle +/− button clicks inside the item list. */
function _onItemAction(e) {
  const btn    = e.target.closest("[data-review-action]");
  if (!btn) return;
  const id     = btn.dataset.id;
  const action = btn.dataset.reviewAction;
  const item   = cart.get(id);
  if (!item) return;

  if (action === "inc") {
    addItem(id, item.name, item.price);
  } else if (action === "dec") {
    removeItem(id);
  }

  // Auto-close if the customer removed the last item
  if (cart.size === 0) {
    closeReview();
    return;
  }

  _render();
}

/** Re-render item list and totals from current cart state. */
function _render() {
  const itemsEl  = document.getElementById("reviewItems");
  const totalsEl = document.getElementById("reviewTotals");
  if (!itemsEl || !totalsEl) return;

  let totalQty = 0;
  let totalAmt = 0;
  const rows   = [];

  for (const item of cart.values()) {
    const lineTotal = item.price * item.qty;
    totalQty       += item.qty;
    totalAmt       += lineTotal;

    // [AI UPDATE 2026-08-02] UX upgrade — show selected extras below item name
    const extras    = cartExtras.get(item.id)?.extras || [];
    const extrasHtml = extras.length
      ? `<ul class="review-extras-list">${extras.map(e =>
          `<li class="review-extra-item">• ${_esc(e.name)}</li>`
        ).join("")}</ul>`
      : "";

    rows.push(`
      <div class="review-item">
        <div class="review-item-info">
          <span class="review-item-name">${_esc(item.name)}</span>
          ${extrasHtml}
          <span class="review-item-unit-price">₹${item.price} × ${item.qty}</span>
        </div>
        <div class="review-item-right">
          <span class="review-item-line-total">₹${lineTotal.toFixed(0)}</span>
          <div class="review-qty-ctrl">
            <button
              class="review-qty-btn"
              data-review-action="dec"
              data-id="${_esc(item.id)}"
              aria-label="Remove one ${_esc(item.name)}">−</button>
            <span class="review-qty-num">${item.qty}</span>
            <button
              class="review-qty-btn"
              data-review-action="inc"
              data-id="${_esc(item.id)}"
              aria-label="Add one ${_esc(item.name)}">+</button>
          </div>
        </div>
      </div>
      <hr class="review-divider" />`);
  }

  itemsEl.innerHTML = rows.join("");

  const fmt = (n) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

  totalsEl.innerHTML = `
    <div class="review-total-row">
      <span class="review-total-label">Total Items</span>
      <span class="review-total-value">${totalQty}</span>
    </div>
    <div class="review-total-row review-grand-total">
      <span class="review-total-label">Grand Total</span>
      <span class="review-total-value review-grand-amount">${fmt(totalAmt)}</span>
    </div>`;

  // Keep Place Order button in sync
  const placeBtn = document.getElementById("reviewPlaceBtn");
  if (placeBtn) placeBtn.disabled = (cart.size === 0);
}

function _esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
