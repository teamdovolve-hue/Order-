/**
 * menu.js
 * ─────────────────────────────────────────────────────────────
 * Fetches menu items from Firestore and renders them to the DOM.
 *
 * ── Firestore collection layout ──────────────────────────────
 * Collection : menu_items          ← change MENU_COLLECTION if yours differs
 * Each document must have:
 *   name     : string   e.g. "Paneer Tikka"
 *   price    : number   e.g. 220
 * Optional fields (shown when present):
 *   category : string   e.g. "Starters"    (used for tab filter)
 *   description : string                   (shown under name)
 *   available : boolean (default true)     (false = item skipped)
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
    renderMenuItems(allItems);
    showLoading(false);
    document.getElementById("menuGrid").classList.remove("hidden");
  } catch (err) {
    console.error("[menu.js] Firestore fetch failed:", err);
    showError("Couldn't load the menu.\nCheck your Firebase config.");
  }
}

// ── Fetch from Firestore ──────────────────────────────────────
async function fetchMenuItems() {
  const ref  = collection(db, MENU_COLLECTION);
  const snap = await getDocs(ref); // no orderBy → no composite index needed

  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => item.available !== false) // skip unavailable items
    .sort((a, b) => {
      // sort client-side: category first, then name
      const catA = (a.category || "Other").toLowerCase();
      const catB = (b.category || "Other").toLowerCase();
      if (catA !== catB) return catA < catB ? -1 : 1;
      return (a.name || "").toLowerCase() < (b.name || "").toLowerCase() ? -1 : 1;
    });
}

// ── Build category tabs ───────────────────────────────────────
function renderCategoryTabs(items) {
  const categories = ["All", ...new Set(items.map((i) => i.category || "Other"))];
  const scroll     = document.querySelector(".category-scroll");
  if (!scroll) return;

  scroll.innerHTML = categories
    .map(
      (cat) =>
        `<button class="cat-btn${cat === "All" ? " active" : ""}" data-cat="${cat}">${cat}</button>`
    )
    .join("");

  scroll.addEventListener("click", (e) => {
    const btn = e.target.closest(".cat-btn");
    if (!btn) return;
    scroll.querySelectorAll(".cat-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeCategory = btn.dataset.cat;
    filterMenu();
  });
}

// ── Filter by active category ─────────────────────────────────
function filterMenu() {
  const filtered =
    activeCategory === "All"
      ? allItems
      : allItems.filter((i) => (i.category || "Other") === activeCategory);
  renderMenuItems(filtered);
}

// ── Render item cards ─────────────────────────────────────────
function renderMenuItems(items) {
  const grid = document.getElementById("menuGrid");
  if (!grid) return;

  if (items.length === 0) {
    grid.innerHTML = `<p style="color:var(--text-3);text-align:center;padding:40px 0;">No items in this category.</p>`;
    return;
  }

  // Group by category for section labels
  const grouped = groupByCategory(items);
  let html = "";

  for (const [cat, catItems] of Object.entries(grouped)) {
    html += `<div class="section-label">${escHtml(cat)}</div>`;
    for (const item of catItems) {
      html += buildCardHTML(item);
    }
  }

  grid.innerHTML = html;
  attachCardListeners(grid);
}

// ── Build a single card's HTML ────────────────────────────────
function buildCardHTML(item) {
  const desc = item.description
    ? `<p class="card-desc">${escHtml(item.description)}</p>`
    : "";

  const price = Number(item.price || 0);
  const priceStr = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(price);

  return `
    <div class="menu-card"
         data-id="${item.id}"
         data-name="${escHtml(item.name)}"
         data-price="${price}">
      <div class="card-info">
        <div class="card-name">${escHtml(item.name)}</div>
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

// ── Delegate click events on the grid ────────────────────────
function attachCardListeners(grid) {
  grid.addEventListener("click", (e) => {
    // "Add" button
    const addBtn = e.target.closest(".btn-add");
    if (addBtn) {
      addItem(addBtn.dataset.id, addBtn.dataset.name, addBtn.dataset.price);
      return;
    }

    // "+" button
    const plusBtn = e.target.closest(".qty-plus");
    if (plusBtn) {
      addItem(plusBtn.dataset.id, getNameFromCard(plusBtn), getPriceFromCard(plusBtn));
      return;
    }

    // "−" button
    const minusBtn = e.target.closest(".qty-minus");
    if (minusBtn) {
      removeItem(minusBtn.dataset.id);
    }
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

function getNameFromCard(el) {
  return el.closest(".menu-card")?.dataset.name || "";
}

function getPriceFromCard(el) {
  return el.closest(".menu-card")?.dataset.price || 0;
}

function escHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Loading / error state helpers ─────────────────────────────
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
