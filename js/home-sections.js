/**
 * home-sections.js
 * ─────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-08-03] Phase 3 — Intelligent Home Screen
 *
 * Renders four dynamic discovery sections when the "All" category
 * is active and no search is in progress:
 *   • ⭐ Recommended   — featured items first, then by popularity
 *   • 🔥 Most Ordered  — ranked by orderCount field
 *   • ✨ New Arrivals   — isNew=true items, then newest by createdAt
 *   • 👨‍🍳 Chef's Picks  — featured items by displayOrder, then rest
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

// ── Section algorithms ────────────────────────────────────────

/** OOS check for a grouped entry */
function _isOos(entry) {
  if (entry.isGroup) {
    return !entry.variants || entry.variants.every((v) => v.oos);
  }
  return entry.inStock === false || entry.available === false;
}

/** Convert a Firestore Timestamp, Date, or number to ms */
function _tsOf(entry) {
  const c = entry.createdAt;
  if (!c) return 0;
  if (typeof c.toDate === "function") return c.toDate().getTime();
  if (c instanceof Date) return c.getTime();
  return Number(c) || 0;
}

function _orderCount(e) { return Number(e.orderCount) || 0; }
function _isFeatured(e) { return Boolean(e.isFeatured); }
function _isNew(e)      { return Boolean(e.isNew); }
function _dispOrder(e)  {
  const v = e.displayOrder;
  return v !== undefined && v !== null ? Number(v) : 9999;
}

/** Collect up to `n` deduplicated entries from `arr` */
function _limit(arr, n) {
  const seen = new Set();
  const out  = [];
  for (const e of arr) {
    const key = e.isGroup ? e.groupKey : e.id;
    if (!seen.has(key)) { seen.add(key); out.push(e); }
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Given all grouped entries, compute the four section item arrays.
 * Falls back gracefully when optional Firestore fields are missing.
 */
function _computeSections(grouped) {
  const avail = grouped.filter((e) => !_isOos(e));
  if (avail.length === 0) return [];

  // ── RECOMMENDED ────────────────────────────────────────────
  // Featured items (by orderCount desc), then rest (by orderCount desc).
  const recommended = _limit(
    [
      ...avail.filter(_isFeatured).sort((a, b) => _orderCount(b) - _orderCount(a)),
      ...avail.filter((e) => !_isFeatured(e)).sort((a, b) => _orderCount(b) - _orderCount(a)),
    ],
    8
  );

  // ── MOST ORDERED ────────────────────────────────────────────
  // Items where orderCount > 0, sorted desc.
  // Fallback: featured → all available (when no orderCount data exists).
  const withCount = avail
    .filter((e) => _orderCount(e) > 0)
    .sort((a, b) => _orderCount(b) - _orderCount(a));
  const mostOrdered = _limit(
    withCount.length >= 3
      ? withCount
      : [
          ...avail.filter(_isFeatured),
          ...avail.filter((e) => !_isFeatured(e)),
        ],
    8
  );

  // ── NEW ARRIVALS ────────────────────────────────────────────
  // isNew=true items first; fallback: newest by createdAt.
  const newMarked = avail.filter(_isNew);
  const byDate    = [...avail].sort((a, b) => _tsOf(b) - _tsOf(a));
  const newItems  = _limit(
    newMarked.length >= 2
      ? [...newMarked, ...byDate.filter((e) => !_isNew(e))]
      : byDate,
    6
  );

  // ── CHEF'S PICKS ────────────────────────────────────────────
  // Featured items sorted by displayOrder asc, then rest by displayOrder.
  const chefsPicks = _limit(
    [
      ...avail.filter(_isFeatured).sort((a, b) => _dispOrder(a) - _dispOrder(b)),
      ...avail.filter((e) => !_isFeatured(e)).sort((a, b) => _dispOrder(a) - _dispOrder(b)),
    ],
    8
  );

  return [
    { id: "recommended",  title: "⭐ Recommended",  entries: recommended },
    { id: "most-ordered", title: "🔥 Most Ordered",  entries: mostOrdered },
    { id: "new-items",    title: "✨ New Arrivals",   entries: newItems },
    { id: "chefs-picks",  title: "👨‍🍳 Chef's Picks", entries: chefsPicks },
  ].filter((s) => s.entries.length > 0);
}
