/**
 * coupons.js — Customer Panel coupon + loyalty STATE (single source for UI, cart/review and Smart Assistant)
 * ─────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-19] NEW FILE — Coupon + Loyalty rebuild.
 *
 * READ-ONLY toward Firestore. The Customer Panel never writes coupons, never marks one used, and never
 * issues rewards: issuing + redemption are Billing-Panel-only (js/coupon-service.js in that repo).
 *   • coupons where phone == my phone            (live onSnapshot)  → my coupons
 *   • customer_order_history/{uid}/orders        (live onSnapshot)  → qualifying orders/spend → progress
 * All rules (eligibility, discount maths, tabs, best coupon, progress) come from ./coupon-engine.js, which is a
 * byte-identical copy of the Billing Panel's engine — so Customer Panel, Smart Assistant and POS can never disagree.
 *
 * "Applied" coupon = a local selection (localStorage `qrmenu_applied_coupon` → {phone, code}). It is NOT a claim on
 * the coupon: it is only attached to the order document at placeOrder() and the POS re-validates it and marks it
 * USED only when the order is actually settled. Eligibility is re-computed from the LIVE cart every time it is read,
 * so removing an item that drops the cart below the minimum instantly invalidates the discount.
 */
import { db } from "./firebase-config.js";
import { collection, query, where, onSnapshot }
  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { cart } from "./cart.js";
import { getLoginInfo } from "./auth.js";
import {
  normalizeCoupon, evaluateCoupon, pickBestCoupon, bucketCoupons, effectiveStatus,
  deriveQualifyingStats, loyaltyProgress, discountLabel,
} from "./coupon-engine.js";

const APPLIED_KEY = "qrmenu_applied_coupon";

let _phone = null, _uid = null;
let _coupons = [];                       // normalized, live
let _stats = { orders: 0, spend: 0 };    // qualifying, live
let _unsubC = null, _unsubH = null;
let _couponsLoaded = false;
const _subs = new Set();

const _emit = () => _subs.forEach((cb) => { try { cb(); } catch (e) { console.warn("[coupons] subscriber failed:", e); } });

/** Subscribe to any coupon / applied / progress change. Returns unsubscribe. */
export function onCouponsChange(cb) { _subs.add(cb); return () => _subs.delete(cb); }

export const getCoupons = () => _coupons.slice();
export const couponsLoaded = () => _couponsLoaded;
export const getBuckets = () => bucketCoupons(_coupons);
export const getQualifyingStats = () => ({ ..._stats });
export const getLoyalty = () => loyaltyProgress(_stats);
export const currentCustomerId = () => _phone;

/** Live cart subtotal (same maths as the cart bar / review sheet). */
export function cartSubtotal() {
  let t = 0;
  for (const it of cart.values()) t += it.price * it.qty;
  return Math.round(t * 100) / 100;
}

// ── watchers (started/stopped on login state, like offers.js / order-status.js) ──────────────
export function startCouponWatch(phone, uid) {
  if (_phone === phone && _uid === uid && _unsubC) return;
  stopCouponWatch();
  if (!phone) return;
  _phone = phone; _uid = uid || null;
  _unsubC = onSnapshot(
    query(collection(db, "coupons"), where("phone", "==", phone)),
    (snap) => {
      _coupons = snap.docs.map((d) => normalizeCoupon(d.data(), d.id))
        .sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
      _couponsLoaded = true;
      _emit();
    },
    (err) => console.warn("[coupons] coupon watch failed:", err)
  );
  if (_uid) {
    _unsubH = onSnapshot(
      collection(db, "customer_order_history", _uid, "orders"),
      (snap) => { _stats = deriveQualifyingStats(snap.docs.map((d) => ({ id: d.id, ...d.data() }))); _emit(); },
      (err) => console.warn("[coupons] loyalty watch failed:", err)
    );
  }
}

export function stopCouponWatch() {
  if (_unsubC) { _unsubC(); _unsubC = null; }
  if (_unsubH) { _unsubH(); _unsubH = null; }
  _phone = null; _uid = null; _coupons = []; _stats = { orders: 0, spend: 0 }; _couponsLoaded = false;
  _emit();
}

