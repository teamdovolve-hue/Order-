/**
 * menu.js
 * ─────────────────────────────────────────────────────────────
 * Renders menu from Firestore (real-time onSnapshot).
 *
 * Card types — matching Billing Panel structure:
 *   • Regular card     — plain items
 *   • Half / Full card — paired "(Half)" + "(Full)" items
 *   • Triple card      — "(Regular)" + "(Medium)" + "(Large)" pizza groups
 *
 * Sort: by Admin-defined category displayOrder (products schema) or A→Z
 * (legacy). Within each category: cheapest → most expensive.
 * Pizza sorted by Regular price; Half/Full sorted by Half price.
 *
 * Out-of-Stock behaviour:
 *   • Items with inStock=false or available=false → shown with OOS badge,
 *     ordering disabled.
 *   • Pizza sizes disabled in settings/pizza_sizes → affected size-sides
 *     shown with OOS badge, other sizes remain orderable.
 *   • Items are NEVER hidden — they stay visible so customers can see the
 *     full menu.
 *
 * [AI UPDATE 2026-07-29] Compatibility with Billing Panel menu availability field.
 * The Billing Panel manages availability using the `inStock` field (set via Menu
 * Management toggle in the Billing Panel). _isItemOos() already checks both
 * `inStock === false` and `available === false` for full backward compatibility.
 * No filter that hides items is used — OOS items remain visible with a badge
 * and ordering disabled, so customers always see the complete menu.
 *
 * [AI UPDATE 2026-08-03] New hierarchical schema support.
 * The Admin Panel migrated from flat `menu_items` to `categories` → `products`
 * → `variants`. On init, menu.js checks whether the `products` collection is
 * non-empty. If yes, it subscribes to `products` + `categories` with onSnapshot
 * (real-time) and transforms them into the same flat item format the rest of
 * menu.js already expects — no downstream code changes needed. If `products` is
 * empty it falls back to the legacy `menu_items` listener so old deployments
 * are unaffected.
 *
 * Field mapping from products schema → flat item schema:
 *   products.categoryName          → item.category
 *   products.extras[].name/price   → item.extraOptions[].name/price
 *   products.flags.recommended     → item.isFeatured
 *   products.flags.mostOrdered     → item._isMostOrdered  (home sections)
 *   products.flags.casualSnack     → item._isCasualSnack  (home sections)
 *   products.flags.chefPick        → item._isChefPick     (home sections)
 *   products.flags.newArrival      → item.isNew
 *   categories[catId].displayOrder → item._catDisplayOrder (sort key)
 *   variant name suffix            → appended to item.name: "Pizza (Regular)"
 */

