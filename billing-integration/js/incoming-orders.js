/**
 * incoming-orders.js  — Drop into your billing panel's js/ folder
 * ─────────────────────────────────────────────────────────────────
 * Listens for new customer QR orders in real-time.
 * • Shows a pulsing 🔔 Orders button with red badge
 * • Drawer shows: customer name, phone, order count, items, total
 * • Accept  → adds items to localStorage cart → navigates to table
 * • Reject  → marks order rejected in Firestore
 *
 * NEW (order-status integration):
 * • KOT hook     — call window._orderStatusKOT(tableName) when KOT is printed
 * • Complete hook — call window._orderStatusComplete(tableName, type) on Save/Settle
 *
 * ── Setup ──────────────────────────────────────────────────────
 * See billing-integration/HOW-TO-ADD.md for full setup instructions.
 * ────────────────────────────────────────────────────────────────
 */

import { db } from './firebase-config.js';
import {
  collection, query, where, onSnapshot,
  doc, updateDoc, getDocs, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';

const ORDERS_COL = 'pending_table_orders';

// ── Module state ──────────────────────────────────────────────
let pendingOrders  = [];
const SOUND_ENABLED = false;
let alertInterval  = null;

/**
 * Maps normalised table name → array of Firestore docIds.
 * Populated on Accept; cleared on Complete.
 * e.g. { "Table 4": ["abc123", "def456"] }
 */
const tableDocMap = {};

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  injectStyles();
  injectHTML();
  wireEvents();
  startOrdersListener();
  exposeOrderStatusHooks();
});

// ─────────────────────────────────────────────────────────────
// FIRESTORE LISTENER — pending orders
// ─────────────────────────────────────────────────────────────
function startOrdersListener() {
  const q = query(collection(db, ORDERS_COL), where('status', '==', 'pending'));

  onSnapshot(q, (snap) => {
    const incoming = snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
    const hadNone  = pendingOrders.length === 0;
    pendingOrders  = incoming;

    updateBadge();

    if (pendingOrders.length > 0) {
      startAlert();
      if (hadNone) flashBtn();
    } else {
      stopAlert();
    }

    const drawer = document.getElementById('incomingOrdersDrawer');
    if (drawer?.classList.contains('open')) renderOrdersList();
  });
}

// ─────────────────────────────────────────────────────────────
// ORDER-STATUS HOOKS (called by billing panel)
// ─────────────────────────────────────────────────────────────

function exposeOrderStatusHooks() {

  /**
   * Call this when KOT is printed for a table.
   * Updates all accepted orders for that table to status "kot".
   *
   * @param {string} tableName  e.g. "Table 4"
   */
  window._orderStatusKOT = async function (tableName) {
    const norm   = normalizeTableName(tableName);
    const docIds = tableDocMap[norm] || [];
    if (!docIds.length) return;

    const updates = docIds.map((id) =>
      updateDoc(doc(db, ORDERS_COL, id), {
        status: 'kot',
        kotAt:  serverTimestamp(),
      }).catch((e) => console.warn('[incoming-orders] KOT update failed for', id, e))
    );
    await Promise.all(updates);
    console.log('[incoming-orders] KOT marked for', norm, docIds);
  };

  /**
   * Call this when Save & Exit OR Bill & Settle is pressed for a table.
   * Updates all accepted orders for that table to status "completed".
   *
   * @param {string} tableName       e.g. "Table 4"
   * @param {string} [completionType]  "save_exit" | "bill_settle"
   */
  window._orderStatusComplete = async function (tableName, completionType = 'save_exit') {
    const norm   = normalizeTableName(tableName);
    const docIds = tableDocMap[norm] || [];
    if (!docIds.length) return;

    const updates = docIds.map((id) =>
      updateDoc(doc(db, ORDERS_COL, id), {
        status:         'completed',
        completedAt:    serverTimestamp(),
        completionType,
      }).catch((e) => console.warn('[incoming-orders] complete update failed for', id, e))
    );
    await Promise.all(updates);

    // Clear tracking for this table
    delete tableDocMap[norm];
    console.log('[incoming-orders] Completed marked for', norm, completionType);
  };
}

// ─────────────────────────────────────────────────────────────
// BADGE
// ─────────────────────────────────────────────────────────────
function updateBadge() {
  const badge = document.getElementById('incOrdersBadge');
  const btn   = document.getElementById('incOrdersBtn');
  const count = pendingOrders.length;
  if (badge) { badge.textContent = count; badge.style.display = count > 0 ? 'flex' : 'none'; }
  if (btn)   btn.classList.toggle('has-orders', count > 0);
}

