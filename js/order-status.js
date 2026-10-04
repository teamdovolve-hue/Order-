/**
 * order-status.js  — BRIDGE BUILD (no Cloud Functions)
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides real-time Active Orders tracking and Order History for the customer.
 *
 * REPLACED FROM: original order-status.js read `customer_table_sessions`
 *   which is only written by Cloud Functions (Admin SDK). In bridge mode that
 *   collection is never populated, so order tracking showed nothing.
 *
 * THIS VERSION reads:
 *   • pending_table_orders  — filtered by customer.uid + active statuses
 *                             → Active Orders (Preparing / Received / etc.)
 *   • customer_order_history/{uid}/orders  — written by billing panel on
 *                             completion (Bill & Settle / Save & Exit)
 *                             → Order History tab
 *
 * STATUS LIFECYCLE written by billing panel (js/cart.js):
 *   pending   → order placed by customer
 *   accepted  → operator opened in POS
 *   kot       → KOT printed (order is being prepared)
 *   completed → Bill & Settle or Save & Exit pressed (billing panel)
 *   dismissed → operator dismissed the order
 *   rejected  → operator rejected the order (silently removed, not saved)
 *
 * PUBLIC API (used by app.js):
 *   initOrderStatus()   — start tracking + wire DOM rendering (called after login)
 *   stopOrderStatus()   — stop tracking (called on logout)
 *
 * LOWER-LEVEL API (available if you need custom rendering):
 *   startOrderTracking(callbacks) — start listeners with your own render fns
 *   stopOrderTracking()           — stop listeners
 *   getStatusLabel(status)        — human-readable status string
 *   getStatusColor(status)        — hex colour for status
 *
 * HOW initOrderStatus INTEGRATES WITH app.js:
 *   app.js calls initOrderStatus() with no args after the user logs in.
 *   This function wires startOrderTracking with DOM callbacks that render
 *   into #activeOrdersList / #activeOrdersSection and sync completed orders
 *   into localStorage via saveOrderToHistory (history.js).
 *
 * REQUIRED Firestore rules (see firestore.rules in billing repo):
 *   • pending_table_orders read:  if isOrderOwner() || isOperator()
 *   • customer_order_history/{uid}/orders read: if isSameCustomer(uid)
 *
 * AI UPDATE — 2026-07-28 v2
 * Added initOrderStatus / stopOrderStatus exports so app.js wiring works.
 * These were missing from v1; app.js already imported them but they didn't exist,
 * causing order tracking to silently never start.
 * Also added: DOM render functions for active orders using .aos-* CSS classes,
 * and Firestore→localStorage sync for order history via saveOrderToHistory.
 *
 * AI UPDATE — 2026-07-28 v3 — KOT Timer
 * Root cause: startOrderTracking never forwarded `kotAt` from Firestore into the
 * mapped order objects passed to onActiveOrders callbacks.  _renderActiveOrders
 * therefore had no timestamp to display, so customers saw "Preparing 🍕" with no
 * elapsed time and no live counter.
 *
 * Fix:
 *   1. `kotAt` is now included in every mapped active-order object.
 *   2. _renderActiveOrders computes elapsed minutes from kotAt on every render
 *      and shows "Preparing 🍕 • X min" for kot-status cards.
 *   3. A module-level setInterval (_timerInterval, 30 s cadence) patches the
 *      elapsed-time label directly in the DOM on pre-existing cards via
 *      data-kot-at timestamps — no Firestore round-trips, no full re-render.
 *      The interval starts when the first preparing order appears and is
 *      stopped when there are no more preparing orders or on logout.
 *
 * AI UPDATE — 2026-07-28 v4 — History persistence, duplicates, Invalid Date
 * Switched to two-listener architecture where Listener 1 handles active orders
 * and Listener 2 reads customer_order_history/{uid}/orders (written by Billing Panel).
 *
 * AI UPDATE — 2026-07-29 — Compatibility sync with Billing Panel session 21
 * Uses getLoginInfo().uid (stable stored profile uid) instead of auth.currentUser.uid.
 * auth.currentUser.uid is a new anonymous uid after every logout+re-login (signOut
 * clears the auth session), causing history queries to target an empty path.
 * getLoginInfo().uid is the uid stored in customers/{phone}.uid at account creation —
 * the permanent key for customer_order_history/{uid}/orders and pending_table_orders
 * customer.uid field. Also restored Listener 2 (customer_order_history) now that
 * Billing Panel writes to it on Bill & Settle / Save & Exit.
 *
 * AI UPDATE — 2026-07-31 — Per-item timers and per-item served status
 * Root cause of timer-reset bug: Billing Panel printKOT was writing a fresh
 * kotAt to EVERY active order doc for the table on every KOT press, resetting
 * already-running timers. Billing Panel fix: it now writes per-item kotAt into
 * an itemMeta map on each order document (keyed by stable item ID) and no
 * longer overwrites kotAt on already-preparing items.
 *
 * Customer Panel changes (this file):
 *   1. Listener 1 mapping now forwards itemMeta from each Firestore document.
 *   2. _renderActiveOrders now renders per-item rows (.aos-item-row) inside
 *      each order card. Each item row has its own status class and timer.
 *      data-kot-at moves from the card level to the item-row level.
 *   3. _startPreparingTimer interval now targets .aos-item-row[data-kot-at]
 *      and patches .aos-item-status-label within each matched row.
 *   Backward compat: orders without itemMeta (in-flight legacy orders) fall
 *   back to order-level status and kotAt — existing behaviour unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db, auth }             from "./firebase-config.js";
import {
  collection, query, where,
  onSnapshot, orderBy,
  doc, updateDoc, serverTimestamp,
}                               from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { waitForAuthReady, getLoginInfo } from "./auth.js";
// [AI UPDATE 2026-07-29 v2] Task 6 — import updateFromFirestore so history drawer
// refreshes immediately when Firestore snapshot fires, without requiring a re-open.
import { saveOrderToHistory, updateFromFirestore } from "./history.js";

// ── Status display helpers ────────────────────────────────────────────────────

const STATUS_LABEL = {
  pending:   "Order Received ✅",
  accepted:  "Order Confirmed 👨‍🍳",
  kot:       "Preparing 🍕",
  completed: "Ready / Completed 🎉",
  dismissed: "Cancelled",
};

const STATUS_COLOR = {
  pending:   "#f59e0b",
  accepted:  "#3b82f6",
  kot:       "#10b981",
  completed: "#6b7280",
  dismissed: "#ef4444",
};

// [AI UPDATE 2026-09-18] Smart Assistant support — last-known active-orders
// snapshot, kept in sync below (see _renderActiveOrders). Read-only cache,
// no new listener: js/smart-assistant.js calls getActiveOrdersSnapshot()
// for "track my order" instead of starting its own onSnapshot subscription.
let _lastActiveOrders = [];

/** Returns the most recent active-orders array from the existing listener
 *  (same shape as startOrderTracking's onActiveOrders callback), or []
 *  if tracking hasn't started / there are no active orders. Never null. */
