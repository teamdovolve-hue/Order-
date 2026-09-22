/**
 * smart-assistant.js
 * ─────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-18] New file — "Smart Assistant" chat widget.
 *
 * [AI UPDATE 2026-09-21] Voice Assistant support: three ADDITIVE exports were appended at
 * the bottom of this file (getAssistantMenu, getAssistantSnapshot, addToCartByName) so
 * js/voice-assistant.js can reuse this file's product matching, variant/availability rules,
 * cached customer-profile + coupon reads and loyalty rule instead of duplicating them.
 * NOTHING above them changed — the text chat behaves exactly as before. Only the import
 * line below gained `cartExtras`.
 *
 * [AI UPDATE 2026-09-22] Renamed to "Siya" + Groq fallback for out-of-the-box questions.
 * RULE-BASED FIRST, AI ONLY AS A LAST RESORT: routeMessage() still tries every deterministic
 * pattern below FIRST (add/remove/quantity/cart/track/coupons/loyalty/orders/greeting) —
 * nothing about that logic changed. Only when NONE of those match does it now call
 * POST /api/voice/interpret (the SAME Groq endpoint + SAME system prompt the Voice Assistant
 * uses) instead of just giving up with a generic "I didn't understand" message. It is given
 * the EXACT same context shape the voice assistant sends: getAssistantMenu() + the read-only
 * getAssistantSnapshot() (loggedIn/customer/cart) + a rolling window of this chat's own
 * history — see _tryAiUnderstanding()/_actOnAiResult() near the bottom of the intent router.
 * The model is still never trusted with the cart directly: an AI "add_to_cart" result is
 * re-validated the exact same way voice commands are, through addToCartByName() below, so a
 * hallucinated product/size can only ever become a clarifying question, never a bad add.
 * The Groq/Deepgram API keys stay server-side in api/voice/* — nothing secret is in this file.
 *
 * Every response is generated either by deterministic JavaScript string matching against
 * data this app already has (the logged-in customer's own profile/history, the live menu,
 * the live cart, the customer's own coupons), or — for text the rules don't cover — by the
 * same whitelisted Groq call the Voice Assistant uses. If information genuinely isn't
 * available, the assistant says so — it never invents prices, products, coupons, order
 * numbers, or statistics (see FALLBACK / "couldn't find" messages below).
 *
 * REUSE, NOT DUPLICATION — this file creates NO second cart system, NO
 * second customer system, and NO second order-history system:
 *   • Cart reads/writes   → js/cart.js            (cart, addItem, removeItem, clearCart)
 *   • Menu/availability   → js/menu.js             (getMenuIndex, isItemOos — both
 *                            small additive exports added alongside this file,
 *                            wrapping the SAME _groupItems()/_isItemOos() logic
 *                            the menu grid itself renders from)
 *   • Login/session        → js/auth.js            (getLoginInfo, requireLogin)
 *   • Completed orders     → js/history.js         (getHistory — localStorage,
 *                            already kept in sync with Firestore by order-status.js)
 *   • Active order tracking → js/order-status.js    (getActiveOrdersSnapshot — new
 *                            additive export, cached from the EXISTING listener,
 *                            no second listener started)
 *   • Customer profile / coupons — read directly from Firestore
 *     (customers/{phone}, coupons where phone==) using the exact same
 *     collections + query shape js/auth.js and js/offers.js already use.
 *     Read-only. No Firestore rule changes required (see AI_HANDOFF.md).
 *
 * PUBLIC API:
 *   initSmartAssistant() — wires the Siya floating button, panel, quick
 *                          actions, and message input. Call once on boot
 *                          (app.js), same pattern as initOffers()/initHistory().
 *
 * PERFORMANCE (requirement #29): customer profile + coupons are fetched
 * from Firestore at most once per 60s per phone number (see _profileCache /
 * _couponsCache below) — not on every message. Menu/cart/history reads are
 * pure in-memory lookups (zero Firestore cost per message). No new
 * onSnapshot listeners are started by this file.
 */

import { db } from "./firebase-config.js";
import {
  doc, getDoc, collection, query, where, getDocs,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getLoginInfo, requireLogin } from "./auth.js";
import { getMenuIndex, isItemOos } from "./menu.js";
import { cart, cartExtras, addItem, removeItem, clearCart } from "./cart.js";
import { getHistory } from "./history.js";
import { getActiveOrdersSnapshot, getStatusLabel } from "./order-status.js";
import { isOrderingEnabled } from "./restaurant-status.js";

// ─────────────────────────────────────────────────────────────────────────
// Loyalty / reward rule — SINGLE SOURCE OF TRUTH note
// ─────────────────────────────────────────────────────────────────────────
// The Customer Panel and Billing Panel are two separate repositories (see
// ARCHITECTURE_LOCK.md §1) — this file cannot `import` Billing Panel source.
// These four numbers are a deliberate, DOCUMENTED MIRROR of the Billing
// Panel's own single source of truth: js/cart.js LOYALTY_MIN_ORDERS /
// LOYALTY_MIN_SPEND / LOYALTY_AMOUNT / LOYALTY_MIN_REDEEM in
// https://github.com/Arnavmishra142/Billing-system-Pizza-hut- (confirmed
// identical values there as of this update). If the Billing Panel ever
// changes these, this block must be updated to match — do NOT treat this
// as an independent/second source of truth for the reward rule.
const LOYALTY_MIN_ORDERS = 10;
const LOYALTY_MIN_SPEND  = 1000;
const LOYALTY_AMOUNT     = 100;

const DEFAULT_COUPON_MIN_ORDER = 200; // same fallback offers.js uses when a coupon doc has no minOrder field

const _fmt = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n || 0);

// ─────────────────────────────────────────────────────────────────────────
// Session state (in-memory only — resets on page reload/logout, same
// lifetime as the cart's in-memory Map before its own localStorage restore)
// ─────────────────────────────────────────────────────────────────────────

/** Multi-turn context — task 23 "Smart Context" (e.g. "add margherita" →
 *  "which size?" → "medium"). null when there's nothing pending. */
let _ctx = { pending: null, lastTouched: null };

let _profileCache = { phone: null, data: null, ts: 0 };
let _couponsCache = { phone: null, data: null, ts: 0 };
const _CACHE_TTL_MS = 60 * 1000;

// [AI UPDATE 2026-09-22] Groq fallback config — see _tryAiUnderstanding() below.
const API_INTERPRET      = "/api/voice/interpret";
const AI_FETCH_TIMEOUT_MS = 20000;
const AI_HISTORY_KEEP     = 6; // same window size the Voice Assistant keeps
let _aiHistory = []; // [{ role: "user"|"assistant", text }] — this chat session only