/** Bind to the login state (call once). */
export function initCoupons() {
  const boot = (u) => (u?.phone ? startCouponWatch(u.phone, u.uid) : stopCouponWatch());
  boot(getLoginInfo());
  window.addEventListener("customAuthStateChanged", (e) => boot(e.detail?.user));
}

// ── applied coupon ──────────────────────────────────────────────────────────────────────────
function _readApplied() {
  try {
    const a = JSON.parse(localStorage.getItem(APPLIED_KEY));
    return a && a.phone === _phone ? a.code : null;   // never leak a selection across customers
  } catch (_) { return null; }
}
function _writeApplied(code) {
  try {
    if (code) localStorage.setItem(APPLIED_KEY, JSON.stringify({ phone: _phone, code }));
    else localStorage.removeItem(APPLIED_KEY);
  } catch (_) {}
}

/** Eligibility of one coupon against the LIVE cart. */
export function checkCoupon(c, subtotal = cartSubtotal()) {
  return evaluateCoupon(c, { subtotal, customerId: _phone });
}

/**
 * The applied coupon re-validated against the current cart.
 * → { coupon, discount, payable, subtotal } when valid, or { coupon|null, discount:0, payable:subtotal, invalid?:reason }.
 * Never returns a discount for a coupon that is used/expired/cancelled/foreign or below its minimum.
 */
export function getAppliedState(subtotal = cartSubtotal()) {
  const code = _readApplied();
  const base = { coupon: null, discount: 0, payable: subtotal, subtotal };
  if (!code) return base;
  const coupon = _coupons.find((c) => c.code === code);
  if (!coupon) return { ...base, invalid: _couponsLoaded ? "not_found" : "loading" };
  const ev = checkCoupon(coupon, subtotal);
  if (!ev.ok) return { ...base, coupon, invalid: ev.reason, message: ev.message };
  return { coupon, discount: ev.discount, payable: Math.max(0, subtotal - ev.discount), subtotal };
}

/** Apply (replace) the single coupon for this order. */
export function applyCoupon(codeOrCoupon) {
  const code = String(typeof codeOrCoupon === "string" ? codeOrCoupon : codeOrCoupon?.code || "").toUpperCase();
  const c = _coupons.find((x) => x.code === code);
  if (!c) return { ok: false, message: "Coupon not found in your account" };
  const ev = checkCoupon(c);
  if (!ev.ok) return { ok: false, message: ev.message, reason: ev.reason };
  _writeApplied(c.code);
  _emit();
  return { ok: true, coupon: c, discount: ev.discount, message: `${discountLabel(c)} applied — you save ₹${ev.discount}` };
}

export function removeAppliedCoupon() { _writeApplied(null); _emit(); }

/** Coupons that can be applied to the live cart right now, best saving first. */
export function eligibleCoupons(subtotal = cartSubtotal()) {
  return getBuckets().available
    .map((c) => ({ coupon: c, ev: checkCoupon(c, subtotal) }))
    .filter((x) => x.ev.ok)
    .sort((a, b) => b.ev.discount - a.ev.discount);
}

export function bestCoupon(subtotal = cartSubtotal()) {
  return pickBestCoupon(getBuckets().available, { subtotal, customerId: _phone });
}

/**
 * Summary attached to pending_table_orders.coupon at placeOrder(). Re-validated here at placement time so a stale
 * selection is never sent. The POS does NOT trust this object — it re-reads coupons/{code} before importing it.
 */
export function getCouponForOrder(subtotal) {
  const st = getAppliedState(subtotal);
  if (!st.coupon || !st.discount) return null;
  const c = st.coupon;
  return {
    code: c.code, couponId: c.couponId, type: c.type, customerId: c.customerId || _phone,
    discountType: c.discountType, discountValue: c.discountValue, maxDiscount: c.maxDiscount || null,
    minimumOrder: c.minimumOrder, discountAmount: st.discount, appliedAt: Date.now(),
  };
}

/** After a successful order the selection is cleared (the coupon itself stays ACTIVE until the POS settles the order). */
export function clearAppliedAfterOrder() { _writeApplied(null); _emit(); }
export { effectiveStatus, discountLabel };