export function getActiveOrdersSnapshot() {
  return _lastActiveOrders;
}

export function getStatusLabel(status) {
  return STATUS_LABEL[(status || "").toLowerCase()] || status || "Unknown";
}

export function getStatusColor(status) {
  return STATUS_COLOR[(status || "").toLowerCase()] || "#9ca3af";
}

// ── Internal unsubscribe handles ──────────────────────────────────────────────

let _unsubActive  = null;
let _unsubHistory = null;

// ── Preparing-timer state ──────────────────────────────────────────────────────
// A single 30-second interval that updates the elapsed-minutes label on any
// .aos-card[data-kot-at] elements in the DOM.  Only runs while at least one
// order is in "kot" (Preparing) status; automatically stopped otherwise.
let _timerInterval = null;

// Convert a Firestore Timestamp (or plain {seconds,nanoseconds} object) to ms.
function _tsToMs(ts) {
    if (!ts) return null;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (ts.seconds != null) return ts.seconds * 1000;
    return null;
}

// Elapsed minutes since a Firestore Timestamp; returns null if unavailable.
function _elapsedMin(ts) {
    const ms = _tsToMs(ts);
    if (ms === null) return null;
    return Math.max(0, Math.floor((Date.now() - ms) / 60000));
}

// Start the live timer that patches elapsed-time labels every 30 s.
// Safe to call multiple times — only one interval runs at a time.
// [AI UPDATE 2026-07-31] Targets .aos-item-row[data-kot-at] (per-item rows)
// instead of the old .aos-card[data-kot-at] (per-order card) selector.
// Patches .aos-item-status-label within each matched row.
function _startPreparingTimer() {
    if (_timerInterval) return;
    _timerInterval = setInterval(() => {
        document.querySelectorAll('.aos-item-row[data-kot-at]').forEach(row => {
            const kotMs = parseInt(row.dataset.kotAt, 10);
            if (!kotMs) return;
            const elapsed = Math.max(0, Math.floor((Date.now() - kotMs) / 60000));
            const label = row.querySelector('.aos-item-status-label');
            if (label) label.textContent = `Preparing 🍕 • ${elapsed} min`;
        });
    }, 30000);
}