function _resetSessionState() {
  _ctx = { pending: null, lastTouched: null };
  _profileCache = { phone: null, data: null, ts: 0 };
  _couponsCache = { phone: null, data: null, ts: 0 };
  _aiHistory = [];
}

/** customers/{phone} doc — totalOrders, lifetimeSpend, etc. (§5 of
 *  ARCHITECTURE_LOCK.md; same collection auth.js already reads). */
async function _getCustomerProfile() {
  const info = getLoginInfo();
  if (!info?.phone) return null;
  if (_profileCache.phone === info.phone && Date.now() - _profileCache.ts < _CACHE_TTL_MS) {
    return _profileCache.data;
  }
  try {
    const snap = await getDoc(doc(db, "customers", info.phone));
    const data = snap.exists() ? snap.data() : null;
    _profileCache = { phone: info.phone, data, ts: Date.now() };
    return data;
  } catch (err) {
    console.warn("[smart-assistant] profile fetch failed:", err?.code || err);
    return null;
  }
}

/** coupons where phone == logged-in customer's phone — exact same
 *  collection/query shape as js/offers.js renderOffers(). */
async function _getCustomerCoupons() {
  const info = getLoginInfo();
  if (!info?.phone) return [];
  if (_couponsCache.phone === info.phone && Date.now() - _couponsCache.ts < _CACHE_TTL_MS) {
    return _couponsCache.data;
  }
  try {
    const snap = await getDocs(query(collection(db, "coupons"), where("phone", "==", info.phone)));
    const coupons = [];
    snap.forEach((d) => coupons.push({ id: d.id, ...d.data() }));
    coupons.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    _couponsCache = { phone: info.phone, data: coupons, ts: Date.now() };
    return coupons;
  } catch (err) {
    console.warn("[smart-assistant] coupons fetch failed:", err?.code || err);
    return [];
  }
}

/** Runs `fn` only if logged in; otherwise a login prompt (no modal — see
 *  runQuickAction() below for the button path, which DOES use requireLogin). */
async function _withLogin(fn) {
  const info = getLoginInfo();
  if (!info?.phone) {
    return 'You\'re not logged in yet. Please log in (tap "Place Order", or tap a quick action below) and ask me again.';
  }
  return fn();
}

// ─────────────────────────────────────────────────────────────────────────
// Rule-based text understanding
// ─────────────────────────────────────────────────────────────────────────

function _normalize(s) {
  return (s || "").toLowerCase().replace(/[.,!?()&₹]/g, " ").replace(/\s+/g, " ").trim();
}
function _tokens(s) { return _normalize(s).split(" ").filter(Boolean); }

const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  // AI UPDATE [2026-09-18]: deliberately NO "do" → "2" mapping — "do" collides
  // with the extremely common Hinglish verb phrases "kar do" / "de do" ("please
  // do it"/"give it"), which would make EVERY plain add command misread a
  // trailing quantity of 2. Digits ("2") and "two" still work; a bare "do"
  // used to mean the number 2 is a known, documented gap.
  ek: 1, teen: 3, tin: 3, char: 4, chaar: 4, panch: 5, paanch: 5,
  chhe: 6, che: 6, saat: 7, sath: 7, aath: 8, aat: 8, nau: 9, das: 10, dus: 10,
};
function _extractQty(tokens) {
  for (const t of tokens) {
    if (/^\d+$/.test(t)) { const n = parseInt(t, 10); if (n > 0 && n < 100) return n; }
    if (NUM_WORDS[t] != null) return NUM_WORDS[t];
  }
  return null;
}

const VARIANT_WORDS = { regular: "Regular", medium: "Medium", large: "Large", half: "Half", full: "Full" };
function _extractVariant(tokens) {
  for (const t of tokens) { if (VARIANT_WORDS[t]) return VARIANT_WORDS[t]; }
  return null;
}

// Phrase-level removal (multi-word verbs first, so "kar do" doesn't leave a
// stray "kar" AND a stray "do" behind for the generic connector pass below).
const ADD_VERB_PHRASES = [
  /\bkar\s*do\b/g, /\bkardo\b/g, /\bkaro\b/g, /\bkar\s*de\b/g, /\bkarde\b/g,
  /\bdaal\s*do\b/g, /\bdaaldo\b/g, /\bdaalo\b/g, /\bdaal\s*dena\b/g, /\bdaal\b/g,
  /\bde\s*do\b/g, /\bdedo\b/g, /\bdena\b/g,
  /\badd\b/g, /\bplease\b/g, /\bchahiye\b/g,
  /\bcart\s*me\b/g, /\bcart\s*mein\b/g, /\bmy\s*cart\b/g, /\bthe\s*cart\b/g, /\bcart\b/g,
  /\bbhi\b/g, /\baur\b/g,
];
const REMOVE_VERB_PHRASES = [
  /\bhata\s*do\b/g, /\bhatado\b/g, /\bhatao\b/g, /\bhata\s*dena\b/g, /\bhata\b/g,
  /\bnikal\s*do\b/g, /\bnikaldo\b/g, /\bnikalo\b/g, /\bnikal\b/g,
  /\bremove\b/g, /\bdelete\b/g, /\bmita\s*do\b/g, /\bmitao\b/g,
  /\bcart\s*se\b/g, /\bfrom\s*my\s*cart\b/g, /\bfrom\s*cart\b/g, /\bse\b/g,
];
const _CONNECTOR_RE = new RegExp(
  "\\b(the|a|an|ka|ki|ke|ko|mein|me|ek|teen|tin|char|chaar|panch|paanch|chhe|che|saat|sath|aath|aat|nau|das|dus|" +
  "one|two|three|four|five|six|seven|eight|nine|ten|regular|medium|large|half|full|\\d+)\\b", "g"
);

/** Strips add/remove verb phrases + qty/variant/connector words, leaving
 *  (hopefully) just the product name text behind for matching. */
