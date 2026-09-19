/**
 * coupon-engine.js — SHARED, PURE coupon + loyalty logic
 * ─────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-19] NEW FILE — Coupon + Loyalty rebuild.
 *
 * !!! THIS FILE EXISTS IN BOTH REPOSITORIES AND MUST BE BYTE-IDENTICAL !!!
 *   • Billing Panel : js/coupon-engine.js
 *   • Customer Panel: js/coupon-engine.js
 * If you edit one, copy it to the other. There is ONE authoritative rule set
 * for eligibility, discount maths, milestones and qualifying-spend maths, and
 * it lives here. No Firebase imports, no DOM, no I/O — pure functions only, so
 * it can be unit-tested in Node (see AI_HANDOFF.md → "Coupon + Loyalty rebuild").
 *
 * Firestore shape (authoritative doc: coupons/{code}, doc ID === code):
 *   code, couponId(=code), customerId(+91… phone), type, discountType('fixed'|'percent'),
 *   discountValue, maxDiscount?, minimumOrder(<=500), issuedAt, expiresAt|null,
 *   status('active'|'used'|'cancelled'|'expired'), oneTime(bool), usedAt, usedOrderId,
 *   usedOrderIds[], source, title, message, createdBy
 *   + LEGACY MIRRORS kept in sync by every writer so old readers keep working:
 *     phone(=customerId), amount(fixed value or 0), minOrder(=minimumOrder), used(bool)
 * Pre-rebuild docs only have the legacy fields; normalizeCoupon() upgrades them
 * in memory (never rewrites them), so there is no forced migration.
 */

export const MAX_MIN_ORDER = 500; // hard business cap — NEVER exceed anywhere

export const COUPON_TYPES = ['loyalty', 'personalized', 'welcome', 'comeback', 'promotional'];

/** Loyalty milestones. Qualifying orders AND qualifying spend must BOTH be met. */
export const MILESTONES = [
  { orders: 3,  spend: 300,  amount: 30,  minimumOrder: 199 },
  { orders: 5,  spend: 500,  amount: 50,  minimumOrder: 299 },
  { orders: 10, spend: 1000, amount: 100, minimumOrder: 499 },
  { orders: 20, spend: 2000, amount: 150, minimumOrder: 500 },
  { orders: 30, spend: 3000, amount: 200, minimumOrder: 500 },
];

export const LOYALTY_VALID_DAYS = 60; // milestone coupons expire this long after issue

// ── helpers ────────────────────────────────────────────────────────────────
export function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
export const clampMinOrder = (n) => Math.max(0, Math.min(MAX_MIN_ORDER, Math.round(Number(n) || 0)));
export const phoneDigits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Any stored coupon doc (new OR legacy) → canonical in-memory coupon. */
export function normalizeCoupon(raw, id) {
  if (!raw) return null;
  const code = String(raw.code || id || '').toUpperCase();
  const discountType = raw.discountType === 'percent' ? 'percent' : 'fixed';
  const discountValue = raw.discountValue != null ? Number(raw.discountValue) : Number(raw.amount) || 0;
  const min = raw.minimumOrder != null ? raw.minimumOrder : (raw.minOrder != null ? raw.minOrder : 200);
  let status = raw.status;
  if (!status) status = raw.used ? 'used' : 'active'; // legacy docs
  return {
    couponId: code, code,
    customerId: raw.customerId || raw.phone || '',
    type: COUPON_TYPES.includes(raw.type) ? raw.type : 'personalized',
    discountType, discountValue,
    maxDiscount: raw.maxDiscount != null ? Number(raw.maxDiscount) : null,
    minimumOrder: clampMinOrder(min),
    issuedAt: toMs(raw.issuedAt) ?? toMs(raw.createdAt),
    expiresAt: toMs(raw.expiresAt),            // null = legacy / never expires
    status,
    oneTime: raw.oneTime !== false,            // default one-time
    usedAt: toMs(raw.usedAt),
    usedOrderId: raw.usedOrderId || raw.usedBillId || null,
    usedOrderIds: Array.isArray(raw.usedOrderIds) ? raw.usedOrderIds : [],
    source: raw.source || (raw.type === 'loyalty' ? 'loyalty_engine' : 'admin'),
    title: raw.title || defaultTitle(discountType, discountValue),
    message: raw.message || '',
  };
}
export function defaultTitle(discountType, value) {
  return discountType === 'percent' ? `${value}% OFF` : `₹${value} OFF`;
}
export function discountLabel(c) {
  return c.discountType === 'percent'
    ? `${c.discountValue}% OFF${c.maxDiscount ? ` (up to ₹${c.maxDiscount})` : ''}`
    : `₹${c.discountValue} OFF`;
}

/** 'active' | 'used' | 'cancelled' | 'expired' — expiry is derived, never trusted from a stale flag. */
export function effectiveStatus(c, now = Date.now()) {
  if (c.status === 'used') return 'used';
  if (c.status === 'cancelled') return 'cancelled';
  if (c.status === 'expired') return 'expired';
  if (c.expiresAt != null && now > c.expiresAt) return 'expired';
  return 'active';
}