// Stop and clear the preparing timer.
function _stopPreparingTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}

// ── 3-HOUR ACTIVE-ORDER EXPIRY ─────────────────────────────────────────────────
// [AI UPDATE 2026-10-04] An active (not completed / dismissed / rejected) order must never stay visible for
// more than 3 HOURS after its original order time. The authority is the stored Firestore `createdAt`
// (server timestamp written by js/order.js) — NOT a frontend timer — so the rule holds across refresh,
// logout/login, other devices and reopening the panel: every snapshot (including the first one after load)
// is checked against createdAt. Expired orders are (1) dropped from the active list immediately and
// (2) retired in Firestore with the EXISTING `dismissed` status — the same contract the POS "Dismiss" /
// "Cancel Order" uses, which the firestore.rules allow and every listener already treats as "gone".
// They are NEVER written to customer_order_history (that collection is only written by the POS when an order
// is actually completed via Save & Exit / Bill & Settle), so expired orders never appear in history.
// This is integrated into the existing active-orders listener — no second listener. The setTimeout below only
// makes an already-open screen drop the order at the 3 h mark; correctness never depends on it.
const ACTIVE_ORDER_TTL_MS = 3 * 60 * 60 * 1000;

let _activeCallbacks = null;       // callbacks of the running tracking session (null when stopped)
let _rawActive       = [];         // last raw active docs [{ id, ...data }] from the listener
let _expiryTimer     = null;
const _expiryHandled = new Set();  // ids already sent for Firestore cleanup this session (no repeat writes)
let _expiryHooked    = false;

// Original order time in ms, or null when unknown (e.g. serverTimestamp not yet resolved locally).
function _orderCreatedMs(o) { return _tsToMs(o && o.createdAt); }

function _isOrderExpired(o, now) {
  const ms = _orderCreatedMs(o);
  return ms !== null && (now - ms) >= ACTIVE_ORDER_TTL_MS;
}

// Retire a stale order in Firestore exactly once per session. Failure is non-fatal: the order stays hidden
// client-side (createdAt check on every snapshot) and the cleanup is retried on the next load.
function _retireExpiredOrder(o) {
  if (!o || !o.id || _expiryHandled.has(o.id)) return;
  _expiryHandled.add(o.id);
  updateDoc(doc(db, "pending_table_orders", o.id), {
    status:        "dismissed",
    dismissReason: "auto_expired_3h",
    expiredAt:     serverTimestamp(),
  }).catch(err => console.warn("[order-status] Expired-order cleanup failed (non-fatal):", err.code || err.message));
}

