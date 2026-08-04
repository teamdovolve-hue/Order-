/**
 * item-sheet.js
 * ─────────────────────────────────────────────────────────────
 * Item Details Bottom Sheet — opened when a customer taps ADD.
 *
 * [AI UPDATE 2026-08-02] UX upgrade — handles both single items
 * and variant groups (Half/Full, Regular/Medium/Large).
 * Adds auto-extra logic driven by category + item name rules.
 * Extras are stored in cartExtras Map in cart.js so order.js
 * and review.js can include them in the payload/UI.
 *
 * Public API:
 *   initItemSheet()      — wire DOM events once on boot
 *   openItemSheet(item)  — item can be single item OR group object
 *   closeItemSheet()     — close and reset
 *
 * Group object shape (from menu.js _groupItems):
 *   {
 *     isGroup: true, groupKey, displayName, category,
 *     imageUrl?, description?, extraOptions?,
 *     variants: [{ id, label, price, oos }]
 *   }
 *
 * Single item shape (from Firestore menu_items):
 *   { id, name, price, category?, imageUrl?, description?, extraOptions? }
 *
 * Auto-extra rules (applied on top of Firestore extraOptions):
 *   category "Pizza"                → Extra Cheese, Extra Veggies
 *   category includes "noodle"      → Extra Veggies
 *   name includes "cheese"          → Extra Cheese
 *   name includes "paneer"          → Extra Paneer
 *   (prices pulled from Firestore Extra Topping docs when available)
 *
 * Compatibility guarantees:
 *   - addItem(id, name, price) interface in cart.js UNCHANGED.
 *   - No Firestore writes.
 *   - cartExtras Map in cart.js carries extras to order.js + review.js.
 */

import { addItem, cartExtras } from "./cart.js";
import { getAllExtraToppings }  from "./menu.js";

// ── Module state ──────────────────────────────────────────────
let _current          = null;   // single item or group object
let _qty              = 1;
let _selectedVariantIdx = 0;    // index into group.variants (or -1 for single)
let _extrasChecked    = [];     // boolean[] parallel to _resolvedExtras
let _resolvedExtras   = [];     // [{name, price}] — merged auto + Firestore extras

// ── Public ────────────────────────────────────────────────────

export function initItemSheet() {
  document.getElementById("itemSheetModal")
    ?.querySelector(".item-sheet-backdrop")
    ?.addEventListener("click", closeItemSheet);

  document.getElementById("itemSheetQtyMinus")
    ?.addEventListener("click", _onQtyMinus);

  document.getElementById("itemSheetQtyPlus")
    ?.addEventListener("click", _onQtyPlus);

  document.getElementById("itemSheetAddBtn")
    ?.addEventListener("click", _onAddToCart);

  // Delegated: variant radios + extra checkboxes
  document.getElementById("itemSheetModal")
    ?.addEventListener("change", _onSheetChange);
}

/**
 * Open the sheet for a single item or a variant group.
 * @param {object} itemOrGroup
 */