function _isolateProductQuery(normText, phraseList) {
  let s = ` ${normText} `;
  for (const re of phraseList) s = s.replace(re, " ");
  s = s.replace(_CONNECTOR_RE, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Product/group display name → matchable lowercase tokens, with the
 *  "(Regular)"/"(Medium)"/… variant suffix stripped (menu.js already
 *  strips this the same way for its own _displayBase()/_vBase() helpers —
 *  duplicated here as a tiny pure function rather than importing an
 *  internal, non-exported helper). */
function _productTokens(name) {
  return _tokens((name || "").replace(/\s*\((regular|medium|large|half|full)\)\s*/gi, " "));
}

/**
 * Rule 6/7/8 — Product matching against the live menu.
 * Token-overlap match: every query token found in a candidate's name
 * counts as +1. Highest-overlap candidate(s) win; ties → ambiguous (the
 * caller lists them rather than guessing — requirement #8).
 */
function _matchProduct(queryText) {
  const { groups } = getMenuIndex();
  if (!groups || groups.length === 0) return { matches: [], menuNotReady: true };

  const qTokens = _tokens(queryText);
  if (qTokens.length === 0) return { matches: [] };

  const candidates = groups.map((g) => ({
    kind: g.isGroup ? "group" : "item",
    ref: g,
    tokens: _productTokens(g.isGroup ? g.displayName : g.name),
  }));

  const scored = candidates
    .map((c) => ({ c, overlap: qTokens.filter((t) => c.tokens.includes(t)).length }))
    .filter((x) => x.overlap > 0);

  if (scored.length === 0) return { matches: [] };

  const maxOverlap = Math.max(...scored.map((s) => s.overlap));
  let top = scored.filter((s) => s.overlap === maxOverlap).map((s) => s.c);

  // If exactly one candidate's full token set is entirely covered by the
  // query (e.g. query "margherita pizza" fully covers "Margherita Pizza"),
  // prefer it over other same-overlap-count partial matches.
  if (top.length > 1) {
    const fullCover = top.filter((c) => c.tokens.every((t) => qTokens.includes(t)));
    if (fullCover.length === 1) top = fullCover;
  }

  return { matches: top };
}

function _productLabel(m) { return m.kind === "group" ? m.ref.displayName : m.ref.name; }

// ─────────────────────────────────────────────────────────────────────────
// Cart actions — the assistant NEVER touches cart.js's Map directly; every
// mutation goes through addItem/removeItem/clearCart (requirement #30).
// ─────────────────────────────────────────────────────────────────────────

async function _resolveAndAdd(candidate, qty) {
  if (candidate.kind === "group") {
    const group = candidate.ref;
    let variant = candidate.variant || null;

    if (!variant) {
      if (group.variants.length === 1) {
        variant = group.variants[0];
      } else {
        _ctx.pending = { kind: "add", group, qty };
        const labels = group.variants.map((v) => v.label).join(", ");
        return `Which size would you like for ${group.displayName}? (${labels})`;
      }
    }

    if (variant.oos) return `${group.displayName} (${variant.label}) is currently unavailable.`;
    if (!isOrderingEnabled()) return "Sorry, online ordering is paused right now. Please speak to our staff.";

    for (let i = 0; i < qty; i++) addItem(variant.id, `${group.displayName} (${variant.label})`, variant.price);
    _ctx.pending = null;
    _ctx.lastTouched = { id: variant.id, name: `${group.displayName} (${variant.label})` };
    return `Done! Added ${qty} × ${group.displayName} (${variant.label}) to your cart.`;
  }

  const item = candidate.ref;
  if (isItemOos(item)) return `${item.name} is currently unavailable.`;
  if (!isOrderingEnabled()) return "Sorry, online ordering is paused right now. Please speak to our staff.";

  for (let i = 0; i < qty; i++) addItem(item.id, item.name, item.price);
  _ctx.pending = null;
  _ctx.lastTouched = { id: item.id, name: item.name };
  return `Done! Added ${qty} × ${item.name} to your cart.`;
}

/** Resolves a group + a requested variant label. Returns a clarification
 *  string (and remembers _ctx.pending) if the label doesn't exist on this
 *  group — requirement #7: never invent a variant that isn't there. */
function _pickVariant(group, variantLabel, qty) {
  if (!variantLabel) return { variant: null };
  const variant = group.variants.find((v) => v.label.toLowerCase() === variantLabel.toLowerCase());
  if (variant) return { variant };
  _ctx.pending = { kind: "add", group, qty };
  const labels = group.variants.map((v) => v.label).join(", ");
  return { clarify: `${group.displayName} is available in ${labels}. Which one would you like?` };
}

/**
 * Handles an "add to cart" message.
 * @param {boolean} implicit  true when no explicit add-verb was found and
 *   this is the loose fallback attempt (task 4's "medium margherita pizza 2"
 *   with no verb at all). In implicit mode, a failed match returns null so
 *   the caller falls through to the generic help message instead of a
 *   confident-sounding "couldn't find that" for what might not have been
 *   an order attempt at all.
 */
async function _handleAddIntent(norm, rawText, qtyOverride, implicit = false) {
  const tokens = _tokens(norm);
  const qty = qtyOverride || _extractQty(tokens) || 1;
  const variantLabel = _extractVariant(tokens);

  const productQuery = implicit ? norm : _isolateProductQuery(norm, ADD_VERB_PHRASES);
  if (!productQuery) {
    if (implicit) return null;
    _ctx.pending = { kind: "awaitingProductName", qty };
    return "Sure! What would you like to add?";
  }

  const { matches, menuNotReady } = _matchProduct(productQuery);
  if (menuNotReady) return "The menu is still loading — please try again in a moment.";

  if (matches.length === 0) {
    if (implicit) return null;
    return `Sorry, I couldn't find "${rawText.trim()}" on our menu. Check the categories above, or try a different name.`;
  }
  if (matches.length > 1) {
    const names = matches.slice(0, 6).map((m) => `• ${_productLabel(m)}`).join("\n");
    return `Sure. Which one would you like?\n\n${names}`;
  }

  const only = matches[0];
  if (only.kind === "group" && variantLabel) {
    const picked = _pickVariant(only.ref, variantLabel, qty);
    if (picked.clarify) return picked.clarify;
    return _resolveAndAdd({ kind: "group", ref: only.ref, variant: picked.variant }, qty);
  }
  return _resolveAndAdd(only, qty);
}

async function _handleRemoveIntent(norm) {
  const tokens = _tokens(norm);
  const qtyFound = _extractQty(tokens);
  const productQuery = _isolateProductQuery(norm, REMOVE_VERB_PHRASES);

  if (cart.size === 0) return "Your cart is already empty.";
  if (!productQuery) return "Which item would you like to remove?";

  const qTokens = _tokens(productQuery);
  const entries = [...cart.values()];
  const scored = entries
    .map((e) => ({ e, overlap: qTokens.filter((t) => _productTokens(e.name).includes(t)).length }))
    .filter((x) => x.overlap > 0);

  if (scored.length === 0) {
    return `I couldn't find "${productQuery}" in your cart. Say "show my cart" to see what's in it.`;
  }
  const maxOverlap = Math.max(...scored.map((s) => s.overlap));
  const top = scored.filter((s) => s.overlap === maxOverlap).map((s) => s.e);

  if (top.length > 1) {
    const names = top.map((t) => `• ${t.name}`).join("\n");
    return `You have a few matching items in your cart. Which one exactly?\n\n${names}`;
  }

  const target = top[0];
  const originalQty = target.qty; // snapshot — removeItem() mutates this same object below
  const n = Math.min(qtyFound || originalQty, originalQty);
  for (let i = 0; i < n; i++) removeItem(target.id);

  const remaining = originalQty - n;
  if (remaining <= 0) return `Done! Removed ${target.name} from your cart.`;
  return `Done! Removed ${n} × ${target.name} from your cart. ${remaining} left.`;
}

/** Requirement #11 — "pizza ki quantity 2 kar do" / "make it 3". */
function _handleSetQuantity(norm) {
  const m = norm.match(/\bquantity\b[^\d]*(\d+)\b/) || norm.match(/\bmake it\s+(\d+)\b/);
  if (!m) return null;
  const targetQty = parseInt(m[1], 10);
  if (isNaN(targetQty) || targetQty < 0 || cart.size === 0) return null;

  const productPart = norm.replace(/\bquantity\b/g, " ").replace(/\bmake it\b/g, " ").replace(/\d+/g, " ").trim();
  let target = null;

  if (productPart) {
    const qTokens = _tokens(productPart);
    const scored = [...cart.values()]
      .map((e) => ({ e, overlap: qTokens.filter((t) => _productTokens(e.name).includes(t)).length }))
      .filter((x) => x.overlap > 0);
    if (scored.length === 1) target = scored[0].e;
  }
  if (!target && _ctx.lastTouched) target = cart.get(_ctx.lastTouched.id) || null;
  if (!target && cart.size === 1) target = [...cart.values()][0];
  if (!target) return "Which item's quantity would you like to change? (e.g. \"margherita quantity 2\")";

  const current = target.qty;
  if (targetQty === current) return `${target.name} is already at ${current}.`;
  if (targetQty === 0) {
    for (let i = 0; i < current; i++) removeItem(target.id);
    return `Done! Removed ${target.name} from your cart.`;
  }
  if (targetQty > current) { for (let i = 0; i < targetQty - current; i++) addItem(target.id, target.name, target.price); }
  else { for (let i = 0; i < current - targetQty; i++) removeItem(target.id); }
  return `Done! ${target.name} quantity updated to ${targetQty}.`;
}

function _actionClearCart() {
  if (cart.size === 0) return "Your cart is already empty.";
  clearCart();
  _ctx.pending = null;
  return "Done! Your cart has been cleared.";
}

function _actionViewCart() {
  if (cart.size === 0) return 'Your cart is empty. Try: "add 2 medium margherita pizza".';
  let total = 0;
  const lines = [...cart.values()].map((i) => {
    const sub = i.price * i.qty;
    total += sub;
    return `• ${i.qty} × ${i.name} — ${_fmt(sub)}`;
  });
  return `Your cart currently has:\n\n${lines.join("\n")}\n\nSubtotal: ${_fmt(total)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Continuing a pending multi-turn exchange (requirement #23)
// ─────────────────────────────────────────────────────────────────────────

async function _tryContinuePending(norm, rawText) {
  const pending = _ctx.pending;
  if (!pending) return null;

  if (pending.kind === "add" && pending.group) {
    const tokens = _tokens(norm);
    const variantLabel = _extractVariant(tokens);
    if (!variantLabel) { _ctx.pending = null; return null; } // not an answer to our question — let normal routing try
    const qty = _extractQty(tokens) || pending.qty || 1;
    const picked = _pickVariant(pending.group, variantLabel, qty);
    if (picked.clarify) return picked.clarify;
    return _resolveAndAdd({ kind: "group", ref: pending.group, variant: picked.variant }, qty);
  }

  if (pending.kind === "awaitingProductName") {
    const qty = pending.qty;
    _ctx.pending = null;
    return _handleAddIntent(norm, rawText, qty, false);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Orders / tracking / coupons / loyalty — read-only, all from data the app
// already loads elsewhere (no second data pipeline — requirements #12–19).
// ─────────────────────────────────────────────────────────────────────────

function _actionTrackOrder() {
  const orders = getActiveOrdersSnapshot();
  if (!orders || orders.length === 0) return "You don't have an active order right now.";
  return orders
    .map((o) => `Your order (${o.tableId || "—"}) is currently:\n${o.statusLabel || getStatusLabel(o.status)}`)
    .join("\n\n");
}

function _actionMyLastOrder() {
  const hist = getHistory();
  if (!hist || hist.length === 0) return "You don't have any previous orders yet.";
  const last = hist[0]; // newest first
  const lines = (last.items || []).map((it) => `• ${it.name} ×${it.quantity ?? it.qty ?? 1}`).join("\n");
  return `Your last order was:\n\n${lines}\n\nTotal: ${_fmt(last.totalPrice || 0)}`;
}

async function _actionRepeatLastOrder() {
  const hist = getHistory();
  if (!hist || hist.length === 0) return "You don't have any previous orders yet.";
  const items = hist[0].items || [];
  if (items.length === 0) return "Your last order didn't have any items I can repeat.";
  if (!isOrderingEnabled()) return "Sorry, online ordering is paused right now. Please speak to our staff.";

  const added = [];
  const failed = [];

  for (const it of items) {
    const qty = it.quantity ?? it.qty ?? 1;
    const bareName = (it.name || "").replace(/\s*\((regular|medium|large|half|full)\)\s*/i, "");
    const { matches } = _matchProduct(bareName);

    const candidate =
      matches.length === 1 ? matches[0]
        : matches.find((m) => _normalize(_productLabel(m)) === _normalize(bareName));

    if (!candidate) { failed.push(it.name); continue; }

    if (candidate.kind === "group") {
      const vMatch = (it.name || "").match(/\((regular|medium|large|half|full)\)/i);
      const variant = vMatch
        ? candidate.ref.variants.find((v) => v.label.toLowerCase() === vMatch[1].toLowerCase())
        : (candidate.ref.variants.length === 1 ? candidate.ref.variants[0] : null);
      if (!variant) { failed.push(it.name); continue; }
      if (variant.oos) { failed.push(`${candidate.ref.displayName} (${variant.label})`); continue; }
      for (let i = 0; i < qty; i++) addItem(variant.id, `${candidate.ref.displayName} (${variant.label})`, variant.price);
      added.push(`${qty} × ${candidate.ref.displayName} (${variant.label})`);
    } else {
      const item = candidate.ref;
      if (isItemOos(item)) { failed.push(item.name); continue; }
      for (let i = 0; i < qty; i++) addItem(item.id, item.name, item.price);
      added.push(`${qty} × ${item.name}`);
    }
  }

  let msg = "";
  if (added.length) msg += `Added to your cart:\n${added.map((a) => `• ${a}`).join("\n")}`;
  if (failed.length) msg += `${msg ? "\n\n" : ""}Couldn't add (no longer on the menu / unavailable): ${failed.join(", ")}`;
  return msg || "Couldn't repeat that order — none of those items are on the menu anymore.";
}

async function _actionMyOrders() {
  const hist = getHistory();
  const profile = await _getCustomerProfile();
  const count = profile?.totalOrders ?? hist.length;
  if (!count) return "You haven't placed any orders yet.";

  const recent = hist.slice(0, 3).map((o, i) => {
    const n = hist.length - i;
    const names = (o.items || []).map((it) => it.name).slice(0, 3).join(", ");
    const more = (o.items || []).length > 3 ? "…" : "";
    return `#${n} — ${names}${more} (${_fmt(o.totalPrice || 0)})`;
  }).join("\n");

  return `You've placed ${count} order${count === 1 ? "" : "s"} so far.${recent ? `\n\nMost recent:\n${recent}` : ""}`;
}

async function _actionMyCoupons() {
  const coupons = await _getCustomerCoupons();
  const unused = coupons.filter((c) => !c.used);
  if (unused.length === 0) return "You don't have any available coupons right now. Order more to unlock rewards!";
  const lines = unused.map((c) => {
    const minOrder = c.minOrder ?? DEFAULT_COUPON_MIN_ORDER;
    const tag = c.type === "loyalty" ? " · 🎖️ Loyalty reward" : "";
    return `🎟 ${_fmt(c.amount || 0)} OFF (code ${c.code})\nMinimum order: ${_fmt(minOrder)}${tag}`;
  }).join("\n\n");
  return `You currently have ${unused.length} available coupon${unused.length === 1 ? "" : "s"}:\n\n${lines}`;
}

async function _actionBestCoupon() {
  const coupons = await _getCustomerCoupons();
  const subtotal = [...cart.values()].reduce((s, i) => s + i.price * i.qty, 0);
  const eligible = coupons.filter((c) => !c.used && (c.minOrder ?? DEFAULT_COUPON_MIN_ORDER) <= subtotal);

  if (eligible.length === 0) {
    if (subtotal === 0) return "Add some items to your cart first, then I can suggest the best coupon for it.";
    return `None of your coupons apply yet — your cart total is ${_fmt(subtotal)}. Add a bit more to unlock one.`;
  }
  const best = eligible.reduce((b, c) => ((c.amount || 0) > (b.amount || 0) ? c : b));
  return `Your best available coupon is 🎟 ${_fmt(best.amount || 0)} OFF (code ${best.code}) — minimum order ${_fmt(best.minOrder ?? DEFAULT_COUPON_MIN_ORDER)}. Your cart total is ${_fmt(subtotal)}, so you're eligible!`;
}

async function _actionLoyalty() {
  const profile = await _getCustomerProfile();
  if (!profile) return "I couldn't find your customer profile yet — try placing your first order!";

  const orders = profile.totalOrders || 0;
  const spend = profile.lifetimeSpend || 0;

  // There is no separate "points balance" field anywhere in this system —
  // requirement #18: don't invent one. The only real reward mechanic is
  // this order-count + spend milestone (requirement #19).
  if (orders >= LOYALTY_MIN_ORDERS && spend >= LOYALTY_MIN_SPEND) {
    return `You've completed ${orders} orders and have reached the ${LOYALTY_MIN_ORDERS}-order reward milestone. Check "My Coupons" — your ₹${LOYALTY_AMOUNT} reward coupon should be there!`;
  }

  const ordersLeft = Math.max(0, LOYALTY_MIN_ORDERS - orders);
  const spendLeft  = Math.max(0, LOYALTY_MIN_SPEND - spend);
  let msg = `Loyalty points aren't tracked as a separate balance for this account. Instead, completing ${LOYALTY_MIN_ORDERS} orders with ${_fmt(LOYALTY_MIN_SPEND)}+ lifetime spend earns you a ₹${LOYALTY_AMOUNT} reward coupon.\n\n`;
  msg += `You've completed ${orders} order${orders === 1 ? "" : "s"}`;
  if (ordersLeft > 0) msg += ` (${ordersLeft} more to go)`;
  msg += ` with ${_fmt(spend)} lifetime spend`;
  if (spendLeft > 0) msg += ` (${_fmt(spendLeft)} more needed)`;
  msg += ".";
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────
// Intent router
// ─────────────────────────────────────────────────────────────────────────

const CLEAR_CART_RE = /\bcart\s*(clear|khali|empty)\b|\bclear\s*(my\s*)?cart\b|\bempty\s*(my\s*)?cart\b/i;
const VIEW_CART_RE  = /\bcart\s*me\s*kya\b|what.?s\s*in\s*my\s*cart|\bshow\s*my\s*cart\b|\bview\s*(my\s*)?cart\b|\bcart\s*dikhao\b|\bmera\s*cart\b|\bcart\s*total\b|\bcart\s*ka\s*total\b|\bmera\s*total\b/i;
const REMOVE_VERB_RE = /\b(remove|hata|hatao|hatado|nikal|nikalo|nikaldo|delete|mitao|mitado)\b/i;
const ADD_VERB_RE = /\b(add|daal|daalo|daaldo|kar\s*do|kardo|karo|kar\s*de|karde|chahiye|de\s*do|dedo|dena)\b/i;
// Lookaheads — "order" + a repeat/track/etc. cue, in any order in the sentence.
const REPEAT_ORDER_RE = /(?=.*\border\b)(?=.*\b(repeat|dubara|firse|again)\b)/i;
const LAST_ORDER_RE   = /\b(last\s*order|previous\s*order|pichla\s*order|purana\s*order)\b/i;
const TRACK_ORDER_RE  = /(?=.*\border\b)(?=.*\b(track|kaha|status|ho\s*raha|happening)\b)/i;
const BEST_COUPON_RE  = /\b(best\s*coupon|which\s*coupon|kaunsa\s*coupon)\b/i;
const COUPON_RE       = /\b(coupons?|offers?|vouchers?)\b/i;
const LOYALTY_RE      = /\b(loyalty|reward\s*points?|\bpoints?\b)\b/i;
const ORDERS_RE       = /\b(my\s*orders|order\s*history|kitne\s*order|how\s*many\s*orders?|order\s*count|purane\s*orders)\b/i;
const GREETING_RE     = /^(hi|hello|hey|namaste|hola|yo)\b/i;

function _greetingText() {
  const info = getLoginInfo();
  const name = info?.name ? info.name.split(" ")[0] : null;
  return name ? `Hi ${name}! 👋 What would you like to order?`
              : "Hi! 👋 What would you like to order? (Log in anytime to check your orders, coupons and more.)";
}

function _fallbackHelp() {
  return "Sorry, I didn't understand that. You can ask me things like:\n\n"
    + "• Add 2 medium pizza\n• Show my cart\n• Track my order\n"
    + "• Repeat my last order\n• My coupons\n• My orders";
}

// ─────────────────────────────────────────────────────────────────────────
// [AI UPDATE 2026-09-22] Groq fallback — used ONLY when every rule above
// finds no match. Same endpoint, same system prompt, same context shape as
// the Voice Assistant (js/voice-assistant.js → api/voice/interpret.js).
// ─────────────────────────────────────────────────────────────────────────

const _AI_ACCOUNT_TOPICS = new Set(["coupons", "orders", "loyalty", "spend"]);
const _AI_LOGIN_MSG = "You're not logged in yet. Please log in (tap \"Place Order\", or tap a quick action below) and ask me again.";

async function _fetchInterpret(transcript, context) {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), AI_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(API_INTERPRET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, history: _aiHistory, context }),
      signal: ctl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data?.message || `http_${res.status}`);
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Re-validates every AI-suggested item through the SAME addToCartByName()
 *  the voice assistant uses — a hallucinated product/size can only ever
 *  become a clarifying question, never a bad add (see file header note). */
async function _aiAddItems(items) {
  const added = [];
  const notes = [];
  for (const it of items || []) {
    const r = await addToCartByName(it);
    if (r.status === "added") added.push(r.added);
    else notes.push(r.message);
  }
  const lines = [];
  if (added.length) lines.push(`Added ${added.join(", ")} to your cart.`);
  lines.push(...notes);
  return lines.join("\n") || _fallbackHelp();
}

/** Closes the chat sheet and clicks an existing header button (offersBtn /
 *  historyBtn) — the exact same drawer + login-gating a normal tap gets,
 *  no second implementation (mirrors voice-assistant.js _navigateTo()). */
function _navigateFromChat(buttonId) {
  window.setTimeout(() => {
    _closeAssistant();
    document.getElementById(buttonId)?.click();
  }, 450);
}

async function _actOnAiResult(result, snap) {
  switch (result?.action) {
    case "add_to_cart":
      return _aiAddItems(result.items);

    case "open_coupons":
      _navigateFromChat("offersBtn");
      return "Opening your offers…";

    case "open_history":
      _navigateFromChat("historyBtn");
      return "Opening your order history…";

    case "answer": {
      const topic = result.topic || "other";
      if (!snap.loggedIn && _AI_ACCOUNT_TOPICS.has(topic)) return _AI_LOGIN_MSG;
      return result.reply || _fallbackHelp();
    }

    case "login_required":
      return _AI_LOGIN_MSG;

    case "clarify":
      return result.reply || _fallbackHelp();

    default: // unsupported / unknown
      return result?.reply || _fallbackHelp();
  }
}

/** Last resort when no hardcoded rule matched anything in routeMessage(). */
async function _tryAiUnderstanding(rawText) {
  try {
    const menu = getAssistantMenu();
    const snap = await getAssistantSnapshot();
    const result = await _fetchInterpret(rawText, {
      loggedIn: snap.loggedIn, menu, customer: snap.customer, cart: snap.cart,
    });
    return await _actOnAiResult(result, snap);
  } catch (err) {
    console.warn("[smart-assistant] Groq fallback failed:", err?.message || err);
    return _fallbackHelp();
  }
}

async function routeMessage(rawText) {
  const norm = _normalize(rawText);

  if (_ctx.pending) {
    const r = await _tryContinuePending(norm, rawText);
    if (r !== null) return r;
  }

  if (CLEAR_CART_RE.test(norm)) return _actionClearCart();

  const setQtyReply = _handleSetQuantity(norm);
  if (setQtyReply) return setQtyReply;

  if (REMOVE_VERB_RE.test(norm)) return _handleRemoveIntent(norm);

  if (VIEW_CART_RE.test(norm)) return _actionViewCart();

  if (REPEAT_ORDER_RE.test(norm)) return _withLogin(_actionRepeatLastOrder);
  if (LAST_ORDER_RE.test(norm))   return _withLogin(async () => _actionMyLastOrder());
  if (TRACK_ORDER_RE.test(norm))  return _withLogin(async () => _actionTrackOrder());

  if (BEST_COUPON_RE.test(norm)) return _withLogin(_actionBestCoupon);
  if (COUPON_RE.test(norm))      return _withLogin(_actionMyCoupons);
  if (LOYALTY_RE.test(norm))     return _withLogin(_actionLoyalty);
  if (ORDERS_RE.test(norm))      return _withLogin(_actionMyOrders);

  if (GREETING_RE.test(norm) && norm.split(" ").length <= 3) return _greetingText();

  // Explicit add-verb present → try hard, and explain if the product
  // genuinely isn't found.
  if (ADD_VERB_RE.test(norm)) return _handleAddIntent(norm, rawText);

  // No verb, no other intent matched — last resort: maybe this whole
  // message IS just a bare product mention ("medium margherita pizza 2").
  const implicitTry = await _handleAddIntent(norm, rawText, null, true);
  if (implicitTry) return implicitTry;

  // Genuinely out-of-the-box: every hardcoded rule above found nothing.
  // Hand it to Groq (same call the Voice Assistant makes) instead of
  // giving up with a generic "I didn't understand" message.
  return _tryAiUnderstanding(rawText);
}

// ─────────────────────────────────────────────────────────────────────────
// DOM wiring
// ─────────────────────────────────────────────────────────────────────────

function _appendMsg(text, who) {
  const list = document.getElementById("saMessages");
  if (!list) return;
  const row = document.createElement("div");
  row.className = `sa-msg sa-msg--${who}`;
  const bubble = document.createElement("div");
  bubble.className = "sa-bubble";
  bubble.textContent = text; // textContent only — never innerHTML with user/product text
  row.appendChild(bubble);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}
const _userSay = (t) => _appendMsg(t, "user");
const _botSay  = (t) => _appendMsg(t, "bot");

function _rememberAiTurn(userText, assistantText) {
  _aiHistory.push({ role: "user", text: userText });
  if (assistantText) _aiHistory.push({ role: "assistant", text: assistantText });
  _aiHistory = _aiHistory.slice(-AI_HISTORY_KEEP);
}

async function _handleUserMessage(raw) {
  const text = raw.trim();
  if (!text) return;
  _userSay(text);
  try {
    const reply = await routeMessage(text);
    if (reply) _botSay(reply);
    _rememberAiTurn(text, reply);
  } catch (err) {
    console.error("[smart-assistant] routeMessage failed:", err);
    _botSay("Sorry, something went wrong on my end. Please try again.");
    _rememberAiTurn(text, null);
  }
}

let _opened = false;
function _openAssistant() {
  document.getElementById("saModal")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  if (!_opened) {
    _opened = true;
    const info = getLoginInfo();
    const name = info?.name ? info.name.split(" ")[0] : null;
    _botSay(name
      ? `👋 Hi ${name}! I'm Siya, your AI assistant. What can I help you with?`
      : "👋 Hi! I'm Siya, your AI assistant. Ask me to add items to your cart, or log in to check your orders, coupons and more.");
  }
  document.getElementById("saInput")?.focus();
}
function _closeAssistant() {
  document.getElementById("saModal")?.classList.add("hidden");
  document.body.style.overflow = "";
}

const QUICK_ACTION_LABELS = {
  trackOrder: "Track my order",
  repeatOrder: "Repeat my last order",
  myCoupons: "My coupons",
  loyaltyPoints: "My loyalty points",
  myOrders: "My orders",
  viewCart: "View my cart",
};

/** Quick-action buttons call the EXACT SAME action handlers text commands
 *  use (requirement #22) — trackOrder → _actionTrackOrder(), etc. Buttons
 *  that need customer data go through requireLogin() first (same pattern
 *  offers.js/history.js already use for their header buttons); viewCart
 *  doesn't, since the cart is local and needs no login to inspect. */
function _runQuickAction(action) {
  const label = QUICK_ACTION_LABELS[action];
  if (!label) return;
  _userSay(label);

  const needsLogin = action !== "viewCart";
  const run = async () => {
    try {
      let reply;
      switch (action) {
        case "trackOrder":    reply = _actionTrackOrder(); break;
        case "repeatOrder":   reply = await _actionRepeatLastOrder(); break;
        case "myCoupons":     reply = await _actionMyCoupons(); break;
        case "loyaltyPoints": reply = await _actionLoyalty(); break;
        case "myOrders":      reply = await _actionMyOrders(); break;
        case "viewCart":      reply = _actionViewCart(); break;
        default: reply = _fallbackHelp();
      }
      _botSay(reply);
    } catch (err) {
      console.error("[smart-assistant] quick action failed:", err);
      _botSay("Sorry, something went wrong on my end. Please try again.");
    }
  };

  if (needsLogin) requireLogin(run); else run();
}

/** Wires the 🤖 floating button, panel open/close, quick-action chips, and
 *  the message input. Call once on boot (app.js), same pattern as
 *  initOffers()/initHistory(). */
export function initSmartAssistant() {
  document.getElementById("saFab")?.addEventListener("click", _openAssistant);
  document.getElementById("saCloseBtn")?.addEventListener("click", _closeAssistant);
  document.getElementById("saBackdrop")?.addEventListener("click", _closeAssistant);

  document.getElementById("saInputForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("saInput");
    const text = input?.value || "";
    if (input) input.value = "";
    _handleUserMessage(text);
  });

  document.getElementById("saQuickActions")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".sa-chip");
    if (btn?.dataset.saAction) _runQuickAction(btn.dataset.saAction);
  });

  // Session state (pending multi-turn context, profile/coupon caches) is
  // tied to WHICH customer is logged in — reset on every login/logout so
  // one customer's session never bleeds into the next on a shared device.
  window.addEventListener("customAuthStateChanged", _resetSessionState);
}