function _mapActiveOrder(o) {
  return {
    id:          o.id,
    tableId:     o.tableId    || "",
    status:      o.status     || "pending",
    statusLabel: getStatusLabel(o.status),
    statusColor: getStatusColor(o.status),
    items:       o.items      || [],
    total:       o.totalPrice || 0,
    createdAt:   o.createdAt  || null,
    kotAt:       o.kotAt      || null,   // order-level kotAt (backward compat fallback)
    // [AI UPDATE 2026-07-31] Per-item status/timer map written by Billing Panel.
    // Keys are stable item IDs matching items[].itemId or items[].id.
    // null when Billing Panel has not yet deployed the itemMeta feature.
    itemMeta:    o.itemMeta   || null,
  };
}

// Filters expired orders out of the raw snapshot, retires them, re-arms the single expiry timer and
// publishes the live list. Called for every listener snapshot, by the timer, and when the tab wakes up.
function _publishActive() {
  if (!_activeCallbacks) return;
  const now = Date.now();
  const live = [];
  for (const o of _rawActive) {
    if (_isOrderExpired(o, now)) _retireExpiredOrder(o);
    else live.push(o);
  }

  if (_expiryTimer) { clearTimeout(_expiryTimer); _expiryTimer = null; }
  let next = Infinity;
  for (const o of live) {
    const ms = _orderCreatedMs(o);
    if (ms !== null) next = Math.min(next, ms + ACTIVE_ORDER_TTL_MS - now);
  }
  if (next !== Infinity) _expiryTimer = setTimeout(_publishActive, Math.max(1000, next + 500));

  if (typeof _activeCallbacks.onActiveOrders === "function") {
    _activeCallbacks.onActiveOrders(live.map(_mapActiveOrder));
  }
}

// Phones throttle/suspend timers in the background — re-check the moment the tab is visible again.
function _hookExpiryWakeup() {
  if (_expiryHooked || typeof document === "undefined") return;
  _expiryHooked = true;
  document.addEventListener("visibilitychange", () => { if (!document.hidden) _publishActive(); });
  window.addEventListener("focus", _publishActive);
  window.addEventListener("online", _publishActive);
}

// ── Public API (used by app.js) ───────────────────────────────────────────────

/**
 * initOrderStatus()
 *
 * High-level entry point — called by app.js after the user logs in.
 * Starts both Firestore listeners and wires them to the DOM.
 *
 * Active orders → rendered into #activeOrdersList; #activeOrdersSection shown/hidden.
 * Completed orders → synced into localStorage via saveOrderToHistory (history.js),
 *   which deduplicates by firestoreId so repeated snapshot fires are safe.
 */
export function initOrderStatus() {
  startOrderTracking({
    onActiveOrders: _renderActiveOrders,
    onHistory:      _syncHistoryToLocalStorage,
  });
}

/**
 * stopOrderStatus()
 *
 * Called by app.js on logout. Detaches listeners and clears the active orders UI.
 */
export function stopOrderStatus() {
  stopOrderTracking();
  _renderActiveOrders([]);   // hide the section and clear the list
}

// ── Lower-level API ───────────────────────────────────────────────────────────

/**
 * startOrderTracking(callbacks)
 *
 * Starts two real-time Firestore listeners:
 *   1. Active orders  — pending_table_orders where customer.uid == current UID
 *                       and status is NOT completed/dismissed/rejected.
 *   2. Order history  — customer_order_history/{uid}/orders ordered by completedAt desc.
 *                       Written by Billing Panel on Bill & Settle / Save & Exit.
 *
 * callbacks.onActiveOrders(orders[]) — fired whenever active orders change.
 * callbacks.onHistory(orders[])      — fired whenever order history changes.
 * callbacks.onActiveOrdersError(err) — optional error handler.
 * callbacks.onHistoryError(err)      — optional error handler.
 *
 * Each `orders` element shape:
 *   Active:  { id, tableId, status, statusLabel, statusColor, items[], total, createdAt, kotAt }
 *   History: { id, orderId, tableId, items[], total, completedAt, orderedAt, completionReason }
 */
