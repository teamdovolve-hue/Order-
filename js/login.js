/**
 * login.js
 * ─────────────────────────────────────────────────────────────
 * First-time login system (persists across sessions in localStorage).
 *
 * Flow:
 *   1. Truecaller 1-tap (if TRUECALLER_PARTNER_KEY is set)
 *   2. WhatsApp fallback → opens pre-filled message, shows manual form
 *   3. "Having trouble? Please place your order at the cash counter."
 *
 * ⚠️  Configure WHATSAPP_NUMBER below before deploying.
 *     Set TRUECALLER_PARTNER_KEY to your Truecaller partner key,
 *     or leave "" to skip Truecaller entirely.
 */

// ── Config ────────────────────────────────────────────────────
export const WHATSAPP_NUMBER        = "919999999999"; // ← replace with your WhatsApp Business number (no spaces/+)
const        TRUECALLER_PARTNER_KEY = "";             // ← replace with Truecaller partner key, or leave ""

const STORAGE_KEY = "qrmenu_login";

// ── Public API ─────────────────────────────────────────────────

/** Returns saved login info or null. */
export function getLoginInfo() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); }
  catch { return null; }
}

/** Persist login. */
export function saveLoginInfo(name, phone, method = "manual") {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    name:    name.trim(),
    phone:   phone.trim(),
    method,
    loginAt: new Date().toISOString(),
  }));
}

/** Remove login (logout). */
export function clearLoginInfo() {
  localStorage.removeItem(STORAGE_KEY);
}

/** True if user is already logged in. */
export function isLoggedIn() {
  return !!getLoginInfo();
}

/**
 * Ensure user is logged in before running cb().
 * If already logged in, cb() fires immediately.
 * If not, the login screen is shown first.
 */
export function requireLogin(cb) {
  if (isLoggedIn()) { cb(); return; }
  _showLoginScreen(cb);
}

// ── Init (wire DOM events, called once from app.js) ──────────

export function initLogin() {
  const waBtn      = document.getElementById("loginWhatsAppBtn");
  const tcBtn      = document.getElementById("loginTruecallerBtn");
  const manualForm = document.getElementById("loginManualForm");
  const skipBtn    = document.getElementById("loginSkipBtn");
  const logoutBtn  = document.getElementById("headerLogoutBtn");

  waBtn?.addEventListener("click", _onWhatsApp);
  tcBtn?.addEventListener("click", _onTruecaller);
  skipBtn?.addEventListener("click", _showManualForm);
  manualForm?.addEventListener("submit", _onManualSubmit);
  logoutBtn?.addEventListener("click", _onLogout);
  document.getElementById("loginBackBtn")?.addEventListener("click", _showPrimaryPanel);

  // Show or hide Truecaller button based on config
  if (TRUECALLER_PARTNER_KEY && tcBtn) {
    tcBtn.classList.remove("hidden");
    document.getElementById("loginTcDivider")?.classList.remove("hidden");
  }

  // If already logged in, update greeting and skip login screen
  _updateGreeting();
}

// ── Login screen lifecycle ────────────────────────────────────

let _pendingCb = null;

function _showLoginScreen(cb) {
  _pendingCb = cb;
  const screen = document.getElementById("loginScreen");
  if (!screen) { cb(); return; } // safety: no screen → just proceed
  screen.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  if (TRUECALLER_PARTNER_KEY) {
    _attemptTruecaller();
  }
  // else: primary panel already visible with WhatsApp button
}

function _dismissLoginScreen() {
  const screen = document.getElementById("loginScreen");
  if (screen) screen.classList.add("hidden");
  document.body.style.overflow = "";
  _updateGreeting();
  const cb = _pendingCb;
  _pendingCb = null;
  if (cb) cb();
}

// ── Truecaller 1-tap ──────────────────────────────────────────

function _onTruecaller() {
  _setLoginStatus("Connecting to Truecaller…");
  _attemptTruecaller();
}

