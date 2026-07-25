/**
 * menu.js
 * ─────────────────────────────────────────────────────────────
 * Fetches menu items from Firestore using a real-time listener (onSnapshot)
 * so out-of-stock changes from the billing panel reflect instantly.
 *
 * Firestore collection: menu_items
 * Required fields: name (string), price (number)
 * Optional:
 *   category       string
 *   description    string
 *   available      boolean  (false → hide item)
 *   inStock        boolean  (false → hide item)
 *   sizes          array    [{ label, price, available }]
 */

import { db }                              from "./firebase-config.js";
import {
  collection, onSnapshot, query, orderBy,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { addItem, removeItem }             from "./cart.js";

const MENU_COLLECTION = "menu_items";

let allItems       = [];
let activeCategory = "All";
let activeSearch   = "";
let _unsub         = null;

// ── Public ────────────────────────────────────────────────────

export function initMenu() {
  showLoading(true);

  // Stop any previous listener
  if (_unsub) { _unsub(); _unsub = null; }

  const q = query(collection(db, MENU_COLLECTION));

  _unsub = onSnapshot(q, (snap) => {
    allItems = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter(_isAvailable)
      .sort(_sortItems);

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
export function filterBySearch(query) {
  activeSearch = query.trim().toLowerCase();

  const catNav = document.getElementById("categoryNav");
  if (catNav) catNav.style.display = activeSearch ? "none" : "";

  applyFilter();
}

// ── Availability check ────────────────────────────────────────

function _isAvailable(item) {
  // Top-level flags
  if (item.inStock   === false) return false;
  if (item.available === false) return false;

  // If item has sizes, only show if at least one size is available
  if (Array.isArray(item.sizes) && item.sizes.length > 0) {
    const hasAvailableSize = item.sizes.some(
      (s) => s.available !== false && s.inStock !== false
    );
    if (!hasAvailableSize) return false;
  }

  return true;
}

// ── Sort: by category then by name ───────────────────────────

function _sortItems(a, b) {
  const catA = (a.category || "Other").toLowerCase();
  const catB = (b.category || "Other").toLowerCase();
  if (catA !== catB) return catA < catB ? -1 : 1;
  return (a.name || "").toLowerCase() < (b.name || "").toLowerCase() ? -1 : 1;
}

// ── Combined filter ───────────────────────────────────────────

function applyFilter() {
  let items;

  if (activeSearch) {
    const q = activeSearch;
    items = allItems.filter(
      (i) =>
        (i.name        || "").toLowerCase().includes(q) ||
        (i.description || "").toLowerCase().includes(q) ||
        (i.category    || "").toLowerCase().includes(q)
    );
    renderMenuItems(items, q);
  } else {
    items =
      activeCategory === "All"
        ? allItems
        : allItems.filter((i) => (i.category || "Other") === activeCategory);
    renderMenuItems(items, "");
  }
}

// ── Category tabs ─────────────────────────────────────────────

function renderCategoryTabs(items) {
  const categories = ["All", ...new Set(items.map((i) => i.category || "Other"))];
  const scroll     = document.querySelector(".category-scroll");
  if (!scroll) return;

  // Preserve active category if it still exists
  if (!categories.includes(activeCategory)) activeCategory = "All";

  scroll.innerHTML = categories
    .map(
      (cat) =>
        `<button class="cat-btn${cat === activeCategory ? " active" : ""}"
                 data-cat="${escHtml(cat)}">${escHtml(cat)}</button>`
    )
    .join("");

  scroll.addEventListener("click", (e) => {
    const btn = e.target.closest(".cat-btn");
    if (!btn) return;
    scroll.querySelectorAll(".cat-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeCategory = btn.dataset.cat;
    // Clear search when switching category
    const searchInput = document.getElementById("searchInput");
    if (searchInput) searchInput.value = "";
    activeSearch = "";
    const catNav = document.getElementById("categoryNav");
    if (catNav) catNav.style.display = "";
    applyFilter();
  });
}

// ── Menu item cards ───────────────────────────────────────────

function renderMenuItems(items, query) {
  const grid = document.getElementById("menuGrid");
  if (!grid) return;

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="menu-empty">
        <span>🍽️</span>
        <p>${query ? `No results for "<strong>${escHtml(query)}</strong>"` : "No items in this category."}</p>
      </div>`;
    // Wire events after inserting
    _wireCardEvents(grid);
    return;
  }

  grid.innerHTML = items.map((item) => _buildCard(item, query)).join("");
  _wireCardEvents(grid);
}

function _buildCard(item, query) {
  const name  = query ? highlight(item.name        || "", query) : escHtml(item.name || "");
  const desc  = query ? highlight(item.description || "", query) : escHtml(item.description || "");
  const cat   = query ? highlight(item.category    || "", query) : escHtml(item.category || "");

  // Determine display price
  const displayPrice = _getDisplayPrice(item);
  const priceLabel   = Array.isArray(item.sizes) && item.sizes.length > 0
    ? `from ₹${displayPrice}`
    : `₹${displayPrice}`;

  // Sizes chips (if item has size variants)
  const sizesHTML = _buildSizesHTML(item);

  return `
    <div class="menu-card"
         data-id="${escHtml(item.id)}"
         data-name="${escHtml(item.name || "")}"
         data-price="${displayPrice}">
      <div class="card-body">
        ${item.imageUrl ? `<img class="card-img" src="${escHtml(item.imageUrl)}" alt="${escHtml(item.name || "")}" loading="lazy"/>` : ""}
        <div class="card-info">
          <h3 class="card-name">${name}</h3>
          ${cat   ? `<span class="card-category">${cat}</span>` : ""}
          ${desc  ? `<p class="card-desc">${desc}</p>` : ""}
          ${sizesHTML}
          <div class="card-footer">
            <span class="card-price">${priceLabel}</span>
            <div class="card-action">
              <button class="btn-add"
                      data-id="${escHtml(item.id)}"
                      data-name="${escHtml(item.name || "")}"
                      data-price="${displayPrice}">
                Add
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function _getDisplayPrice(item) {
  if (Array.isArray(item.sizes) && item.sizes.length > 0) {
    const available = item.sizes.filter((s) => s.available !== false && s.inStock !== false);
    if (available.length > 0) {
      return Math.min(...available.map((s) => s.price || 0));
    }
  }
  return item.price || 0;
}

function _buildSizesHTML(item) {
  if (!Array.isArray(item.sizes) || item.sizes.length === 0) return "";
  const chips = item.sizes
    .filter((s) => s.available !== false && s.inStock !== false)
    .map(
      (s) => `<span class="size-chip">${escHtml(s.label || "")} ₹${s.price || 0}</span>`
    )
    .join("");
  return chips ? `<div class="size-chips">${chips}</div>` : "";
}

// ── Wire add/remove events (event delegation) ─────────────────

function _wireCardEvents(grid) {
  // Remove previous listener by cloning (prevents duplicate listeners)
  const fresh = grid.cloneNode(true);
  grid.parentNode?.replaceChild(fresh, grid);

  fresh.addEventListener("click", (e) => {
    // Add button
    const addBtn = e.target.closest(".btn-add");
    if (addBtn) {
      addItem(addBtn.dataset.id, addBtn.dataset.name, Number(addBtn.dataset.price));
      return;
    }
    // Qty minus
    const minus = e.target.closest(".qty-minus");
    if (minus) { removeItem(minus.dataset.id); return; }
    // Qty plus
    const plus = e.target.closest(".qty-plus");
    if (plus) {
      const card = plus.closest(".menu-card");
      if (card) addItem(card.dataset.id, card.dataset.name, Number(card.dataset.price));
      return;
    }
  });
}

// ── Loading / error states ────────────────────────────────────

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

// ── Highlight helper ──────────────────────────────────────────

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
