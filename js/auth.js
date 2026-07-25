/**
 * auth.js
 * ─────────────────────────────────────────────────────────────
 * Custom OTP verification via Fast2SMS (no Firebase Phone Auth).
 *
 * Flow:
 *   Customer browses freely → taps "Place Order" → if not logged in →
 *   OTP modal appears → enters name and phone → Fast2SMS sends OTP →
 *   customer enters 6-digit code → verified in JS → order placed.
 *
 * Session is stored in localStorage so the customer stays logged in
 * across page reloads (until they explicitly log out).
 */

// ── One-time cleanup: purge old localStorage-based login data ────────────────
const _OLD_KEYS = ["qrmenu_login", "qrmenu_moved_to_history", "qrmenu_orders"];
_OLD_KEYS.forEach((k) => {
  if (localStorage.getItem(k) !== null) {
    localStorage.removeItem(k);
    console.info("[auth] Removed legacy key:", k);
  }
});

// ── Session storage key ───────────────────────────────────────────────────────
const SESSION_KEY = "qrmenu_user"; // stores { name, phone }

// ── Module state ─────────────────────────────────────────────────────────────
let _currentUser         = _loadSession();  // { name, phone } | null
let _pendingCb           = null;            // callback to run after login
let _pendingCustomerName = "";              // name entered in step 1
let _expectedOTP         = null;           // 6-digit string generated on send

// ── Public API ────────────────────────────────────────────────────────────────

/** Always true — no async Firebase check needed. */
export function isAuthReady() { return true; }

/** True when a verified session exists in localStorage. */
export function isLoggedIn() { return !!_currentUser; }

/**
 * Returns { name, phone, uid } for the current user, or null.
 * uid is empty string (Fast2SMS has no Firebase UID concept).
 */
export function getLoginInfo() {
  return _currentUser ? { ..._currentUser, uid: "" } : null;
}

/**
 * Ensures the user is logged in, then calls cb().
 * If already signed in, cb() fires immediately.
 * Otherwise the OTP modal is shown first.
 */
export function requireLogin(cb) {
  if (_currentUser) { cb(); return; }
  _pendingCb = cb;
  _showModal();
}

/** Wire DOM events. Call once from app.js after DOMContentLoaded. */
export function initAuth() {
  document.getElementById("otpPhoneForm")
    ?.addEventListener("submit", _onPhoneSubmit);
  document.getElementById("otpCodeForm")
    ?.addEventListener("submit", _onOTPSubmit);
  document.getElementById("otpChangePhone")
    ?.addEventListener("click", _showPhoneStep);
  document.getElementById("headerLogoutBtn")
    ?.addEventListener("click", _onLogout);
  _updateGreeting();
}

/**
 * Calls cb immediately with the current user (or null).
 * Synchronous because there is no async Firebase check.
 */
export function onAuthReady(cb) {
  cb(_currentUser);
}

/** Refresh the customer chip in the header. */
export function updateGreeting() { _updateGreeting(); }

// ── OTP Modal lifecycle ───────────────────────────────────────────────────────