/** Rupee discount for a subtotal. Never exceeds the subtotal; whole rupees for percent. */
export function computeDiscount(c, subtotal) {
  const sub = Math.max(0, Number(subtotal) || 0);
  let d = c.discountType === 'percent'
    ? Math.round((sub * c.discountValue) / 100)
    : c.discountValue;
  if (c.discountType === 'percent' && c.maxDiscount) d = Math.min(d, c.maxDiscount);
  return r2(Math.max(0, Math.min(d, sub)));
}

/**
 * Single eligibility check used by Customer Panel Apply, Smart Assistant, POS Apply,
 * and the POS settle-time re-check.
 * ctx: { subtotal, customerId (the customer actually placing/seated), now,
 *        allowUsedByOrderId (edit re-settle: a coupon already used by THIS order stays valid) }
 */
export function evaluateCoupon(c, ctx) {
  const now = ctx.now ?? Date.now();
  const subtotal = Number(ctx.subtotal) || 0;
  if (!c) return { ok: false, reason: 'not_found', message: 'Invalid coupon code', discount: 0 };
  const st = effectiveStatus(c, now);
  const usedBySameOrder = st === 'used' && ctx.allowUsedByOrderId && c.usedOrderId === ctx.allowUsedByOrderId;
  if (st === 'used' && !usedBySameOrder) return no('used', 'Coupon already used');
  if (st === 'cancelled') return no('cancelled', 'Coupon was cancelled');
  if (st === 'expired') return no('expired', 'Coupon has expired');
  if (c.customerId && ctx.customerId && c.customerId !== ctx.customerId)
    return no('wrong_customer', "This coupon isn't valid for this customer");
  if (c.customerId && !ctx.customerId)
    return no('wrong_customer', 'This coupon is linked to a customer');
  if (subtotal <= 0) return no('empty_cart', 'Add items to your cart first');
  if (subtotal < c.minimumOrder)
    return no('min_order', `Minimum order ₹${c.minimumOrder} required (add ₹${Math.ceil(c.minimumOrder - subtotal)} more)`);
  const discount = computeDiscount(c, subtotal);
  if (discount <= 0) return no('no_discount', 'Coupon gives no discount on this cart');
  return { ok: true, reason: 'ok', message: 'Coupon valid', discount };
  function no(reason, message) { return { ok: false, reason, message, discount: 0 }; }
}

/** Highest-saving eligible coupon (ties → soonest expiry). Returns { coupon, discount } | null. */
export function pickBestCoupon(coupons, ctx) {
  let best = null;
  for (const c of coupons || []) {
    const ev = evaluateCoupon(c, ctx);
    if (!ev.ok) continue;
    if (!best || ev.discount > best.discount ||
        (ev.discount === best.discount && (c.expiresAt ?? Infinity) < (best.coupon.expiresAt ?? Infinity)))
      best = { coupon: c, discount: ev.discount };
  }
  return best;
}

/** Split coupons into the three customer tabs. */
export function bucketCoupons(coupons, now = Date.now()) {
  const out = { available: [], used: [], expired: [] };
  for (const c of coupons || []) {
    const st = effectiveStatus(c, now);
    if (st === 'active') out.available.push(c);
    else if (st === 'used') out.used.push(c);
    else out.expired.push(c); // expired + cancelled
  }
  out.available.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  out.used.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
  out.expired.sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
  return out;
}

// ── Loyalty ────────────────────────────────────────────────────────────────
/**
 * QUALIFYING stats — derived ONLY from customer_order_history/{uid}/orders docs:
 *   • one doc == one completed/settled order (doc ID is the order ID, so an order edited
 *     any number of times is still ONE doc → can never be counted twice);
 *   • `total` is the FINAL settled amount (post-coupon, post-edit) → coupon discounts never
 *     inflate spend; cancelled/dismissed orders never write a history doc → never count.
 * LIFETIME spend (customers/{phone}.lifetimeSpend) is a separate, unchanged, display stat.
 */
export function deriveQualifyingStats(historyDocs) {
  const seen = new Set();
  let orders = 0, spend = 0;
  for (const d of historyDocs || []) {
    const id = d.orderId || d.id;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    const status = String(d.orderStatus || 'completed').toLowerCase();
    if (status !== 'completed') continue;
    const t = Number(d.total);
    if (!(t > 0)) continue;
    orders += 1; spend += t;
  }
  return { orders, spend: r2(spend) };
}

export const milestoneKey = (m) => `m${m.orders}`;
export const issuanceId = (customerId, key) => `${phoneDigits(customerId)}_${key}`;

/** Milestones whose BOTH requirements are met. */
export function reachedMilestones(stats) {
  return MILESTONES.filter((m) => stats.orders >= m.orders && stats.spend >= m.spend);
}

