/**
 * order.js
 * ─────────────────────────────────────────────────────────────
 * Reads Table ID from URL, handles order flow.
 * Writes to Firestore → billing panel picks it up in real-time.
 */

import { db }                          from "./firebase-config.js";
import { collection, addDoc, serverTimestamp }
                                       from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

import { cart, clearCart }             from "./cart.js";
import { getCustomer }                 from "./customer.js";
import { saveOrderToHistory }          from "./history.js";

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

  const tableId  = getTableId();
  const customer = getCustomer();
  const items    = [];
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
    customer: customer || { name: "Guest", phone: "" },
    items,
    totalItems,
    totalPrice:  +totalPrice.toFixed(2),
    status:      "pending",
  };

  // ── PRODUCTION — write to Firestore ──────────────────────
  try {
    const ref = await addDoc(collection(db, ORDER_COLLECTION), {
      ...orderPayload,
      createdAt: serverTimestamp(),
    });
    console.log("[order.js] Order saved:", ref.id);
    saveOrderToHistory(orderPayload);
    clearCart();
    showSuccessOverlay(tableId, totalItems, totalPrice, customer);
  } catch (err) {
    console.error("[order.js] Order submission failed:", err);
    showErrorOverlay(err.message);
    if (btn) {
      btn.disabled    = false;
      btn.textContent = "Place Order →";
    }
  }
  // ──────────────────────────────────────────────────────────
}

// ── Test-mode overlay ─────────────────────────────────────────
function showTestOverlay(tableId, totalItems, totalPrice, customer) {
  const fmt = (n) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

  const overlay = document.getElementById("successOverlay");
  const msg     = document.getElementById("overlayMsg");

  if (msg) {
    msg.innerHTML = `
      <span class="test-badge">🚧 Testing Mode</span><br/>
      Your place order is working!<br/>
      <small style="color:var(--text-3)">
        ${customer?.name ? `Hi ${escHtml(customer.name)} · ` : ""}
        Table <strong>${escHtml(tableId)}</strong> —
        ${totalItems} item${totalItems !== 1 ? "s" : ""} · ${fmt(totalPrice)}
      </small>`;
  }
  overlay?.classList.remove("hidden");
}

// ── Live success overlay (used in production mode) ────────────
function showSuccessOverlay(tableId, totalItems, totalPrice, customer) {
  const fmt = (n) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

  const overlay = document.getElementById("successOverlay");
  const msg     = document.getElementById("overlayMsg");

  if (msg) {
    msg.innerHTML = `
      ${customer?.name ? `Hi <strong>${escHtml(customer.name)}</strong>!<br/>` : ""}
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

function escHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
