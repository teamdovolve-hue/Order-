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
 *
 * [AI UPDATE 2026-08-03] Special request support:
 *   - Each cart item now shows its special request (if any) below the name.
 *   - Customers can add/edit/clear the request inline without removing the item.
 *   - Changes are written back to cartExtras immediately.
 *   - The updated specialRequest is included in the order payload via order.js.
 */

import { cart, addItem, removeItem, cartExtras } from "./cart.js";

/** Callback supplied by app.js — called when customer taps "Place Order →" */
let _onPlaceOrder = null;

/**
 * Tracks which item ID is currently in "editing special request" mode.
 * When null, all items render in display mode.
 * @type {string|null}
 */
let _editingRequestId = null;

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

  // Delegated +/− and request handlers inside the item list
  document.getElementById("reviewItems")
    ?.addEventListener("click", _onItemAction);
}

/**
 * Open the review sheet.
 * @param {function} onPlaceOrder - called when customer taps "Place Order →"
 */
export function openReview(onPlaceOrder) {
  _onPlaceOrder = onPlaceOrder;
  _editingRequestId = null;
  _render();
  document.getElementById("reviewModal")?.classList.remove("hidden");
}

/** Close the review sheet. */
export function closeReview() {
  _editingRequestId = null;
  document.getElementById("reviewModal")?.classList.add("hidden");
  _onPlaceOrder = null;
}

// ── Internal ──────────────────────────────────────────────────

/** Handle all button clicks inside the item list. */
function _onItemAction(e) {
  const btn    = e.target.closest("[data-review-action]");
  if (!btn) return;
  const id     = btn.dataset.id;
  const action = btn.dataset.reviewAction;

  // ── Quantity controls ──────────────────────────────────────
  if (action === "inc" || action === "dec") {
    const item = cart.get(id);
    if (!item) return;
    if (action === "inc") {
      addItem(id, item.name, item.price);
    } else {
      removeItem(id);
    }
    if (cart.size === 0) { closeReview(); return; }
    _render();
    return;
  }

  // ── Special request: open edit ─────────────────────────────
  if (action === "edit-req" || action === "add-req") {
    _editingRequestId = id;
    _render();
    // Focus the textarea on next frame
    requestAnimationFrame(() => {
      const ta = document.querySelector(`.review-req-textarea[data-req-id="${CSS.escape(id)}"]`);
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
    });
    return;
  }

  // ── Special request: save ──────────────────────────────────
  if (action === "save-req") {
    const ta  = document.querySelector(`.review-req-textarea[data-req-id="${CSS.escape(id)}"]`);
    const val = (ta?.value || "").trim();
    const existing = cartExtras.get(id) || { extras: [] };
    cartExtras.set(id, { ...existing, specialRequest: val });
    _editingRequestId = null;
    _render();
    return;
  }

  // ── Special request: cancel edit ──────────────────────────
  if (action === "cancel-req") {
    _editingRequestId = null;
    _render();
    return;
  }

  // ── Special request: clear ─────────────────────────────────
  if (action === "clear-req") {
    const existing = cartExtras.get(id) || { extras: [] };
    cartExtras.set(id, { ...existing, specialRequest: "" });
    _editingRequestId = null;
    _render();
    return;
  }
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
    const lineTotal     = item.price * item.qty;
    totalQty           += item.qty;
    totalAmt           += lineTotal;

    // Variant label (e.g. "250 ml") — shown as "• 250 ml" below the product name
    const variantLabel = cartExtras.get(item.id)?.variantLabel || "";
    const parentName   = cartExtras.get(item.id)?.parentName   || "";

    // Extras
    const extras        = cartExtras.get(item.id)?.extras || [];
    const extrasHtml    = extras.length
      ? `<ul class="review-extras-list">${extras.map(e =>
          `<li class="review-extra-item">• ${_esc(e.name)}</li>`
        ).join("")}</ul>`
      : "";

    // Special request — inline edit or display
    const specialRequest = cartExtras.get(item.id)?.specialRequest || "";
    let specialReqHtml;

    if (_editingRequestId === item.id) {
      // ── Editing state ───────────────────────────────────────
      specialReqHtml = `
        <div class="review-req-edit-wrap">
          <textarea
            class="review-req-textarea"
            data-req-id="${_esc(item.id)}"
            maxlength="200"
            placeholder="e.g. Less spicy, no onions…"
            rows="2"
          >${_esc(specialRequest)}</textarea>
          <div class="review-req-edit-actions">
            <button class="review-req-save" data-review-action="save-req" data-id="${_esc(item.id)}">Save</button>
            <button class="review-req-cancel" data-review-action="cancel-req" data-id="${_esc(item.id)}">Cancel</button>
          </div>
        </div>`;
    } else if (specialRequest) {
      // ── Display state with request ──────────────────────────
      specialReqHtml = `
        <div class="review-special-req">
          <span class="review-special-text">📝 ${_esc(specialRequest)}</span>
          <div class="review-special-btns">
            <button class="review-special-edit" data-review-action="edit-req" data-id="${_esc(item.id)}" aria-label="Edit special request">Edit</button>
            <button class="review-special-clear" data-review-action="clear-req" data-id="${_esc(item.id)}" aria-label="Remove special request">✕</button>
          </div>
        </div>`;
    } else {
      // ── No request yet ──────────────────────────────────────
      specialReqHtml = `
        <button class="review-add-req" data-review-action="add-req" data-id="${_esc(item.id)}">+ Special request</button>`;
    }

    rows.push(`
      <div class="review-item">
        <div class="review-item-info">
          <span class="review-item-name">${variantLabel
            ? `${_esc(parentName || item.name)}<br><span class="review-variant-lbl">• ${_esc(variantLabel)}</span>`
            : _esc(item.name)}</span>
          ${extrasHtml}
          ${specialReqHtml}
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