export async function startOrderTracking(callbacks = {}) {
  // Stop any existing listeners first
  stopOrderTracking();

  await waitForAuthReady();

  // [AI UPDATE 2026-07-29] Use the stable stored profile uid from getLoginInfo()
  // instead of auth.currentUser?.uid.  auth.currentUser.uid is a new anonymous uid
  // after every logout+re-login (signOut clears the auth session), causing history
  // queries to target an empty Firestore path.
  // getLoginInfo().uid is the uid stored in customers/{phone}.uid at account
  // creation — the permanent key for customer_order_history/{uid}/orders.
  const loginInfo = getLoginInfo();
  const uid = loginInfo?.uid || auth.currentUser?.uid;
  if (!uid) {
    console.warn("[order-status] Cannot start tracking — user not signed in.");
    return;
  }

  // ── Listener 1: Active orders ───────────────────────────────────────────────
  // NOTE: No orderBy here — combining where("customer.uid") with orderBy("createdAt")
  // requires a Firestore composite index that is not guaranteed to exist.
  // Sorting is done client-side below instead; result set is tiny (1-3 docs max).
  const activeQuery = query(
    collection(db, "pending_table_orders"),
    where("customer.uid", "==", uid)
  );

  _activeCallbacks = callbacks;
  _rawActive = [];
  _hookExpiryWakeup();

  _unsubActive = onSnapshot(
    activeQuery,
    (snap) => {
      _rawActive = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        // Preserve "rejected" in filter — silently removed, not saved to history
        .filter(o => !["completed", "dismissed", "rejected"].includes(
          (o.status || "").toLowerCase()
        ))
        // Sort newest-first client-side (avoids composite index on customer.uid + createdAt)
        .sort((a, b) => {
          const tA = a.createdAt?.seconds ?? 0;
          const tB = b.createdAt?.seconds ?? 0;
          return tB - tA;
        });

      // [AI UPDATE 2026-10-04] 3-hour expiry: drops/retires stale orders, then fires onActiveOrders.
      _publishActive();
    },
    (err) => {
      console.warn("[order-status] Active orders listener error:", err.code || err.message);
      if (typeof callbacks.onActiveOrdersError === "function") {
        callbacks.onActiveOrdersError(err);
      }
    }
  );

  // ── Listener 2: Order history ───────────────────────────────────────────────
  // Written by billing panel (js/cart.js → syncCustomerOrderCompletion) whenever
  // Bill & Settle or Save & Exit is pressed for a Customer Panel order.
  const historyQuery = query(
    collection(db, "customer_order_history", uid, "orders"),
    orderBy("completedAt", "desc")
  );

  _unsubHistory = onSnapshot(
    historyQuery,
    (snap) => {
      const history = snap.docs.map(d => ({
        id:               d.id,
        orderId:          d.data().orderId          || d.id,
        tableId:          d.data().tableId          || "",
        items:            d.data().items            || [],
        total:            d.data().total            || 0,
        // [AI UPDATE 2026-09-20] Pass through the POS-saved Custom Instant Discount (flat ₹ off,
        // 0/absent = none) so history.js can display it. Read-only copy of the existing
        // customer_order_history.customDiscount field — `total` above is already the FINAL payable
        // and is never recalculated here.
        customDiscount:   Number(d.data().customDiscount) || 0,
        completedAt:      d.data().completedAt      || null,
        orderedAt:        d.data().orderedAt        || "",
        completionReason: d.data().completionReason || "",
      }));

      if (typeof callbacks.onHistory === "function") {
        callbacks.onHistory(history);
      }
    },
    (err) => {
      console.warn("[order-status] History listener error:", err.code || err.message);
      if (typeof callbacks.onHistoryError === "function") {
        callbacks.onHistoryError(err);
      }
    }
  );

  console.log("[order-status] Tracking started for UID:", uid);
}

