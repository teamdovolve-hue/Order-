/**
 * offers.js
 * ─────────────────────────────────────────────────────────────
 * AI UPDATE [2026-09-12]: New file — "My Offers" drawer.
 *
 * Shows the logged-in customer their coupons: auto-issued loyalty rewards
 * (10+ orders & ₹1000+ lifetime spend → ₹100 off) and any personalized
 * coupons an operator sent them from the admin Customer Management panel.
 *
 * Reuses the exact visual pattern of history.js's drawer (history-panel /
 * history-backdrop / history-order classes) so no new CSS is required.
 *
 * Firestore: reads coupons/{code} where phone == logged-in customer's phone.
 * Read-only — coupons are only ever written by the Billing Panel
 * (auto loyalty issue, or coupon redemption) or the admin Customer panel
 * (personalized send). This module never writes.
 *
 * Public API:
 *   initOffers() — wires the 🎟️ header button + close/backdrop handlers.
 *
 * AI UPDATE [2026-09-13]: Coupon notification dot + one-time "new offer" toast
 * ─────────────────────────────────────────────────────────────────────────
 * Adds a small red badge on the existing #offersBtn icon (no new button, no
 * layout change) when the logged-in customer has ≥1 unused coupon, plus a
 * one-time toast when a genuinely new coupon is detected. Reuses the exact
 * `coupons` collection / `phone == ` / `used` fields already read by
 * renderOffers() below — no new coupon logic, no writes.
 *
 * - Badge state is kept live via a Firestore onSnapshot listener (same
 *   query shape as renderOffers' getDocs), started/stopped on
 *   `customAuthStateChanged` (dispatched by auth.js), matching the
 *   start/stop-on-login pattern already used by order-status.js.
 * - "Seen" coupon IDs are cached per-phone in localStorage
 *   (`qrmenu_seen_coupons`) purely so the toast fires only once per new
 *   coupon and never on a plain page reload. The first snapshot for a phone
 *   seeds this cache without a toast, so pre-existing coupons don't trigger
 *   a false "new offer" the first time this feature runs for a customer.
 */

import { db } from "./firebase-config.js";
import { collection, query, where, getDocs, onSnapshot }
  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getLoginInfo, requireLogin } from "./auth.js";

const SEEN_COUPONS_KEY = "qrmenu_seen_coupons"; // { [phone]: [couponId, ...] }

const fmt = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let _drawerOpen = false;
let _unsubCoupons = null;
let _availableIds = new Set(); // live, from the badge listener
let _toastTimer = null;

/** Wire up the offers button, close button, and backdrop. */
export function initOffers() {
  document.getElementById("offersBtn")?.addEventListener("click", () => {
    // Coupons are tied to a customer's phone — require login first, same
    // pattern as the "Place Order" flow in app.js.
    requireLogin(openOffers);
  });
  document.getElementById("offersCloseBtn")?.addEventListener("click", closeOffers);
  document.getElementById("offersBackdrop")?.addEventListener("click", closeOffers);

  // AI UPDATE [2026-09-13]: keep the badge listener in sync with login state,
  // same start/stop-on-auth-change pattern order-status.js uses.
  const info = getLoginInfo();
  if (info?.phone) _startCouponWatch(info.phone);
  window.addEventListener("customAuthStateChanged", (e) => {
    const user = e.detail?.user;
    if (user?.phone) _startCouponWatch(user.phone);
    else _stopCouponWatch();
  });
}

async function openOffers() {
  _drawerOpen = true;
  // [AI UPDATE 2026-09-22] Modal-overlap fix: see matching comment in
  // js/history.js's openHistory() — dismiss any open on-screen keyboard so
  // the panel's centered layout/max-height gets the full viewport height.
  document.activeElement?.blur?.();
  document.getElementById("offersPanel")?.classList.remove("hidden");
  document.getElementById("offersBackdrop")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  const info = getLoginInfo();
  if (info?.phone) _maybeNotifyNewOffer(info.phone);

  await renderOffers();
}

function closeOffers() {
  _drawerOpen = false;
  document.getElementById("offersPanel")?.classList.add("hidden");
  document.getElementById("offersBackdrop")?.classList.add("hidden");
  document.body.style.overflow = "";
}

