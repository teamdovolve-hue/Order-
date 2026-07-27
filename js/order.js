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
import { waitForAuthReady }            from "./auth.js";

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
const SESSION_KEY  = "qrmenu_locked_table";   // sessionStorage key
let _activeTableId = null;

export function getTableId() {
  if (_activeTableId) return _activeTableId;

  // ── Priority 1: server-injected value (Replit / Express) ──────────────────
  //   The Express server validates /t/:n and writes window.__TABLE_ID__ before
  //   serving the HTML.  This is the strongest signal — no URL parsing needed.
  if (typeof window.__TABLE_ID__ === "number") {
    const n = window.__TABLE_ID__;
    if (Number.isInteger(n) && n >= 1 && n <= VALID_TABLES) {
      const tableId = `Table ${n}`;
      try { sessionStorage.setItem(SESSION_KEY, tableId); } catch (_) {}
      return tableId;
    }
    return null;
  }

  // ── Priority 2: sessionStorage lock (Vercel / static CDN) ─────────────────
  //   On static hosting the URL is the only signal, but we lock it into
  //   sessionStorage the first time so a customer cannot switch tables by
  //   editing the address bar within the same browser session.
  //
  //   Exception: if the current URL carries a *valid* table number that differs
  //   from the stored one, we ONLY accept it if the stored session is being
  //   viewed from a brand-new tab (sessionStorage is per-tab, so a fresh scan
  //   from a different QR will always land in its own empty session).
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) return stored;                   // tab already locked — ignore URL
  } catch (_) {}

  // ── Priority 3: parse /t/<n> from the URL (first visit in this tab) ────────
  const match = window.location.pathname.match(/^\/t\/(\d+)$/);
  if (!match) return null;

  const n = parseInt(match[1], 10);
  if (n < 1 || n > VALID_TABLES) return null;

  const tableId = `Table ${n}`;
  try { sessionStorage.setItem(SESSION_KEY, tableId); } catch (_) {}
  return tableId;
}

export async function loadActiveTableAssignment() {
  await waitForAuthReady();
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

  // Always refresh the server-owned session before reading the URL. This is
  // deliberately repeated for every order: a changed /t/:n path is never
  // allowed to replace an active table assignment.
  await loadActiveTableAssignment();
  const tableId = getTableId();
  if (!tableId) {
    _showError("Could not detect your active table. Please rescan your table QR.");
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
