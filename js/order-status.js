/**
 * order-status.js
 * ─────────────────────────────────────────────────────────────
 * Real-time active-order tracking for the customer panel.
 *
 * Statuses (set by billing panel via billing-integration/incoming-orders.js):
 *   pending / accepted → "Order Received — Kitchen notified soon"
 *   kot               → "Preparing • X min"  (live elapsed timer)
 *   completed         → removed from active view, saved to local history
 *   rejected          → silent remove from active view
 */

import { db }                             from "./firebase-config.js";
import { collection, query, where, onSnapshot }
                                          from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getLoginInfo }                   from "./login.js";
import { saveOrderToHistory }             from "./history.js";

const ORDERS_COL   = "pending_table_orders";
const MOVED_KEY    = "qrmenu_moved_to_history";   // docIds already saved to local history

let _unsub         = null;
let _timerInterval = null;
let _activeOrders  = [];

// ── Public ────────────────────────────────────────────────────

/** Start listening for this customer's orders. Call after login. */
export function initOrderStatus() {
  const login = getLoginInfo();
  if (!login?.phone) return;
  _startListener(login.phone);
}

/** Stop listener (e.g. on logout). */
export function stopOrderStatus() {
  _unsub?.();
  clearInterval(_timerInterval);
  _timerInterval = null;
}

// ── Firestore listener ────────────────────────────────────────

function _startListener(phone) {
  if (_unsub) _unsub();

  // Single query by phone — filter statuses client-side to avoid composite index
  const q = query(collection(db, ORDERS_COL), where("customer.phone", "==", phone));

  _unsub = onSnapshot(q, (snap) => {
    const now        = Date.now();
    const cutoff     = now - 24 * 60 * 60 * 1000; // 24-hour window
    const movedSet   = _getMovedSet();
    let   changed    = false;

    const active = [];

    snap.docs.forEach((d) => {
      const data   = { _docId: d.id, ...d.data() };
      const status = data.status || "pending";
      const ts     = data.createdAt?.seconds
        ? data.createdAt.seconds * 1000
        : new Date(data.placedAt || 0).getTime();

      if (status === "completed" && !movedSet.has(d.id)) {
        saveOrderToHistory({ ...data, firestoreId: d.id });
        movedSet.add(d.id);
        changed = true;
      }

      // Show in active view if within last 24 h and still active
      if (["pending", "accepted", "kot"].includes(status) && ts > cutoff) {
        active.push(data);
      }
    });

    if (changed) _setMovedSet(movedSet);

    _activeOrders = active.sort((a, b) => {
      const ta = a.createdAt?.seconds || 0;
      const tb = b.createdAt?.seconds || 0;
      return tb - ta;
    });

    _render();
    _startTimers();
  }, (err) => {
    console.error("[order-status] Firestore error:", err);
  });
}

// ── Render ─────────────────────────────────────────────────────

function _render() {
  const section   = document.getElementById("activeOrdersSection");
  const container = document.getElementById("activeOrdersList");
  if (!section || !container) return;

  if (_activeOrders.length === 0) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  container.innerHTML = _activeOrders.map(_buildCard).join("");
}

function _buildCard(order) {
  const status = order.status || "pending";
  const isKot  = status === "kot";
  const fmt    = (n) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

  const kotSec    = order.kotAt?.seconds || 0;
  const elapsedMn = kotSec ? Math.floor((Date.now() - kotSec * 1000) / 60000) : 0;

  const statusHTML = isKot
    ? `<div class="aos-status aos-preparing">
        <span class="aos-dot aos-dot-prep"></span>
        <span class="aos-status-label">Preparing</span>
        <span class="aos-timer" data-kotat="${kotSec}">• ${elapsedMn} min</span>
       </div>`
    : `<div class="aos-status aos-pending">
        <span class="aos-dot aos-dot-pend"></span>
        <span class="aos-status-label">Order Received</span>
        <span class="aos-status-sub">Kitchen will be notified soon</span>
       </div>`;

  const items = (order.items || [])
    .map((it) => `<li><span class="aos-item-name">${_esc(it.name)}</span><span class="aos-item-qty">×${it.quantity}</span></li>`)
    .join("");

  return `
    <div class="aos-card" data-docid="${order._docId}">
      <div class="aos-card-top">
        <div class="aos-card-left">
          <span class="aos-table-tag">Table ${_esc(order.tableId || "—")}</span>
          <span class="aos-item-count">${order.totalItems || 0} item${(order.totalItems || 0) !== 1 ? "s" : ""}</span>
        </div>
        <span class="aos-total">${fmt(order.totalPrice || 0)}</span>
      </div>
      ${statusHTML}
      <ul class="aos-items">${items}</ul>
    </div>`;
}

// ── Live timers ────────────────────────────────────────────────

function _startTimers() {
  clearInterval(_timerInterval);
  if (!_activeOrders.some((o) => o.status === "kot")) return;

  _timerInterval = setInterval(() => {
    document.querySelectorAll(".aos-timer[data-kotat]").forEach((el) => {
      const sec = parseInt(el.dataset.kotat, 10);
      if (!sec) return;
      const mins = Math.floor((Date.now() - sec * 1000) / 60000);
      el.textContent = `• ${mins} min`;
    });
  }, 15_000);
}

// ── Moved-set helpers ─────────────────────────────────────────

function _getMovedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(MOVED_KEY)) || []); }
  catch { return new Set(); }
}

function _setMovedSet(set) {
  localStorage.setItem(MOVED_KEY, JSON.stringify([...set]));
}

function _esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
