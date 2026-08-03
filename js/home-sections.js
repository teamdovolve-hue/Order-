/**
 * home-sections.js
 * ─────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-08-03] Phase 3 — Intelligent Home Screen
 *
 * Renders four dynamic discovery sections when the "All" category
 * is active and no search is in progress:
 *   • ⭐ Recommended   — premium/high-value items by highest starting price
 *   • 🔥 Most Ordered  — ranked by real orderCount sales data
 *   • 🍟 Casual Snacks — category-based snack items
 *   • 👨‍🍳 Chef's Picks  — highest-priced item from each major category
 *
 * All sections are generated entirely from the already-loaded
 * Firestore snapshot — NO extra database reads.
 *
 * Sections with no qualifying items are silently skipped.
 * "See All" switches to the flat full-menu view.
 *
 * Card rendering delegates to menu.js buildCardElement() so the
 * EXACT same premium card HTML is used in both views — zero
 * layout duplication.
 */

import {
  buildCardElement,
  wireCardContainer,
  setHomeSectionsRenderer,
  showFlatMenu,
} from "./menu.js";
import { restoreCartUI } from "./cart.js";

// ── Init ──────────────────────────────────────────────────────

let _wired = false;

/**
 * Called once from app.js at DOMContentLoaded.
 * Registers this module as the home-sections renderer so menu.js
 * can call it when "All" is active.
 */
export function initHomeSections() {
  setHomeSectionsRenderer(_render);

  // Wire click handler once on the container (event delegation).
  // Cards are re-created on every render; the container persists.
  const container = document.getElementById("homeSections");
  if (container && !_wired) {
    wireCardContainer(container);
    _wired = true;
  }
}

// ── Renderer ──────────────────────────────────────────────────

/**
 * Called by menu.js applyFilter() whenever activeCategory === "All"
 * and no search/flat-override is active.
 *
 * @param {Array} _allItems   Raw Firestore item array (unused here — we
 *                            work from grouped entries which carry all fields)
 * @param {Array} grouped     Output of _groupItems(allItems) — each entry is
 *                            { isGroup, groupKey, displayName, … } with all
 *                            Firestore fields (isFeatured, orderCount, etc.)
 *                            spread from the representative variant item.
 */
function _render(_allItems, grouped) {
  const container = document.getElementById("homeSections");
  if (!container) return;

  const sections = _computeSections(grouped);

  if (sections.length === 0) {
    container.innerHTML = "";
    return;
  }

  // Build section scaffold HTML
  container.innerHTML = sections
    .map(
      (s) => `
      <div class="home-section" id="home-section-${s.id}">
        <div class="home-section-header">
          <h2 class="home-section-title">${s.title}</h2>
          <button class="home-section-see-all" data-section="${s.id}">See All</button>
        </div>
        <div class="home-section-scroll" id="home-scroll-${s.id}"></div>
      </div>`
    )
    .join("");

  // Inject card elements into each scroll row
  for (const s of sections) {
    const scrollEl = document.getElementById(`home-scroll-${s.id}`);
    if (!scrollEl) continue;
    const frag = document.createDocumentFragment();
    for (const entry of s.entries) {
      frag.appendChild(buildCardElement(entry, ""));
    }
    scrollEl.appendChild(frag);
  }

  // Wire "See All" → flat full-menu view
  container.querySelectorAll(".home-section-see-all").forEach((btn) => {
    btn.addEventListener("click", () => showFlatMenu());
  });

  // Restore cart quantity badges on newly rendered cards
  restoreCartUI();
}

// ── Low-level field helpers ───────────────────────────────────

/** OOS check for a grouped entry */
function _isOos(entry) {
  if (entry.isGroup) {
    return !entry.variants || entry.variants.every((v) => v.oos);
  }
  return entry.inStock === false || entry.available === false;
}

function _orderCount(e) { return Number(e.orderCount) || 0; }
function _isFeatured(e) { return Boolean(e.isFeatured); }

/** Unique key for cross-section deduplication */
function _entryKey(e) { return e.isGroup ? e.groupKey : e.id; }

/** Normalised category string */
function _cat(e) { return (e.category || "").toLowerCase().trim(); }

/** Normalised display name string */
function _name(e) { return (e.displayName || e.name || "").toLowerCase(); }

/** True if the entry's category or name contains any of the given keywords */
function _matches(e, keywords) {
  const c = _cat(e);
  const n = _name(e);
  return keywords.some((k) => c.includes(k) || n.includes(k));
}

/**
 * Lowest in-stock price for an entry.
 * Groups: min across available variants. Singles: item price.
 */
