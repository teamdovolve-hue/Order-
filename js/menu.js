/**
 * menu.js
 * ─────────────────────────────────────────────────────────────
 * Fetches menu items from Firestore and renders them to the DOM.
 * Supports real-time search and category filtering.
 *
 * Firestore collection: menu_items
 * Required fields: name (string), price (number)
 * Optional: category, description, available/inStock (boolean)
 */

import { db }                              from "./firebase-config.js";
import { collection, getDocs }
                                           from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { addItem, removeItem }             from "./cart.js";

// ── ✏️  Change this to match your Firestore collection name ───
const MENU_COLLECTION = "menu_items";

// ── Module-level state ────────────────────────────────────────
let allItems       = [];
let activeCategory = "All";
let activeSearch   = "";

// ── Public: load, render, wire events ────────────────────────
export async function initMenu() {
  showLoading(true);

  try {
    allItems = await fetchMenuItems();

    if (allItems.length === 0) {
      showError("No menu items found.\nCheck the Firestore collection name.");
      return;
    }

    renderCategoryTabs(allItems);
    applyFilter();
    showLoading(false);
    document.getElementById("menuGrid")?.classList.remove("hidden");
  } catch (err) {
    console.error("[menu.js] Firestore fetch failed:", err);
    showError("Couldn't load the menu.\nCheck your Firebase config.");
  }
}

/**
 * Called by search.js on every keystroke.
 * Overrides category filter when a query is active.
 */
export function filterBySearch(query) {
  activeSearch = query.trim().toLowerCase();

  // When searching, collapse category tabs
  const catNav = document.getElementById("categoryNav");
  if (catNav) catNav.style.display = activeSearch ? "none" : "";

  applyFilter();
}

// ── Fetch from Firestore ──────────────────────────────────────
async function fetchMenuItems() {
  const ref  = collection(db, MENU_COLLECTION);
  const snap = await getDocs(ref);

  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => item.inStock !== false && item.available !== false)
    .sort((a, b) => {
      const catA = (a.category || "Other").toLowerCase();
      const catB = (b.category || "Other").toLowerCase();
      if (catA !== catB) return catA < catB ? -1 : 1;
      return (a.name || "").toLowerCase() < (b.name || "").toLowerCase() ? -1 : 1;
    });
}

// ── Combined filter (search + category) ──────────────────────
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

// ── Build category tabs ───────────────────────────────────────
function renderCategoryTabs(items) {
  const categories = ["All", ...new Set(items.map((i) => i.category || "Other"))];
  const scroll     = document.querySelector(".category-scroll");
  if (!scroll) return;

  scroll.innerHTML = categories
    .map(
      (cat) =>
        `<button class="cat-btn${cat === "All" ? " active" : ""}" data-cat="${cat}">${escHtml(cat)}</button>`
    )
    .join("");

  scroll.addEventListener("click", (e) => {
    const btn = e.target.closest(".cat-btn");
    if (!btn) return;
    scroll.querySelectorAll(".cat-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeCategory = btn.dataset.cat;
    // Clear search when switching category
    const input = document.getElementById("searchInput");
    const clear = document.getElementById("searchClear");
    if (input) { input.value = ""; }
    if (clear)  { clear.classList.add("hidden"); }
    activeSearch = "";
    document.getElementById("categoryNav").style.display = "";
    applyFilter();
  });
}

// ── Render item cards ─────────────────────────────────────────
function renderMenuItems(items, highlight = "") {
  const grid = document.getElementById("menuGrid");
  if (!grid) return;

  if (items.length === 0) {
    const msg = highlight
      ? `No results for "<strong>${escHtml(highlight)}</strong>"`
      : "No items in this category.";
    grid.innerHTML = `<p class="menu-empty-msg">${msg}</p>`;
    return;
  }

  if (highlight) {
    // Search results: flat list, no section labels
    grid.innerHTML = items.map((i) => buildCardHTML(i, highlight)).join("");
  } else {
    // Category view: grouped by section
    const grouped = groupByCategory(items);
    let html = "";
    for (const [cat, catItems] of Object.entries(grouped)) {
      html += `<div class="section-label">${escHtml(cat)}</div>`;
      for (const item of catItems) html += buildCardHTML(item, "");
    }
    grid.innerHTML = html;
  }

  attachCardListeners(grid);
}

// ── Build a single card's HTML ────────────────────────────────
function buildCardHTML(item, highlight) {
  const desc  = item.description
    ? `<p class="card-desc">${highlight ? highlightText(escHtml(item.description), highlight) : escHtml(item.description)}</p>`
    : "";

  const price    = Number(item.price || 0);
  const priceStr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(price);
  const nameHtml = highlight
    ? highlightText(escHtml(item.name), highlight)
    : escHtml(item.name);

  return `
    <div class="menu-card"
         data-id="${item.id}"
         data-name="${escHtml(item.name)}"
         data-price="${price}">
      <div class="card-info">
        <div class="card-name">${nameHtml}</div>
        ${desc}
        <div class="card-price">${priceStr}</div>
      </div>
      <div class="card-action">
        <button class="btn-add"
                data-id="${item.id}"
                data-name="${escHtml(item.name)}"
                data-price="${price}">
          Add
        </button>
      </div>
    </div>`;
}

/** Wrap matched text in a highlight span. */
function highlightText(html, query) {
  if (!query) return html;
  const re = new RegExp(`(${escRegex(query)})`, "gi");
  return html.replace(re, `<mark class="search-highlight">$1</mark>`);
}

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Delegate click events on the grid ────────────────────────
function attachCardListeners(grid) {
  // Remove previous listener by replacing node
  const fresh = grid.cloneNode(true);
  grid.parentNode?.replaceChild(fresh, grid);
  const g = document.getElementById("menuGrid");

  g.addEventListener("click", (e) => {
    const addBtn = e.target.closest(".btn-add");
    if (addBtn) { addItem(addBtn.dataset.id, addBtn.dataset.name, addBtn.dataset.price); return; }

    const plusBtn = e.target.closest(".qty-plus");
    if (plusBtn) { addItem(plusBtn.dataset.id, getNameFromCard(plusBtn), getPriceFromCard(plusBtn)); return; }

    const minusBtn = e.target.closest(".qty-minus");
    if (minusBtn) removeItem(minusBtn.dataset.id);
  });
}

// ── Helpers ───────────────────────────────────────────────────
function groupByCategory(items) {
  return items.reduce((acc, item) => {
    const cat = item.category || "Other";
    (acc[cat] = acc[cat] || []).push(item);
    return acc;
  }, {});
}

function getNameFromCard(el) { return el.closest(".menu-card")?.dataset.name || ""; }
function getPriceFromCard(el) { return el.closest(".menu-card")?.dataset.price || 0; }

function escHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Loading / error helpers ───────────────────────────────────
function showLoading(visible) {
  document.getElementById("loadingState")?.classList.toggle("hidden", !visible);
  document.getElementById("errorState")?.classList.add("hidden");
}

function showError(msg) {
  showLoading(false);
  const state = document.getElementById("errorState");
  const text  = document.querySelector(".error-text");
  if (state) state.classList.remove("hidden");
  if (text)  text.innerHTML = msg.replace(/\n/g, "<br/>");
}
