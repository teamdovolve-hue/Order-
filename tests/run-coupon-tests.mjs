// [AI UPDATE 2026-09-19] Unit tests for js/coupon-engine.js (pure logic). Run: node tests/run-coupon-tests.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(tmpdir(), `coupon-engine-${Date.now()}.mjs`);
writeFileSync(tmp, readFileSync(join(here, '..', 'js', 'coupon-engine.js'), 'utf8'));
const E = await import(pathToFileURL(tmp).href);

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const H = (id, total, extra = {}) => ({ orderId: id, total, orderStatus: 'completed', ...extra });
const PH = '+919876543210', NOW = Date.UTC(2026, 8, 19);

console.log('LOYALTY — milestones (orders AND spend)');
const mk = (n, each) => Array.from({ length: n }, (_, i) => H('O' + i, each));
for (const [n, each, amt] of [[3, 100, 30], [5, 100, 50], [10, 100, 100], [20, 100, 150], [30, 100, 200]]) {
  const s = E.deriveQualifyingStats(mk(n, each));
  t(`${n} orders × ₹${each} unlocks ₹${amt}`, E.reachedMilestones(s).some((m) => m.amount === amt));
}
t('3 orders but only ₹200 spend → NOT unlocked (spend rule)', E.reachedMilestones(E.deriveQualifyingStats(mk(3, 66.67))).length === 0);
t('₹5000 spend but 2 orders → NOT unlocked (order rule)', E.reachedMilestones(E.deriveQualifyingStats(mk(2, 2500))).length === 0);
t('10 orders + ₹1000 exactly → ₹100 unlocked', E.reachedMilestones(E.deriveQualifyingStats(mk(10, 100))).some((m) => m.amount === 100));
t('9 orders + ₹5000 → ₹100 NOT unlocked', !E.reachedMilestones(E.deriveQualifyingStats(mk(9, 555))).some((m) => m.amount === 100));

console.log('LOYALTY — counting rules');
t('cancelled order does not count', E.deriveQualifyingStats([H('A', 300), H('B', 300, { orderStatus: 'cancelled' })]).orders === 1);
t('same order doc seen twice counts once (edit/dup)', E.deriveQualifyingStats([H('A', 300), H('A', 350)]).orders === 1);
t('edited order contributes FINAL total only', E.deriveQualifyingStats([H('A', 350, { isEdited: true })]).spend === 350);
t('zero-total order does not count', E.deriveQualifyingStats([H('A', 0)]).orders === 0);
t('coupon discount never inflates spend (uses settled total 450 not 550)', E.deriveQualifyingStats([H('A', 450)]).spend === 450);
t('issuance id is stable per milestone', E.issuanceId(PH, 'm10') === '9876543210_m10');
t('all MILESTONES minimumOrder ≤ 500', E.MILESTONES.every((m) => m.minimumOrder <= 500));
t('milestone table matches spec', eq(E.MILESTONES.map((m) => [m.orders, m.spend, m.amount, m.minimumOrder]),
  [[3,300,30,199],[5,500,50,299],[10,1000,100,499],[20,2000,150,500],[30,3000,200,500]]));

console.log('LOYALTY — progress');
const p = E.loyaltyProgress({ orders: 8, spend: 920 });
t('next = 10-order milestone', p.next.orders === 10);
t('2 more orders + ₹80 message', p.message === '2 more orders + ₹80 qualifying spend to unlock ₹100 OFF');
t('progress bars 80% / 92%', p.ordersPct === 80 && p.spendPct === 92);
t('no next after 30/3000', E.loyaltyProgress({ orders: 30, spend: 3000 }).next === null);

console.log('COUPON — eligibility');
const c100 = E.normalizeCoupon({ code: 'LOY100-AAAA', customerId: PH, phone: PH, discountType: 'fixed', discountValue: 100, minimumOrder: 499,
  status: 'active', expiresAt: NOW + 5 * 864e5, oneTime: true }, 'LOY100-AAAA');
const ev = (c, sub, o = {}) => E.evaluateCoupon(c, { subtotal: sub, customerId: PH, now: NOW, ...o });
t('cart ₹450 < min ₹499 → rejected', !ev(c100, 450).ok && ev(c100, 450).reason === 'min_order');
t('cart ₹550 ≥ min ₹499 → applies ₹100', ev(c100, 550).ok && ev(c100, 550).discount === 100);
t('remove item 550→450 → invalid again (no retained discount)', !ev(c100, 450).ok);
t('exact minimum 499 → valid', ev(c100, 499).ok);
t('expired coupon rejected', ev({ ...c100, expiresAt: NOW - 1 }, 550).reason === 'expired');
t('used coupon rejected', ev({ ...c100, status: 'used' }, 550).reason === 'used');
t('cancelled coupon rejected', ev({ ...c100, status: 'cancelled' }, 550).reason === 'cancelled');
t('other customer rejected', ev(c100, 550, { customerId: '+911111111111' }).reason === 'wrong_customer');
t('no customer identity rejected', ev(c100, 550, { customerId: '' }).reason === 'wrong_customer');
t('edit re-settle: coupon used by SAME order stays valid', ev({ ...c100, status: 'used', usedOrderId: 'SALE_1' }, 550, { allowUsedByOrderId: 'SALE_1' }).ok);
t('edit re-settle: coupon used by DIFFERENT order rejected', !ev({ ...c100, status: 'used', usedOrderId: 'SALE_2' }, 550, { allowUsedByOrderId: 'SALE_1' }).ok);
t('empty cart rejected', ev(c100, 0).reason === 'empty_cart');
const pct = E.normalizeCoupon({ code: 'P10', customerId: PH, discountType: 'percent', discountValue: 10, minimumOrder: 300, status: 'active', expiresAt: NOW + 1e9, maxDiscount: 50 }, 'P10');
t('percent 10% of ₹400 = ₹40', ev(pct, 400).discount === 40);
t('percent capped by maxDiscount ₹50', ev(pct, 1000).discount === 50);
t('discount never exceeds subtotal', E.computeDiscount({ discountType: 'fixed', discountValue: 500 }, 200) === 200);
t('final payable never negative', 200 - E.computeDiscount({ discountType: 'fixed', discountValue: 500 }, 200) >= 0);

