/**
 * order.js
 * ─────────────────────────────────────────────────────────────
 * Reads Table ID from URL, handles order submission to Firestore.
 * History is written by order-status.js when billing panel marks "completed".
 */

import { db }                          from "./firebase-config.js";
import {
  collection, addDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { cart, clearCart }             from "./cart.js";
import { getCustomer }                 from "./customer.js";

const ORDER_COLLECTION = "pending_table_orders";

// ── Read validated table from server-injected window.__TABLE_ID__ ─────────────
//
//   The server validates the table number at the /t/:n route and injects it
//   as a plain integer before serving index.html.  The frontend NEVER reads
//   from the URL — it only reads this server-set value.  A customer who edits
//   the URL is simply served a new server-validated page for that URL; there
//   is no client-side state they can tamper with to change their table.

export function getTableId() {
  const n = window.__TABLE_ID__;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10) {
    return null;   // not reached via a valid /t/:n URL
  }
  return `Table ${n}`;
}

// ── Submit order ──────────────────────────────────────────────

export async function placeOrder() {
  if (cart.size === 0) return;

  const tableId = getTableId();
  if (!tableId) {
    // Should never happen — server blocks non-/t/:n access — but guard anyway
    _showError("Could not detect your table. Please rescan the QR code.");
    return;
  }

  const btn = document.getElementById("placeOrderBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Placing…"; }
  const customer = getCustomer();    // { name, phone, uid } from Firebase Auth
  const items    = [];
  let   totalItems = 0;
  let   totalPrice = 0;

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

  const payload = {
    tableId,
    customer: customer
      ? { name: customer.name, phone: customer.phone, uid: customer.uid }
      : { name: "Guest", phone: "", uid: "" },
    items,
    totalItems,
    totalPrice:  +totalPrice.toFixed(2),
    status:      "pending",
    createdAt:   serverTimestamp(),
  };

  try {
    const ref = await addDoc(collection(db, ORDER_COLLECTION), payload);
    console.log("[order] Order saved:", ref.id);
    clearCart();
    _showSuccess(tableId, totalItems, totalPrice, customer);
  } catch (err) {
    console.error("[order] Submission failed:", err);
    _showError(err.message);
    if (btn) { btn.disabled = false; btn.textContent = "Place Order →"; }
  }
}

// ── Success overlay ───────────────────────────────────────────

function _showSuccess(tableId, totalItems, totalPrice, customer) {
  const fmt = (n) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

  const overlay = document.getElementById("successOverlay");
  const msg     = document.getElementById("overlayMsg");

  if (msg) {
    msg.innerHTML = `
      <strong>Table ${_esc(tableId)}</strong> —
      ${totalItems} item${totalItems !== 1 ? "s" : ""} · ${fmt(totalPrice)}<br/>
      <span style="color:var(--text-3);font-size:13px;">
        Track your order in <em>Active Orders</em> above.
      </span>`;
  }
  overlay?.classList.remove("hidden");
}

// ── Error overlay ─────────────────────────────────────────────

function _showError(detail = "") {
  const overlay = document.getElementById("errorOverlay");
  const msg     = document.getElementById("errorOverlayMsg");
  if (msg && detail) msg.textContent = detail;
  overlay?.classList.remove("hidden");
}

function _esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
