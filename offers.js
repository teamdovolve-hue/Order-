/**
 * offers.js — "My Coupons" drawer (Available / Used / Expired) + loyalty progress + self-apply
 * ─────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-19] REBUILT for the Coupon + Loyalty rebuild (replaces the 2026-09-12/13 "My Offers" list).
 *
 * All data + rules come from js/coupons.js (live Firestore state) and js/coupon-engine.js (shared pure rules);
 * this file is presentation only. It never writes to Firestore. "Apply" only records the selection locally —
 * it is attached to the order at placeOrder() and the POS marks the coupon USED only when the order is settled.
 *
 * Kept from the earlier versions (unchanged behaviour): the 🎟️ #offersBtn, red #offersDot badge (now: ≥1 AVAILABLE
 * coupon), and the one-time "new offer" toast (seen-ids cached per phone in localStorage `qrmenu_seen_coupons`).
 *
 * Public API: initOffers()
 */
import { getLoginInfo, requireLogin } from "./auth.js";
import {
  initCoupons, onCouponsChange, getBuckets, getLoyalty, getQualifyingStats, couponsLoaded,
  checkCoupon, applyCoupon, removeAppliedCoupon, getAppliedState, cartSubtotal,
} from "./coupons.js";
import { discountLabel } from "./coupon-engine.js";

const SEEN_COUPONS_KEY = "qrmenu_seen_coupons"; // { [phone]: [couponId, ...] }
const fmt = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dateStr = (ms) => ms ? new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "";

let _drawerOpen = false;
let _tab = "available";
let _toastTimer = null;
let _msg = null; // { text, ok } inline result of the last Apply tap

export function initOffers() {
  document.getElementById("offersBtn")?.addEventListener("click", () => requireLogin(openOffers));
  document.getElementById("offersCloseBtn")?.addEventListener("click", closeOffers);
  document.getElementById("offersBackdrop")?.addEventListener("click", closeOffers);
  document.getElementById("offersList")?.addEventListener("click", _onListClick);

  initCoupons();
  let first = true;
  onCouponsChange(() => {
    if (!couponsLoaded()) { _setDot(false); return; }
    const avail = getBuckets().available;
    _setDot(avail.length > 0);
    const info = getLoginInfo();
    if (info?.phone) _seenBaselineOrToast(info.phone, avail, first);
    first = false;
    if (_drawerOpen) renderOffers();
  });
}

function openOffers() {
  _drawerOpen = true; _msg = null;
  document.getElementById("offersPanel")?.classList.remove("hidden");
  document.getElementById("offersBackdrop")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  const info = getLoginInfo();
  if (info?.phone) _saveSeen(info.phone, new Set(getBuckets().available.map((c) => c.code)));
  renderOffers();
}
function closeOffers() {
  _drawerOpen = false;
  document.getElementById("offersPanel")?.classList.add("hidden");
  document.getElementById("offersBackdrop")?.classList.add("hidden");
  document.body.style.overflow = "";
}

// ── rendering ────────────────────────────────────────────────────────────────
function _progressHtml() {
  const p = getLoyalty(), s = getQualifyingStats();
  const bar = (pct) => `<div class="cp-bar"><span style="width:${pct}%"></span></div>`;
  if (!p.next) return `<div class="cp-progress"><div class="cp-progress-title">🎯 LOYALTY</div><p class="cp-progress-msg">${esc(p.message)}</p></div>`;
  return `
  <div class="cp-progress">
    <div class="cp-progress-title">🎯 NEXT REWARD · ₹${p.next.amount} OFF</div>
    <div class="cp-progress-row"><span>${Math.min(s.orders, p.next.orders)} / ${p.next.orders} Orders</span></div>${bar(p.ordersPct)}
    <div class="cp-progress-row"><span>${fmt(Math.min(s.spend, p.next.spend))} / ${fmt(p.next.spend)} Spend</span></div>${bar(p.spendPct)}
    <p class="cp-progress-msg">${esc(p.message)}</p>
  </div>`;
}

