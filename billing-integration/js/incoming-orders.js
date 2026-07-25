/**
 * incoming-orders.js  — Drop into your billing panel's js/ folder
 * ─────────────────────────────────────────────────────────────────
 * Listens for new customer QR orders in real-time.
 *
 * Actions in this file:
 *   Accept  → merges items into localStorage POS cart, navigates to table
 *   Dismiss → sets status "dismissed" in Firestore (customer panel removes it silently)
 *
 * Order status hooks (exposed on window):
 *   window._orderStatusKOT(tableName)
 *     → Call when KOT is printed. Sets status = "kot" + kotAt timestamp.
 *        Customer panel shows "Preparing • X min" live timer.
 *
 *   window._orderStatusComplete(tableName, reason)
 *     → Call on "Save & Exit" or "Bill & Settle".
 *        Sets status = "completed" + completedAt timestamp.
 *        Customer panel moves order to history.
 *
 * Setup (4 steps):
 *   1. Copy this file into your billing panel's js/ folder.
 *   2. Add <script type="module" src="js/incoming-orders.js"></script> before </body>.
 *   3. Expose window._posOpenTable and window._posLoadGrid in tables.js.
 *   4. Call the hooks above in your KOT / Save & Exit / Bill & Settle handlers.
 */

import { db } from './firebase-config.js';
import {
  collection, onSnapshot, query, orderBy, where,
  getDocs, doc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ── Safe escaping (prevent XSS from Firestore-derived fields) ────────────────

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setTextContent(el, text) {
  if (el) el.textContent = String(text ?? "");
}

// ── Table name normalization ───────────────────────────────────────────────────
// Orders arrive from the QR URL with values like "T4", "4", or "Table 4".
// The billing panel uses canonical names like "Table 4" or "Parcel A".
// This normalises both sides to a canonical form for matching.

/**
 * Normalise a raw table identifier to canonical form.
 * "T4" → "Table 4", "4" → "Table 4", "Table 4" → "Table 4"
 * "Parcel A" → "Parcel A" (already canonical)
 */
function normaliseName(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  // Already canonical (starts with "Table" or "Parcel")
  if (/^(Table|Parcel)\s/i.test(s)) return s;
  // "T4" → "Table 4"
  if (/^T\d+$/i.test(s)) return `Table ${s.slice(1)}`;
  // Pure number → "Table N"
  if (/^\d+$/.test(s)) return `Table ${s}`;
  // Fallback: return as-is
  return s;
}

/** True if two table names refer to the same table after normalization. */
function sameTable(a, b) {
  return normaliseName(a).toLowerCase() === normaliseName(b).toLowerCase();
}

// ── DOM refs — wired lazily so we survive partial DOM ────────────────────────

function getEl(id) { return document.getElementById(id); }

// ── CSS ───────────────────────────────────────────────────────────────────────
(function injectCSS() {
  if (getEl('orders-drawer-style')) return;
  const s = document.createElement('style');
  s.id = 'orders-drawer-style';
  s.textContent = `
    @keyframes badgePop { 0%{transform:scale(1)} 50%{transform:scale(1.4)} 100%{transform:scale(1)} }
    .btn-pulse { animation: badgePop 0.5s ease 3; }
    #orders-badge {
      position:absolute; top:-8px; right:-8px;
      background:#ef4444; color:#fff;
      border-radius:999px; min-width:22px; height:22px;
      font-size:.72rem; font-weight:700;
      display:none; align-items:center; justify-content:center;
      padding:0 5px; pointer-events:none;
      z-index:10; box-shadow:0 2px 6px rgba(0,0,0,.4);
    }
    .orders-drawer {
      position:fixed; bottom:0; left:0; right:0;
      background:#1e1e2e; border-radius:20px 20px 0 0;
      z-index:5000; transform:translateY(100%);
      transition:transform .3s ease;
      max-height:80vh; display:flex; flex-direction:column;
    }
    .orders-drawer.open { transform:translateY(0); }
    .orders-overlay {
      position:fixed; inset:0;
      background:rgba(0,0,0,.55); z-index:4999;
      display:none; opacity:0; transition:opacity .3s ease;
    }
    .orders-overlay.open { display:block; opacity:1; }
    .order-card-item {
      background:#2a2a3e; border-radius:12px;
      padding:14px 16px; margin-bottom:12px;
      border-left:4px solid #f59e0b;
    }
    .order-card-item .oc-head {
      display:flex; justify-content:space-between;
      align-items:center; margin-bottom:8px;
    }
    .order-card-item .oc-table  { font-weight:700; font-size:1rem; }
    .order-card-item .oc-time   { font-size:.75rem; opacity:.6; }
    .order-card-item .oc-items  { font-size:.85rem; opacity:.85; margin-bottom:10px; line-height:1.5; }
    .order-card-item .oc-total  { font-size:.85rem; font-weight:700; color:#f5a623; margin-bottom:10px; }
    .order-card-item .oc-actions { display:flex; gap:8px; }
    .oc-btn-accept {
      flex:1; background:linear-gradient(135deg,#10b981,#34d399);
      color:#fff; border:none; border-radius:8px;
      padding:9px; font-weight:600; font-size:.9rem; cursor:pointer;
    }
    .oc-btn-dismiss {
      background:rgba(255,255,255,.08); color:inherit;
      border:none; border-radius:8px; padding:9px 14px;
      font-size:.85rem; cursor:pointer; opacity:.7;
    }
    .oc-btn-accept:hover  { opacity:.9; }
    .oc-btn-dismiss:hover { opacity:1; }
    .oc-btn-accept:disabled,.oc-btn-dismiss:disabled { opacity:.4; pointer-events:none; }
    .drawer-header {
      padding:16px 20px; border-bottom:1px solid rgba(255,255,255,.08);
      display:flex; justify-content:space-between; align-items:center; flex-shrink:0;
    }
    .drawer-title { font-size:1.1rem; font-weight:700; }
    .drawer-close-btn {
      background:none; border:none; color:inherit;
      font-size:1.3rem; cursor:pointer; opacity:.6; padding:4px 8px;
    }
    .drawer-close-btn:hover { opacity:1; }
    .drawer-body { overflow-y:auto; padding:16px; flex:1; }
    .drawer-empty { text-align:center; opacity:.5; padding:40px 0; font-size:.95rem; }
  `;
  document.head.appendChild(s);
})();

// ── Badge ─────────────────────────────────────────────────────────────────────
function setBadge(count) {
  const badge    = getEl('orders-badge');
  const btnOrders = getEl('btn-orders');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = 'flex';
    if (btnOrders) {
      btnOrders.classList.add('btn-pulse');
      setTimeout(() => btnOrders.classList.remove('btn-pulse'), 1600);
    }
  } else {
    badge.style.display = 'none';
  }
}

