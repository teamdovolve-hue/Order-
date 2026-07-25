/**
 * cart.js
 * ─────────────────────────────────────────────────────────────
 * In-memory cart state. Exports addItem, removeItem, clearCart,
 * and the cart Map for order.js to read.
 */

/** Map<itemId, { id, name, price, qty }> */
export const cart = new Map();

// ── Add one unit ───────────────────────────────────────────────

export function addItem(id, name, price) {
  if (cart.has(id)) {
    cart.get(id).qty += 1;
  } else {
    cart.set(id, { id, name, price: Number(price), qty: 1 });
  }
  refreshCartUI();
  updateCardUI(id);
}

// ── Remove one unit (or delete if qty hits 0) ──────────────────

export function removeItem(id) {
  if (!cart.has(id)) return;
  const item = cart.get(id);
  item.qty -= 1;
  if (item.qty <= 0) cart.delete(id);
  refreshCartUI();
  updateCardUI(id);
}

// ── Clear entire cart ──────────────────────────────────────────

export function clearCart() {
  const ids = [...cart.keys()];
  cart.clear();
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

// ── Per-card UI (Add button ↔ qty control) ────────────────────

export function updateCardUI(itemId) {
  // The menu grid may have been replaced via cloneNode; query fresh each time
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
      <button class="btn-add"
              data-id="${itemId}"
              data-name="${escHtml(card.dataset.name)}"
              data-price="${card.dataset.price}">
        Add
      </button>`;
  }
}

function escHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