/**
 * stopOrderTracking()
 * Detaches both Firestore listeners and stops the preparing timer.
 * Call on logout or page unload.
 */
export function stopOrderTracking() {
  if (_unsubActive)  { _unsubActive();  _unsubActive  = null; }
  if (_unsubHistory) { _unsubHistory(); _unsubHistory = null; }
  _stopPreparingTimer();
  // [AI UPDATE 2026-10-04] stop the 3-hour expiry timer + drop the session state with the listener.
  if (_expiryTimer) { clearTimeout(_expiryTimer); _expiryTimer = null; }
  _activeCallbacks = null;
  _rawActive = [];
}

// ── DOM rendering (used by initOrderStatus) ───────────────────────────────────

const _fmt = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n || 0);

function _esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * _renderActiveOrders(orders)
 *
 * Renders active order cards into #activeOrdersList.
 * Shows #activeOrdersSection when there are orders; hides it when empty.
 *
 * [AI UPDATE 2026-07-31] Per-item lifecycle rendering.
 * Each item in the order now renders as its own .aos-item-row with its own
 * status class and elapsed timer, driven by the itemMeta map written by the
 * Billing Panel when KOT is printed for that specific item.
 *
 * Per-item status logic:
 *   itemMeta present → use meta.itemStatus + meta.kotAt per item
 *   itemMeta absent  → fall back to order-level status + kotAt (backward compat)
 *
 * CSS classes (defined in css/style.css):
 *   .aos-item-preparing  — green border-left, "Preparing 🍕 • X min" timer
 *   .aos-item-pending    — amber border-left, "Order Received — Kitchen notified"
 *   .aos-item-served     — muted border-left, "Order Received ✓"
 *
 * data-kot-at is now on each .aos-item-row (not the card) so the interval
 * can patch labels per-item without touching the card structure.
 *
 * The single .aos-status / .aos-dot row per card is removed — replaced by
 * per-item status labels inside each .aos-item-row.
 * The .aos-status, .aos-dot CSS classes still exist in style.css and are
 * intentionally kept there for potential future use.
 */