// ── Drawer open / close ───────────────────────────────────────────────────────
function openDrawer() {
  getEl('ordersDrawer')?.classList.add('open');
  getEl('ordersOverlay')?.classList.add('open');
}
function closeDrawer() {
  getEl('ordersDrawer')?.classList.remove('open');
  getEl('ordersOverlay')?.classList.remove('open');
}

// Wire drawer controls — safe if elements are missing
(function wireDrawer() {
  const btnOrders  = getEl('btn-orders');
  const overlay    = getEl('ordersOverlay');
  const closeBtn   = document.querySelector('.drawer-close-btn');

  btnOrders?.addEventListener('click', openDrawer);
  overlay?.addEventListener('click', closeDrawer);
  closeBtn?.addEventListener('click', closeDrawer);

  // Warn clearly if required IDs are absent (easier debugging)
  if (!getEl('btn-orders'))        console.warn('[incoming-orders] #btn-orders not found — badge will not show.');
  if (!getEl('ordersDrawer'))      console.warn('[incoming-orders] #ordersDrawer not found — drawer will not open.');
  if (!getEl('ordersDrawerList'))  console.warn('[incoming-orders] #ordersDrawerList not found — order cards will not render.');
})();

// ── Toast notification ────────────────────────────────────────────────────────
function showToast(msg) {
  if (!document.getElementById('toast-kf')) {
    const ks = document.createElement('style');
    ks.id = 'toast-kf';
    ks.textContent = `
      @keyframes toastIn  { to { opacity:1; transform:translateX(-50%) translateY(0); } }
      @keyframes toastOut { to { opacity:0; transform:translateX(-50%) translateY(20px); } }
    `;
    document.head.appendChild(ks);
  }
  const t = document.createElement('div');
  t.style.cssText = `
    position:fixed; bottom:90px; left:50%; transform:translateX(-50%) translateY(20px);
    background:#1f2937; color:#f9fafb; border:1px solid #374151;
    border-radius:12px; padding:12px 20px; font-size:.9rem; font-weight:500;
    z-index:6000; box-shadow:0 8px 24px rgba(0,0,0,.5); opacity:0;
    animation:toastIn .35s ease forwards;
    max-width:calc(100vw - 40px); text-align:center; cursor:pointer;
  `;
  // textContent: safe — no HTML
  t.textContent = msg;
  t.addEventListener('click', openDrawer);
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toastOut .35s ease forwards';
    setTimeout(() => t.remove(), 350);
  }, 6000);
}