function _attemptTruecaller() {
  if (!TRUECALLER_PARTNER_KEY) { _showPrimaryPanel(); return; }

  const existing = document.getElementById("_tc_sdk_script");
  if (!existing) {
    const s    = document.createElement("script");
    s.id       = "_tc_sdk_script";
    s.src      = "https://oauth.truecaller.com/v2/sdk/webcall.js";
    s.onload   = _launchTruecaller;
    s.onerror  = () => { _setLoginStatus(""); _showPrimaryPanel(); };
    document.head.appendChild(s);
  } else {
    _launchTruecaller();
  }
}

function _launchTruecaller() {
  try {
    window.TcSdk?.init({
      partnerKey:  TRUECALLER_PARTNER_KEY,
      partnerName: "Menu",
      lang:        "en",
      loginPrefix: "continue",
      loginSuffix: "to order",
      ctaText:     "truecaller",
      btnShape:    "rect",
      skipOption:  "skip",
      onSuccess:   (p) => {
        const name  = p?.firstName || p?.name || "Guest";
        const phone = p?.phoneNumber || "";
        saveLoginInfo(name, phone, "truecaller");
        _dismissLoginScreen();
      },
      onFailure: () => { _setLoginStatus(""); _showPrimaryPanel(); },
    });
  } catch (e) {
    console.warn("[login] Truecaller error:", e);
    _setLoginStatus("");
    _showPrimaryPanel();
  }
}

// ── WhatsApp fallback ─────────────────────────────────────────

function _onWhatsApp() {
  const tableId = new URLSearchParams(window.location.search).get("table") || "your table";
  const msg     = encodeURIComponent(`Hi, verify my login for Table ${tableId} ordering`);
  window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`, "_blank");

  // Show manual form for user to enter details after sending WA msg
  setTimeout(_showManualForm, 500);
  const hint = document.getElementById("loginWaHint");
  if (hint) hint.classList.remove("hidden");
}

// ── Manual form ───────────────────────────────────────────────

function _showManualForm() {
  document.getElementById("loginPrimarySection")?.classList.add("hidden");
  const manual = document.getElementById("loginManualSection");
  if (manual) {
    manual.classList.remove("hidden");
    document.getElementById("loginName")?.focus();
  }
}

function _onManualSubmit(e) {
  e.preventDefault();
  const name  = document.getElementById("loginName")?.value.trim()  || "";
  const phone = document.getElementById("loginPhone")?.value.trim() || "";
  const errEl = document.getElementById("loginError");

  if (!name)                   { _showLoginErr("Please enter your name.");               return; }
  if (!/^\d{10}$/.test(phone)) { _showLoginErr("Enter a valid 10-digit phone number.");  return; }

  if (errEl) { errEl.textContent = ""; errEl.classList.add("hidden"); }
  saveLoginInfo(name, phone, "manual");
  _dismissLoginScreen();
}

function _showLoginErr(msg) {
  const el = document.getElementById("loginError");
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}

function _setLoginStatus(msg) {
  const el = document.getElementById("loginStatus");
  if (el) el.textContent = msg;
}

function _showPrimaryPanel() {
  document.getElementById("loginPrimarySection")?.classList.remove("hidden");
  document.getElementById("loginManualSection")?.classList.add("hidden");
}

// ── Logout ────────────────────────────────────────────────────

function _onLogout() {
  if (!confirm("Log out? You'll need to log in again before placing an order.")) return;
  clearLoginInfo();
  location.reload();
}

// ── Greeting chip ─────────────────────────────────────────────

export function updateGreeting() { _updateGreeting(); }

function _updateGreeting() {
  const c    = getLoginInfo();
  const chip = document.getElementById("customerChip");
  if (!chip) return;
  if (c) {
    chip.textContent = `👤 ${c.name}`;
    chip.classList.remove("hidden");
  } else {
    chip.classList.add("hidden");
  }
}