function _renderActiveOrders(orders) {
  // [AI UPDATE 2026-09-18] Smart Assistant support — cache the raw snapshot
  // regardless of whether the DOM elements below exist, so getActiveOrdersSnapshot()
  // stays correct even if this fires before/without the Active Orders section
  // being in the DOM.
  _lastActiveOrders = orders || [];

  const section = document.getElementById("activeOrdersSection");
  const list    = document.getElementById("activeOrdersList");
  if (!section || !list) return;

  if (!orders || orders.length === 0) {
    section.classList.add("hidden");
    list.innerHTML = "";
    _stopPreparingTimer();   // no preparing items — timer not needed
    return;
  }

  section.classList.remove("hidden");

  let hasPreparingItem = false;

  list.innerHTML = orders.map(order => {
    const orderStatus = (order.status || "pending").toLowerCase();
    const itemCount   = (order.items || []).reduce((s, i) => s + (i.quantity || 1), 0);

    // ── Per-item rows ──────────────────────────────────────────────────────────
    const itemsHtml = (order.items || []).map(it => {
      const itemKey = it.itemId || it.id || null;
      const meta    = (itemKey && order.itemMeta) ? (order.itemMeta[itemKey] || null) : null;

      // Determine per-item status and kotAt.
      // If itemMeta is present, use it. Otherwise fall back to order-level values
      // so orders placed before the Billing Panel update render correctly.
      let itemStatus, itemKotAt;
      if (meta) {
        itemStatus = (meta.itemStatus || "pending").toLowerCase();
        itemKotAt  = meta.kotAt || null;
      } else {
        itemStatus = orderStatus;             // order-level fallback
        itemKotAt  = order.kotAt || null;     // order-level fallback
      }

      // Resolve CSS class, display label, and data-kot-at attribute for this row.
      let itemStatusClass, displayLabel, kotAtAttr = "";

      const isPreparing = itemStatus === "preparing" || itemStatus === "kot";

      if (isPreparing) {
        hasPreparingItem  = true;
        const kotAtMs     = _tsToMs(itemKotAt);
        const elapsed     = kotAtMs !== null ? _elapsedMin(itemKotAt) : null;
        displayLabel      = elapsed !== null ? `Preparing 🍕 • ${elapsed} min` : "Preparing 🍕";
        itemStatusClass   = "aos-item-preparing";
        kotAtAttr         = kotAtMs !== null ? ` data-kot-at="${kotAtMs}"` : "";
      } else if (itemStatus === "served") {
        displayLabel    = "Order Received ✓";
        itemStatusClass = "aos-item-served";
      } else {
        // pending, accepted — waiting for kitchen
        displayLabel    = "Order Received — Kitchen notified soon";
        itemStatusClass = "aos-item-pending";
      }

      return `
        <li class="aos-item-row ${_esc(itemStatusClass)}"${kotAtAttr}>
          <div class="aos-item-row-name">
            <span class="aos-item-name">${_esc(it.name || "")}</span>
            <span class="aos-item-qty">×${it.quantity || 1} · ${_fmt((it.price || 0) * (it.quantity || 1))}</span>
          </div>
          <span class="aos-item-status-label">${displayLabel}</span>
        </li>`;
    }).join("");

    return `
      <div class="aos-card" data-order-id="${_esc(order.id)}">
        <div class="aos-card-top">
          <div class="aos-card-left">
            <span class="aos-table-tag">${_esc(order.tableId || "—")}</span>
            <span class="aos-item-count">${itemCount} item${itemCount !== 1 ? "s" : ""}</span>
          </div>
          <span class="aos-total">${_fmt(order.total)}</span>
        </div>

        <ul class="aos-items">
          ${itemsHtml}
        </ul>
      </div>`;
  }).join("");

  // ── Start / stop preparing timer ───────────────────────────────────────────
  if (hasPreparingItem) {
    _startPreparingTimer();
  } else {
    _stopPreparingTimer();
  }
}

/**
 * _syncHistoryToLocalStorage(orders)
 *
 * Syncs completed orders from Firestore (customer_order_history) into localStorage
 * so the history drawer (history.js) shows them. saveOrderToHistory deduplicates
 * by firestoreId — calling it for all orders on every snapshot is safe.
 *
 * Field mapping:
 *   Firestore (order-status)  → history.js saveOrderToHistory
 *   id                        → firestoreId  (deduplication key)
 *   total                     → totalPrice   (history.js uses .totalPrice)
 *   orderedAt                 → placedAt     (history.js uses .placedAt)
 *
 * [AI UPDATE 2026-07-29 v2] Task 6 — also calls updateFromFirestore() so the
 * history drawer re-renders immediately when a Firestore snapshot fires,
 * without requiring the user to close and re-open the drawer.
 * updateFromFirestore() stores the full mapped snapshot in memory and calls
 * renderHistory() immediately if the drawer is currently open.
 */
function _syncHistoryToLocalStorage(orders) {
  // Map to the shape expected by history.js (totalPrice, placedAt)
  const mapped = (orders || []).map(order => ({
    firestoreId:      order.id,
    orderId:          order.orderId || order.id,
    tableId:          order.tableId,
    items:            order.items,
    totalPrice:       order.total,        // history.js reads .totalPrice
    // [AI UPDATE 2026-09-20] carry the saved Custom Instant Discount through to history.js (display only).
    customDiscount:   order.customDiscount || 0,
    placedAt:         order.orderedAt || null,
    completedAt:      order.completedAt,
    completionReason: order.completionReason || "",
    status:           "completed",
  }));

  // Update in-memory Firestore snapshot — history drawer re-renders immediately
  // if open, and uses this data on next open (no localStorage round-trip needed).
  updateFromFirestore(mapped);

  // Also persist to localStorage as offline cache / fallback before first snapshot.
  for (const order of mapped) {
    saveOrderToHistory(order);
  }
}
