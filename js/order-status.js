/**
 * order-status.js
 * ─────────────────────────────────────────────────────────────
 * Real-time active-order tracking for the customer panel.
 *
 * Statuses (set by billing panel):
 *   pending / accepted → "Order Received — Kitchen notified soon"
 *   kot               → "Preparing • X min"  (live elapsed timer)
 *   completed         → removed from active view, saved to history
 *   dismissed/rejected→ removed from active view silently (NOT saved to history)
 *
 * Firebase Auth is the source of truth for the current user's phone.
 */

import { db, auth }                       from "./firebase-config.js";
import {
  collection, query, where, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { saveOrderToHistory }             from "./history.js";

const ORDERS_COL   = "pending_table_orders";
const MOVED_KEY    = "qrmenu_moved_to_history";

// Statuses that should appear in Active Orders view
const ACTIVE_STATUSES = new Set(["pending", "accepted", "kot"]);

// Statuses that should be quietly dropped (not shown, not saved)
const SILENT_DISCARD = new Set(["dismissed", "rejected"]);

let _unsub         = null;
let _timerHandle   = null;
let _activeOrders  = [];

// ── Public ────────────────────────────────────────────────────

/** Start listening for this customer's orders (keyed by phone number). */
export function initOrderStatus() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  _startListener(uid);
}

/** Stop listener — call on logout. */
export function stopOrderStatus() {
  if (_unsub) { _unsub(); _unsub = null; }
  clearInterval(_timerHandle);
  _timerHandle  = null;
  _activeOrders = [];
  _render();
}

// ── Firestore listener ────────────────────────────────────────

function _startListener(uid) {
  // Stop any existing listener first
  if (_unsub) { _unsub(); _unsub = null; }

  // 24-hour window so old orders don't pile up
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;

  const q = query(
    collection(db, ORDERS_COL),
    where("customer.uid", "==", uid)
  );

  _unsub = onSnapshot(q, (snap) => {
    const movedSet = _getMovedSet();
    let   dirty    = false;
    const active   = [];

    snap.docs.forEach((d) => {
      const data   = { _docId: d.id, ...d.data() };
      const status = (data.status || "pending").toLowerCase();

      const ts = data.createdAt?.seconds
        ? data.createdAt.seconds * 1000
        : new Date(data.placedAt || 0).getTime();

      // ── completed → save to history once, then discard from active ────────
      if (status === "completed") {
        if (!movedSet.has(d.id)) {
          saveOrderToHistory({ ...data, firestoreId: d.id });
          movedSet.add(d.id);
          dirty = true;
        }
        return; // not shown in active
      }

      // ── dismissed / rejected → silently drop (never save to history) ──────
      if (SILENT_DISCARD.has(status)) return;

      // ── active statuses → show if within 24-hour window ──────────────────
      if (ACTIVE_STATUSES.has(status) && ts > cutoffMs) {
        active.push(data);
      }
    });

    if (dirty) _setMovedSet(movedSet);

    _activeOrders = active.sort((a, b) => {
      const ta = a.createdAt?.seconds || 0;
      const tb = b.createdAt?.seconds || 0;
      return tb - ta; // newest first
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
    container.innerHTML = "";
    return;
  }

  section.classList.remove("hidden");
  container.innerHTML = _activeOrders.map(_buildCard).join("");
}

function _buildCard(order) {
  const status = (order.status || "pending").toLowerCase();
  const isKot  = status === "kot";
  const fmt    = (n) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

  // Elapsed preparing time
  const kotSec    = order.kotAt?.seconds || 0;
  const nowMs     = Date.now();
  const elapsedMn = kotSec ? Math.floor((nowMs - kotSec * 1000) / 60_000) : 0;

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

  const itemsHTML = (order.items || [])
    .map((it) => `
      <li>
        <span class="aos-item-name">${_esc(it.name)}</span>
        <span class="aos-item-qty">×${it.quantity}</span>
      </li>`)
    .join("");

  return `
    <div class="aos-card" data-docid="${_esc(order._docId)}">
      <div class="aos-card-top">
        <div class="aos-card-left">
          <span class="aos-table-tag">Table ${_esc(order.tableId || "—")}</span>
          <span class="aos-item-count">
            ${order.totalItems || 0} item${(order.totalItems || 0) !== 1 ? "s" : ""}
          </span>
        </div>
        <span class="aos-total">${fmt(order.totalPrice || 0)}</span>
      </div>
      ${statusHTML}
      <ul class="aos-items">${itemsHTML}</ul>
    </div>`;
}

// ── Live timer (ticks every minute) ──────────────────────────

function _startTimers() {
  clearInterval(_timerHandle);

  const hasKot = _activeOrders.some((o) => (o.status || "").toLowerCase() === "kot");
  if (!hasKot) return;

  // Tick immediately then every 60 s
  _tickTimers();
  _timerHandle = setInterval(_tickTimers, 60_000);
}

function _tickTimers() {
  document.querySelectorAll(".aos-timer[data-kotat]").forEach((el) => {
    const sec = parseInt(el.dataset.kotat, 10);
    if (!sec) return;
    const mins = Math.floor((Date.now() - sec * 1000) / 60_000);
    el.textContent = `• ${mins} min`;
  });
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
