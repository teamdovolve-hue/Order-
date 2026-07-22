/**
 * incoming-orders.js  — Drop into your billing panel's js/ folder
 * ─────────────────────────────────────────────────────────────────
 * Listens for new customer QR orders in real-time.
 * • Shows a pulsing 🔔 Orders button with red badge
 * • Plays a looping alert sound until the button is touched
 * • Drawer shows: customer name, phone, order number (1st/5th/…),
 *   table, item list, total — with Accept / Reject buttons
 * • Accept  → adds items to localStorage cart → navigates to that table
 * • Reject  → marks order rejected in Firestore
 *
 * ── Setup (3 steps) ────────────────────────────────────────────
 * 1. Copy this file to:  billing-panel/js/incoming-orders.js
 * 2. In index.html, just before </body>:
 *      <script type="module" src="js/incoming-orders.js"></script>
 * 3. In js/tables.js, inside DOMContentLoaded, after openPOS is
 *    defined (around line 126), add these two lines:
 *      window._posOpenTable = openPOS;
 *      window._posLoadGrid  = loadGrid;
 * ────────────────────────────────────────────────────────────────
 */

import { db } from './firebase-config.js';
import {
  collection, query, where, onSnapshot,
  doc, updateDoc, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';

const ORDERS_COL = 'pending_table_orders';

// ── Module state ──────────────────────────────────────────────
let pendingOrders  = [];
let alertInterval  = null;
let audioCtx       = null;
let alertBuf       = null;
let audioUnlocked  = false;

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  injectStyles();
  injectHTML();
  wireEvents();
  buildAlertSound();
  startOrdersListener();
});

// ─────────────────────────────────────────────────────────────
// FIRESTORE LISTENER
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
      if (hadNone) flashBtn(); // extra visual pop on first arrival
    } else {
      stopAlert();
    }

    // If drawer is open, refresh it live
    const drawer = document.getElementById('incomingOrdersDrawer');
    if (drawer?.classList.contains('open')) renderOrdersList();
  });
}

// ─────────────────────────────────────────────────────────────
// BADGE
// ─────────────────────────────────────────────────────────────
function updateBadge() {
  const badge = document.getElementById('incOrdersBadge');
  const btn   = document.getElementById('incOrdersBtn');
  const count = pendingOrders.length;

  if (badge) {
    badge.textContent  = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
  if (btn) btn.classList.toggle('has-orders', count > 0);
}

function flashBtn() {
  const btn = document.getElementById('incOrdersBtn');
  if (!btn) return;
  btn.style.transform = 'scale(1.15)';
  setTimeout(() => (btn.style.transform = ''), 300);
}

// ─────────────────────────────────────────────────────────────
// SOUND  (Web Audio — no extra file needed)
// ─────────────────────────────────────────────────────────────
function buildAlertSound() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // 2-tone descending alert  880 Hz → 660 Hz, 0.6 s
    const sr  = audioCtx.sampleRate;
    const dur = 0.6;
    const buf = audioCtx.createBuffer(1, sr * dur, sr);
    const ch  = buf.getChannelData(0);

    for (let i = 0; i < ch.length; i++) {
      const t   = i / sr;
      const env = Math.sin(Math.PI * (t / dur)); // smooth fade in/out
      const f   = 880 - (220 * (t / dur));        // sweep 880→660
      ch[i]     = env * 0.45 * Math.sin(2 * Math.PI * f * t);
    }
    alertBuf = buf;
  } catch (e) {}
}

function unlockAudio() {
  if (audioUnlocked || !audioCtx) return;
  audioCtx.resume().catch(() => {});
  audioUnlocked = true;
}

function playBeep() {
  if (!audioCtx || !alertBuf) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const src  = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    src.buffer      = alertBuf;
    gain.gain.value = 0.65;
    src.connect(gain);
    gain.connect(audioCtx.destination);
    src.start(0);
  } catch (e) {}
}

function startAlert() {
  if (alertInterval) return;          // already running
  playBeep();
  alertInterval = setInterval(playBeep, 2200);
}

function stopAlert() {
  clearInterval(alertInterval);
  alertInterval = null;
}

