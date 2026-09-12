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
 */

import { db } from "./firebase-config.js";
import { collection, query, where, getDocs }
  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getLoginInfo, requireLogin } from "./auth.js";

const fmt = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let _drawerOpen = false;

/** Wire up the offers button, close button, and backdrop. */
export function initOffers() {
  document.getElementById("offersBtn")?.addEventListener("click", () => {
    // Coupons are tied to a customer's phone — require login first, same
    // pattern as the "Place Order" flow in app.js.
    requireLogin(openOffers);
  });
  document.getElementById("offersCloseBtn")?.addEventListener("click", closeOffers);
  document.getElementById("offersBackdrop")?.addEventListener("click", closeOffers);
}

async function openOffers() {
  _drawerOpen = true;
  document.getElementById("offersPanel")?.classList.remove("hidden");
  document.getElementById("offersBackdrop")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
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
