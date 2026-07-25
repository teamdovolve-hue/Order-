/**
 * search.js
 * ─────────────────────────────────────────────────────────────
 * Real-time menu search. Delegates rendering back to menu.js
 * via the onSearch callback passed to initSearch().
 */

let _onSearch = null;

/**
 * Wire search bar events.
 * @param {function(string): void} onSearch  Called with query on every keystroke.
 */
export function initSearch(onSearch) {
  _onSearch = onSearch;

  const input = document.getElementById("searchInput");
  const clear = document.getElementById("searchClear");
  if (!input) return;

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    clear?.classList.toggle("hidden", !q);
    _onSearch(q);
    // Scroll to top of content when typing
    if (q) document.getElementById("mainContent")?.scrollTo({ top: 0, behavior: "smooth" });
  });

  clear?.addEventListener("click", () => {
    input.value = "";
    clear.classList.add("hidden");
    _onSearch("");
    input.focus();
  });

  // Close keyboard on Enter
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
  });
}

/** Returns current search query (lowercase). */
export function getSearchQuery() {
  return (document.getElementById("searchInput")?.value || "").trim().toLowerCase();
}