async function renderOffers() {
  const list = document.getElementById("offersList");
  if (!list) return;

  const info = getLoginInfo();
  if (!info?.phone) {
    list.innerHTML = `
      <div class="history-empty">
        <span class="history-empty-icon">🎟️</span>
        <p>Log in to see your offers.</p>
      </div>`;
    return;
  }

  list.innerHTML = `<div class="history-empty"><p>Loading offers…</p></div>`;

  try {
    const snap = await getDocs(
      query(collection(db, "coupons"), where("phone", "==", info.phone))
    );
    const coupons = [];
    snap.forEach((d) => coupons.push({ id: d.id, ...d.data() }));
    coupons.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    if (coupons.length === 0) {
      list.innerHTML = `
        <div class="history-empty">
          <span class="history-empty-icon">🎟️</span>
          <p>No offers yet.<br/>Order more to unlock rewards!</p>
        </div>`;
      return;
    }

    list.innerHTML = coupons.map((cp) => {
      const active = !cp.used;
      return `
      <div class="history-order" style="border-left:3px solid ${active ? "#22c55e" : "#9ca3af"};">
        <div class="history-order-meta">
          <div class="history-order-left">
            <span class="history-order-num" style="font-family:monospace;letter-spacing:0.5px;">${esc(cp.code)}</span>
            ${cp.type === "loyalty" ? `<span class="history-table-tag">🎖️ Loyalty</span>` : ""}
          </div>
          <span class="history-total" style="color:${active ? "#22c55e" : "#9ca3af"};">${fmt(cp.amount || 0)} off</span>
        </div>

        ${cp.message ? `<p style="font-size:0.85rem;color:#4b5563;margin:8px 0 4px;line-height:1.4;">${esc(cp.message)}</p>` : ""}

        <div class="history-order-footer">
          <div class="history-footer-left">
            <span class="history-status-badge" style="background:${active ? "#dcfce7" : "#e5e7eb"};color:${active ? "#16a34a" : "#6b7280"};">
              ${active ? "🟢 Available" : "✅ Used"}
            </span>
          </div>
          <span style="font-size:0.78rem;color:#6b7280;">Min order ${fmt(cp.minOrder || 200)}</span>
        </div>
      </div>`;
    }).join("");
  } catch (err) {
    console.warn("[offers] Failed to load coupons:", err);
    list.innerHTML = `
      <div class="history-empty">
        <span class="history-empty-icon">⚠️</span>
        <p>Could not load offers. Please try again.</p>
      </div>`;
  }
}

// ── AI UPDATE [2026-09-13]: Coupon badge dot ──────────────────────────────────

/** Start (or restart) the real-time "any unused coupon?" watch for `phone`. */
function _startCouponWatch(phone) {
  _stopCouponWatch();
  if (!phone) return;

  const map = _readSeenCoupons();
  let isFirstRun = !(phone in map);

  _unsubCoupons = onSnapshot(
    query(collection(db, "coupons"), where("phone", "==", phone)),
    (snap) => {
      const ids = new Set();
      snap.forEach((d) => { if (!d.data().used) ids.add(d.id); });
      _availableIds = ids;
      _setDotVisible(ids.size > 0);

      // First time we've ever watched this phone: baseline the "seen" set
      // so existing coupons don't fire a false "new offer" toast later.
      if (isFirstRun) {
        _saveSeenCoupons(phone, ids);
        isFirstRun = false;
      }
    },
    (err) => console.warn("[offers] coupon badge watch failed:", err)
  );
}

/** Stop the badge listener (called on logout) and hide the dot. */
function _stopCouponWatch() {
  if (_unsubCoupons) { _unsubCoupons(); _unsubCoupons = null; }
  _availableIds = new Set();
  _setDotVisible(false);
}

function _setDotVisible(visible) {
  document.getElementById("offersDot")?.classList.toggle("hidden", !visible);
}

// ── AI UPDATE [2026-09-13]: One-time "new offer" toast ────────────────────────

function _readSeenCoupons() {
  try { return JSON.parse(localStorage.getItem(SEEN_COUPONS_KEY)) || {}; }
  catch (_) { return {}; }
}

function _saveSeenCoupons(phone, idSet) {
  const map = _readSeenCoupons();
  map[phone] = Array.from(idSet);
  try { localStorage.setItem(SEEN_COUPONS_KEY, JSON.stringify(map)); } catch (_) {}
}

/** Show the toast once if any live available coupon hasn't been seen yet. */
function _maybeNotifyNewOffer(phone) {
  const seen = new Set(_readSeenCoupons()[phone] || []);
  const hasNew = Array.from(_availableIds).some((id) => !seen.has(id));
  if (!hasNew) return;

  _showNewOfferToast();
  _saveSeenCoupons(phone, _availableIds);
}

function _showNewOfferToast() {
  let el = document.getElementById("offerNewToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "offerNewToast";
    el.className = "offer-toast";
    document.body.appendChild(el);
  }
  el.textContent = "🎟️ New offer available! Tap the coupon icon to view.";

  el.classList.remove("show");
  void el.offsetWidth; // reflow, so the transition restarts if shown again
  el.classList.add("show");

  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