// ═════════════════════════════════════════════════════════════════════════
// [AI UPDATE 2026-09-21] VOICE ASSISTANT SUPPORT — ADDITIVE EXPORTS ONLY
// ─────────────────────────────────────────────────────────────────────────
// Consumed by js/voice-assistant.js. Everything here is built from the SAME
// helpers the text chat above already uses (_matchProduct, _productTokens,
// _resolveAndAdd, _getCustomerProfile, _getCustomerCoupons, the LOYALTY_*
// constants, getHistory, getActiveOrdersSnapshot). No second cart, coupon,
// history, customer-stat or loyalty system is created, and nothing above this
// banner was modified. There is still no fetch() in this file.
// ═════════════════════════════════════════════════════════════════════════

const _VOICE_MAX_QTY = 20; // same per-add cap the Item Details sheet enforces (item-sheet.js _onQtyPlus)

function _cartTotals() {
  let qty = 0, subtotal = 0;
  for (const i of cart.values()) { qty += i.qty; subtotal += i.price * i.qty; }
  return { qty, subtotal };
}

/** "A", "A or B", "A, B or C" — for spoken-style clarification questions. */
function _orList(names) {
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** ms number / ISO string / Firestore-style {seconds} → "YYYY-MM-DD", or null. */
function _isoDay(val) {
  if (!val && val !== 0) return null;
  const d = typeof val === "number" ? new Date(val)
    : val && val.seconds != null ? new Date(val.seconds * 1000)
    : new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Menu names + sizes the voice AI may choose from — straight from getMenuIndex()
 * (the same _groupItems() output the menu cards render), so the AI can only ever
 * refer to products/sizes that really exist.
 * @returns {{name: string, variants: string[]}[]}
 */
export function getAssistantMenu() {
  const { groups } = getMenuIndex();
  return (groups || []).slice(0, 400).map((g) => (g.isGroup
    ? { name: g.displayName, variants: g.variants.map((v) => v.label) }
    : { name: g.name, variants: [] }));
}

/**
 * Read-only snapshot of "what the assistant may know" about the current customer.
 * Sources (all pre-existing): customers/{phone} + coupons via the cached readers
 * above (max 1 Firestore read each per 60 s), getHistory(), getActiveOrdersSnapshot(),
 * and the live cart Map. Deliberately contains NO phone number, uid or name.
 * @returns {Promise<{loggedIn: boolean, customer: object|null, cart: {items: object[], subtotal: number}}>}
 */
export async function getAssistantSnapshot() {
  const cartInfo = {
    items: [...cart.values()].map((i) => ({ name: i.name, qty: i.qty, price: i.price })),
    subtotal: _cartTotals().subtotal,
  };

  const info = getLoginInfo();
  if (!info?.phone) return { loggedIn: false, customer: null, cart: cartInfo };

  const [profile, coupons] = await Promise.all([_getCustomerProfile(), _getCustomerCoupons()]);
  const hist = getHistory() || [];
  const unused = coupons.filter((c) => !c.used);

  // Same rules _actionMyOrders / _actionLoyalty use: totalOrders from the profile (falling
  // back to the history length), lifetimeSpend from the profile, reward = the LOYALTY_* mirror.
  const totalOrders = profile?.totalOrders ?? hist.length;
  let loyalty = null;
  if (profile) {
    const o = profile.totalOrders || 0;
    const s = profile.lifetimeSpend || 0;
    loyalty = {
      rule: `Complete ${LOYALTY_MIN_ORDERS} orders with ${LOYALTY_MIN_SPEND} rupees or more lifetime spend to earn a ${LOYALTY_AMOUNT} rupee reward coupon. There is no separate loyalty-points balance.`,
      ordersCompleted: o,
      ordersRequired: LOYALTY_MIN_ORDERS,
      ordersRemaining: Math.max(0, LOYALTY_MIN_ORDERS - o),
      spendCompleted: s,
      spendRequired: LOYALTY_MIN_SPEND,
      spendRemaining: Math.max(0, LOYALTY_MIN_SPEND - s),
      rewardAmount: LOYALTY_AMOUNT,
      milestoneReached: o >= LOYALTY_MIN_ORDERS && s >= LOYALTY_MIN_SPEND,
    };
  }

  return {
    loggedIn: true,
    cart: cartInfo,
    customer: {
      totalOrders,
      lifetimeSpend: profile ? (profile.lifetimeSpend || 0) : null,
      loyalty,
      coupons: {
        availableCount: unused.length,
        usedCount: coupons.length - unused.length,
        available: unused.slice(0, 10).map((c) => ({
          code: c.code,
          amountOff: c.amount || 0,
          minOrder: c.minOrder ?? DEFAULT_COUPON_MIN_ORDER,
          kind: c.type === "loyalty" ? "loyalty reward" : "special offer",
        })),
      },
      recentOrders: hist.slice(0, 5).map((o, i) => ({
        orderNumber: hist.length - i,
        date: _isoDay(o.placedAt),
        items: (o.items || []).map((it) => `${it.name} x${it.quantity ?? it.qty ?? 1}`).join(", ").slice(0, 160),
        total: o.totalPrice || 0,
      })),
      activeOrders: (getActiveOrdersSnapshot() || []).slice(0, 3).map((o) => ({
        table: o.tableId || "",
        status: o.statusLabel || getStatusLabel(o.status),
        total: o.total || 0,
      })),
    },
  };
}

/**
 * Add ONE product to the cart on behalf of the voice assistant.
 *
 * `item`, `variant`, `quantity` come from the language model, which is told to copy
 * names from getAssistantMenu() — but the model is NOT trusted: the name is re-checked
 * against the live menu here, and anything short of an unambiguous match becomes a
 * short clarification question instead of a guess.
 *
 *   1. exact product-name match (case/punctuation-insensitive), else
 *   2. every spoken word appears in exactly one product's name ("margherita" → "Margherita Pizza"), else
 *   3. NO auto-add — partial overlaps (via the text chat's _matchProduct) are offered as suggestions only.
 *
 * The add itself is the text chat's own _resolveAndAdd() → cart.js addItem(), so the
 * out-of-stock, "ordering paused" and single-size rules are identical. After a successful
 * add it stores the same cartExtras variant metadata (parentName / variantLabel / imageUrl)
 * the Item Details sheet stores, so the order payload and Order Review look exactly like an
 * item added by tapping ADD. Existing extras / special request on that cart line are kept.
 *
 * @returns {Promise<{status: "added"|"clarify"|"failed", message: string, added?: string}>}
 *   added   → cart changed (`added` = e.g. "2 × Paneer Pizza (Regular)")
 *   clarify → nothing added; `message` is a question the customer should answer
 *   failed  → nothing added; `message` explains (unavailable / ordering paused / menu loading)
 */
export async function addToCartByName({ item, variant, quantity } = {}) {
  const savedPending = _ctx.pending;
  try {
    return await _voiceAdd(item, variant, quantity);
  } finally {
    // The voice flow keeps its own multi-turn state; never leave a dangling
    // "which size?" question behind in the text chat's context.
    _ctx.pending = savedPending;
  }
}

async function _voiceAdd(itemText, variantText, quantity) {
  _ctx.pending = null; // lets us tell "asked a size question" apart from "refused" below

  const { groups } = getMenuIndex();
  if (!groups || groups.length === 0) {
    return { status: "failed", message: "The menu is still loading — please try again in a moment." };
  }

  let qty = Math.round(Number(quantity));
  if (!Number.isFinite(qty) || qty < 1) qty = 1;
  if (qty > _VOICE_MAX_QTY) {
    return { status: "clarify", message: `I can add up to ${_VOICE_MAX_QTY} at a time. How many would you like?` };
  }

  const label = (g) => (g.isGroup ? g.displayName : g.name);
  const wanted = _normalize(itemText);
  let pool = groups.filter((g) => _normalize(label(g)) === wanted);
  if (pool.length === 0) {
    const q = _tokens(itemText);
    if (q.length) {
      pool = groups.filter((g) => {
        const t = _productTokens(label(g));
        return q.every((w) => t.includes(w));
      });
    }
  }

  if (pool.length === 0) {
    const { matches } = _matchProduct(itemText); // suggestions only — never auto-added
    const names = [...new Set(matches.slice(0, 3).map(_productLabel))];
    return {
      status: "clarify",
      message: names.length
        ? `I couldn't find "${itemText}" on the menu. Did you mean ${_orList(names)}?`
        : `I couldn't find "${itemText}" on the menu. What else can I add?`,
    };
  }
  if (pool.length > 1) {
    const names = [...new Set(pool.slice(0, 4).map(label))];
    return { status: "clarify", message: `Which one did you mean — ${_orList(names)}?` };
  }

  const entry = pool[0];
  const before = _cartTotals().qty;
  let message;
  let usedVariant = null;

  if (entry.isGroup) {
    if (variantText) {
      usedVariant = entry.variants.find((v) => v.label.toLowerCase() === String(variantText).toLowerCase()) || null;
      if (!usedVariant) {
        return {
          status: "clarify",
          message: `${entry.displayName} comes in ${entry.variants.map((v) => v.label).join(", ")}. Which size would you like?`,
        };
      }
    }
    message = await _resolveAndAdd({ kind: "group", ref: entry, variant: usedVariant }, qty);
    if (!usedVariant && entry.variants.length === 1) usedVariant = entry.variants[0];
  } else {
    if (variantText && !/^(regular|normal|standard)$/i.test(String(variantText))) {
      return { status: "clarify", message: `${entry.name} doesn't come in different sizes. Should I add it as it is?` };
    }
    message = await _resolveAndAdd({ kind: "item", ref: entry }, qty);
  }

  if (_cartTotals().qty > before) {
    const id = usedVariant ? usedVariant.id : entry.id;
    const prev = cartExtras.get(id) || {};
    if (entry.isGroup && usedVariant) {
      cartExtras.set(id, {
        extras: [], specialRequest: "", ...prev,
        variantLabel: usedVariant.label,
        parentName: entry.displayName,
        imageUrl: usedVariant.imageUrl || entry.imageUrl || "",
      });
    } else {
      cartExtras.set(id, { extras: [], specialRequest: "", ...prev, imageUrl: entry.imageUrl || "" });
    }
    const shown = entry.isGroup && usedVariant ? `${entry.displayName} (${usedVariant.label})` : label(entry);
    return { status: "added", message, added: `${qty} × ${shown}` };
  }

  // Nothing was added: either a size question (pending was set) or a refusal (sold out / ordering paused).
  return { status: _ctx.pending ? "clarify" : "failed", message };
}
