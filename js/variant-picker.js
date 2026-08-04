/**
 * variant-picker.js
 * ─────────────────────────────────────────────────────────────
 * Premium bottom sheet that intercepts +/- on group (variant) cards.
 *
 * openVariantPicker(group, mode)
 *   mode: 'add'    — shows all available (non-OOS) variants
 *   mode: 'remove' — shows only variants currently in cart
 *
 * On selection: calls addItem / removeItem from cart.js.
 * No Firestore writes. No order logic changes.
 *
 * Called by menu.js _wireCardEvents and wireCardContainer when
 * a group card's + or - button is pressed.
 */

import { addItem, removeItem, cart } from "./cart.js";

// ── Module state ──────────────────────────────────────────────
let _group = null;
let _mode  = null; // 'add' | 'remove'

// ── DOM IDs ───────────────────────────────────────────────────
const MODAL_ID  = "variantPickerModal";
const LIST_ID   = "variantPickerList";
const TITLE_ID  = "variantPickerTitle";

// ── Public API ────────────────────────────────────────────────

export function initVariantPicker() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;

  // Backdrop tap → close
  modal.querySelector(".vp-backdrop")
    ?.addEventListener("click", closeVariantPicker);

  // Row taps (event delegation on the list)
  document.getElementById(LIST_ID)
    ?.addEventListener("click", _onRowClick);
}

/**
 * Open the picker for a group card.
 * @param {object}          group — group entry from _groupsById (has .displayName, .variants)
 * @param {'add'|'remove'}  mode
 */
export function openVariantPicker(group, mode) {
  _group = group;
  _mode  = mode;
  _render();

  const modal = document.getElementById(MODAL_ID);
  if (modal) {
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }
}

export function closeVariantPicker() {
  const modal = document.getElementById(MODAL_ID);
  if (modal) {
    modal.classList.add("hidden");
    document.body.style.overflow = "";
  }
  _group = null;
  _mode  = null;
}

// ── Rendering ─────────────────────────────────────────────────

function _render() {
  if (!_group) return;

  const title = document.getElementById(TITLE_ID);
  if (title) {
    title.textContent = _mode === "add"
      ? "What would you like to add?"
      : "What would you like to remove?";
  }

  const list = document.getElementById(LIST_ID);
  if (!list) return;

  // Filter variants based on mode
  let variants;
  if (_mode === "add") {
    variants = _group.variants.filter(v => !v.oos);
  } else {
    // remove: only show variants currently in cart
    variants = _group.variants.filter(v => (cart.get(v.id)?.qty || 0) > 0);
  }

  list.innerHTML = variants.map(v => {
    const qty = cart.get(v.id)?.qty || 0;
    const qtyTag = _mode === "remove" && qty > 0
      ? `<span class="vp-row-qty">×${qty} in cart</span>`
      : "";
    return `
      <button class="vp-row" data-variant-id="${_esc(v.id)}" type="button">
        <div class="vp-row-info">
          <span class="vp-row-label">${_esc(v.label)}</span>
          ${qtyTag}
        </div>
        <span class="vp-row-price">₹${v.price}</span>
      </button>`;
  }).join("");
}

// ── Event handlers ────────────────────────────────────────────

function _onRowClick(e) {
  const row = e.target.closest(".vp-row");
  if (!row || !_group) return;

  const variantId = row.dataset.variantId;
  const variant   = _group.variants.find(v => v.id === variantId);
  if (!variant) return;

  if (_mode === "add") {
    const name = `${_group.displayName} (${variant.label})`;
    addItem(variantId, name, variant.price);
  } else {
    removeItem(variantId);
  }

  closeVariantPicker();
}

// ── Helpers ───────────────────────────────────────────────────

function _esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
