/**
 * customer.js
 * ─────────────────────────────────────────────────────────────
 * Manages customer identity (name + phone) in localStorage.
 * Asked exactly once; remembered across the session.
 *
 * Public API:
 *   getCustomer()          → { name, phone } | null
 *   requireCustomer(cb)    → runs cb() immediately if info exists,
 *                            otherwise shows modal first, then cb()
 */

const STORAGE_KEY = "qrmenu_customer";

/** Returns saved customer or null. */
export function getCustomer() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); }
  catch { return null; }
}

/** Persist customer info. */
export function saveCustomer(name, phone) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: name.trim(), phone: phone.trim() }));
}

/**
 * Call before any cart action.
 * If we already have the customer's info, cb() fires immediately.
 * If not, the modal is shown; cb() fires after a valid submission.
 */
export function requireCustomer(cb) {
  if (getCustomer()) { cb(); return; }
  openCustomerModal(cb);
}

// ── Internal ──────────────────────────────────────────────────
function openCustomerModal(cb) {
  const modal = document.getElementById("customerModal");
  const form  = document.getElementById("customerForm");
  const nameEl  = document.getElementById("custName");
  const phoneEl = document.getElementById("custPhone");
  const errEl   = document.getElementById("custError");

  if (!modal || !form) return;
  modal.classList.remove("hidden");
  nameEl?.focus();

  function onSubmit(e) {
    e.preventDefault();
    const name  = nameEl?.value.trim()  || "";
    const phone = phoneEl?.value.trim() || "";

    // Basic phone validation: 10 digits
    if (!name) { showErr("Please enter your name."); return; }
    if (!/^\d{10}$/.test(phone)) { showErr("Enter a valid 10-digit phone number."); return; }

    saveCustomer(name, phone);
    modal.classList.add("hidden");
    form.removeEventListener("submit", onSubmit);
    if (errEl) errEl.textContent = "";

    // Update greeting chip in header
    updateGreeting();
    cb();
  }

  form.addEventListener("submit", onSubmit);

  function showErr(msg) {
    if (errEl) errEl.textContent = msg;
  }
}

/** Refresh the greeting chip in the header if customer is known. */
export function updateGreeting() {
  const c = getCustomer();
  const chip = document.getElementById("customerChip");
  if (!chip) return;
  if (c) {
    chip.textContent = `👤 ${c.name}`;
    chip.classList.remove("hidden");
  } else {
    chip.classList.add("hidden");
  }
}