function flashBtn() {
  const btn = document.getElementById('incOrdersBtn');
  if (!btn) return;
  btn.style.transform = 'scale(1.15)';
  setTimeout(() => (btn.style.transform = ''), 300);
}

// ─────────────────────────────────────────────────────────────
// SOUND  — disabled (set SOUND_ENABLED = true to re-enable)
// ─────────────────────────────────────────────────────────────
function buildAlertSound() { /* disabled */ }
function unlockAudio()     { /* disabled */ }
function playBeep()        { /* disabled */ }
function startAlert()      { /* disabled */ }
function stopAlert()       { clearInterval(alertInterval); alertInterval = null; }

// ─────────────────────────────────────────────────────────────
// DRAWER
// ─────────────────────────────────────────────────────────────
async function openDrawer() {
  unlockAudio();
  stopAlert();
  await renderOrdersList();
  document.getElementById('incomingOrdersDrawer')?.classList.add('open');
  document.getElementById('incOrdersOverlay')?.classList.add('open');
}

function closeDrawer() {
  document.getElementById('incomingOrdersDrawer')?.classList.remove('open');
  document.getElementById('incOrdersOverlay')?.classList.remove('open');
}

// ─────────────────────────────────────────────────────────────
// RENDER ORDER LIST
// ─────────────────────────────────────────────────────────────
async function renderOrdersList() {
  const list = document.getElementById('incOrdersList');
  if (!list) return;

  if (pendingOrders.length === 0) {
    list.innerHTML = `
      <div style="text-align:center;padding:50px 20px;color:#6b7280;">
        <div style="font-size:40px;margin-bottom:12px;">✅</div>
        <p style="font-size:15px;">No pending orders</p>
      </div>`;
    return;
  }

  const enriched = await Promise.all(
    pendingOrders.map(async (order) => {
      const count = await getCustomerOrderCount(order.customer?.phone);
      return { order, count };
    })
  );

  list.innerHTML = enriched.map(({ order, count }) => buildOrderCard(order, count)).join('');
}

