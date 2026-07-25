/**
 * history.js
 * ─────────────────────────────────────────────────────────────
 * Saves completed orders to localStorage and renders the history drawer.
 * Orders are stored newest-first; up to 50 are kept.
 *
 * History is written by order-status.js when Firestore status → "completed".
 * Legacy: saveOrderToHistory() still accepts direct calls.
 */

const HISTORY_KEY = "qrmenu_orders";
const MAX_HISTORY = 50;

const fmt = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

// ── Public ────────────────────────────────────────────────────

/** Prepend a new order record and persist. Deduplicated by firestoreId. */
export function saveOrderToHistory(order) {
  const history = getHistory();

  // Deduplicate by firestoreId (for Firestore-completed orders)
  if (order.firestoreId) {
    const exists = history.some((h) => h.firestoreId === order.firestoreId);
    if (exists) return;
  }

  history.unshift({
    ...order,
    localId:     order.localId  || `ORD-${Date.now()}`,
    placedAt:    order.placedAt || new Date().toISOString(),
    completedAt: order.completedAt || null,
    status:      order.status || "completed",
  });

  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

/** Returns full order history array. */
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

/** Open drawer and re-render. */
export function openHistory() {
  renderHistory();
  document.getElementById("historyPanel")?.classList.remove("hidden");
  document.getElementById("historyBackdrop")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

// ── Internal ──────────────────────────────────────────────────

function closeHistory() {
  document.getElementById("historyPanel")?.classList.add("hidden");
  document.getElementById("historyBackdrop")?.classList.add("hidden");
  document.body.style.overflow = "";
}

function renderHistory() {
  const list = document.getElementById("historyList");
  if (!list) return;

  const orders = getHistory();

  if (orders.length === 0) {
    list.innerHTML = `
      <div class="history-empty">
        <span class="history-empty-icon">🧾</span>
        <p>No orders yet.<br/>Completed orders appear here.</p>
      </div>`;
    return;
  }

  list.innerHTML = orders
    .map((order, i) => {
      const date    = new Date(order.placedAt);
      const timeStr = date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
      const dateStr = date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
      const orderNum = orders.length - i;

      // Completion timestamp line
      let completedLine = "";
      if (order.completedAt) {
        const cd = new Date(order.completedAt?.seconds ? order.completedAt.seconds * 1000 : order.completedAt);
        const ct = cd.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
        completedLine = `<span class="history-completed-time">Completed at ${ct}</span>`;
      }

      return `
        <div class="history-order">
          <div class="history-order-meta">
            <div class="history-order-left">
              <span class="history-order-num">Order #${orderNum}</span>
              <span class="history-table-tag">Table ${escHtml(order.tableId || "—")}</span>
            </div>
            <div class="history-order-time">
              <span class="history-date">${dateStr}</span>
              <span class="history-time">${timeStr}</span>
            </div>
          </div>

          <ul class="history-items">
            ${(order.items || [])
              .map(
                (it) => `
              <li class="history-item-row">
                <span class="history-item-name">${escHtml(it.name)}</span>
                <span class="history-item-detail">×${it.quantity} &nbsp;${fmt(it.subtotal)}</span>
              </li>`
              )
              .join("")}
          </ul>

          <div class="history-order-footer">
            <div class="history-footer-left">
              <span class="history-status-badge">Completed</span>
              ${completedLine}
            </div>
            <span class="history-total">${fmt(order.totalPrice)}</span>
          </div>
        </div>`;
    })
    .join("");
}

function escHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
