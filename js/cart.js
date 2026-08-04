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

/**
 * Extras metadata for the current session.
 * Map<itemId, { extras: [{name, price}] }>
 * [AI UPDATE 2026-08-02] UX upgrade — populated by item-sheet.js after
 * each "Add to Cart". Read by order.js (payload) and review.js (UI).
 * NOT persisted to localStorage — price already includes extras.
 */
export const cartExtras = new Map();

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
  if (item.qty <= 0) {
    cart.delete(id);
    cartExtras.delete(id); // [AI UPDATE 2026-08-02]
  }
  _saveCart();
  refreshCartUI();
  updateCardUI(id);
}

// ── Clear entire cart ──────────────────────────────────────────

export function clearCart() {
  const ids = [...cart.keys()];
  cart.clear();
  cartExtras.clear(); // [AI UPDATE 2026-08-02]
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

  // ── Group card qty controls (variants share one card) ─────────
  // When any variant of a group is added/removed, refresh the whole
  // card-action area: show qty control when in-cart, ADD when empty.
  if (!card) {
    document.querySelectorAll(".menu-card[data-variant-ids]").forEach(groupCard => {
      const ids = groupCard.dataset.variantIds.split(",");
      if (!ids.includes(itemId)) return;

      const totalQty = ids.reduce((sum, vid) => sum + (cart.get(vid)?.qty || 0), 0);
      const groupKey = groupCard.dataset.groupKey || "";
      const wrapper  = groupCard.querySelector(".card-action");

      groupCard.classList.toggle("in-cart", totalQty > 0);

      if (wrapper) {
        if (totalQty > 0) {
          wrapper.innerHTML = `
            <div class="qty-control">
              <button class="qty-btn qty-minus qty-minus--group"
                      data-group-key="${escHtml(groupKey)}"
                      aria-label="Remove one">−</button>
              <span class="qty-display">${totalQty}</span>
              <button class="qty-btn qty-plus qty-plus--group"
                      data-group-key="${escHtml(groupKey)}"
                      aria-label="Add one">+</button>
            </div>`;
        } else {
          wrapper.innerHTML = `
            <div class="group-cart-badge" style="display:none">0</div>
            <button class="btn-add"
                    data-group-key="${escHtml(groupKey)}">ADD</button>`;
        }
      }
    });
  }
}

function escHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