function _cardHtml(c, tab) {
  const applied = getAppliedState().coupon?.code === c.code && !getAppliedState().invalid;
  const fresh = c.type === "loyalty" && tab === "available" && c.issuedAt && Date.now() - c.issuedAt < 3 * 86400000;
  let action = "";
  if (tab === "available") {
    const ev = checkCoupon(c);
    action = applied
      ? `<button class="cp-apply cp-applied" data-remove="1">✓ Applied · Remove</button>`
      : `<button class="cp-apply" data-apply="${esc(c.code)}" ${ev.ok ? "" : "disabled"}>Apply</button>`;
    if (!applied && !ev.ok) action += `<div class="cp-hint">${esc(ev.message)}</div>`;
  }
  const foot = tab === "used" ? `Used ${dateStr(c.usedAt)}` : tab === "expired" ? (c.status === "cancelled" ? "Cancelled" : `Expired ${dateStr(c.expiresAt)}`)
    : c.expiresAt ? `Valid till ${dateStr(c.expiresAt)}` : "No expiry";
  return `
  <div class="cp-card ${tab !== "available" ? "cp-card-off" : ""}">
    ${fresh ? `<div class="cp-unlocked">🎉 Reward Unlocked</div>` : ""}
    <div class="cp-card-top"><span class="cp-title">🎟 ${esc(c.title)}</span><span class="cp-disc">${esc(discountLabel(c))}</span></div>
    ${c.message ? `<p class="cp-msg">${esc(c.message)}</p>` : ""}
    <div class="cp-meta">Minimum order ${fmt(c.minimumOrder)} · ${esc(foot)}${c.oneTime ? "" : " · reusable"}</div>
    <div class="cp-card-bottom"><span class="cp-code">${esc(c.code)}</span><div class="cp-actions">${action}</div></div>
  </div>`;
}

function renderOffers() {
  const list = document.getElementById("offersList");
  if (!list) return;
  const info = getLoginInfo();
  if (!info?.phone) {
    list.innerHTML = `<div class="history-empty"><span class="history-empty-icon">🎟️</span><p>Log in to see your coupons.</p></div>`;
    return;
  }
  if (!couponsLoaded()) { list.innerHTML = `<div class="history-empty"><p>Loading coupons…</p></div>`; return; }

  const b = getBuckets();
  const tabs = [["available", "Available"], ["used", "Used"], ["expired", "Expired"]];
  const items = b[_tab];
  const empty = _tab === "available"
    ? "No coupons available.<br/>Order more to unlock rewards!" : _tab === "used" ? "No used coupons yet." : "No expired coupons.";

  list.innerHTML = `
    ${_progressHtml()}
    <div class="cp-tabs">${tabs.map(([k, l]) => `<button class="cp-tab ${k === _tab ? "active" : ""}" data-tab="${k}">${l} (${b[k].length})</button>`).join("")}</div>
    ${_msg ? `<div class="cp-flash ${_msg.ok ? "ok" : "bad"}">${esc(_msg.text)}</div>` : ""}
    ${items.length ? items.map((c) => _cardHtml(c, _tab)).join("") : `<div class="history-empty"><span class="history-empty-icon">🎟️</span><p>${empty}</p></div>`}`;
}

function _onListClick(e) {
  const t = e.target.closest("[data-tab],[data-apply],[data-remove]");
  if (!t) return;
  if (t.dataset.tab) { _tab = t.dataset.tab; _msg = null; renderOffers(); return; }
  if (t.dataset.remove) { removeAppliedCoupon(); _msg = { ok: true, text: "Coupon removed from your cart." }; renderOffers(); return; }
  if (t.dataset.apply) {
    const r = applyCoupon(t.dataset.apply);
    _msg = { ok: r.ok, text: r.ok ? `${r.message}. Open your cart to see the new total.` : r.message };
    renderOffers();
  }
}

// ── badge dot + one-time "new offer" toast ───────────────────────────────────
const _setDot = (v) => document.getElementById("offersDot")?.classList.toggle("hidden", !v);
function _readSeen() { try { return JSON.parse(localStorage.getItem(SEEN_COUPONS_KEY)) || {}; } catch (_) { return {}; } }
function _saveSeen(phone, set) { const m = _readSeen(); m[phone] = Array.from(set); try { localStorage.setItem(SEEN_COUPONS_KEY, JSON.stringify(m)); } catch (_) {} }
function _seenBaselineOrToast(phone, avail, first) {
  const map = _readSeen();
  const ids = new Set(avail.map((c) => c.code));
  if (!(phone in map)) { _saveSeen(phone, ids); return; }          // first ever run: baseline, no toast
  if (_drawerOpen) { _saveSeen(phone, ids); return; }
  if (!first || true) {
    const seen = new Set(map[phone] || []);
    if ([...ids].some((id) => !seen.has(id))) { _showToast(); _saveSeen(phone, ids); }
  }
}
function _showToast() {
  let el = document.getElementById("offerNewToast");
  if (!el) { el = document.createElement("div"); el.id = "offerNewToast"; el.className = "offer-toast"; document.body.appendChild(el); }
  el.textContent = "🎟️ New coupon available! Tap the coupon icon to view.";
  el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
  clearTimeout(_toastTimer); _toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
