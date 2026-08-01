/**
 * cart.js
 * ─────────────────────────────────────────────────────────────
 * In-memory cart state. Exports addItem, removeItem, clearCart,
 * and the cart Map for order.js to read.
 *
 * updateCardUI handles three card types:
 *   • .menu-card       (regular items)
 *   • .half-full-side  (Half / Full variant sides)
 *   • .triple-side     (Regular / Medium / Large variant sides)
 *
 * [AI UPDATE 2026-08-01] Cart persistence via localStorage.
 * Every add/remove immediately saves to localStorage ("qrmenu_cart").
 * On module load the saved cart is restored into the Map.
 * restoreCartUI() must be called after menu items are rendered to
 * sync DOM card states (qty controls, in-cart classes, cart bar).
 * clearCart() removes the saved key. Logout also removes it.
 */

/** Map<itemId, { id, name, price, qty }> */
export const cart = new Map();

// ── localStorage persistence ───────────────────────────────────

const CART_KEY = "qrmenu_cart";

function _saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify([...cart.values()]));
  } catch (_) {}
}

function _loadCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return;
    for (const item of data) {
      if (
        item?.id &&
        item?.name &&
        typeof item?.price === "number" &&
        typeof item?.qty  === "number" &&
        item.qty > 0
      ) {
        cart.set(item.id, { id: item.id, name: item.name, price: item.price, qty: item.qty });
      }
    }
  } catch (_) {}
}

// Restore cart on module load (before menu renders)
_loadCart();

/**
 * Call this after menu items are rendered to the DOM so every
 * saved cart entry gets its qty-control UI restored.
 */
export function restoreCartUI() {
  refreshCartUI();
  for (const id of cart.keys()) {
    updateCardUI(id);
  }
}

// ── Add one unit ───────────────────────────────────────────────

export function addItem(id, name, price) {
  if (cart.has(id)) {
    cart.get(id).qty += 1;
  } else {
    cart.set(id, { id, name, price: Number(price), qty: 1 });
  }
  _saveCart();
  refreshCartUI();
  updateCardUI(id);
}

// ── Remove one unit (or delete if qty hits 0) ──────────────────

export function removeItem(id) {
  if (!cart.has(id)) return;
  const item = cart.get(id);
  item.qty -= 1;
  if (item.qty <= 0) cart.delete(id);
  _saveCart();
  refreshCartUI();
  updateCardUI(id);
}

// ── Clear entire cart ──────────────────────────────────────────

export function clearCart() {
  const ids = [...cart.keys()];
  cart.clear();
  try { localStorage.removeItem(CART_KEY); } catch (_) {}
  refreshCartUI();
  ids.forEach((id) => updateCardUI(id));
}

// ── Cart bar UI ───────────────────────────────────────────────

export function refreshCartUI() {
  const bar   = document.getElementById("cartBar");
  const badge = document.getElementById("cartCountBadge");
  const total = document.getElementById("cartTotal");
  const btn   = document.getElementById("placeOrderBtn");

  if (!bar) return;

  let totalQty = 0;
  let totalAmt = 0;
  for (const item of cart.values()) {
    totalQty += item.qty;
    totalAmt += item.price * item.qty;
  }

  const hasItems = totalQty > 0;
  bar.classList.toggle("hidden", !hasItems);

  if (badge) badge.textContent = totalQty;
  if (total) {
    total.textContent = new Intl.NumberFormat("en-IN", {
      style: "currency", currency: "INR",
    }).format(totalAmt);
  }
  if (btn) btn.disabled = !hasItems;
}

// ── Per-card UI update ────────────────────────────────────────

export function updateCardUI(itemId) {
  const item = cart.get(itemId);
  const qty  = item?.qty || 0;

  // ── Regular .menu-card ──
  const card    = document.querySelector(`.menu-card[data-id="${itemId}"]`);
  const wrapper = card?.querySelector(".card-action");
  if (card && wrapper) {
    if (qty > 0) {
      card.classList.add("in-cart");
      wrapper.innerHTML = `
        <div class="qty-control">
          <button class="qty-btn qty-minus" data-id="${itemId}" aria-label="Remove one">−</button>
          <span class="qty-display">${qty}</span>
          <button class="qty-btn qty-plus"  data-id="${itemId}" aria-label="Add one">+</button>
        </div>`;
    } else {
      card.classList.remove("in-cart");
      wrapper.innerHTML = `
        <button class="btn-add"
                data-id="${itemId}"
                data-name="${escHtml(card.dataset.name)}"
                data-price="${card.dataset.price}">Add</button>`;
    }
  }

  // ── .half-full-side ──
  const hfSide = document.querySelector(`.half-full-side[data-id="${itemId}"]`);
  if (hfSide) {
    hfSide.classList.toggle("in-cart", qty > 0);
    const qtyEl = hfSide.querySelector(".hf-qty");
    const remEl = hfSide.querySelector(".hf-remove");
    if (qtyEl) { qtyEl.textContent = qty; qtyEl.style.display = qty > 0 ? "flex" : "none"; }
    if (remEl)   remEl.style.display = qty > 0 ? "flex" : "none";
  }

  // ── .triple-side ──
  const trSide = document.querySelector(`.triple-side[data-id="${itemId}"]`);
  if (trSide) {
    trSide.classList.toggle("in-cart", qty > 0);
    const qtyEl = trSide.querySelector(".triple-qty");
    const remEl = trSide.querySelector(".triple-remove");
    if (qtyEl) { qtyEl.textContent = qty; qtyEl.style.display = qty > 0 ? "flex" : "none"; }
    if (remEl)   remEl.style.display = qty > 0 ? "flex" : "none";
  }
}

function escHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