// [AI UPDATE 2026-08-02] Phase 1 — imported openItemSheet; ADD button now
// opens Item Details Sheet instead of calling addItem() directly.
import { db } from "./firebase-config.js";
import {
  collection, doc, onSnapshot, query, getDocs,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { addItem, removeItem, restoreCartUI, cart } from "./cart.js";
import { openItemSheet } from "./item-sheet.js";
import { openVariantPicker } from "./variant-picker.js";

const MENU_COLLECTION  = "menu_items";
const SIZES_DOC        = "settings/pizza_sizes";   // billing panel writes here

let allItems       = [];
let activeCategory = "All";
let activeSearch   = "";
let _unsub         = null;
let _unsubSizes    = null;

// [AI UPDATE 2026-08-03] New schema listeners + category display order
let _unsubProducts = null;   // onSnapshot for products collection (new schema)
let _unsubCats     = null;   // onSnapshot for categories collection (new schema)
/**
 * Map<categoryName, displayOrder> populated when reading from products/categories.
 * Used by _sortItems() and renderCategoryTabs() to respect Admin-defined order.
 */
const _catDisplayOrderMap = new Map();

// [AI UPDATE 2026-08-03] Phase 3 — Home sections support
/** When true, applyFilter() skips home sections and shows the flat full list. */
let _forceFlat = false;
/** Registered by home-sections.js; called to render the discovery sections. */
let _renderHomeSectionsCb = null;

/**
 * [AI UPDATE 2026-08-02] Phase 2 — callback invoked after each renderCategoryTabs()
 * call so category-fab.js can keep its sheet list in sync with Firestore data.
 */
let _onCategoriesReadyCb = null;
export function onCategoriesReady(cb) { _onCategoriesReadyCb = cb; }

// [AI UPDATE 2026-08-03] Phase 3 — Home sections public API

/**
 * Registered by home-sections.js at init time.
 * Avoids a circular import: menu.js never imports home-sections.js.
 */
export function setHomeSectionsRenderer(cb) { _renderHomeSectionsCb = cb; }

/**
 * Switch to the flat full-menu view (bypasses home sections).
 * Called by the "See All" buttons inside each home section.
 */
export function showFlatMenu() {
  _forceFlat = true;
  applyFilter();
  document.querySelector(".main-content")?.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * Build a card DOM element for a single grouped entry.
 * Used by home-sections.js to reuse the exact same premium cards.
 * @param {Object} entry  Group or regular entry from _groupItems()
 * @param {string} query  Highlight query (pass "" for no highlighting)
 */
export function buildCardElement(entry, query = "") {
  return entry.isGroup
    ? _createGroupCard(entry, query)
    : _createRegularCard(entry, query);
}

/**
 * Attach a delegated click handler to any container holding .menu-card elements.
 * Used by home-sections.js so home section cards respond to ADD / qty buttons.
 * Safe to call once — uses addEventListener (no cloneNode replacement).
 */
export function wireCardContainer(container) {
  container.addEventListener("click", (e) => {
    // Description Read More / Read Less
    const moreBtn = e.target.closest(".card-desc-more");
    if (moreBtn) {
      e.stopPropagation();
      const descEl = moreBtn.previousElementSibling;
      if (descEl?.classList.contains("card-desc")) {
        const expanded = descEl.classList.toggle("card-desc--expanded");
        moreBtn.textContent = expanded ? "Read Less" : "Read More";
      }
      return;
    }
    // ADD button — opens item sheet
    const addBtn = e.target.closest(".btn-add");
    if (addBtn && !addBtn.disabled) {
      if (addBtn.dataset.groupKey) {
        const group = _groupsById.get(addBtn.dataset.groupKey);
        if (group) { openItemSheet(group); return; }
      }
      const item = _itemsById.get(addBtn.dataset.id);
      if (item) { openItemSheet(item); return; }
      addItem(addBtn.dataset.id, addBtn.dataset.name, Number(addBtn.dataset.price));
      return;
    }
    // ── Group card qty controls — variant picker intercept ─────
    const groupMinus2 = e.target.closest(".qty-minus--group");
    if (groupMinus2) {
      const groupKey = groupMinus2.dataset.groupKey;
      const group    = _groupsById.get(groupKey);
      if (group) {
        const inCart = group.variants.filter(v => (cart.get(v.id)?.qty || 0) > 0);
        if (inCart.length === 1) {
          removeItem(inCart[0].id);
        } else if (inCart.length > 1) {
          openVariantPicker(group, "remove");
        }
      }
      return;
    }

    const groupPlus2 = e.target.closest(".qty-plus--group");
    if (groupPlus2) {
      const groupKey = groupPlus2.dataset.groupKey;
      const group    = _groupsById.get(groupKey);
      if (group) {
        const available = group.variants.filter(v => !v.oos);
        if (available.length === 1) {
          const v = available[0];
          addItem(v.id, `${group.displayName} (${v.label})`, v.price);
        } else if (available.length > 1) {
          openVariantPicker(group, "add");
        }
      }
      return;
    }

    // Qty controls (regular in-cart items)
    const minus = e.target.closest(".qty-minus");
    if (minus) { removeItem(minus.dataset.id); return; }
    const plus = e.target.closest(".qty-plus");
    if (plus) {
      const card = plus.closest(".menu-card");
      if (card) addItem(card.dataset.id, card.dataset.name, Number(card.dataset.price));
    }
  });
}

/**
 * Quick-lookup Map for full item objects by Firestore document ID.
 * [AI UPDATE 2026-08-02] Phase 1
 */
let _itemsById = new Map();

/**
 * [AI UPDATE 2026-08-02] UX upgrade — group objects keyed by groupKey.
 * Looked up by _wireCardEvents when the ADD button on a group card is clicked.
 */
let _groupsById = new Map();

/**
 * [AI UPDATE 2026-08-02] UX upgrade — items from the "Extra Topping" Firestore
 * category, kept separate so item-sheet.js can use them as auto-extra prices.
 * These items are NEVER shown in the menu or category tabs.
 */
let _extraToppings = [];
export function getAllExtraToppings() { return _extraToppings; }

/**
 * Categories permanently hidden from the menu UI.
 * Items in these categories are used internally (e.g. as extra-option prices)
 * but never displayed as menu cards or category tabs.
 */
const HIDDEN_CATEGORIES = new Set(["extra topping"]);

/** Pizza-size availability — updated by the sizes listener. */
let _pizzaSizes = { regular: true, medium: true, large: true };

// ── Public ────────────────────────────────────────────────────

export function initMenu() {
  showLoading(true);
  // Clean up all existing listeners
  if (_unsub)        { _unsub();        _unsub        = null; }
  if (_unsubSizes)   { _unsubSizes();   _unsubSizes   = null; }
  if (_unsubProducts){ _unsubProducts();_unsubProducts = null; }
  if (_unsubCats)    { _unsubCats();    _unsubCats    = null; }
  _catDisplayOrderMap.clear();

  // ── Listen to pizza-size availability (billing panel toggle) ──
  _unsubSizes = onSnapshot(doc(db, "settings", "pizza_sizes"), (snap) => {
    if (snap.exists()) {
      const d = snap.data();
      _pizzaSizes = {
        regular: d.regular !== false,
        medium:  d.medium  !== false,
        large:   d.large   !== false,
      };
    } else {
      _pizzaSizes = { regular: true, medium: true, large: true };
    }
    // Re-render immediately so size changes reflect without page refresh
    applyFilter();
  }, (err) => {
    console.warn("[menu] pizza_sizes listener error:", err.message);
  });

  // ── Detect which schema is active, then start the right listener ──
  //
  // New schema (products + categories): Admin Panel >= 2026-08-03
  //   Check is a one-shot getDocs; if non-empty we subscribe with onSnapshot.
  // Legacy schema (menu_items): original flat collection.
  //   Used when products is empty OR the check fails (network error, etc.).
  getDocs(collection(db, "products")).then((prodCheck) => {
    if (!prodCheck.empty) {
      // ── New schema path ──────────────────────────────────────────
      console.log("[menu] Using new products/categories schema.");
      _startProductsListener();
    } else {
      // ── Legacy path ──────────────────────────────────────────────
      console.log("[menu] products empty — using legacy menu_items schema.");
      _startMenuItemsListener();
    }
  }).catch((err) => {
    console.warn("[menu] products check failed, falling back to menu_items:", err.message);
    _startMenuItemsListener();
  });
}

// ── New-schema listener (products + categories) ───────────────

/**
 * Subscribe to both `products` and `categories` with onSnapshot.
 * On every snapshot, rebuild the flat item list via _productsToFlatItems()
 * and feed it through the same processing pipeline as the legacy path.
 *
 * Uses a simple dual-snapshot coordinator: both listeners store their latest
 * snapshot and call _onBothReady() which re-renders only when both are available.
 */
function _startProductsListener() {
  let _latestProdSnap = null;
  let _latestCatSnap  = null;

  function _onBothReady() {
    if (!_latestProdSnap || !_latestCatSnap) return;

    // Build catMap: catId → { name, displayOrder, imageUrl }
    const catMap = {};
    _latestCatSnap.docs.forEach(d => {
      catMap[d.id] = {
        name:         d.data().name         || "",
        displayOrder: d.data().displayOrder ?? 999,
        imageUrl:     d.data().imageUrl     || null,
      };
    });

    // Refresh global category display-order map (used by sort + tab render)
    _catDisplayOrderMap.clear();
    Object.values(catMap).forEach(c => {
      if (c.name) _catDisplayOrderMap.set(c.name, c.displayOrder);
    });

    // Convert products snapshot to flat items
    const flatItems = _productsToFlatItems(_latestProdSnap.docs, catMap);
    _processRawItems(flatItems);
  }

  _unsubCats = onSnapshot(collection(db, "categories"), (snap) => {
    _latestCatSnap = snap;
    _onBothReady();
  }, (err) => {
    console.warn("[menu] categories listener error:", err.message);
    // If categories fails, still try to render with whatever prod snapshot we have
    if (_latestProdSnap) _onBothReady();
  });

  _unsubProducts = onSnapshot(collection(db, "products"), (snap) => {
    _latestProdSnap = snap;
    _onBothReady();
  }, (err) => {
    console.error("[menu] products listener error:", err);
    showError("Couldn't load the menu. Please check your connection.");
  });
}

/**
 * Transform a Firestore `products` collection snapshot into the flat item array
 * that the rest of menu.js expects (same shape as `menu_items` documents).
 *
 * For products with variants, one flat item is emitted per variant with name
 * formatted as "ProductName (VariantName)" — e.g. "Margherita Pizza (Regular)".
 * This lets the existing _groupItems() variant-detection regex work unchanged.
 *
 * For products without variants, one flat item is emitted with the product name.
 *
 * Field mapping:
 *   products.categoryName        → item.category
 *   products.extras[].name/price → item.extraOptions[].name/price  (item-sheet)
 *   products.flags.recommended   → item.isFeatured
 *   products.flags.mostOrdered   → item._isMostOrdered
 *   products.flags.casualSnack   → item._isCasualSnack
 *   products.flags.chefPick      → item._isChefPick
 *   products.flags.newArrival    → item.isNew
 *   catMap[categoryId].displayOrder → item._catDisplayOrder
 *
 * @param {FirestoreDocumentSnapshot[]} prodDocs  — docs from products collection
 * @param {Object} catMap  — catId → { name, displayOrder, imageUrl }
 * @returns {Object[]}  flat item array
 */
function _productsToFlatItems(prodDocs, catMap) {
  const items = [];

  prodDocs.forEach(d => {
    const prod = { id: d.id, ...d.data() };

    // Skip fully inactive products
    if (prod.active === false) return;

    const catName      = prod.categoryName || "Other";
    const catEntry     = Object.values(catMap).find(c => c.name === catName) || {};
    const catDispOrder = catEntry.displayOrder ?? 999;

    // Map flags → home-section fields
    const flags          = prod.flags || {};
    const isFeatured     = !!(flags.recommended);
    const _isMostOrdered = !!(flags.mostOrdered);
    const _isCasualSnack = !!(flags.casualSnack);
    const _isChefPick    = !!(flags.chefPick);
    const isNew          = !!(flags.newArrival);

    // Map extras → extraOptions (for item-sheet.js compatibility)
    const extraOptions = (prod.extras || [])
      .filter(e => e.active !== false)
      .map(e => ({ name: e.name || "", price: Number(e.price) || 0 }));

    const base = {
      category:        catName,
      imageUrl:        prod.imageUrl || null,
      description:     prod.description || "",
      extraOptions,
      isFeatured,
      // orderCount: use a synthetic value from flags.mostOrdered so home-sections.js
      // "Most Ordered" section ranks flagged items above unflagged ones.
      orderCount:      _isMostOrdered ? 999 : 0,
      _isMostOrdered,
      _isCasualSnack,
      _isChefPick,
      isNew,
      _catDisplayOrder: catDispOrder,
      _displayOrder:    prod.displayOrder ?? 999,
      displayOrder:     prod.displayOrder ?? 999,
    };

    if (prod.hasVariants && prod.variantsList && prod.variantsList.length > 0) {
      // ── Emit ONE item per parent product with _nativeVariants attached ──────
      //
      // Previously this path expanded every variant into a separate flat item
      // named "ProductName (VariantName)" — e.g. "Frooti (125 ml)", "Frooti (250 ml)".
      // _groupItems() could only re-collapse a hardcoded set of size suffixes
      // (Half / Full / Regular / Medium / Large), so any other label ("125 ml",
      // "Small", "600 ml", "1 L", etc.) was left as a standalone card — causing
      // the duplicates the user reported.
      //
      // Fix: keep the parent product name intact and carry all variant data as
      // _nativeVariants. _groupItems() detects this property and converts the
      // item into a group object directly — no regex needed.
      const nativeVariants = prod.variantsList
        .filter(v => v.active !== false)
        .map(v => ({
          id:       v.id || `${prod.id}_${(v.name || "").replace(/\s+/g, "_")}`,
          label:    v.name || "",
          price:    Number(v.price) || 0,
          imageUrl: v.imageUrl || null,   // null = fall back to parent imageUrl in item-sheet
          oos:      v.inStock === false || prod.inStock === false,
        }));

      if (nativeVariants.length > 0) {
        // Use cheapest variant as the sort-key price ("Starting from ₹X")
        const minPrice = Math.min(...nativeVariants.map(v => v.price));
        const entry = {
          ...base,
          id:              prod.id,
          name:            prod.name || "",
          price:           minPrice,
          _nativeVariants: nativeVariants,
        };
        if (prod.inStock === false) entry.inStock = false;
        items.push(entry);
      }
    } else {
      const entry = {
        ...base,
        id:    prod.id,
        name:  prod.name || "",
        price: Number(prod.price) || 0,
      };
      if (prod.inStock === false) entry.inStock = false;
      items.push(entry);
    }
  });

  return items;
}

// ── Legacy listener (menu_items) ──────────────────────────────

function _startMenuItemsListener() {
  _unsub = onSnapshot(query(collection(db, MENU_COLLECTION)), (snap) => {
    const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    _processRawItems(raw);
  }, (err) => {
    console.error("[menu] Firestore error:", err);
    showError("Couldn't load the menu. Please check your connection.");
  });
}

// ── Shared snapshot processor ─────────────────────────────────

/**
 * Process a raw flat-item array (from either menu_items or _productsToFlatItems).
 * Splits off Extra Topping items, sorts, builds lookup maps, and renders.
 */
function _processRawItems(raw) {
  // Keep ALL items — do NOT filter by availability here.
  // OOS items are shown with a badge and ordering disabled.

  // [AI UPDATE 2026-08-02] UX upgrade — split Extra Topping into separate pool
  _extraToppings = raw.filter(i =>
    HIDDEN_CATEGORIES.has((i.category || "").toLowerCase().trim())
  );
  const visibleRaw = raw.filter(i =>
    !HIDDEN_CATEGORIES.has((i.category || "").toLowerCase().trim())
  );

  allItems = _sortItems(visibleRaw);

  // Phase 1 — quick-lookup Map for item sheet
  _itemsById.clear();
  for (const item of allItems) _itemsById.set(item.id, item);

  if (allItems.length === 0) {
    showError("No menu items available.\nCheck Firestore collection.");
    return;
  }

  renderCategoryTabs(allItems);
  applyFilter();
  showLoading(false);
  document.getElementById("menuGrid")?.classList.remove("hidden");
}

/** Called by search.js on every keystroke. */
export function filterBySearch(term) {
  activeSearch = term.trim().toLowerCase();
  const catNav = document.getElementById("categoryNav");
  if (catNav) catNav.style.display = activeSearch ? "none" : "";
  applyFilter();
}

// ── Out-of-Stock helpers ──────────────────────────────────────

/**
 * Returns true if this individual item is out of stock.
 * Checks item-level flags AND pizza-size availability from the billing panel.
 */
function _isItemOos(item) {
  if (item.inStock   === false) return true;
  if (item.available === false) return true;
  // Pizza size check — driven by settings/pizza_sizes in Firestore
  if (_isPizzaVariant(item)) {
    const size = _getPizzaSize(item);
    if (size && !_pizzaSizes[size]) return true;
  }
  return false;
}

function _isPizzaVariant(item) {
  return /\(\s*(regular|medium|large)\s*\)/i.test(item.name || "");
}

function _getPizzaSize(item) {
  if (/\(\s*regular\s*\)/i.test(item.name || "")) return "regular";
  if (/\(\s*medium\s*\)/i.test(item.name  || "")) return "medium";
  if (/\(\s*large\s*\)/i.test(item.name   || "")) return "large";
  return null;
}

// ── Variant name helpers ──────────────────────────────────────

/** Strip all variant labels → lowercase base for grouping / sorting */
function _vBase(name) {
  return name.replace(/\s*\(\s*(half|full|regular|medium|large)\s*\)\s*/gi, '').trim().toLowerCase();
}

/** Strip variant labels → display name (preserves original casing) */
function _displayBase(name) {
  return name.replace(/\s*\(\s*(half|full|regular|medium|large)\s*\)\s*/gi, '').trim();
}

const _isHalf    = n => /\(\s*half\s*\)/i.test(n);
const _isFull    = n => /\(\s*full\s*\)/i.test(n);
const _isRegular = n => /\(\s*regular\s*\)/i.test(n);
const _isMedium  = n => /\(\s*medium\s*\)/i.test(n);
const _isLarge   = n => /\(\s*large\s*\)/i.test(n);
const _isVariant = n => _isHalf(n) || _isFull(n) || _isRegular(n) || _isMedium(n) || _isLarge(n);

// ── Sort: categories A→Z, items cheapest→most expensive within each ───────

function _sortItems(items) {
  // Compute group min price keyed by "category::base" so groups stay within
  // their own category (avoids cross-category price comparisons).
  // Use only in-stock items for pricing reference so OOS items don't distort sort.
  const groupMin = {};
  items.forEach(item => {
    if (_isItemOos(item)) return;   // skip OOS for price reference
    const cat   = (item.category || 'Other').toLowerCase();
    const key   = `${cat}::${_vBase(item.name)}`;
    const price = Number(item.price) || 0;
    if (!(key in groupMin) || price < groupMin[key]) groupMin[key] = price;
  });
  // Fallback: OOS-only items still need a sort key
  items.forEach(item => {
    const cat  = (item.category || 'Other').toLowerCase();
    const key  = `${cat}::${_vBase(item.name)}`;
    if (!(key in groupMin)) groupMin[key] = Number(item.price) || 0;
  });

  // For pizza: use the Regular-variant price as the canonical sort key
  const pizzaMin = {};
  items.forEach(item => {
    if ((item.category || '').toLowerCase() !== 'pizza') return;
    const key   = `pizza::${_vBase(item.name)}`;
    const price = Number(item.price) || 0;
    if (_isRegular(item.name)) {
      pizzaMin[key] = price;               // Regular = canonical
    } else if (!(key in pizzaMin)) {
      pizzaMin[key] = price;               // fallback if no Regular
    }
  });

  return [...items].sort((a, b) => {
    const catA = (a.category || 'Other').toLowerCase();
    const catB = (b.category || 'Other').toLowerCase();

    // 1. Sort categories by Admin-defined displayOrder when using new schema;
    //    fall back to alphabetical for legacy menu_items.
    if (_catDisplayOrderMap.size > 0) {
      const orderA = _catDisplayOrderMap.get(a.category || 'Other') ?? 999;
      const orderB = _catDisplayOrderMap.get(b.category || 'Other') ?? 999;
      if (orderA !== orderB) return orderA - orderB;
    }
    const catCmp = catA.localeCompare(catB, undefined, { sensitivity: 'base' });
    if (catCmp !== 0) return catCmp;

    // 2. Within the same category: sort by group min price (cheapest first)
    const baseA = _vBase(a.name);
    const baseB = _vBase(b.name);
    const keyA  = `${catA}::${baseA}`;
    const keyB  = `${catB}::${baseB}`;

    const minA = catA === 'pizza'
      ? (pizzaMin[`pizza::${baseA}`] ?? groupMin[keyA] ?? 0)
      : (groupMin[keyA] ?? 0);
    const minB = catB === 'pizza'
      ? (pizzaMin[`pizza::${baseB}`] ?? groupMin[keyB] ?? 0)
      : (groupMin[keyB] ?? 0);

    if (minA !== minB) return minA - minB;

    // 3. Same group min → keep group together by base name
    if (baseA !== baseB) return baseA.localeCompare(baseB);

    // 4. Same base name → sort by individual price (Regular < Medium < Large)
    return (Number(a.price) || 0) - (Number(b.price) || 0);
  });
}

// ── Filter + render ───────────────────────────────────────────

function applyFilter() {
  let items;
  if (activeSearch) {
    const q = activeSearch;
    // [AI UPDATE 2026-08-02] Phase 5 prep — search now also checks description
    items = allItems.filter(i =>
      (i.name        || "").toLowerCase().includes(q) ||
      (i.category    || "").toLowerCase().includes(q) ||
      (i.description || "").toLowerCase().includes(q)
    );
    _hideHomeSections();
    renderMenuItems(items, q);
  } else if (activeCategory === "All" && !_forceFlat && _renderHomeSectionsCb) {
    // [AI UPDATE 2026-08-03] Phase 3 — show intelligent home sections
    // Pre-populate _groupsById so ADD button handlers work on home section cards
    const grouped = _groupItems(allItems);
    _groupsById.clear();
    for (const g of grouped) {
      if (g.isGroup) _groupsById.set(g.groupKey, g);
    }
    _showHomeSections();
    _renderHomeSectionsCb(allItems, grouped);
  } else {
    items = activeCategory === "All"
      ? allItems
      : allItems.filter(i => (i.category || "Other") === activeCategory);
    _hideHomeSections();
    renderMenuItems(items, "");
  }
}

// [AI UPDATE 2026-08-03] Phase 3 — show/hide helpers
function _showHomeSections() {
  const grid = document.getElementById("menuGrid");
  if (grid) { grid.innerHTML = ""; grid.classList.add("hidden"); }
  document.getElementById("homeSections")?.classList.remove("hidden");
}

function _hideHomeSections() {
  document.getElementById("homeSections")?.classList.add("hidden");
  document.getElementById("menuGrid")?.classList.remove("hidden");
}

// ── Category tabs ─────────────────────────────────────────────

function renderCategoryTabs(items) {
  const cats = [...new Set(items.map(i => i.category || "Other"))].sort((a, b) => {
    // Use Admin-defined displayOrder when using new schema; fall back to alphabetical.
    if (_catDisplayOrderMap.size > 0) {
      const orderA = _catDisplayOrderMap.get(a) ?? 999;
      const orderB = _catDisplayOrderMap.get(b) ?? 999;
      if (orderA !== orderB) return orderA - orderB;
    }
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
  const categories = ["All", ...cats];
  const scroll     = document.querySelector(".category-scroll");
  if (!scroll) return;

  if (!categories.includes(activeCategory)) activeCategory = "All";

  scroll.innerHTML = categories
    .map(cat =>
      `<button class="cat-btn${cat === activeCategory ? " active" : ""}"
               data-cat="${escHtml(cat)}">${escHtml(cat)}</button>`
    ).join("");

  scroll.addEventListener("click", (e) => {
    const btn = e.target.closest(".cat-btn");
    if (!btn) return;
    _selectCategory(btn.dataset.cat);
  });

  // [AI UPDATE 2026-08-02] Phase 2 — notify category-fab.js with updated list
  const itemCounts = {};
  categories.forEach(cat => {
    itemCounts[cat] = cat === "All"
      ? items.length
      : items.filter(i => (i.category || "Other") === cat).length;
  });
  _onCategoriesReadyCb?.(categories, itemCounts);
}

/**
 * Shared category-selection logic used by both the tab strip click handler
 * and the exported setActiveCategory (called by category-fab.js).
 * [AI UPDATE 2026-08-02] Phase 2
 */
function _selectCategory(cat) {
  _forceFlat = false; // [AI UPDATE 2026-08-03] Reset flat override on explicit category pick
  const scroll = document.querySelector(".category-scroll");
  if (scroll) {
    scroll.querySelectorAll(".cat-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.cat === cat);
    });
    // Scroll the active tab into view
    const activeBtn = scroll.querySelector(`.cat-btn[data-cat="${CSS.escape(cat)}"]`);
    activeBtn?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }
  activeCategory = cat;
  const si = document.getElementById("searchInput");
  if (si) si.value = "";
  activeSearch = "";
  const catNav = document.getElementById("categoryNav");
  if (catNav) catNav.style.display = "";
  applyFilter();
}

/**
 * Programmatically activate a category — called by category-fab.js.
 * [AI UPDATE 2026-08-02] Phase 2
 */
export function setActiveCategory(cat) {
  _selectCategory(cat);
}

// ── Main renderer — pairs up variants ────────────────────────

function renderMenuItems(items, query) {
  const grid = document.getElementById("menuGrid");
  if (!grid) return;

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="menu-empty">
        <span>🍽️</span>
        <p>${query ? `No results for "<strong>${escHtml(query)}</strong>"` : "No items in this category."}</p>
      </div>`;
    _wireCardEvents(grid);
    return;
  }

  // [AI UPDATE 2026-08-02] UX upgrade — all variants collapsed into a single
  // premium card. _groupItems() merges Half/Full and Regular/Medium/Large
  // variants into group objects; single items pass through unchanged.
  const grouped = _groupItems(items);
  _groupsById.clear();
  for (const g of grouped) {
    if (g.isGroup) _groupsById.set(g.groupKey, g);
  }

  const frag = document.createDocumentFragment();
  for (const entry of grouped) {
    if (entry.isGroup) {
      frag.appendChild(_createGroupCard(entry, query));
    } else {
      frag.appendChild(_createRegularCard(entry, query));
    }
  }

  grid.innerHTML = "";
  grid.appendChild(frag);
  _wireCardEvents(grid);
  // [AI UPDATE 2026-08-01] Restore saved cart quantities/UI after every render.
  restoreCartUI();
  // [AI UPDATE 2026-08-02] Phase 1 — show "Read More" only on cards where
  // description text actually overflows the 2-line clamp.
  requestAnimationFrame(() => _wireReadMore(grid));
}

// ── Variant grouping ──────────────────────────────────────────

/**
 * [AI UPDATE 2026-08-02] UX upgrade — collapses variant Firestore docs into
 * group objects so every product shows ONE premium card regardless of how many
 * sizes it has.  Single items (no variant suffix) pass through unchanged.
 *
 * Returns an array of either:
 *   { isGroup: false, ...originalItem }
 *   {
 *     isGroup: true, groupKey, displayName, category,
 *     imageUrl, description, extraOptions,
 *     variants: [{ id, label, price, oos }]
 *   }
 */
function _groupItems(items) {
  const result    = [];
  const processed = new Set();

  for (const item of items) {
    if (processed.has(item.id)) continue;

    // ── Native variants (new products schema) ────────────────────────────────
    // Items emitted by _productsToFlatItems() for hasVariants products carry
    // a _nativeVariants array. Convert directly to a group object — no regex.
    if (item._nativeVariants && item._nativeVariants.length > 0) {
      processed.add(item.id);
      const groupKey = `${item.id}::${(item.category || "Other").toLowerCase()}`;
      result.push({
        ...item,
        isGroup:     true,
        groupKey,
        displayName: item.name,
        variants:    item._nativeVariants,
      });
      continue;
    }

    if (_isVariant(item.name)) {
      const base = _vBase(item.name);
      const cat  = item.category || "Other";

      // Collect every known variant type for this base+category
      const half = items.find(i => !processed.has(i.id) && _isHalf(i.name)    && _vBase(i.name) === base && (i.category || "Other") === cat);
      const full = items.find(i => !processed.has(i.id) && _isFull(i.name)    && _vBase(i.name) === base && (i.category || "Other") === cat);
      const reg  = items.find(i => !processed.has(i.id) && _isRegular(i.name) && _vBase(i.name) === base && (i.category || "Other") === cat);
      const med  = items.find(i => !processed.has(i.id) && _isMedium(i.name)  && _vBase(i.name) === base && (i.category || "Other") === cat);
      const lrg  = items.find(i => !processed.has(i.id) && _isLarge(i.name)   && _vBase(i.name) === base && (i.category || "Other") === cat);

      const variants = [];
      if (half) { variants.push({ id: half.id, label: "Half",    price: half.price, oos: _isItemOos(half) }); processed.add(half.id); }
      if (full) { variants.push({ id: full.id, label: "Full",    price: full.price, oos: _isItemOos(full) }); processed.add(full.id); }
      if (reg)  { variants.push({ id: reg.id,  label: "Regular", price: reg.price,  oos: _isItemOos(reg)  }); processed.add(reg.id);  }
      if (med)  { variants.push({ id: med.id,  label: "Medium",  price: med.price,  oos: _isItemOos(med)  }); processed.add(med.id);  }
      if (lrg)  { variants.push({ id: lrg.id,  label: "Large",   price: lrg.price,  oos: _isItemOos(lrg)  }); processed.add(lrg.id);  }

      if (variants.length > 0) {
        if (!processed.has(item.id)) processed.add(item.id);
        const rep      = reg || half || med || full || lrg || item;
        const groupKey = `${base}::${cat.toLowerCase()}`;
        result.push({
          // [AI UPDATE 2026-08-03] Phase 3 — spread all rep fields so
          // isFeatured, orderCount, isNew, displayOrder, createdAt, etc.
          // are available to home-sections.js without extra Firestore reads.
          ...rep,
          isGroup:      true,
          groupKey,
          displayName:  _displayBase(item.name),
          category:     cat,
          imageUrl:     rep.imageUrl     || "",
          description:  rep.description  || "",
          extraOptions: rep.extraOptions || [],
          variants,
        });
        continue;
      }
    }

    if (!processed.has(item.id)) {
      processed.add(item.id);
      result.push({ isGroup: false, ...item });
    }
  }

  return result;
}

// ── Card builders ─────────────────────────────────────────────

/**
 * [AI UPDATE 2026-08-02] Phase 1 — Premium card layout:
 *   LEFT  — product image with shimmer placeholder + lazy load
 *   RIGHT — name, description (2-line clamp + Read More), price, ADD button
 *
 * ADD button now opens the Item Details Sheet instead of calling
 * addItem() directly. The qty control (shown when item is in cart)
 * still calls addItem/removeItem directly — no sheet opened for
 * increments/decrements of items already in cart.
 */
function _createRegularCard(item, query) {
  const div   = document.createElement('div');
  const label = query ? highlight(item.name || "", query) : escHtml(item.name || "");
  const price = item.price || 0;
  const oos   = _isItemOos(item);
  const desc  = item.description || "";
  const imgUrl = item.imageUrl   || "";

  div.className     = `menu-card${oos ? ' oos' : ''}`;
  div.dataset.id    = item.id;
  div.dataset.name  = item.name || "";
  div.dataset.price = price;

  // Image area — always rendered; hides itself via CSS if no src
  const imgHtml = imgUrl
    ? `<div class="card-img-wrap">
         <div class="card-img-shimmer"></div>
         <img class="card-img"
              src="${escHtml(imgUrl)}"
              alt="${escHtml(item.name || '')}"
              loading="lazy"
              decoding="async"
              onload="this.classList.add('card-img--loaded');this.previousElementSibling.style.display='none'"
              onerror="this.closest('.card-img-wrap').style.display='none'" />
       </div>`
    : `<div class="card-img-wrap card-img-wrap--empty">
         <span class="card-img-emoji">🍽️</span>
       </div>`;

  // Description with 2-line clamp; Read More button shown by _wireReadMore
  const descHtml = desc
    ? `<p class="card-desc">${escHtml(desc)}</p>
       <button class="card-desc-more" type="button" style="display:none">Read More</button>`
    : "";

  div.innerHTML = `
    <div class="card-body">
      ${imgHtml}
      <div class="card-info">
        <h3 class="card-name">${label}</h3>
        ${descHtml}
        ${oos ? '<span class="oos-badge">Out of Stock</span>' : ''}
        <div class="card-footer-inline">
          <span class="card-price">₹${price}</span>
          <div class="card-action">
            ${oos
              ? '<button class="btn-add btn-oos" disabled>Unavailable</button>'
              : `<button class="btn-add"
                         data-id="${escHtml(item.id)}"
                         data-name="${escHtml(item.name || "")}"
                         data-price="${price}">ADD</button>`
            }
          </div>
        </div>
      </div>
    </div>`;
  return div;
}

/**
 * After the grid is in the DOM, check each .card-desc for overflow and
 * reveal the "Read More" button only when the text is actually clamped.
 * [AI UPDATE 2026-08-02] Phase 1
 */
function _wireReadMore(grid) {
  grid.querySelectorAll('.card-desc').forEach(el => {
    const btn = el.nextElementSibling;
    if (!btn || !btn.classList.contains('card-desc-more')) return;
    // scrollHeight > clientHeight means the text overflows the 2-line clamp
    if (el.scrollHeight > el.clientHeight + 2) {
      btn.style.display = 'block';
    }
  });
}

/**
 * [AI UPDATE 2026-08-02] UX upgrade — ONE card for all variant groups.
 * Shows cheapest available price as "Starting from ₹X".
 * ADD opens item sheet with variant radio buttons.
 */
function _createGroupCard(group, query) {
  const div = document.createElement('div');

  const availableVariants = group.variants.filter(v => !v.oos);
  const lowestPrice = availableVariants.length
    ? Math.min(...availableVariants.map(v => v.price))
    : Math.min(...group.variants.map(v => v.price));
  const allOos = group.variants.every(v => v.oos);
  const variantIds = group.variants.map(v => v.id).join(',');

  const label = query
    ? highlight(group.displayName, query)
    : escHtml(group.displayName);

  const imgHtml = group.imageUrl
    ? `<div class="card-img-wrap">
         <div class="card-img-shimmer"></div>
         <img class="card-img"
              src="${escHtml(group.imageUrl)}"
              alt="${escHtml(group.displayName)}"
              loading="lazy" decoding="async"
              onload="this.classList.add('card-img--loaded');this.previousElementSibling.style.display='none'"
              onerror="this.closest('.card-img-wrap').style.display='none'" />
       </div>`
    : `<div class="card-img-wrap card-img-wrap--empty">
         <span class="card-img-emoji">🍽️</span>
       </div>`;

  const descHtml = group.description
    ? `<p class="card-desc">${escHtml(group.description)}</p>
       <button class="card-desc-more" type="button" style="display:none">Read More</button>`
    : "";

  div.className = `menu-card menu-card--group${allOos ? " oos" : ""}`;
  div.dataset.id         = `group__${group.groupKey}`;
  div.dataset.name       = group.displayName;
  div.dataset.groupKey   = group.groupKey;
  div.dataset.variantIds = variantIds;

  div.innerHTML = `
    <div class="card-body">
      ${imgHtml}
      <div class="card-info">
        <h3 class="card-name">${label}</h3>
        ${descHtml}
        ${allOos ? '<span class="oos-badge">Out of Stock</span>' : ''}
        <div class="card-footer-inline">
          <div>
            <span class="card-price-from">From</span>
            <span class="card-price">₹${lowestPrice}</span>
          </div>
          <div class="card-action">
            <div class="group-cart-badge" style="display:none">0</div>
            ${allOos
              ? '<button class="btn-add btn-oos" disabled>Unavailable</button>'
              : `<button class="btn-add" data-group-key="${escHtml(group.groupKey)}">ADD</button>`
            }
          </div>
        </div>
      </div>
    </div>`;
  return div;
}

function _createHalfFullCard(halfItem, fullItem) {
  const div  = document.createElement('div');
  div.className = 'half-full-card';

  const side = (item, label) => {
    const oos = _isItemOos(item);
    return `
      <div class="half-full-side${oos ? ' oos' : ''}"
           data-id="${item.id}"
           data-name="${escHtml(item.name)}"
           data-price="${item.price}"
           data-oos="${oos ? '1' : '0'}">
        <div class="hf-remove" data-id="${item.id}" title="Remove">✕</div>
        <div class="half-full-label">${label}</div>
        <div class="half-full-price">₹${item.price}</div>
        ${oos
          ? '<div class="oos-badge oos-badge--side">Out of Stock</div>'
          : `<div class="hf-qty" data-id="${item.id}">0</div>`
        }
      </div>`;
  };

  div.innerHTML = `
    <div class="half-full-heading">${escHtml(_displayBase(halfItem.name))}</div>
    <div class="half-full-body">
      ${side(halfItem, 'Half')}
      <div class="half-full-divider"></div>
      ${side(fullItem, 'Full')}
    </div>`;
  return div;
}

function _createTripleCard(reg, med, lrg) {
  const div = document.createElement('div');
  div.className = 'triple-card';

  const side = (item, label) => {
    const oos = _isItemOos(item);
    return `
      <div class="triple-side${oos ? ' oos' : ''}"
           data-id="${item.id}"
           data-name="${escHtml(item.name)}"
           data-price="${item.price}"
           data-oos="${oos ? '1' : '0'}">
        <div class="triple-remove" data-id="${item.id}" title="Remove">✕</div>
        <div class="triple-label">${label}</div>
        <div class="triple-price">₹${item.price}</div>
        ${oos
          ? '<div class="oos-badge oos-badge--side">Out of Stock</div>'
          : `<div class="triple-qty" data-id="${item.id}">0</div>`
        }
      </div>`;
  };

  div.innerHTML = `
    <div class="triple-heading">${escHtml(_displayBase(reg.name))}</div>
    <div class="triple-body">
      ${side(reg, 'Regular')}
      <div class="triple-divider"></div>
      ${side(med, 'Medium')}
      <div class="triple-divider"></div>
      ${side(lrg, 'Large')}
    </div>`;
  return div;
}

// ── Event delegation ──────────────────────────────────────────

/**
 * [AI UPDATE 2026-08-02] UX upgrade — simplified event delegation.
 * Group cards and regular cards both open item sheet on ADD.
 * In-cart qty controls (regular cards only) still call addItem/removeItem directly.
 */
function _wireCardEvents(grid) {
  const fresh = grid.cloneNode(true);
  grid.parentNode?.replaceChild(fresh, grid);

  fresh.addEventListener("click", (e) => {

    // ── Description Read More / Read Less ──────────────────────
    const moreBtn = e.target.closest(".card-desc-more");
    if (moreBtn) {
      e.stopPropagation();
      const descEl = moreBtn.previousElementSibling;
      if (descEl?.classList.contains("card-desc")) {
        const expanded = descEl.classList.toggle("card-desc--expanded");
        moreBtn.textContent = expanded ? "Read Less" : "Read More";
      }
      return;
    }

    // ── ADD button — opens item sheet for single items or groups ─
    const addBtn = e.target.closest(".btn-add");
    if (addBtn && !addBtn.disabled) {
      // Group card
      if (addBtn.dataset.groupKey) {
        const group = _groupsById.get(addBtn.dataset.groupKey);
        if (group) { openItemSheet(group); return; }
      }
      // Single-item card
      const item = _itemsById.get(addBtn.dataset.id);
      if (item) { openItemSheet(item); return; }
      // Fallback
      addItem(addBtn.dataset.id, addBtn.dataset.name, Number(addBtn.dataset.price));
      return;
    }

    // ── Group card qty controls — variant picker intercept ─────
    // Must be checked BEFORE the generic .qty-minus / .qty-plus
    // because group qty buttons carry both classes.
    const groupMinus = e.target.closest(".qty-minus--group");
    if (groupMinus) {
      const groupKey = groupMinus.dataset.groupKey;
      const group    = _groupsById.get(groupKey);
      if (group) {
        const inCart = group.variants.filter(v => (cart.get(v.id)?.qty || 0) > 0);
        if (inCart.length === 1) {
          removeItem(inCart[0].id);
        } else if (inCart.length > 1) {
          openVariantPicker(group, "remove");
        }
      }
      return;
    }

    const groupPlus = e.target.closest(".qty-plus--group");
    if (groupPlus) {
      const groupKey = groupPlus.dataset.groupKey;
      const group    = _groupsById.get(groupKey);
      if (group) {
        const available = group.variants.filter(v => !v.oos);
        if (available.length === 1) {
          const v = available[0];
          addItem(v.id, `${group.displayName} (${v.label})`, v.price);
        } else if (available.length > 1) {
          openVariantPicker(group, "add");
        }
      }
      return;
    }

    // ── Regular card in-cart qty controls (no sheet) ────────────
    const minus = e.target.closest(".qty-minus");
    if (minus) { removeItem(minus.dataset.id); return; }
    const plus = e.target.closest(".qty-plus");
    if (plus) {
      const card = plus.closest(".menu-card");
      if (card) addItem(card.dataset.id, card.dataset.name, Number(card.dataset.price));
      return;
    }
  });
}

// ── Loading / error ───────────────────────────────────────────

function showLoading(visible) {
  document.getElementById("loadingState")?.classList.toggle("hidden", !visible);
  if (visible) document.getElementById("menuGrid")?.classList.add("hidden");
}

function showError(msg) {
  showLoading(false);
  const state = document.getElementById("errorState");
  const text  = document.getElementById("errorText");
  if (text) text.textContent = msg;
  state?.classList.remove("hidden");
}

// ── Helpers ───────────────────────────────────────────────────

function highlight(text, query) {
  if (!query) return escHtml(text);
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return escHtml(text).replace(re, '<mark class="search-highlight">$1</mark>');
}

function escHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