function _startPrice(e) {
  if (e.isGroup && e.variants?.length) {
    const prices = e.variants
      .filter((v) => !v.oos)
      .map((v) => Number(v.price) || 0)
      .filter((p) => p > 0);
    return prices.length ? Math.min(...prices) : 0;
  }
  return Number(e.price) || 0;
}

/**
 * Highest in-stock price for an entry.
 * Used by Chef's Picks to identify the premium/signature variant.
 */
function _maxPrice(e) {
  if (e.isGroup && e.variants?.length) {
    const prices = e.variants
      .filter((v) => !v.oos)
      .map((v) => Number(v.price) || 0);
    return prices.length ? Math.max(...prices) : 0;
  }
  return Number(e.price) || 0;
}

// ── Collection helpers ────────────────────────────────────────

/**
 * Collect up to `n` unique entries from `arr`.
 * - First pass: items NOT yet in `globalUsed` (preferred).
 * - Second pass: fills any remaining slots from items already used elsewhere
 *   (fallback — ensures sections are never left empty due to dedup).
 * - When `updateGlobal` is true, all selected keys are added to `globalUsed`.
 */
function _pickEntries(arr, n, globalUsed, updateGlobal = true) {
  const seen = new Set();
  const out  = [];

  // Pass 1 — prefer fresh items
  for (const e of arr) {
    if (out.length >= n) break;
    const key = _entryKey(e);
    if (!seen.has(key) && !globalUsed.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }

  // Pass 2 — fill with already-used items if still short
  if (out.length < n) {
    for (const e of arr) {
      if (out.length >= n) break;
      const key = _entryKey(e);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(e);
      }
    }
  }

  if (updateGlobal) out.forEach((e) => globalUsed.add(_entryKey(e)));
  return out;
}

// ── Section algorithms ────────────────────────────────────────

// Category keyword sets
// ---------------------
// These are intentionally broad — a substring match is used so "noodle" catches
// "Hakka Noodles", "noodles", etc.  Order within an array is irrelevant.

/** Categories considered premium / high-value */
const PREMIUM_CATS = [
  "pizza", "noodle", "fried rice", "cake", "chinese", "pasta",
  "biryani", "momos", "roll", "wrap", "paneer", "grill",
];

/** Categories considered low-value / casual — avoided in Recommended */
const LOW_VALUE_CATS = [
  "burger", "cold drink", "soft drink", "fries", "french fries",
  "sandwich", "pastry", "snack", "soda", "bread", "juice", "chips",
];

/** Keywords for the Casual Snacks section */
const SNACK_CATS = [
  "fries", "french fries", "cold drink", "soft drink",
  "cupcake", "cup cake", "garlic bread", "sandwich", "pastry",
  "snack", "soda", "juice", "chips", "wafer", "bread",
  "biscuit", "cookie", "nugget",
];

/**
 * Ordered list of category groups for Chef's Picks.
 * Each element is a keyword array; the highest-priced matching item is selected.
 */
const CHEF_CAT_GROUPS = [
  ["pizza"],
  ["cake", "dessert", "cupcake", "pastry", "brownie"],
  ["noodle", "chinese", "fried rice", "hakka"],
  ["coffee", "cappuccino", "latte", "espresso", "cold coffee"],
  ["burger"],
  ["momos", "pasta", "biryani", "roll", "wrap"],
  ["shake", "smoothie", "mocktail", "milkshake"],
  ["grill", "tandoor", "paneer", "starter"],
];

/**
 * Given all grouped entries, compute the four section item arrays.
 * Falls back gracefully when optional Firestore fields are missing.
 */