function _showModal() {
  const modal = document.getElementById("otpModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  _showPhoneStep();
}

function _hideModal() {
  document.getElementById("otpModal")?.classList.add("hidden");
  document.body.style.overflow = "";
}

function _showPhoneStep() {
  document.getElementById("otpPhoneStep")?.classList.remove("hidden");
  document.getElementById("otpCodeStep")?.classList.add("hidden");
  _clearError("otpNameError");
  _clearError("otpPhoneError");
  _clearError("otpCodeError");
  document.getElementById("otpNameInput")?.focus();
}

function _showCodeStep(phone) {
  document.getElementById("otpPhoneStep")?.classList.add("hidden");
  document.getElementById("otpCodeStep")?.classList.remove("hidden");
  const sub = document.getElementById("otpCodeSubtitle");
  if (sub) sub.textContent = `OTP sent to +91\u00a0${phone}`;
  document.getElementById("otpCodeInput").value = "";
  document.getElementById("otpCodeInput")?.focus();
}

// ── Phone submission — generate OTP + call Fast2SMS ──────────────────────────

async function _onPhoneSubmit(e) {
  e.preventDefault();
  _clearError("otpNameError");
  _clearError("otpPhoneError");

  const name  = (document.getElementById("otpNameInput")?.value || "").trim();
  const raw   = document.getElementById("otpPhoneInput")?.value || "";
  const phone = raw.replace(/\D/g, "").slice(-10);

  if (name.length < 2) {
    _setError("otpNameError", "Please enter your name.");
    document.getElementById("otpNameInput")?.focus();
    return;
  }

  if (phone.length !== 10) {
    _setError("otpPhoneError", "Enter a valid 10-digit mobile number.");
    return;
  }

  _pendingCustomerName = name;
  _setLoadingBtn("otpSendBtn", true, "Sending…");

  // Generate a random 6-digit OTP
  _expectedOTP = String(Math.floor(100000 + Math.random() * 900000));

  try {
    const url = `https://www.fast2sms.com/dev/bulkV2?authorization=VzIykBwZrPlaNCJ9n0sXgxo1QLfmuKvUtjqdORTecbY462WiME4FOC6baxz5AmKlq2o0IgvJkEyZVfst&variables_values=${_expectedOTP}&route=otp&numbers=${phone}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (!data.return) {
      // Fast2SMS returns { return: true } on success
      throw new Error(data.message || "Failed to send OTP. Please try again.");
    }

    _showCodeStep(phone);
  } catch (err) {
    console.error("[auth] Fast2SMS send:", err);
    _expectedOTP = null;
    _setError("otpPhoneError", err.message || "Could not send OTP. Check your number and try again.");
  } finally {
    _setLoadingBtn("otpSendBtn", false, "Send OTP");
  }
}

// ── OTP verification ──────────────────────────────────────────────────────────

async function _onOTPSubmit(e) {
  e.preventDefault();
  _clearError("otpCodeError");

  const code = (document.getElementById("otpCodeInput")?.value || "").trim();

  if (code.length !== 6) {
    _setError("otpCodeError", "Enter the 6-digit OTP you received.");
    return;
  }

  if (!_expectedOTP) {
    _setError("otpCodeError", "Session expired. Please go back and resend OTP.");
    return;
  }

  _setLoadingBtn("otpVerifyBtn", true, "Verifying…");

  // Slight async tick so the button state renders before we compare
  await new Promise((r) => setTimeout(r, 300));

  if (code === _expectedOTP) {
    // ✅ Correct OTP — persist session and proceed
    _currentUser = { name: _pendingCustomerName, phone: document.getElementById("otpPhoneInput")?.value.replace(/\D/g, "").slice(-10) };
    _saveSession(_currentUser);
    _expectedOTP = null;

    _updateGreeting();
    _dispatchAuthChange(_currentUser);
    _hideModal();

    alert("Login Successful");

    const cb = _pendingCb;
    _pendingCb           = null;
    _pendingCustomerName = "";
    if (cb) cb();
  } else {
    // ❌ Wrong OTP
    _setError("otpCodeError", "Invalid OTP. Please try again.");
    _setLoadingBtn("otpVerifyBtn", false, "Verify OTP");
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function _onLogout() {
  if (!confirm("Log out? You'll need to verify your phone again before placing the next order.")) return;
  _currentUser = null;
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem("qrmenu_history");
  localStorage.removeItem("qrmenu_moved_to_history");
  _dispatchAuthChange(null);
  location.reload();
}

// ── Custom auth-state event (replaces onAuthStateChanged) ─────────────────────

function _dispatchAuthChange(user) {
  window.dispatchEvent(new CustomEvent("customAuthStateChanged", { detail: { user } }));
}

// ── Greeting chip ─────────────────────────────────────────────────────────────

function _updateGreeting() {
  const chip      = document.getElementById("customerChip");
  const logoutBtn = document.getElementById("headerLogoutBtn");

  if (_currentUser?.name) {
    if (chip) {
      chip.textContent = `👤 ${_currentUser.name}`;
      chip.classList.remove("hidden");
    }
    logoutBtn?.classList.remove("hidden");
  } else {
    chip?.classList.add("hidden");
    logoutBtn?.classList.add("hidden");
  }
}

// ── Session helpers ───────────────────────────────────────────────────────────

function _loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function _saveSession(user) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } catch (_) {}
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function _setError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}

function _clearError(id) {
  const el = document.getElementById(id);
  if (el) { el.textContent = ""; el.classList.add("hidden"); }
}

function _setLoadingBtn(id, loading, text) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled    = loading;
  btn.textContent = text;
}