// ── Ordinal helper ────────────────────────────────────────────────────────────
async function getCustomerOrderCount(phone) {
  if (!phone) return 1;
  try {
    const q    = query(collection(db, 'pending_table_orders'), where('customer.phone', '==', phone));
    const snap = await getDocs(q);
    return Math.max(1, snap.size);
  } catch (_) { return 1; }
}

function toOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── Build order card (DOM nodes — no innerHTML with user data) ────────────────
async function buildCard({ id, data }) {
  const canonTable = normaliseName(data.tableId || 'Unknown');
  const items      = data.items   || [];
  const customer   = data.customer || {};
  const phone      = customer.phone || '';
  const total      = data.totalPrice || 0;
  const count      = await getCustomerOrderCount(phone);
  const ordinal    = toOrdinal(count);

  const ts = data.createdAt?.seconds
    ? new Date(data.createdAt.seconds * 1000)
    : new Date();
  const timeStr = ts.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  // Build card using DOM APIs for all user-derived content (no innerHTML for data)
  const card = document.createElement('div');
  card.className = 'order-card-item';
  card.dataset.orderId = id;

  // Head row
  const head = document.createElement('div');
  head.className = 'oc-head';
  const tableEl = document.createElement('span');
  tableEl.className = 'oc-table';
  tableEl.textContent = `🪑 ${canonTable}`;
  const timeEl = document.createElement('span');
  timeEl.className = 'oc-time';
  timeEl.textContent = timeStr;
  head.appendChild(tableEl);
  head.appendChild(timeEl);
  card.appendChild(head);

  // Customer info
  if (phone) {
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:.8rem;opacity:.6;margin-bottom:6px;';
    const customerName = customer.name || 'Guest';
    meta.textContent = `👤 ${customerName} · 📱 ${phone} · ${ordinal} order`;
    card.appendChild(meta);
  }

  // Items
  const itemsEl = document.createElement('div');
  itemsEl.className = 'oc-items';
  itemsEl.textContent = items.map((i) => `${i.name} ×${i.quantity || 1}`).join(', ') || '—';
  card.appendChild(itemsEl);

  // Total
  const totalEl = document.createElement('div');
  totalEl.className = 'oc-total';
  totalEl.textContent = `Total: ₹${total}`;
  card.appendChild(totalEl);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'oc-actions';

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'oc-btn-accept';
  acceptBtn.textContent = '✓ Accept';

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'oc-btn-dismiss';
  dismissBtn.textContent = 'Dismiss';

  actions.appendChild(acceptBtn);
  actions.appendChild(dismissBtn);
  card.appendChild(actions);

  // ── Accept ──────────────────────────────────────────────────────────────
  acceptBtn.addEventListener('click', async () => {
    acceptBtn.disabled = true;
    dismissBtn.disabled = true;
    acceptBtn.textContent = 'Accepting…';

    // Merge into POS localStorage cart (uses canonical table name)
    const cartKey = `cart_${canonTable}_C1`;
    let existing = [];
    try { existing = JSON.parse(localStorage.getItem(cartKey) || '[]'); } catch (_) {}

    items.forEach((newItem) => {
      const qty        = newItem.quantity || 1;
      const posMenuItems = window._posMenuItems || [];
      const posItem    = posMenuItems.find(
        (m) => m.name?.trim().toLowerCase() === (newItem.name || '').trim().toLowerCase()
      );
      const idx = existing.findIndex((e) =>
        posItem
          ? e.id === posItem.id
          : e.name?.trim().toLowerCase() === (newItem.name || '').trim().toLowerCase()
      );
      if (idx >= 0) {
        existing[idx].qty = (existing[idx].qty || 1) + qty;
      } else {
        existing.push(posItem
          ? { ...posItem, qty }
          : { id: newItem.itemId || `qr_${Date.now()}`, name: newItem.name, price: newItem.price, qty }
        );
      }
    });

    localStorage.setItem(cartKey, JSON.stringify(existing));

    // Mark accepted in Firestore
    try {
      await updateDoc(doc(db, 'pending_table_orders', id), {
        status: 'accepted',
        acceptedAt: serverTimestamp(),
      });
    } catch (_) {}

    closeDrawer();
    window._posOpenTable?.(canonTable);
    window._posLoadGrid?.('table');
  });

  // ── Dismiss ─────────────────────────────────────────────────────────────
  dismissBtn.addEventListener('click', async () => {
    dismissBtn.disabled = true;
    acceptBtn.disabled  = true;
    dismissBtn.textContent = 'Dismissing…';
    try {
      // "dismissed" → customer panel removes order silently (never saved to history)
      await updateDoc(doc(db, 'pending_table_orders', id), {
        status: 'dismissed',
        dismissedAt: serverTimestamp(),
      });
    } catch (_) {}
    card.remove();
    const drawerList = getEl('ordersDrawerList');
    const remaining  = drawerList ? drawerList.querySelectorAll('.order-card-item').length : 0;
    setBadge(remaining);
    if (remaining === 0 && drawerList) {
      const empty = document.createElement('div');
      empty.className = 'drawer-empty';
      empty.textContent = 'No pending orders';
      drawerList.appendChild(empty);
    }
  });

  return card;
}