function _computeSections(grouped) {
  const avail = grouped.filter((e) => !_isOos(e));
  if (avail.length === 0) return [];

  // Global deduplication set — shared across all four sections.
  // Sections add their picks here so later sections prefer fresh items.
  const used = new Set();

  // ── 1. RECOMMENDED ─────────────────────────────────────────
  //
  // Purpose: showcase premium / high-value items.
  // Strategy:
  //   a) Premium-category items sorted by highest starting price (desc).
  //   b) Non-low-value items by starting price (filler if (a) is thin).
  //   c) Everything else by price (ultimate fallback).
  //
  // Low-value categories (burger, cold drink, fries, etc.) are excluded
  // unless (a) and (b) together cannot fill 8 slots.

  const isPremium   = (e) => _matches(e, PREMIUM_CATS);
  const isLowValue  = (e) => _matches(e, LOW_VALUE_CATS);

  const premiumByPrice = avail
    .filter((e) => isPremium(e) && !isLowValue(e))
    .sort((a, b) => _startPrice(b) - _startPrice(a));

  const neutralByPrice = avail
    .filter((e) => !isPremium(e) && !isLowValue(e))
    .sort((a, b) => _startPrice(b) - _startPrice(a));

  const lowByPrice = avail
    .filter((e) => isLowValue(e))
    .sort((a, b) => _startPrice(b) - _startPrice(a));

  const recommendedPool = [...premiumByPrice, ...neutralByPrice, ...lowByPrice];
  const recommended = _pickEntries(recommendedPool, 8, used);

  // ── 2. MOST ORDERED ─────────────────────────────────────────
  //
  // Purpose: surface items customers actually buy most.
  // Strategy:
  //   a) Items with orderCount > 0, sorted by orderCount desc.
  //   b) Fallback (when sales data is thin): featured items → all items.

  const withCount = avail
    .filter((e) => _orderCount(e) > 0)
    .sort((a, b) => _orderCount(b) - _orderCount(a));

  const mostOrderedPool =
    withCount.length >= 3
      ? withCount
      : [
          ...avail.filter(_isFeatured).sort((a, b) => _orderCount(b) - _orderCount(a)),
          ...avail.filter((e) => !_isFeatured(e)).sort((a, b) => _orderCount(b) - _orderCount(a)),
        ];

  const mostOrdered = _pickEntries(mostOrderedPool, 8, used);

  // ── 3. CASUAL SNACKS ────────────────────────────────────────
  //
  // Purpose: quick, light items for a snacking visit.
  // Strategy:
  //   a) Items whose category/name matches snack keywords, by orderCount desc.
  //   b) Any remaining low-value items by orderCount desc.
  //   c) Non-premium items (filler).
  //   d) Everything (ultimate fallback — never leave section empty).

  const isSnack = (e) => _matches(e, SNACK_CATS);

  const snackItems = avail
    .filter(isSnack)
    .sort((a, b) => _orderCount(b) - _orderCount(a));

  const extraLow = avail
    .filter((e) => isLowValue(e) && !isSnack(e))
    .sort((a, b) => _orderCount(b) - _orderCount(a));

  const nonPremium = avail
    .filter((e) => !isPremium(e) && !isSnack(e) && !isLowValue(e))
    .sort((a, b) => _orderCount(b) - _orderCount(a));

  const snackPool = [...snackItems, ...extraLow, ...nonPremium, ...avail];
  const casualSnacks = _pickEntries(snackPool, 6, used);

  // ── 4. CHEF'S PICKS ─────────────────────────────────────────
  //
  // Purpose: showcase the restaurant's signature / highest-priced dish
  //          from each major cuisine/category group.
  // Strategy:
  //   For each of the CHEF_CAT_GROUPS keyword arrays, pick the single
  //   highest-priced item (by max variant price) that hasn't already
  //   appeared in this section.  Prefer items not yet in `used` but
  //   allow repeats as a fallback.
  //   Fill any remaining slots with featured items → all items by price.

  const chefsLocal = new Set(); // within-section dedup only
  const chefsList  = [];

  for (const catGroup of CHEF_CAT_GROUPS) {
    const candidates = avail
      .filter((e) => _matches(e, catGroup))
      .sort((a, b) => _maxPrice(b) - _maxPrice(a));

    if (candidates.length === 0) continue;

    // Prefer: not used globally AND not already in chefsList
    const pick =
      candidates.find((e) => !chefsLocal.has(_entryKey(e)) && !used.has(_entryKey(e))) ||
      candidates.find((e) => !chefsLocal.has(_entryKey(e)));

    if (pick) {
      chefsList.push(pick);
      chefsLocal.add(_entryKey(pick));
    }
  }

  // Fill remaining slots with featured items (highest price), then all by price
  if (chefsList.length < 8) {
    const fillerPool = [
      ...avail.filter(_isFeatured).sort((a, b) => _maxPrice(b) - _maxPrice(a)),
      ...avail.sort((a, b) => _maxPrice(b) - _maxPrice(a)),
    ];
    for (const e of fillerPool) {
      if (chefsList.length >= 8) break;
      if (!chefsLocal.has(_entryKey(e))) {
        chefsList.push(e);
        chefsLocal.add(_entryKey(e));
      }
    }
  }

  const chefsPicks = chefsList.slice(0, 8);
  chefsPicks.forEach((e) => used.add(_entryKey(e)));

  return [
    { id: "recommended",   title: "⭐ Recommended",  entries: recommended  },
    { id: "most-ordered",  title: "🔥 Most Ordered",  entries: mostOrdered  },
    { id: "casual-snacks", title: "🍟 Casual Snacks", entries: casualSnacks },
    { id: "chefs-picks",   title: "👨‍🍳 Chef's Picks", entries: chefsPicks  },
  ].filter((s) => s.entries.length > 0);
}
