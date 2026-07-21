/**
 * order.js
 * ─────────────────────────────────────────────────────────────
 * Reads Table ID from the URL, submits the cart to Firestore,
 * and handles success / error overlays.
 *
 * Firestore write target:
 *   Collection : pending_table_orders
 *   Each doc   : { tableId, items[], totalItems, totalPrice,
 *                  status: "pending", createdAt: serverTimestamp }
 */

import { db }                          from "./firebase-config.js";
import { collection, addDoc, serverTimestamp }
                                       from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { cart, clearCart }             from "./cart.js";

const ORDER_COLLECTION = "pending_table_orders";

// ── Read ?table=XX from the URL ───────────────────────────────
export function getTableId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("table") || "Unknown";
}

// ── Submit order ──────────────────────────────────────────────
export async function placeOrder() {
  if (cart.size === 0) return;

  const btn = document.getElementById("placeOrderBtn");
  if (btn) {
    btn.disabled    = true;
    btn.textContent = "Placing…";
  }

  const tableId = getTableId();
  const items   = [];
  let totalItems = 0;
  let totalPrice = 0;

  for (const item of cart.values()) {
    items.push({
      itemId:   item.id,
      name:     item.name,
      price:    item.price,
      quantity: item.qty,
      subtotal: +(item.price * item.qty).toFixed(2),
    });
    totalItems += item.qty;
    totalPrice += item.price * item.qty;
  }

  const orderPayload = {
    tableId,
    items,
    totalItems,
    totalPrice: +totalPrice.toFixed(2),
    status:     "pending",
    createdAt:  serverTimestamp(),
  };

  try {
    const ref = await addDoc(collection(db, ORDER_COLLECTION), orderPayload);
    console.log("[order.js] Order saved:", ref.id);

    clearCart();
    showSuccessOverlay(tableId, totalItems, totalPrice);
  } catch (err) {
    console.error("[order.js] Order submission failed:", err);
    showErrorOverlay(err.message);
    // Re-enable button so user can retry
    if (btn) {
      btn.disabled    = false;
      btn.textContent = "Place Order →";
    }
  }
}

// ── Success overlay ───────────────────────────────────────────
function showSuccessOverlay(tableId, totalItems, totalPrice) {
  const fmt = (n) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

  const overlay = document.getElementById("successOverlay");
  const msg     = document.getElementById("overlayMsg");

  if (msg) {
    msg.innerHTML = `
      Table <strong>${escHtml(tableId)}</strong> — 
      ${totalItems} item${totalItems !== 1 ? "s" : ""} for ${fmt(totalPrice)}<br/>
      Your order is being prepared!`;
  }
  overlay?.classList.remove("hidden");
}

// ── Error overlay ─────────────────────────────────────────────
function showErrorOverlay(detail = "") {
  const overlay = document.getElementById("errorOverlay");
  const msg     = document.getElementById("errorOverlayMsg");
  if (msg && detail) msg.textContent = detail;
  overlay?.classList.remove("hidden");
}

// ── Tiny escape ───────────────────────────────────────────────
function escHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