function buildOrderCard(order, orderCount) {
  const table   = normalizeTableName(order.tableId);
  const ordinal = toOrdinal(orderCount);
  const fmt     = (n) => `₹${Number(n || 0).toFixed(2)}`;
  const ts      = order.createdAt?.seconds
    ? new Date(order.createdAt.seconds * 1000)
    : order.placedAt ? new Date(order.placedAt) : new Date();
  const timeStr = ts.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  return `
    <div class="inc-order-card">
      <div class="inc-order-top">
        <div class="inc-order-left">
          <div class="inc-table-tag">🪑 ${esc(table)}</div>
          <div class="inc-customer">
            <span>👤 <strong>${esc(order.customer?.name || 'Guest')}</strong></span>
            <span>📱 ${esc(order.customer?.phone || '—')}</span>
          </div>
          <div class="inc-ordinal-badge">${ordinal} order from this customer</div>
        </div>
        <div class="inc-order-right">
          <div class="inc-total">${fmt(order.totalPrice)}</div>
          <div class="inc-time">${timeStr}</div>
        </div>
      </div>

      <ul class="inc-items">
        ${(order.items || []).map(it => `
          <li>
            <span>${esc(it.name)}</span>
            <span>×${it.quantity} &nbsp; ${fmt(it.subtotal)}</span>
          </li>`).join('')}
      </ul>

      <div class="inc-actions">
        <button class="inc-btn inc-reject"
                onclick="window._incReject('${order._docId}')">
          ✕ &nbsp;Reject
        </button>
        <button class="inc-btn inc-accept"
                onclick="window._incAccept('${order._docId}', '${esc(table)}')">
          ✓ &nbsp;Accept → ${esc(table)}
        </button>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// ACCEPT
// ─────────────────────────────────────────────────────────────
window._incAccept = async function (docId, tableName) {
  const order = pendingOrders.find(o => o._docId === docId);
  if (!order) return;

  const btn = document.querySelector(`[onclick*="_incAccept('${docId}'"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }

  // 1. Merge items into localStorage cart
  const cartKey = `cart_${tableName}_C1`;
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem(cartKey)) || []; } catch (e) {}

  for (const ni of (order.items || [])) {
    const match = cart.find(e => e.name === ni.name && e.price === ni.price);
    if (match) {
      match.qty = (match.qty || 1) + (ni.quantity || 1);
    } else {
      cart.push({
        id:    ni.itemId || `qr_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name:  ni.name,
        price: ni.price,
        qty:   ni.quantity || 1,
      });
    }
  }
  localStorage.setItem(cartKey, JSON.stringify(cart));

  // 2. Track docId → table for KOT/complete hooks
  const norm = normalizeTableName(tableName);
  tableDocMap[norm] = tableDocMap[norm] || [];
  if (!tableDocMap[norm].includes(docId)) tableDocMap[norm].push(docId);

  // 3. Mark accepted in Firestore
  await updateDoc(doc(db, ORDERS_COL, docId), {
    status:     'accepted',
    acceptedAt: serverTimestamp(),
  });

  // 4. Close drawer → navigate
  closeDrawer();
  navigateToTable(tableName);
};

// ─────────────────────────────────────────────────────────────
// REJECT
// ─────────────────────────────────────────────────────────────
window._incReject = async function (docId) {
  const card = document.querySelector(`.inc-order-card [onclick*="_incReject('${docId}'"]`)
    ?.closest('.inc-order-card');
  if (card) { card.style.opacity = '0.4'; card.style.pointerEvents = 'none'; }

  await updateDoc(doc(db, ORDERS_COL, docId), {
    status:     'rejected',
    rejectedAt: serverTimestamp(),
  });
};

// ─────────────────────────────────────────────────────────────
// NAVIGATE
// ─────────────────────────────────────────────────────────────
function navigateToTable(tableName) {
  try {
    if (typeof window._posLoadGrid === 'function') window._posLoadGrid('table');
    setTimeout(() => {
      if (typeof window._posOpenTable === 'function') {
        window._posOpenTable(tableName, 'C1');
        window.dispatchEvent(new Event('load-table-cart'));
      }
    }, 120);
  } catch (e) { console.warn('[incoming-orders] navigate failed:', e); }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
async function getCustomerOrderCount(phone) {
  if (!phone) return 1;
  try {
    const q    = query(collection(db, ORDERS_COL), where('customer.phone', '==', phone));
    const snap = await getDocs(q);
    return Math.max(1, snap.size);
  } catch (e) { return 1; }
}

function normalizeTableName(id = '') {
  const s = String(id).trim();
  if (/^[Tt]\d+$/.test(s))  return `Table ${s.replace(/\D/g, '')}`;
  if (/^\d+$/.test(s))      return `Table ${s}`;
  return s;
}

function toOrdinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function esc(s = '') {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────────────────────
// WIRE EVENTS
// ─────────────────────────────────────────────────────────────
function wireEvents() {
  document.addEventListener('click', unlockAudio, { once: true });

  window._incOpenDrawer  = openDrawer;
  window._incCloseDrawer = closeDrawer;

  const btn     = document.getElementById('incOrdersBtn');
  const overlay = document.getElementById('incOrdersOverlay');
  const close   = document.getElementById('incOrdersClose');

  if (btn)     btn.addEventListener('click', openDrawer);
  if (overlay) overlay.addEventListener('click', closeDrawer);
  if (close)   close.addEventListener('click', closeDrawer);

  setTimeout(() => {
    const b = document.getElementById('incOrdersBtn');
    if (b && !b._incWired) { b._incWired = true; b.addEventListener('click', openDrawer); }
  }, 800);
}

// ─────────────────────────────────────────────────────────────
// INJECT HTML
// ─────────────────────────────────────────────────────────────
function injectHTML() {
  let btn = document.getElementById('incOrdersBtn');

  if (!btn) {
    const allBtns = Array.from(document.querySelectorAll('button, .menu-big-btn'));
    btn = allBtns.find(b =>
      b.textContent.toLowerCase().includes('incoming') || b.textContent.includes('🔔')
    );
  }

  if (btn) {
    btn.id = 'incOrdersBtn';
    if (!btn.querySelector('.inc-badge')) {
      const badge = document.createElement('span');
      badge.id = 'incOrdersBadge'; badge.className = 'inc-badge'; badge.style.display = 'none';
      badge.textContent = '0'; btn.prepend(badge);
    }
  } else {
    btn           = document.createElement('button');
    btn.id        = 'incOrdersBtn';
    btn.className = 'menu-big-btn';
    btn.innerHTML = `
      <span id="incOrdersBadge" class="inc-badge" style="display:none;">0</span>
      <span class="icon">🔔</span>
      <span class="title">Incoming Orders</span>`;

    const homeGrid = document.querySelector('.home-grid');
    if (homeGrid) {
      homeGrid.appendChild(btn);
    } else {
      const historyBtn = document.getElementById('historyBtn');
      if (historyBtn) historyBtn.parentNode.insertBefore(btn, historyBtn);
      else document.body.prepend(btn);
    }
  }

  if (!document.getElementById('incOrdersOverlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'incOrdersOverlay'; overlay.className = 'drawer-overlay';
    document.body.appendChild(overlay);
  }

  if (!document.getElementById('incomingOrdersDrawer')) {
    const drawer = document.createElement('div');
    drawer.id = 'incomingOrdersDrawer'; drawer.className = 'inc-drawer';
    drawer.innerHTML = `
      <div class="drawer-header">
        <h3 style="margin:0;color:#f9fafb;">🔔 Incoming Orders</h3>
        <button id="incOrdersClose" class="close-btn">❌</button>
      </div>
      <div id="incOrdersList" class="drawer-content" style="padding:12px;"></div>`;
    document.body.appendChild(drawer);
  }
}

// ─────────────────────────────────────────────────────────────
// INJECT STYLES
// ─────────────────────────────────────────────────────────────
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    #incOrdersBtn {
      position: relative;
      background: linear-gradient(135deg, #b91c1c, #ef4444) !important;
    }
    #incOrdersBtn.has-orders {
      animation: incPulse 1.4s ease-in-out infinite;
    }
    @keyframes incPulse {
      0%,100% { box-shadow: 0 4px 15px rgba(239,68,68,0.3); }
      50%      { box-shadow: 0 0 0 12px rgba(239,68,68,0.12), 0 4px 15px rgba(239,68,68,0.4); }
    }
    .inc-badge {
      position: absolute; top: 10px; right: 10px;
      background: white; color: #dc2626; border-radius: 50%;
      min-width: 24px; height: 24px; display: flex;
      align-items: center; justify-content: center;
      font-size: 13px; font-weight: 900;
      box-shadow: 0 2px 6px rgba(0,0,0,0.35); padding: 0 4px;
    }
    .inc-drawer {
      position: fixed; top: 0; right: -440px;
      width: 430px; max-width: 100vw; height: 100vh;
      background: #1f2937; z-index: 10000;
      display: flex; flex-direction: column;
      transition: right 0.3s cubic-bezier(0.32,0.72,0,1);
      box-shadow: -6px 0 30px rgba(0,0,0,0.5);
    }
    .inc-drawer.open { right: 0; }
    .inc-order-card {
      background: #374151; border: 1px solid #4b5563;
      border-radius: 12px; padding: 14px; margin-bottom: 12px;
    }
    .inc-order-top { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:12px; }
    .inc-order-left { flex:1; }
    .inc-order-right { text-align:right; flex-shrink:0; }
    .inc-table-tag { font-size:17px; font-weight:800; color:#f9fafb; margin-bottom:5px; }
    .inc-customer { display:flex; flex-direction:column; gap:2px; font-size:13px; color:#9ca3af; margin-bottom:6px; }
    .inc-ordinal-badge {
      display:inline-block; background:rgba(245,166,35,0.15); color:#f5a623;
      border:1px solid rgba(245,166,35,0.3); border-radius:20px;
      padding:2px 10px; font-size:11px; font-weight:700;
    }
    .inc-total { font-size:18px; font-weight:800; color:#f5a623; }
    .inc-time  { font-size:12px; color:#6b7280; margin-top:2px; }
    .inc-items { list-style:none; padding:8px 0; margin:0 0 12px; border-top:1px solid #4b5563; border-bottom:1px solid #4b5563; }
    .inc-items li { display:flex; justify-content:space-between; font-size:13px; color:#d1d5db; padding:3px 0; }
    .inc-actions { display:flex; gap:8px; }
    .inc-btn { flex:1; padding:11px 8px; border:none; border-radius:8px; font-weight:700; font-size:13px; cursor:pointer; transition:opacity .15s,transform .1s; }
    .inc-btn:active { transform:scale(0.97); opacity:.85; }
    .inc-btn:disabled { opacity:.4; cursor:not-allowed; }
    .inc-reject { background:transparent; color:#ef4444; border:1.5px solid #ef4444; }
    .inc-accept { background:#059669; color:white; }
  `;
  document.head.appendChild(style);
}