export function openItemSheet(itemOrGroup) {
  _current = itemOrGroup;
  _qty     = 1;

  if (itemOrGroup.isGroup) {
    // Default to first non-OOS variant; fall back to first
    _selectedVariantIdx = itemOrGroup.variants.findIndex(v => !v.oos);
    if (_selectedVariantIdx < 0) _selectedVariantIdx = 0;
  } else {
    _selectedVariantIdx = -1;
  }

  _resolvedExtras  = _buildExtras(itemOrGroup);
  _extrasChecked   = _resolvedExtras.map(() => false);

  _renderSheet();
  document.getElementById("itemSheetModal")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

export function closeItemSheet() {
  document.getElementById("itemSheetModal")?.classList.add("hidden");
  document.body.style.overflow = "";
  _current = null;
}

// ── Auto-extras builder ───────────────────────────────────────

/**
 * Merge auto-extras (based on category/name rules) with any
 * extraOptions stored on the Firestore document.
 * Prices for auto-extras are pulled from the "Extra Topping"
 * Firestore docs when available, with a ₹50 fallback.
 */
function _buildExtras(itemOrGroup) {
  const category = (itemOrGroup.category || "").toLowerCase();
  const name     = (itemOrGroup.isGroup
    ? itemOrGroup.displayName
    : (itemOrGroup.name || "")).toLowerCase();

  // Index Extra Topping docs by name for price lookup
  const toppingMap = new Map();
  for (const t of getAllExtraToppings()) {
    toppingMap.set((t.name || "").toLowerCase(), Number(t.price) || 50);
  }

  const lookup = (extraName) =>
    toppingMap.get(extraName.toLowerCase()) ?? 50;

  // Accumulate in insertion-order Map (deduplicates by name)
  const extras = new Map();

  const add = (name, price) => {
    if (!extras.has(name)) extras.set(name, { name, price });
  };

  // ── Rule-based auto extras ──────────────────────────────────
  if (category === "pizza") {
    add("Extra Cheese", lookup("Extra Cheese"));
    add("Extra Veggies", lookup("Extra Veggies"));
  }
  if (category.includes("noodle")) {
    add("Extra Veggies", lookup("Extra Veggies"));
  }
  if (name.includes("cheese")) {
    add("Extra Cheese", lookup("Extra Cheese"));
  }
  if (name.includes("paneer")) {
    add("Extra Paneer", lookup("Extra Paneer"));
  }

  // ── Merge Firestore extraOptions (deduplicate) ──────────────
  const firestoreExtras = itemOrGroup.extraOptions || [];
  for (const fe of firestoreExtras) {
    if (fe?.name) add(fe.name, Number(fe.price) || 0);
  }

  return [...extras.values()];
}

// ── Rendering ─────────────────────────────────────────────────

function _renderSheet() {
  if (!_current) return;

  const isGroup   = _current.isGroup === true;
  // For variant groups, use the selected variant's image when available;
  // fall back to the parent product image so there are never broken images.
  const selVariant = _current.isGroup ? (_current.variants[_selectedVariantIdx] || null) : null;
  const imgUrl     = selVariant?.imageUrl || _current.imageUrl || "";
  const desc      = isGroup ? _current.description  : (_current.description  || "");
  const nameText  = isGroup ? _current.displayName  : (_current.name || "");

  // ── Image ───────────────────────────────────────────────────
  const imgWrap = document.getElementById("itemSheetImgWrap");
  const imgEl   = document.getElementById("itemSheetImg");
  const shimmer = document.getElementById("itemSheetImgShimmer");
  if (imgUrl) {
    if (imgWrap) imgWrap.style.display = "";
    if (shimmer) shimmer.style.display = "";
    if (imgEl) {
      imgEl.style.opacity = "0";
      imgEl.alt   = nameText;
      imgEl.onload  = () => { imgEl.style.opacity = "1"; if (shimmer) shimmer.style.display = "none"; };
      imgEl.onerror = () => { if (imgWrap) imgWrap.style.display = "none"; };
      imgEl.src = imgUrl;
    }
  } else {
    if (imgWrap) imgWrap.style.display = "none";
  }

  // ── Name ────────────────────────────────────────────────────
  const nameEl = document.getElementById("itemSheetName");
  if (nameEl) nameEl.textContent = nameText;

  // ── Description ─────────────────────────────────────────────
  const descEl = document.getElementById("itemSheetDesc");
  if (descEl) {
    descEl.textContent   = desc || "";
    descEl.style.display = desc ? "" : "none";
  }

  // ── Variant selector (groups only) ──────────────────────────
  const variantsSection = document.getElementById("itemSheetVariants");
  const variantsList    = document.getElementById("itemSheetVariantsList");
  if (variantsSection && variantsList) {
    if (isGroup && _current.variants.length > 1) {
      variantsList.innerHTML = _current.variants.map((v, i) => `
        <label class="item-sheet-variant-row${v.oos ? " oos" : ""}">
          <input
            type="radio"
            class="item-sheet-variant-radio"
            name="itemSheetVariant"
            value="${i}"
            ${i === _selectedVariantIdx ? "checked" : ""}
            ${v.oos ? "disabled" : ""}
          />
          <span class="item-sheet-variant-label">${_esc(v.label)}</span>
          <span class="item-sheet-variant-price">₹${v.price}</span>
          ${v.oos ? '<span class="item-sheet-variant-oos">Out of stock</span>' : ""}
        </label>`).join("");
      variantsSection.style.display = "";
    } else {
      variantsSection.style.display = "none";
    }
  }

  // ── Extra options ────────────────────────────────────────────
  const extrasSection = document.getElementById("itemSheetExtras");
  const extrasList    = document.getElementById("itemSheetExtrasList");
  if (extrasSection && extrasList) {
    if (_resolvedExtras.length > 0) {
      extrasList.innerHTML = _resolvedExtras.map((opt, i) => `
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

  // ── Custom request textarea ──────────────────────────────────
  const reqEl = document.getElementById("itemSheetRequest");
  if (reqEl) reqEl.value = "";

  // ── Qty + price ─────────────────────────────────────────────
  _qty = 1;
  _updateQtyDisplay();
  _updatePriceDisplay();
}

// ── Unit price = selected variant base + checked extras ───────

function _currentBasePrice() {
  if (!_current) return 0;
  if (_current.isGroup) {
    const v = _current.variants[_selectedVariantIdx];
    return Number(v?.price) || 0;
  }
  return Number(_current.price) || 0;
}

function _unitPrice() {
  let unit = _currentBasePrice();
  _resolvedExtras.forEach((opt, i) => {
    if (_extrasChecked[i]) unit += Number(opt.price) || 0;
  });
  return unit;
}

function _updatePriceDisplay() {
  const el = document.getElementById("itemSheetPrice");
  if (!el) return;
  el.textContent = new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR",
  }).format(_unitPrice() * _qty);
}

function _updateQtyDisplay() {
  const el = document.getElementById("itemSheetQtyNum");
  if (el) el.textContent = _qty;
  _updatePriceDisplay();
}

// ── Event handlers ────────────────────────────────────────────

/**
 * Update the sheet image when the customer switches variants.
 * Shows the variant-specific image when it has one; otherwise shows
 * the parent product image.  Never shows a broken image.
 */
function _updateVariantImage() {
  if (!_current?.isGroup) return;
  const variant = _current.variants[_selectedVariantIdx];
  if (!variant) return;

  const imgUrl  = variant.imageUrl || _current.imageUrl || "";
  const imgWrap = document.getElementById("itemSheetImgWrap");
  const imgEl   = document.getElementById("itemSheetImg");
  const shimmer = document.getElementById("itemSheetImgShimmer");

  if (imgUrl) {
    if (imgWrap) imgWrap.style.display = "";
    if (shimmer) shimmer.style.display = "";
    if (imgEl) {
      imgEl.style.opacity = "0";
      imgEl.onload  = () => { imgEl.style.opacity = "1"; if (shimmer) shimmer.style.display = "none"; };
      imgEl.onerror = () => { if (imgWrap) imgWrap.style.display = "none"; };
      imgEl.src = imgUrl;
    }
  } else {
    if (imgWrap) imgWrap.style.display = "none";
  }
}

function _onSheetChange(e) {
  // Variant radio
  const radio = e.target.closest(".item-sheet-variant-radio");
  if (radio) {
    const idx = parseInt(radio.value, 10);
    if (!isNaN(idx)) {
      _selectedVariantIdx = idx;
      _updateVariantImage();   // swap to variant-specific image (or parent fallback)
      _updatePriceDisplay();
    }
    return;
  }
  // Extra checkbox
  const check = e.target.closest(".item-sheet-extra-check");
  if (check) {
    const idx = parseInt(check.dataset.index, 10);
    if (!isNaN(idx) && idx >= 0 && idx < _extrasChecked.length) {
      _extrasChecked[idx] = check.checked;
      _updatePriceDisplay();
    }
  }
}

function _onQtyMinus() {
  if (_qty > 1) { _qty--; _updateQtyDisplay(); }
}

function _onQtyPlus() {
  if (_qty < 20) { _qty++; _updateQtyDisplay(); }
}

function _onAddToCart() {
  if (!_current) return;

  const unit = _unitPrice();
  const selectedExtras = _resolvedExtras
    .filter((_, i) => _extrasChecked[i])
    .map(e => ({ name: e.name, price: e.price }));

  let cartId, cartName;

  if (_current.isGroup) {
    const variant = _current.variants[_selectedVariantIdx];
    if (!variant || variant.oos) return;
    cartId   = variant.id;
    cartName = `${_current.displayName} (${variant.label})`;
  } else {
    cartId   = _current.id;
    cartName = _current.name || "";
  }

  // Add to cart (interface unchanged: id, name, price)
  for (let i = 0; i < _qty; i++) {
    addItem(cartId, cartName, unit);
  }

  // Store extras, special request, and (for groups) variant metadata so
  // review.js can display "Frooti • 250 ml" and order.js can send
  // parentName / variantName as separate fields to the billing panel.
  const specialRequest = (document.getElementById("itemSheetRequest")?.value || "").trim();

  // Resolve the displayed image URL so review.js can show a thumbnail.
  const _imgUrl = _current.isGroup
    ? (_current.variants[_selectedVariantIdx]?.imageUrl || _current.imageUrl || "")
    : (_current.imageUrl || "");

  if (_current.isGroup) {
    const variant = _current.variants[_selectedVariantIdx];
    cartExtras.set(cartId, {
      extras:       selectedExtras,
      specialRequest,
      variantLabel: variant?.label   || "",
      parentName:   _current.displayName || "",
      imageUrl:     _imgUrl,
    });
  } else {
    // Always store at minimum imageUrl so review.js can show a thumbnail.
    cartExtras.set(cartId, { extras: selectedExtras, specialRequest, imageUrl: _imgUrl });
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
