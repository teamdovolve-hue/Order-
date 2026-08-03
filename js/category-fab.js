/**
 * category-fab.js
 * ─────────────────────────────────────────────────────────────
 * Phase 2 — Floating Category FAB + Category Bottom Sheet
 * [AI UPDATE 2026-08-02]
 *
 * A floating circular button fixed to the bottom-right lets customers
 * jump to any menu category without scrolling back to the top.
 *
 * Exports:
 *   initCategoryFab()  — call once in boot sequence after initMenu()
 *
 * Communicates with menu.js via:
 *   onCategoriesReady(cb)  — receives (categories[], itemCounts{}) after
 *                            each Firestore snapshot render
 *   setActiveCategory(cat) — triggers the same logic as clicking a tab
 */

import { onCategoriesReady, setActiveCategory } from "./menu.js";

// ── DOM refs (set in initCategoryFab) ────────────────────────
let _fab     = null;
let _modal   = null;
let _list    = null;
let _isOpen  = false;

// ── State ─────────────────────────────────────────────────────
let _categories  = [];
let _itemCounts  = {};

// ── Public ────────────────────────────────────────────────────

export function initCategoryFab() {
  _fab   = document.getElementById("categoryFab");
  _modal = document.getElementById("categoryFabModal");
  _list  = document.getElementById("categoryFabList");

  if (!_fab || !_modal || !_list) return;

  // Receive category list from menu.js whenever Firestore data updates
  onCategoriesReady((cats, counts) => {
    _categories = cats;
    _itemCounts = counts;
    _renderList();
  });

  // FAB open
  _fab.addEventListener("click", () => {
    if (_isOpen) { _close(); return; }
    _renderList();
    _open();
  });

  // Backdrop close
  _modal.querySelector(".category-fab-backdrop")
    ?.addEventListener("click", _close);

  // Drag handle tap closes
  _modal.querySelector(".category-fab-drag-handle")
    ?.addEventListener("click", _close);

  // Hide FAB when item sheet or review sheet opens; restore when they close
  _watchOtherModals();
}

// ── Private ───────────────────────────────────────────────────

function _open() {
  _modal.classList.remove("hidden");
  _isOpen = true;
  _fab.classList.add("fab--open");
  // Trap scroll behind sheet
  document.body.style.overflow = "hidden";
}

function _close() {
  _modal.classList.add("hidden");
  _isOpen = false;
  _fab.classList.remove("fab--open");
  document.body.style.overflow = "";
}

function _renderList() {
  if (!_list) return;
  _list.innerHTML = _categories.map(cat => {
    const count = _itemCounts[cat] ?? 0;
    const icon  = _categoryIcon(cat);
    return `
      <button class="category-fab-row" data-cat="${_esc(cat)}">
        <span class="category-fab-icon">${icon}</span>
        <span class="category-fab-name">${_esc(cat)}</span>
        <span class="category-fab-count">${count}</span>
      </button>`;
  }).join("");

  _list.querySelectorAll(".category-fab-row").forEach(btn => {
    btn.addEventListener("click", () => {
      setActiveCategory(btn.dataset.cat);
      _close();
      // Scroll category nav strip into view so the active tab is visible
      requestAnimationFrame(() => {
        document.getElementById("categoryNav")
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    });
  });
}

/**
 * Hide the FAB while item sheet or review sheet is open so it doesn't
 * overlap those modals. Uses a MutationObserver on the hidden class.
 */
function _watchOtherModals() {
  const targets = [
    document.getElementById("itemSheetModal"),
    document.getElementById("reviewModal"),
  ].filter(Boolean);

  if (!targets.length) return;

  const obs = new MutationObserver(() => {
    const anyOpen = targets.some(el => !el.classList.contains("hidden"));
    _fab.style.opacity    = anyOpen ? "0"    : "";
    _fab.style.pointerEvents = anyOpen ? "none" : "";
    if (anyOpen && _isOpen) _close();
  });

  targets.forEach(el =>
    obs.observe(el, { attributes: true, attributeFilter: ["class"] })
  );
}

/** Simple emoji icons per category — fallback to 🍽️ */
function _categoryIcon(cat) {
  const map = {
    "All"             : "🍽️",
    "Burger"          : "🍔",
    "Pizza"           : "🍕",
    "Pasta"           : "🍝",
    "Sandwich"        : "🥪",
    "Wrap"            : "🌯",
    "Salad"           : "🥗",
    "Soup"            : "🍲",
    "Dessert"         : "🍰",
    "Cake"            : "🎂",
    "Coffee"          : "☕",
    "Cold Coffee"     : "🧋",
    "Juice"           : "🧃",
    "Mocktail"        : "🍹",
    "Shake"           : "🥤",
    "Drink"           : "🥤",
    "Starter"         : "🥟",
    "Chinese Starter" : "🥡",
    "Snack"           : "🍟",
    "Chocolate"       : "🍫",
    "Ice Cream"       : "🍨",
  };
  // Try exact match, then case-insensitive prefix match
  if (map[cat]) return map[cat];
  const key = Object.keys(map).find(k =>
    cat.toLowerCase().includes(k.toLowerCase())
  );
  return key ? map[key] : "🍽️";
}

function _esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
