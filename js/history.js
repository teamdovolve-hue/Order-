/**
 * history.js
 * ─────────────────────────────────────────────────────────────
 * Saves completed orders to localStorage and renders the history drawer.
 * Orders arrive here from order-status.js when Firestore status → "completed".
 * Dismissed/rejected orders are NEVER passed here.
 *
 * [AI UPDATE 2026-07-28] — Firestore-backed persistent history
 * Root cause: history was only stored in localStorage, which is per-device
 * and lost on logout. Added updateFromFirestore() so order-status.js can push
 * live Firestore data directly into memory here. renderHistory() now prefers
 * the in-memory Firestore snapshot over localStorage, giving true persistence
 * across devices and sessions. localStorage is kept as an offline cache.
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
    const placed  = new Date(order.placedAt);
    const timeStr = placed.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    const dateStr = placed.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    const num     = orders.length - i;

    let completedLine = "";
    if (order.completedAt) {
      const cd = new Date(
        order.completedAt?.seconds
          ? order.completedAt.seconds * 1000
          : order.completedAt
      );
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