console.log('COUPON — min-order cap ₹500');
t('clampMinOrder(999) = 500', E.clampMinOrder(999) === 500);
t('legacy doc with minOrder 900 normalises to 500', E.normalizeCoupon({ code: 'X', phone: PH, amount: 10, minOrder: 900 }, 'X').minimumOrder === 500);
t('buildCouponBody clamps to 500', E.buildCouponBody({ code: 'A1B', customerId: PH, discountValue: 20, minimumOrder: 800 }).minimumOrder === 500);
t('validateCouponInput rejects min 501', !E.validateCouponInput({ code: 'ABC', discountType: 'fixed', discountValue: 20, minimumOrder: 501, expiresAtMs: Date.now() + 1e6 }).ok);
t('validateCouponInput accepts min 500', E.validateCouponInput({ code: 'ABC', discountType: 'fixed', discountValue: 20, minimumOrder: 500, expiresAtMs: Date.now() + 1e6 }).ok);
t('validateCouponInput rejects fixed ≥ min', !E.validateCouponInput({ code: 'ABC', discountType: 'fixed', discountValue: 300, minimumOrder: 299, expiresAtMs: Date.now() + 1e6 }).ok);
t('validateCouponInput rejects past expiry', !E.validateCouponInput({ code: 'ABC', discountType: 'fixed', discountValue: 20, minimumOrder: 200, expiresAtMs: Date.now() - 1 }).ok);
t('validateCouponInput rejects percent > 100', !E.validateCouponInput({ code: 'ABC', discountType: 'percent', discountValue: 150, minimumOrder: 200, expiresAtMs: Date.now() + 1e6 }).ok);

console.log('COUPON — legacy compatibility + mirrors');
const legacy = E.normalizeCoupon({ code: 'RAHUL#1234', phone: PH, amount: 100, minOrder: 200, used: false, type: 'loyalty' }, 'RAHUL#1234');
t('legacy unused doc → active fixed ₹100, min 200, never expires', legacy.status === 'active' && legacy.discountValue === 100 && legacy.minimumOrder === 200 && legacy.expiresAt === null);
t('legacy used doc → used', E.normalizeCoupon({ code: 'Z', phone: PH, amount: 1, used: true }, 'Z').status === 'used');
const body = E.buildCouponBody({ code: 'k', customerId: PH, discountValue: 75, minimumOrder: 399, expiresAtMs: NOW });
t('new doc keeps legacy mirrors in sync', body.phone === PH && body.amount === 75 && body.minOrder === 399 && body.used === false && body.status === 'active');
const pbody = E.buildCouponBody({ code: 'k2', customerId: PH, discountType: 'percent', discountValue: 10, minimumOrder: 300, expiresAtMs: NOW });
t('percent doc mirrors amount=0', pbody.amount === 0 && pbody.discountValue === 10);

console.log('COUPON — tabs + best coupon');
const list = [c100, { ...c100, code: 'B', couponId: 'B', status: 'used', usedAt: NOW }, { ...c100, code: 'C', couponId: 'C', expiresAt: NOW - 5 }];
const b = E.bucketCoupons(list, NOW);
t('tabs: 1 available / 1 used / 1 expired', b.available.length === 1 && b.used.length === 1 && b.expired.length === 1);
const c50 = E.normalizeCoupon({ code: 'F50', customerId: PH, discountValue: 50, minimumOrder: 299, status: 'active', expiresAt: NOW + 1e9 }, 'F50');
t('best coupon @₹550 = ₹100', E.pickBestCoupon([c50, c100], { subtotal: 550, customerId: PH, now: NOW }).coupon.code === 'LOY100-AAAA');
t('best coupon @₹350 = ₹50 (₹100 ineligible)', E.pickBestCoupon([c50, c100], { subtotal: 350, customerId: PH, now: NOW }).coupon.code === 'F50');
t('best coupon @₹100 = none', E.pickBestCoupon([c50, c100], { subtotal: 100, customerId: PH, now: NOW }) === null);
t('Customer A never gets Customer B coupon as best', E.pickBestCoupon([c100], { subtotal: 550, customerId: '+912222222222', now: NOW }) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
