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
 * Sort: cheapest → most expensive (group min price across all categories).
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
 */

import { db } from "./firebase-config.js";
import {
  collection, doc, onSnapshot, query,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { addItem, removeItem, restoreCartUI } from "./cart.js";

const MENU_COLLECTION  = "menu_items";
const SIZES_DOC        = "settings/pizza_sizes";   // billing panel writes here

let allItems       = [];
let activeCategory = "All";
let activeSearch   = "";
let _unsub         = null;
let _unsubSizes    = null;

/** Pizza-size availability — updated by the sizes listener. */
let _pizzaSizes = { regular: true, medium: true, large: true };

// ── Public ────────────────────────────────────────────────────

export function initMenu() {
  showLoading(true);
  if (_unsub)      { _unsub();      _unsub      = null; }
  if (_unsubSizes) { _unsubSizes(); _unsubSizes = null; }

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

  // ── Listen to menu items ──
  _unsub = onSnapshot(query(collection(db, MENU_COLLECTION)), (snap) => {
    // Keep ALL items — do NOT filter by availability here.
    // OOS items are shown with a badge and ordering disabled.
    const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    allItems = _sortItems(raw);

    if (allItems.length === 0) {
      showError("No menu items available.\nCheck Firestore collection.");
      return;
    }

    renderCategoryTabs(allItems);
    applyFilter();
    showLoading(false);
    document.getElementById("menuGrid")?.classList.remove("hidden");
  }, (err) => {
    console.error("[menu] Firestore error:", err);
    showError("Couldn't load the menu. Please check your connection.");
  });
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

    // 1. Sort categories alphabetically (A → Z)
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
    items = allItems.filter(i =>
      (i.name     || "").toLowerCase().includes(q) ||
      (i.category || "").toLowerCase().includes(q)
    );
    renderMenuItems(items, q);
  } else {
    items = activeCategory === "All"
      ? allItems
      : allItems.filter(i => (i.category || "Other") === activeCategory);
    renderMenuItems(items, "");
  }
}

// ── Category tabs ─────────────────────────────────────────────

function renderCategoryTabs(items) {
  const cats = [...new Set(items.map(i => i.category || "Other"))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
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
    scroll.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeCategory = btn.dataset.cat;
    const si = document.getElementById("searchInput");
    if (si) si.value = "";
    activeSearch = "";
    const catNav = document.getElementById("categoryNav");
    if (catNav) catNav.style.display = "";
    applyFilter();
  });
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

  const frag      = document.createDocumentFragment();
  const processed = new Set();

  items.forEach(item => {
    if (processed.has(item.id)) return;

    // ── Triple card (Regular / Medium / Large) ──
    if (_isVariant(item.name)) {
      const base = _vBase(item.name);
      const reg = items.find(i => !processed.has(i.id) && _isRegular(i.name) && _vBase(i.name) === base);
      const med = items.find(i => !processed.has(i.id) && _isMedium(i.name)  && _vBase(i.name) === base);
      const lrg = items.find(i => !processed.has(i.id) && _isLarge(i.name)   && _vBase(i.name) === base);
      if (reg && med && lrg) {
        frag.appendChild(_createTripleCard(reg, med, lrg));
        processed.add(reg.id); processed.add(med.id); processed.add(lrg.id);
        return;
      }
    }

    // ── Half / Full card ──
    if (_isHalf(item.name)) {
      const base = _vBase(item.name);
      const full = items.find(i => !processed.has(i.id) && _isFull(i.name) && _vBase(i.name) === base);
      if (full) {
        frag.appendChild(_createHalfFullCard(item, full));
        processed.add(item.id); processed.add(full.id);
        return;
      }
    } else if (_isFull(item.name)) {
      const base = _vBase(item.name);
      const half = items.find(i => !processed.has(i.id) && _isHalf(i.name) && _vBase(i.name) === base);
      if (half) {
        frag.appendChild(_createHalfFullCard(half, item));
        processed.add(half.id); processed.add(item.id);
        return;
      }
    }

    // ── Regular card ──
    frag.appendChild(_createRegularCard(item, query));
    processed.add(item.id);
  });

  grid.innerHTML = "";
  grid.appendChild(frag);
  _wireCardEvents(grid);
  // [AI UPDATE 2026-08-01] Restore saved cart quantities/UI after every render.
  restoreCartUI();
}

// ── Card builders ─────────────────────────────────────────────

function _createRegularCard(item, query) {
  const div   = document.createElement('div');
  const label = query ? highlight(item.name || "", query) : escHtml(item.name || "");
  const price = item.price || 0;
  const oos   = _isItemOos(item);

  div.className    = `menu-card${oos ? ' oos' : ''}`;
  div.dataset.id   = item.id;
  div.dataset.name = item.name || "";
  div.dataset.price= price;

  div.innerHTML = `
    <div class="card-body">
      <div class="card-info">
        <h3 class="card-name">${label}</h3>
        ${oos ? '<span class="oos-badge">Out of Stock</span>' : ''}
      </div>
      <div class="card-footer-inline">
        <span class="card-price">₹${price}</span>
        <div class="card-action">
          ${oos
            ? '<button class="btn-add btn-oos" disabled>Unavailable</button>'
            : `<button class="btn-add"
                       data-id="${escHtml(item.id)}"
                       data-name="${escHtml(item.name || "")}"
                       data-price="${price}">Add</button>`
          }
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

function _wireCardEvents(grid) {
  const fresh = grid.cloneNode(true);
  grid.parentNode?.replaceChild(fresh, grid);

  fresh.addEventListener("click", (e) => {
    // ── Regular card ──
    const addBtn = e.target.closest(".btn-add");
    if (addBtn && !addBtn.disabled) {
      addItem(addBtn.dataset.id, addBtn.dataset.name, Number(addBtn.dataset.price));
      return;
    }
    const minus = e.target.closest(".qty-minus");
    if (minus) { removeItem(minus.dataset.id); return; }
    const plus = e.target.closest(".qty-plus");
    if (plus) {
      const card = plus.closest(".menu-card");
      if (card) addItem(card.dataset.id, card.dataset.name, Number(card.dataset.price));
      return;
    }

    // ── Half/Full ──
    const hfRemove = e.target.closest(".hf-remove");
    if (hfRemove) { e.stopPropagation(); removeItem(hfRemove.dataset.id); return; }
    const hfSide = e.target.closest(".half-full-side");
    if (hfSide && hfSide.dataset.oos !== '1') {
      addItem(hfSide.dataset.id, hfSide.dataset.name, Number(hfSide.dataset.price));
      return;
    }

    // ── Triple ──
    const trRemove = e.target.closest(".triple-remove");
    if (trRemove) { e.stopPropagation(); removeItem(trRemove.dataset.id); return; }
    const trSide = e.target.closest(".triple-side");
    if (trSide && trSide.dataset.oos !== '1') {
      addItem(trSide.dataset.id, trSide.dataset.name, Number(trSide.dataset.price));
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
