/**
 * history.js
 * ─────────────────────────────────────────────────────────────
 * Renders the order history drawer. Data arrives from order-status.js,
 * which reads completed orders directly from pending_table_orders in Firestore.
 * Dismissed/rejected orders are NEVER passed here.
 *
 * [AI UPDATE 2026-07-28 v4] — Bug fixes: persistence, duplicates, Invalid Date
 *
 * Persistence: order-status.js now reads completed orders from the same
 * pending_table_orders listener used for active orders, so history is loaded
 * from Firestore on every login without any extra write path or Billing Panel
 * rule change. updateFromFirestore() stores the snapshot in memory;
 * renderHistory() uses it as the primary source.
 *
 * Duplicates: eliminated by removing the separate customer_order_history write
 * path. A single Firestore query → single onHistory call → single updateFromFirestore.
 *
 * Invalid Date (Bug 3): order-status.js now converts all Firestore Timestamps
 * to ms integers before passing them here. renderHistory() also has a _toDate()
 * guard that handles ms numbers, Firestore Timestamp objects, ISO strings, and
 * null — so "Invalid Date" can never appear.
 */

const HISTORY_KEY = "qrmenu_history";   // clean key (old "qrmenu_orders" is gone)
const MAX_HISTORY = 50;

const fmt = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

// ── In-memory Firestore snapshot ───────────────────────────────────────────────
// Set by updateFromFirestore() whenever order-status.js receives a new snapshot
// from customer_order_history/{uid}/orders. null = not yet received (fall back
// to localStorage). Cleared on module load / logout via stopOrderStatus().
let _firestoreOrders = null;
let _drawerOpen      = false;

// ── Public ────────────────────────────────────────────────────

/**
 * updateFromFirestore(orders)
 *
 * Called by order-status.js _syncHistoryToLocalStorage whenever Listener 2
 * (customer_order_history/{uid}/orders) fires. Stores the full snapshot in
 * memory and immediately re-renders the drawer if it is currently open.
 *
 * orders: array of mapped order objects with the same shape as saveOrderToHistory
 * expects (firestoreId, tableId, items, totalPrice, placedAt, completedAt, …).
 */
export function updateFromFirestore(orders) {
  _firestoreOrders = orders || [];
  if (_drawerOpen) renderHistory();
}

/** Prepend a completed order and persist to localStorage. Deduplicates by firestoreId. */
export function saveOrderToHistory(order) {
  const history = getHistory();

  if (order.firestoreId) {
    if (history.some((h) => h.firestoreId === order.firestoreId)) return;
  }

  history.unshift({
    ...order,
    localId:     `ORD-${Date.now()}`,
    placedAt:    order.placedAt || new Date().toISOString(),
    completedAt: order.completedAt || new Date().toISOString(),
    status:      "completed",
  });

  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

/** Returns full order history array (newest first) from localStorage cache. */
export function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}

/** Wire up the history button, close button, and backdrop. */
export function initHistory() {
  document.getElementById("historyBtn")?.addEventListener("click", openHistory);
  document.getElementById("historyCloseBtn")?.addEventListener("click", closeHistory);
  document.getElementById("historyBackdrop")?.addEventListener("click", closeHistory);
}

/** Open drawer and re-render from Firestore data (or localStorage if not yet loaded). */
export function openHistory() {
  _drawerOpen = true;
  renderHistory();
  document.getElementById("historyPanel")?.classList.remove("hidden");
  document.getElementById("historyBackdrop")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

// ── Internal ──────────────────────────────────────────────────

function closeHistory() {
  _drawerOpen = false;
  document.getElementById("historyPanel")?.classList.add("hidden");
  document.getElementById("historyBackdrop")?.classList.add("hidden");
  document.body.style.overflow = "";
}

// ── Date conversion helper ─────────────────────────────────────────────────────
// Handles every timestamp format this app may encounter:
//   • ms integer      — from order-status.js _tsToMs() (primary path)
//   • ISO string      — from localStorage cache
//   • {seconds, ...}  — Firestore Timestamp object (legacy localStorage data)
//   • null / undefined / NaN → returns null so callers can fall back gracefully
function _toDate(val) {
  if (!val && val !== 0) return null;
  if (typeof val === "number")  return isNaN(val) ? null : new Date(val);
  if (val.seconds != null)      return new Date(val.seconds * 1000);
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function renderHistory() {
  const list = document.getElementById("historyList");
  if (!list) return;

  // Prefer the live Firestore snapshot (_firestoreOrders) when available.
  // Fall back to localStorage so the drawer still works before the first
  // Firestore snapshot arrives (e.g. slow connection, first render).
  const orders = _firestoreOrders !== null ? _firestoreOrders : getHistory();

  if (orders.length === 0) {
    list.innerHTML = `
      <div class="history-empty">
        <span class="history-empty-icon">🧾</span>
        <p>No completed orders yet.<br/>Settled orders appear here.</p>
      </div>`;
    return;
  }

  list.innerHTML = orders.map((order, i) => {
    // _toDate handles ms integers, ISO strings, and Firestore Timestamps —
    // "Invalid Date" is impossible with this helper.
    const placed  = _toDate(order.placedAt) || new Date();
    const timeStr = placed.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    const dateStr = placed.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    const num     = orders.length - i;

    let completedLine = "";
    const cd = _toDate(order.completedAt);
    if (cd) {
      const ct = cd.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
      completedLine = `<span class="history-completed-time">Settled at ${ct}</span>`;
    }

    return `
      <div class="history-order">
        <div class="history-order-meta">
          <div class="history-order-left">
            <span class="history-order-num">Order #${num}</span>
            <span class="history-table-tag">Table ${esc(order.tableId || "—")}</span>
          </div>
          <div class="history-order-time">
            <span class="history-date">${dateStr}</span>
            <span class="history-time">${timeStr}</span>
          </div>
        </div>

        <ul class="history-items">
          ${(order.items || []).map((it) => `
            <li class="history-item-row">
              <span class="history-item-name">${esc(it.name)}</span>
              <span class="history-item-detail">×${it.quantity}&nbsp;&nbsp;${fmt(it.subtotal || 0)}</span>
            </li>`).join("")}
        </ul>

        <div class="history-order-footer">
          <div class="history-footer-left">
            <span class="history-status-badge">Completed</span>
            ${completedLine}
          </div>
          <span class="history-total">${fmt(order.totalPrice || 0)}</span>
        </div>
      </div>`;
  }).join("");
}

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
