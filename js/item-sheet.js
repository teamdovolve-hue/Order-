/**
 * item-sheet.js
 * ─────────────────────────────────────────────────────────────
 * Item Details Bottom Sheet — opened when a customer taps ADD
 * on any menu card. Shows image, full description, optional
 * extras, custom request textarea, qty selector, live price,
 * and an "Add to Cart" button.
 *
 * Public API:
 *   initItemSheet()      — wire DOM events once on DOMContentLoaded
 *   openItemSheet(item)  — open sheet for the given menu item
 *   closeItemSheet()     — close sheet
 *
 * item shape (from Firestore menu_items via menu.js):
 *   {
 *     id, name, price,
 *     imageUrl?:    string  — product photo URL
 *     description?: string  — full item description
 *     extraOptions?: [{name: string, price: number}]  — optional add-ons
 *   }
 *
 * Compatibility guarantees:
 *   - addItem(id, name, price) interface in cart.js is UNCHANGED.
 *   - No Firestore writes — purely client-side presentation layer.
 *   - Custom request is display-only and is NOT sent to Billing Panel
 *     (pending_table_orders schema has no customRequest field).
 *
 * [AI UPDATE 2026-08-02] Phase 1 — New module: Item Details Sheet
 */

import { addItem } from "./cart.js";

// ── Module state ──────────────────────────────────────────────
let _item   = null;   // current item being shown
let _qty    = 1;
let _extras = [];     // boolean[] parallel to item.extraOptions

// ── Public ────────────────────────────────────────────────────

/** Wire all static DOM events. Call once on DOMContentLoaded. */
export function initItemSheet() {
  // Backdrop tap → close
  document.getElementById("itemSheetModal")
    ?.querySelector(".item-sheet-backdrop")
    ?.addEventListener("click", closeItemSheet);

  // Quantity controls
  document.getElementById("itemSheetQtyMinus")
    ?.addEventListener("click", _onQtyMinus);

  document.getElementById("itemSheetQtyPlus")
    ?.addEventListener("click", _onQtyPlus);

  // Add to Cart
  document.getElementById("itemSheetAddBtn")
    ?.addEventListener("click", _onAddToCart);

  // Extra option checkboxes — delegated
  document.getElementById("itemSheetExtrasList")
    ?.addEventListener("change", _onExtrasChange);
}

/**
 * Open the sheet for a given item.
 * @param {object} item — { id, name, price, imageUrl?, description?, extraOptions? }
 */
export function openItemSheet(item) {
  _item   = item;
  _qty    = 1;
  _extras = item.extraOptions ? item.extraOptions.map(() => false) : [];
  _renderSheet();
  document.getElementById("itemSheetModal")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

/** Close the sheet. */
export function closeItemSheet() {
  document.getElementById("itemSheetModal")?.classList.add("hidden");
  document.body.style.overflow = "";
  _item = null;
}

// ── Rendering ─────────────────────────────────────────────────

function _renderSheet() {
  if (!_item) return;

  // ── Image ──────────────────────────────────────────────────
  const imgWrap = document.getElementById("itemSheetImgWrap");
  const imgEl   = document.getElementById("itemSheetImg");
  const shimmer = document.getElementById("itemSheetImgShimmer");

  if (_item.imageUrl) {
    if (imgWrap) imgWrap.style.display = "";
    if (shimmer) shimmer.style.display = "";
    if (imgEl) {
      imgEl.style.opacity = "0";
      imgEl.alt = _item.name || "";
      imgEl.onload  = () => {
        imgEl.style.opacity = "1";
        if (shimmer) shimmer.style.display = "none";
      };
      imgEl.onerror = () => {
        if (imgWrap) imgWrap.style.display = "none";
      };
      imgEl.src = _item.imageUrl;
    }
  } else {
    if (imgWrap) imgWrap.style.display = "none";
  }

  // ── Name ───────────────────────────────────────────────────
  const nameEl = document.getElementById("itemSheetName");
  if (nameEl) nameEl.textContent = _item.name || "";

  // ── Description ────────────────────────────────────────────
  const descEl = document.getElementById("itemSheetDesc");
  if (descEl) {
    if (_item.description) {
      descEl.textContent = _item.description;
      descEl.style.display = "";
    } else {
      descEl.style.display = "none";
    }
  }

  // ── Extra options ──────────────────────────────────────────
  const extrasSection = document.getElementById("itemSheetExtras");
  const extrasList    = document.getElementById("itemSheetExtrasList");
  if (extrasSection && extrasList) {
    const opts = _item.extraOptions;
    if (Array.isArray(opts) && opts.length > 0) {
      extrasList.innerHTML = opts.map((opt, i) => `
        <label class="item-sheet-extra-row">
          <input
            type="checkbox"
            class="item-sheet-extra-check"
            data-index="${i}"
            data-price="${Number(opt.price) || 0}"
          />
          <span class="item-sheet-extra-name">${_esc(opt.name || "")}</span>
          <span class="item-sheet-extra-price">+₹${Number(opt.price) || 0}</span>
        </label>`).join("");
      extrasSection.style.display = "";
    } else {
      extrasSection.style.display = "none";
    }
  }

  // ── Custom request textarea ────────────────────────────────
  const reqEl = document.getElementById("itemSheetRequest");
  if (reqEl) reqEl.value = "";

  // ── Price + qty ────────────────────────────────────────────
  _updateQtyDisplay();
  _updatePriceDisplay();
}

/** Per-unit price = base price + selected extras. */
function _unitPrice() {
  if (!_item) return 0;
  let unit = Number(_item.price) || 0;
  if (_item.extraOptions) {
    _item.extraOptions.forEach((opt, i) => {
      if (_extras[i]) unit += Number(opt.price) || 0;
    });
  }
  return unit;
}

function _updatePriceDisplay() {
  const el = document.getElementById("itemSheetPrice");
  if (!el) return;
  const total = _unitPrice() * _qty;
  el.textContent = new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR",
  }).format(total);
}

function _updateQtyDisplay() {
  const el = document.getElementById("itemSheetQtyNum");
  if (el) el.textContent = _qty;
  _updatePriceDisplay();
}

// ── Event handlers ────────────────────────────────────────────

function _onQtyMinus() {
  if (_qty > 1) { _qty--; _updateQtyDisplay(); }
}

function _onQtyPlus() {
  if (_qty < 20) { _qty++; _updateQtyDisplay(); }
}

function _onExtrasChange(e) {
  const check = e.target.closest(".item-sheet-extra-check");
  if (!check) return;
  const idx = parseInt(check.dataset.index, 10);
  if (!isNaN(idx) && idx >= 0 && idx < _extras.length) {
    _extras[idx] = check.checked;
    _updatePriceDisplay();
  }
}

function _onAddToCart() {
  if (!_item) return;
  const unit = _unitPrice();
  for (let i = 0; i < _qty; i++) {
    addItem(_item.id, _item.name, unit);
  }
  closeItemSheet();
}

// ── Helpers ───────────────────────────────────────────────────

function _esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