/**
 * Progress toward the next unlocked-not-yet-reached milestone.
 * Returns { stats, reached[], next|null, ordersRemaining, spendRemaining, ordersPct, spendPct, message }
 */
export function loyaltyProgress(stats) {
  const reached = reachedMilestones(stats);
  const next = MILESTONES.find((m) => !(stats.orders >= m.orders && stats.spend >= m.spend)) || null;
  if (!next) return { stats, reached, next: null, ordersRemaining: 0, spendRemaining: 0, ordersPct: 100, spendPct: 100,
    message: 'You have unlocked every loyalty reward. Thank you! 🎉' };
  const ordersRemaining = Math.max(0, next.orders - stats.orders);
  const spendRemaining = Math.max(0, Math.ceil(next.spend - stats.spend));
  const parts = [];
  if (ordersRemaining) parts.push(`${ordersRemaining} more order${ordersRemaining === 1 ? '' : 's'}`);
  if (spendRemaining) parts.push(`₹${spendRemaining} qualifying spend`);
  return {
    stats, reached, next, ordersRemaining, spendRemaining,
    ordersPct: Math.min(100, Math.round((stats.orders / next.orders) * 100)),
    spendPct: Math.min(100, Math.round((stats.spend / next.spend) * 100)),
    message: `${parts.join(' + ')} to unlock ₹${next.amount} OFF`,
  };
}

/** Build the canonical coupon doc body for a milestone (writer adds timestamps). */
export function milestoneCouponBody(customerId, name, m, code, nowMs = Date.now()) {
  return buildCouponBody({
    code, customerId, name, type: 'loyalty', discountType: 'fixed', discountValue: m.amount,
    minimumOrder: m.minimumOrder, expiresAtMs: nowMs + LOYALTY_VALID_DAYS * 86400000, oneTime: true,
    source: 'loyalty_engine', title: `₹${m.amount} OFF — Loyalty reward`,
    message: `🎉 Reward unlocked for ${m.orders} orders — enjoy ₹${m.amount} off your next order!`,
    milestone: milestoneKey(m),
  });
}

/**
 * Canonical + legacy-mirror body. `issuedAt`/`createdAt` timestamps are added by the caller
 * (serverTimestamp()) so this stays pure. Enforces the ₹500 cap and sane values.
 */
export function buildCouponBody(o) {
  const discountType = o.discountType === 'percent' ? 'percent' : 'fixed';
  let value = Number(o.discountValue) || 0;
  if (discountType === 'percent') value = Math.max(1, Math.min(100, Math.round(value)));
  else value = Math.max(1, Math.round(value));
  const minimumOrder = clampMinOrder(o.minimumOrder);
  const body = {
    code: String(o.code).toUpperCase(), couponId: String(o.code).toUpperCase(),
    customerId: o.customerId, phone: o.customerId,            // phone = legacy mirror
    name: o.name || '',
    type: COUPON_TYPES.includes(o.type) ? o.type : 'personalized',
    discountType, discountValue: value,
    amount: discountType === 'fixed' ? value : 0,             // legacy mirror
    minimumOrder, minOrder: minimumOrder,                      // legacy mirror
    expiresAt: o.expiresAtMs ? new Date(o.expiresAtMs) : null,
    status: 'active', used: false,                             // used = legacy mirror
    oneTime: o.oneTime !== false,
    usedAt: null, usedOrderId: null, usedOrderIds: [], usedBillId: null, usedTable: null,
    source: o.source || 'admin',
    title: o.title || defaultTitle(discountType, value),
    message: o.message || '',
    milestone: o.milestone || null,
  };
  if (discountType === 'percent' && o.maxDiscount) body.maxDiscount = Math.max(1, Math.round(o.maxDiscount));
  return body;
}

/** Validate admin-form input. Returns { ok, error?, value? }. */
export function validateCouponInput(i) {
  const code = String(i.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9#-]{3,20}$/.test(code)) return { ok: false, error: 'Code must be 3–20 letters/digits (A-Z, 0-9, - or #).' };
  const v = Number(i.discountValue);
  if (!(v > 0)) return { ok: false, error: 'Enter a discount value greater than 0.' };
  if (i.discountType === 'percent' && v > 100) return { ok: false, error: 'Percentage cannot exceed 100.' };
  const min = Number(i.minimumOrder);
  if (!(min >= 0)) return { ok: false, error: 'Enter a minimum order (0 or more).' };
  if (min > MAX_MIN_ORDER) return { ok: false, error: `Minimum order cannot exceed ₹${MAX_MIN_ORDER}.` };
  if (i.discountType !== 'percent' && min > 0 && v >= min) return { ok: false, error: 'Fixed discount must be less than the minimum order.' };
  if (!(i.expiresAtMs > Date.now())) return { ok: false, error: 'Pick an expiry date in the future.' };
  return { ok: true, value: { ...i, code } };
}
