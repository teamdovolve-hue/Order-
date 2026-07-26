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
 */

import { db } from "./firebase-config.js";
import {
  collection, onSnapshot, query,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { addItem, removeItem } from "./cart.js";

const MENU_COLLECTION = "menu_items";

let allItems       = [];
let activeCategory = "All";
let activeSearch   = "";
let _unsub         = null;

// ── Public ────────────────────────────────────────────────────

export function initMenu() {
  showLoading(true);
  if (_unsub) { _unsub(); _unsub = null; }

  _unsub = onSnapshot(query(collection(db, MENU_COLLECTION)), (snap) => {
    const raw = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter(_isAvailable);

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

// ── Availability ──────────────────────────────────────────────

function _isAvailable(item) {
  if (item.inStock   === false) return false;
  if (item.available === false) return false;
  if (Array.isArray(item.sizes) && item.sizes.length > 0) {
    return item.sizes.some(s => s.available !== false && s.inStock !== false);
  }
  return true;
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

// ── Sort: cheapest → most expensive by group min price ────────

function _sortItems(items) {
  // Compute min price per variant group (for all non-pizza items)
  const groupMin = {};
  items.forEach(item => {
    const base  = _vBase(item.name);
    const price = Number(item.price) || 0;
    if (!(base in groupMin) || price < groupMin[base]) groupMin[base] = price;
  });

  // For pizza: use Regular price as the sort key for the whole group
  const pizzaMin = {};
  items.forEach(item => {
    if ((item.category || '').toLowerCase() !== 'pizza') return;
    const base  = _vBase(item.name);
    const price = Number(item.price) || 0;
    if (_isRegular(item.name)) {
      pizzaMin[base] = price; // Regular price = canonical group sort key
    } else if (!(base in pizzaMin)) {
      pizzaMin[base] = price; // fallback if no Regular variant
    }
  });

  return [...items].sort((a, b) => {
    const isPizzaA = (a.category || '').toLowerCase() === 'pizza';
    const isPizzaB = (b.category || '').toLowerCase() === 'pizza';
    const baseA    = _vBase(a.name);
    const baseB    = _vBase(b.name);

    if (isPizzaA && isPizzaB) {
      const minA = pizzaMin[baseA] ?? groupMin[baseA] ?? 0;
      const minB = pizzaMin[baseB] ?? groupMin[baseB] ?? 0;
      if (minA !== minB) return minA - minB;
      if (baseA !== baseB) return baseA.localeCompare(baseB);
      return (Number(a.price) || 0) - (Number(b.price) || 0);
    }

    if (!isPizzaA && !isPizzaB) {
      const minA = groupMin[baseA] ?? 0;
      const minB = groupMin[baseB] ?? 0;
      if (minA !== minB) return minA - minB;
      if (baseA !== baseB) return baseA.localeCompare(baseB);
      return (Number(a.price) || 0) - (Number(b.price) || 0);
    }

    // Mixed categories: sort by category name
    return (a.category || '').toLowerCase().localeCompare((b.category || '').toLowerCase());
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
  const categories = ["All", ...new Set(items.map(i => i.category || "Other"))];
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
}

// ── Card builders ─────────────────────────────────────────────

function _createRegularCard(item, query) {
  const div   = document.createElement('div');
  const label = query ? highlight(item.name || "", query) : escHtml(item.name || "");
  const price = item.price || 0;

  div.className    = 'menu-card';
  div.dataset.id   = item.id;
  div.dataset.name = item.name || "";
  div.dataset.price= price;

  div.innerHTML = `
    <div class="card-body">
      <div class="card-info">
        <h3 class="card-name">${label}</h3>
      </div>
      <div class="card-footer-inline">
        <span class="card-price">₹${price}</span>
        <div class="card-action">
          <button class="btn-add"
                  data-id="${escHtml(item.id)}"
                  data-name="${escHtml(item.name || "")}"
                  data-price="${price}">Add</button>
        </div>
      </div>
    </div>`;
  return div;
}

function _createHalfFullCard(halfItem, fullItem) {
  const div = document.createElement('div');
  div.className = 'half-full-card';

  const side = (item, label) => `
    <div class="half-full-side"
         data-id="${item.id}"
         data-name="${escHtml(item.name)}"
         data-price="${item.price}">
      <div class="hf-remove" data-id="${item.id}" title="Remove">✕</div>
      <div class="half-full-label">${label}</div>
      <div class="half-full-price">₹${item.price}</div>
      <div class="hf-qty" data-id="${item.id}">0</div>
    </div>`;

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

  const side = (item, label) => `
    <div class="triple-side"
         data-id="${item.id}"
         data-name="${escHtml(item.name)}"
         data-price="${item.price}">
      <div class="triple-remove" data-id="${item.id}" title="Remove">✕</div>
      <div class="triple-label">${label}</div>
      <div class="triple-price">₹${item.price}</div>
      <div class="triple-qty" data-id="${item.id}">0</div>
    </div>`;

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
    if (addBtn) {
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
    if (hfSide) { addItem(hfSide.dataset.id, hfSide.dataset.name, Number(hfSide.dataset.price)); return; }

    // ── Triple ──
    const trRemove = e.target.closest(".triple-remove");
    if (trRemove) { e.stopPropagation(); removeItem(trRemove.dataset.id); return; }
    const trSide = e.target.closest(".triple-side");
    if (trSide) { addItem(trSide.dataset.id, trSide.dataset.name, Number(trSide.dataset.price)); return; }
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