// ── Render drawer ─────────────────────────────────────────────────────────────
async function renderDrawer(orders) {
  const drawerList = getEl('ordersDrawerList');
  if (!drawerList) return;

  if (orders.length === 0) {
    drawerList.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'drawer-empty';
    empty.textContent = 'No pending orders';
    drawerList.appendChild(empty);
    return;
  }

  const cards = await Promise.all(orders.map(buildCard));
  drawerList.innerHTML = '';
  cards.forEach((c) => drawerList.appendChild(c));
}

// ── Track order IDs already notified (prevent duplicate toasts) ──────────────
const _notified = new Set();

// ── Firestore real-time listener ──────────────────────────────────────────────
let _unsubscribe = null;

function startListener() {
  if (_unsubscribe) _unsubscribe();

  const q = query(
    collection(db, 'pending_table_orders'),
    orderBy('createdAt', 'desc')
  );

  _unsubscribe = onSnapshot(q, async (snap) => {
    const pending = [];

    snap.docs.forEach((d) => {
      const data = d.data();
      if (data.status !== 'pending') return;

      if (!_notified.has(d.id)) {
        _notified.add(d.id);
        const table = normaliseName(data.tableId || 'Unknown');
        showToast(`🔔 New order from ${table}`);
      }
      pending.push({ id: d.id, data });
    });

    setBadge(pending.length);
    await renderDrawer(pending);
  }, (err) => {
    console.error('[incoming-orders] Firestore error:', err);
  });
}

startListener();

// ── Order status hooks ────────────────────────────────────────────────────────
// Call these from your KOT / Settle handlers in the billing panel.

/**
 * Call when KOT is printed.
 * Sets status = "kot" and kotAt = now.
 * Customer panel shows "Preparing • X min" live timer.
 *
 * Matches orders by normalised table name so "T4", "4", and "Table 4"
 * all refer to the same table.
 *
 * @param {string} tableName  e.g. "Table 4" or "T4" or "4"
 */
window._orderStatusKOT = async function(tableName) {
  if (!tableName) return;
  const canon = normaliseName(tableName);
  try {
    // Query all orders for any variant of this table name
    const snap = await getDocs(query(
      collection(db, 'pending_table_orders'),
      where('status', 'in', ['pending', 'accepted'])
    ));
    const matches = snap.docs.filter((d) => sameTable(d.data().tableId, canon));
    await Promise.all(matches.map((d) =>
      updateDoc(doc(db, 'pending_table_orders', d.id), {
        status: 'kot',
        kotAt:  serverTimestamp(),
      })
    ));
    console.log(`[incoming-orders] KOT set for "${canon}" (${matches.length} orders)`);
  } catch (err) {
    console.error('[incoming-orders] _orderStatusKOT error:', err);
  }
};

/**
 * Call on "Save & Exit" or "Bill & Settle".
 * Sets status = "completed" and completedAt = now.
 * Customer panel moves order to Order History.
 *
 * @param {string} tableName  e.g. "Table 4" or "T4" or "4"
 * @param {string} reason     "save_exit" | "bill_settle"
 */
window._orderStatusComplete = async function(tableName, reason = 'save_exit') {
  if (!tableName) return;
  const canon = normaliseName(tableName);
  try {
    const snap = await getDocs(query(
      collection(db, 'pending_table_orders'),
      where('status', 'in', ['pending', 'accepted', 'kot'])
    ));
    const matches = snap.docs.filter((d) => sameTable(d.data().tableId, canon));
    await Promise.all(matches.map((d) =>
      updateDoc(doc(db, 'pending_table_orders', d.id), {
        status:       'completed',
        completedAt:  serverTimestamp(),
        settleReason: reason,
      })
    ));
    console.log(`[incoming-orders] Completed "${canon}" (${matches.length} orders, reason: ${reason})`);
  } catch (err) {
    console.error('[incoming-orders] _orderStatusComplete error:', err);
  }
};
