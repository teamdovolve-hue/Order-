/**
 * order.js
 * ─────────────────────────────────────────────────────────────
 * Reads Table ID from URL, handles order submission to Firestore.
 * History is written by order-status.js when billing panel marks "completed".
 */

import { db, functions }              from "./firebase-config.js";
import { doc, getDoc }                from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { httpsCallable }              from "https://www.gstatic.com/firebasejs/10.8.1/firebase-functions.js";
import { cart, clearCart }             from "./cart.js";
import { getCustomer }                 from "./customer.js";
import { auth }                       from "./firebase-config.js";

// ── Read table number from the URL ────────────────────────────────────────────
//
//   Two environments:
//
//   1. Replit / Node.js (dev + self-hosted):
//      The server validates /t/:n and injects window.__TABLE_ID__ = <int>
//      into the HTML before serving it.  We prefer that value.
//
//   2. Netlify (production CDN):
//      Netlify rewrites /t/* → index.html (see _redirects).  No server
//      injection happens, so we parse window.location.pathname instead.
//
//   In both cases the validation rule is the same: table must be 1–10.
//   Returns "Table N" on success, null on invalid/missing table.

const VALID_TABLES = 10;
let _activeTableId = null;

export function getTableId() {
  if (_activeTableId) return _activeTableId;
  // Prefer server-injected value (set by Express before serving index.html)
  if (typeof window.__TABLE_ID__ === "number") {
    const n = window.__TABLE_ID__;
    return (Number.isInteger(n) && n >= 1 && n <= VALID_TABLES)
      ? `Table ${n}`
      : null;
  }

  // Fallback: parse /t/<n> from the browser URL (Netlify / static hosting)
  const match = window.location.pathname.match(/^\/t\/(\d+)$/);
  if (!match) return null;                        // not a /t/ URL at all

  const n = parseInt(match[1], 10);
  return (n >= 1 && n <= VALID_TABLES) ? `Table ${n}` : null;
}

export async function loadActiveTableAssignment() {
  const uid = auth.currentUser?.uid;
  if (!uid) return null;
  try {
    const snap = await getDoc(doc(db, "customer_table_sessions", uid));
    const data = snap.exists() ? snap.data() : null;
    _activeTableId = data?.lockStatus === "active" && data.activeTableId
      ? data.activeTableId
      : null;
    _updateTableBadge();
    return _activeTableId;
  } catch (err) {
    console.warn("[table-lock] Could not load active table assignment:", err);
    return null;
  }
}

export function setActiveTableId(tableId) {
  _activeTableId = tableId || null;
  _updateTableBadge();
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
  const customer = getCustomer();    // UI convenience only; server derives identity
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

  try {
    const createCustomerOrder = httpsCallable(functions, "createCustomerOrder");
    const result = await createCustomerOrder({
      requestedTableId: tableId,
      items,
    });
    const assignedTable = result.data?.tableId || tableId;
    setActiveTableId(assignedTable);
    clearCart();
    _showSuccess(assignedTable, totalItems, totalPrice, customer);
  } catch (err) {
    console.error("[order] Submission failed:", err);
    _showError(err.message);
    if (btn) { btn.disabled = false; btn.textContent = "Place Order →"; }
  }
}

function _updateTableBadge() {
  const badge = document.getElementById("tableBadge");
  if (badge) badge.textContent = _activeTableId || getTableIdFromUrl() || "—";
}

function getTableIdFromUrl() {
  if (typeof window.__TABLE_ID__ === "number") {
    const n = window.__TABLE_ID__;
    return (Number.isInteger(n) && n >= 1 && n <= VALID_TABLES) ? `Table ${n}` : null;
  }
  const match = window.location.pathname.match(/^\/t\/(\d+)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return (n >= 1 && n <= VALID_TABLES) ? `Table ${n}` : null;
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