// ─────────────────────────────────────────────────────────────
// DRAWER  open / close
// ─────────────────────────────────────────────────────────────
async function openDrawer() {
  unlockAudio();
  stopAlert();                        // stop sound on touch ✅
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

  // Fetch order counts for each customer (parallel)
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
          <div class="inc-ordinal-badge">${ordinal} Order from this customer</div>
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
// ACCEPT  (global so onclick works in injected HTML)
// ─────────────────────────────────────────────────────────────
window._incAccept = async function (docId, tableName) {
  const order = pendingOrders.find(o => o._docId === docId);
  if (!order) return;

  const btn = document.querySelector(`[onclick*="_incAccept('${docId}'"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }

  // 1.  Merge items into localStorage cart  (Table X → C1)
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

  // 2.  Mark accepted in Firestore
  await updateDoc(doc(db, ORDERS_COL, docId), {
    status:     'accepted',
    acceptedAt: new Date().toISOString(),
  });

  // 3.  Close drawer → navigate to the table
  closeDrawer();
  navigateToTable(tableName);
};

// ─────────────────────────────────────────────────────────────
// REJECT
// ─────────────────────────────────────────────────────────────
window._incReject = async function (docId) {
  const card = document.querySelector(`.inc-order-card [onclick*="_incReject('${docId}'"]`)
    ?.closest('.inc-order-card');
  if (card) {
    card.style.opacity   = '0.4';
    card.style.pointerEvents = 'none';
  }

  await updateDoc(doc(db, ORDERS_COL, docId), {
    status:     'rejected',
    rejectedAt: new Date().toISOString(),
  });
  // onSnapshot will remove it from pendingOrders and re-render automatically
};

// ─────────────────────────────────────────────────────────────
// NAVIGATE  (uses the two lines you added to tables.js)
// ─────────────────────────────────────────────────────────────
function navigateToTable(tableName) {
  try {
    // Make sure we're showing the table grid first
    if (typeof window._posLoadGrid === 'function') {
      window._posLoadGrid('table');
    }
    // Short delay so grid screen is visible, then jump into POS
    setTimeout(() => {
      if (typeof window._posOpenTable === 'function') {
        window._posOpenTable(tableName, 'C1');
        // Fire load-table-cart so cart.js picks up the newly written localStorage
        window.dispatchEvent(new Event('load-table-cart'));
      }
    }, 120);
  } catch (e) {
    console.warn('[incoming-orders] navigate failed:', e);
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/** Count how many orders (any status) this phone number has made */
async function getCustomerOrderCount(phone) {
  if (!phone) return 1;
  try {
    const q    = query(collection(db, ORDERS_COL), where('customer.phone', '==', phone));
    const snap = await getDocs(q);
    return Math.max(1, snap.size); // includes the current pending one
  } catch (e) { return 1; }
}

/**
 * Map QR table IDs → billing panel table names
 * "T4" | "t4" | "4" → "Table 4"
 * "Table 4"          → "Table 4"  (passthrough)
 */
function normalizeTableName(id = '') {
  const s = String(id).trim();
  if (/^[Tt]\d+$/.test(s))     return `Table ${s.replace(/\D/g, '')}`;
  if (/^\d+$/.test(s))         return `Table ${s}`;
  return s; // already "Table 4", "Parcel A", etc.
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
  // Unlock audio on first user interaction (browser requirement)
  document.addEventListener('click', unlockAudio, { once: true });

  document.getElementById('incOrdersBtn')
    ?.addEventListener('click', openDrawer);
  document.getElementById('incOrdersOverlay')
    ?.addEventListener('click', closeDrawer);
  document.getElementById('incOrdersClose')
    ?.addEventListener('click', closeDrawer);
}

// ─────────────────────────────────────────────────────────────
// INJECT HTML
// ─────────────────────────────────────────────────────────────
function injectHTML() {
  // ── Big grid button — sits right after the Expense button ──
  // Matches the .menu-big-btn style of Tables / Parcel / Expense
  const btn = document.createElement('button');
  btn.id        = 'incOrdersBtn';
  btn.className = 'menu-big-btn';
  btn.innerHTML = `
    <span id="incOrdersBadge" class="inc-badge" style="display:none;">0</span>
    <span class="icon">🔔</span>
    <span class="title">Orders</span>`;

  // Insert after the Expense button inside .home-grid
  const homeGrid = document.querySelector('.home-grid');
  if (homeGrid) {
    homeGrid.appendChild(btn);       // last cell, right next to Expense
  } else {
    // Fallback: before historyBtn in header
    const historyBtn = document.getElementById('historyBtn');
    if (historyBtn) historyBtn.parentNode.insertBefore(btn, historyBtn);
    else document.body.prepend(btn);
  }

  // ── Overlay ──
  const overlay = document.createElement('div');
  overlay.id        = 'incOrdersOverlay';
  overlay.className = 'drawer-overlay'; // reuse billing panel's existing class
  document.body.appendChild(overlay);

  // ── Drawer ──
  const drawer = document.createElement('div');
  drawer.id        = 'incomingOrdersDrawer';
  drawer.className = 'inc-drawer';
  drawer.innerHTML = `
    <div class="drawer-header">
      <h3 style="margin:0;color:#f9fafb;">🔔 Incoming Orders</h3>
      <button id="incOrdersClose" class="close-btn">❌</button>
    </div>
    <div id="incOrdersList" class="drawer-content" style="padding:12px;"></div>`;
  document.body.appendChild(drawer);
}

// ─────────────────────────────────────────────────────────────
// INJECT STYLES
// ─────────────────────────────────────────────────────────────
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `

    /* ── Orders big-grid button (matches .menu-big-btn style) ── */
    #incOrdersBtn {
      position: relative;
      background: linear-gradient(135deg, #b91c1c, #ef4444) !important;
    }

    /* Pulsing glow when there are pending orders */
    #incOrdersBtn.has-orders {
      animation: incPulse 1.4s ease-in-out infinite;
    }
    @keyframes incPulse {
      0%,100% { box-shadow: 0 4px 15px rgba(239,68,68,0.3); }
      50%      { box-shadow: 0 0 0 12px rgba(239,68,68,0.12),
                             0 4px 15px rgba(239,68,68,0.4); }
    }

    /* ── Badge (top-right corner of the big button) ──────── */
    .inc-badge {
      position: absolute;
      top: 10px; right: 10px;
      background: white;
      color: #dc2626;
      border-radius: 50%;
      min-width: 24px; height: 24px;
      display: flex;
      align-items: center; justify-content: center;
      font-size: 13px; font-weight: 900;
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
      padding: 0 4px;
    }

    /* ── Drawer ─────────────────────────────────────────── */
    .inc-drawer {
      position: fixed;
      top: 0; right: -440px;
      width: 430px; max-width: 100vw;
      height: 100vh;
      background: #1f2937;
      z-index: 10000;
      display: flex; flex-direction: column;
      transition: right 0.3s cubic-bezier(0.32,0.72,0,1);
      box-shadow: -6px 0 30px rgba(0,0,0,0.5);
    }
    .inc-drawer.open { right: 0; }

    /* ── Order card ─────────────────────────────────────── */
    .inc-order-card {
      background: #374151;
      border: 1px solid #4b5563;
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 12px;
    }
    .inc-order-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 12px;
    }
    .inc-order-left { flex: 1; }
    .inc-order-right { text-align: right; flex-shrink: 0; }

    .inc-table-tag {
      font-size: 17px;
      font-weight: 800;
      color: #f9fafb;
      margin-bottom: 5px;
    }
    .inc-customer {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 13px;
      color: #9ca3af;
      margin-bottom: 6px;
    }
    .inc-ordinal-badge {
      display: inline-block;
      background: rgba(245,166,35,0.15);
      color: #f5a623;
      border: 1px solid rgba(245,166,35,0.3);
      border-radius: 20px;
      padding: 2px 10px;
      font-size: 11px;
      font-weight: 700;
    }
    .inc-total {
      font-size: 18px;
      font-weight: 800;
      color: #f5a623;
    }
    .inc-time {
      font-size: 12px;
      color: #6b7280;
      margin-top: 2px;
    }

    /* ── Items list ─────────────────────────────────────── */
    .inc-items {
      list-style: none;
      padding: 8px 0;
      margin: 0 0 12px;
      border-top: 1px solid #4b5563;
      border-bottom: 1px solid #4b5563;
    }
    .inc-items li {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      color: #d1d5db;
      padding: 3px 0;
    }

    /* ── Action buttons ─────────────────────────────────── */
    .inc-actions { display: flex; gap: 8px; }
    .inc-btn {
      flex: 1;
      padding: 11px 8px;
      border: none;
      border-radius: 8px;
      font-weight: 700;
      font-size: 13px;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.1s;
    }
    .inc-btn:active { transform: scale(0.97); opacity: 0.85; }
    .inc-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .inc-reject {
      background: transparent;
      color: #ef4444;
      border: 1.5px solid #ef4444;
    }
    .inc-accept {
      background: #059669;
      color: white;
    }
  `;
  document.head.appendChild(style);
}
