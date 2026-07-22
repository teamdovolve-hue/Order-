/**
 * history.js
 * ─────────────────────────────────────────────────────────────
 * Saves orders to localStorage and renders the history drawer.
 * Orders are stored newest-first; last 30 are kept.
 */

const HISTORY_KEY = "qrmenu_orders";

const fmt = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

// ── Public ────────────────────────────────────────────────────

/** Prepend a new order record and persist. */
export function saveOrderToHistory(order) {
  const history = getHistory();
  history.unshift({
    ...order,
    localId:  `ORD-${Date.now()}`,
    placedAt: new Date().toISOString(),
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 30)));
}

/** Returns full order history array. */
export function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}

/** Wire up the history button, close button, and backdrop. */
export function initHistory() {
  document.getElementById("historyBtn")
    ?.addEventListener("click", openHistory);
  document.getElementById("historyCloseBtn")
    ?.addEventListener("click", closeHistory);
  document.getElementById("historyBackdrop")
    ?.addEventListener("click", closeHistory);
}

/** Open drawer and re-render (call after placing a new order too). */
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
        <p>No orders yet.<br/>Your order history will appear here.</p>
      </div>`;
    return;
  }

  list.innerHTML = orders
    .map((order, i) => {
      const date    = new Date(order.placedAt);
      const timeStr = date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
      const dateStr = date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
      const orderNum = orders.length - i;

      return `
        <div class="history-order">
          <div class="history-order-meta">
            <div class="history-order-left">
              <span class="history-order-num">Order #${orderNum}</span>
              <span class="history-table-tag">Table ${escHtml(order.tableId)}</span>
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
            <span class="history-status-badge">Placed</span>
            <span class="history-total">${fmt(order.totalPrice)}</span>
          </div>
        </div>`;
    })
    .join("");
}

function escHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
