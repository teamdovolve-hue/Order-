/**
 * cart.js
 * ─────────────────────────────────────────────────────────────
 * In-memory cart state + DOM update helpers.
 * Other modules import { cart, addItem, removeItem, clearCart }.
 */

/** @type {Map<string, { id: string, name: string, price: number, qty: number }>} */
export const cart = new Map();

// ── DOM refs (resolved lazily so this module is import-safe) ──
const getCartBar        = () => document.getElementById("cartBar");
const getCartCount      = () => document.getElementById("cartCountBadge");
const getCartTotal      = () => document.getElementById("cartTotal");
const getPlaceOrderBtn  = () => document.getElementById("placeOrderBtn");

// ── Currency formatter ────────────────────────────────────────
const fmt = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

// ── Recalculate & refresh cart UI ────────────────────────────
export function refreshCartUI() {
  let totalItems = 0;
  let totalPrice = 0;

  for (const item of cart.values()) {
    totalItems += item.qty;
    totalPrice += item.price * item.qty;
  }

  const cartBar = getCartBar();
  const cartCount = getCartCount();
  const cartTotal = getCartTotal();
  const placeBtn  = getPlaceOrderBtn();

  if (totalItems > 0) {
    cartBar?.classList.remove("hidden");
    if (cartCount) cartCount.textContent = totalItems;
    if (cartTotal) cartTotal.textContent = fmt(totalPrice);
    if (placeBtn)  placeBtn.disabled = false;
  } else {
    cartBar?.classList.add("hidden");
  }
}

// ── Add one unit of an item ───────────────────────────────────
export function addItem(id, name, price) {
  if (cart.has(id)) {
    cart.get(id).qty += 1;
  } else {
    cart.set(id, { id, name, price: Number(price), qty: 1 });
  }
  refreshCartUI();
  updateCardUI(id);
}

// ── Remove one unit (or delete if qty hits 0) ─────────────────
export function removeItem(id) {
  if (!cart.has(id)) return;
  const item = cart.get(id);
  item.qty -= 1;
  if (item.qty <= 0) cart.delete(id);
  refreshCartUI();
  updateCardUI(id);
}

// ── Clear entire cart ─────────────────────────────────────────
export function clearCart() {
  const ids = [...cart.keys()];
  cart.clear();
  refreshCartUI();
  ids.forEach((id) => updateCardUI(id));
}

// ── Toggle the card between "Add" button and qty control ─────
function updateCardUI(itemId) {
  const card    = document.querySelector(`.menu-card[data-id="${itemId}"]`);
  const wrapper = card?.querySelector(".card-action");
  if (!card || !wrapper) return;

  const item = cart.get(itemId);

  if (item && item.qty > 0) {
    card.classList.add("in-cart");
    wrapper.innerHTML = `
      <div class="qty-control">
        <button class="qty-btn qty-minus" data-id="${itemId}" aria-label="Remove one">−</button>
        <span class="qty-display">${item.qty}</span>
        <button class="qty-btn qty-plus"  data-id="${itemId}" aria-label="Add one">+</button>
      </div>`;
  } else {
    card.classList.remove("in-cart");
    wrapper.innerHTML = `
      <button class="btn-add" data-id="${itemId}" data-name="${escHtml(card.dataset.name)}" data-price="${card.dataset.price}">
        Add
      </button>`;
  }
}

// ── Tiny HTML escape (for data attributes) ───────────────────
function escHtml(s = "") {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
