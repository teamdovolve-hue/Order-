/**
 * auth.js
 * ─────────────────────────────────────────────────────────────
 * Customer authentication bridge backed by the Billing Panel's callable
 * functions. OTP UI/handlers remain dormant until DLT approval.
 *
 * Flow:
 *   Customer browses freely → taps "Place Order" → if not logged in →
 *   Temporary bridge: phone lookup → existing customers sign in immediately;
 *   new customers enter a name, confirm it, then create the account.
 *
 * Session is stored in localStorage so the customer stays logged in
 * across page reloads (until they explicitly log out). Firestore stores
 * the permanent customer profile separately from this browser session.
 */

import { auth, functions } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInWithCustomToken,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-functions.js";

// ── One-time cleanup: purge old localStorage-based login data ────────────────
const _OLD_KEYS = ["qrmenu_login", "qrmenu_moved_to_history", "qrmenu_orders"];
_OLD_KEYS.forEach((k) => {
  if (localStorage.getItem(k) !== null) {
    localStorage.removeItem(k);
    console.info("[auth] Removed legacy key:", k);
  }
});

// ── Session storage key ───────────────────────────────────────────────────────
const SESSION_KEY = "qrmenu_user"; // stores { name, phone, uid }
// ── Module state ─────────────────────────────────────────────────────────────
let _currentUser         = _loadSession();  // { name, phone, uid } | null
let _pendingCb           = null;            // callback to run after login
let _pendingPhone        = "";
let _pendingName         = "";
let _firebaseUser        = null;
let _authReadyResolve;
const _authReady         = new Promise((resolve) => { _authReadyResolve = resolve; });

// ── Public API ────────────────────────────────────────────────────────────────

/** Kept for the existing app API; Firebase Auth is initialized on demand. */
export function isAuthReady() { return true; }

/** Resolve after Firebase has restored the persisted customer Auth state. */
export function waitForAuthReady() {
  return _authReady;
}

/** True when a verified session exists in localStorage. */
export function isLoggedIn() { return !!_currentUser; }

/**
 * Returns { name, phone, uid } for the current user, or null.
 */
export function getLoginInfo() {
  if (!_currentUser) return null;
  return {
    ..._currentUser,
    uid: _firebaseUser?.uid || _currentUser.uid || "",
  };
}

/**
 * Ensures the user is logged in, then calls cb().
 * If already signed in, cb() fires after Firebase session restoration.
 * Otherwise the phone modal is shown first.
 */
export function requireLogin(cb) {
  if (_currentUser) {
    _ensureFirebaseSession().then(() => cb()).catch((err) => {
      console.error("[auth] Firebase session restore failed:", err);
      _currentUser = null;
      _saveSession(null);
      _showModal();
    });
    return;
  }
  _pendingCb = cb;
  _showModal();
}

/** Wire DOM events. Call once from app.js after DOMContentLoaded. */
export function initAuth() {
  document.getElementById("otpPhoneForm")
    ?.addEventListener("submit", _onPhoneSubmit);
  document.getElementById("otpProfileForm")
    ?.addEventListener("submit", _onProfileSubmit);
  document.getElementById("otpChangeDetails")
    ?.addEventListener("click", _showProfileStep);
  document.getElementById("otpCreateAccountBtn")
    ?.addEventListener("click", _onCreateAccount);
  document.getElementById("headerLogoutBtn")
    ?.addEventListener("click", _onLogout);
  onAuthStateChanged(auth, (user) => {
    _firebaseUser = user;
    _authReadyResolve(user);
    if (!user && _currentUser) {
      _currentUser = null;
      _saveSession(null);
      _dispatchAuthChange(null);
    } else if (user && _currentUser) {
      _dispatchAuthChange(_currentUser);
    }
  });
  _updateGreeting();
}

/**
 * Calls cb with the locally remembered customer session.
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
  document.getElementById("otpProfileStep")?.classList.add("hidden");
  document.getElementById("otpConfirmStep")?.classList.add("hidden");
  _clearError("otpNameError");
  _clearError("otpPhoneError");
  const phoneInput = document.getElementById("otpPhoneInput");
  phoneInput?.focus();
}

function _showProfileStep() {
  document.getElementById("otpPhoneStep")?.classList.add("hidden");
  document.getElementById("otpProfileStep")?.classList.remove("hidden");
  document.getElementById("otpConfirmStep")?.classList.add("hidden");
  _clearError("otpNameError");
  const nameInput = document.getElementById("otpNameInput");
  if (nameInput) nameInput.value = "";
  nameInput?.focus();
}

// ── Temporary phone bridge ────────────────────────────────────────────────────
// OTP is intentionally not requested while DLT approval is pending. The
// callable still performs the lookup server-side, so the browser never reads
// or enumerates customer profiles directly.

async function _onPhoneSubmit(e) {
  e.preventDefault();
  _clearError("otpPhoneError");

  const raw   = document.getElementById("otpPhoneInput")?.value || "";
  const phone = raw.replace(/\D/g, "");
  if (phone.length !== 10) {
    _setError("otpPhoneError", "Enter a valid 10-digit mobile number.");
    return;
  }

  _pendingPhone = phone;
  _setLoadingBtn("otpSendBtn", true, "Checking…");

  try {
    const customerAuth = httpsCallable(functions, "customerAuth");
    const result = await customerAuth({ action: "lookup", phone: `+91${phone}` });
    const profile = result.data || {};

    // Returning customers do not need an OTP or a second name prompt.
    if (profile.found) {
      await signInWithCustomToken(auth, profile.token);
      await _completeLogin(profile.name, profile.phone || `+91${phone}`, { saveProfile: false });
      return;
    }

    // New customers only move to the name step. No account is created yet.
    _pendingPhone = profile.phone || `+91${phone}`;
    _showProfileStep();
  } catch (err) {
    console.error("[auth] Customer lookup failed:", err);
    _setError("otpPhoneError", "Could not check this number. Please try again.");
  } finally {
    _setLoadingBtn("otpSendBtn", false, "Continue");
  }

}

// ── New customer profile ─────────────────────────────────────────────────────

async function _onProfileSubmit(e) {
  e.preventDefault();
  _clearError("otpNameError");

  const name = (document.getElementById("otpNameInput")?.value || "").trim();
  if (name.length < 2) {
    _setError("otpNameError", "Please enter your name.");
    document.getElementById("otpNameInput")?.focus();
    return;
  }
  if (!_pendingPhone) {
    _setError("otpNameError", "Your login session expired. Please enter your phone again.");
    return;
  }

  _pendingName = name;
  const confirmName = document.getElementById("otpConfirmName");
  const confirmPhone = document.getElementById("otpConfirmPhone");
  if (confirmName) confirmName.textContent = name;
  if (confirmPhone) confirmPhone.textContent = _formatPhone(_pendingPhone);
  document.getElementById("otpProfileStep")?.classList.add("hidden");
  document.getElementById("otpConfirmStep")?.classList.remove("hidden");
}

async function _onCreateAccount() {
  _clearError("otpNameError");
  if (!_pendingName || !_pendingPhone) {
    _showPhoneStep();
    return;
  }
  _setLoadingBtn("otpCreateAccountBtn", true, "Creating…");
  try {
    const customerAuth = httpsCallable(functions, "customerAuth");
    const result = await customerAuth({
      action: "create",
      phone: _pendingPhone,
      name: _pendingName,
    });
    await signInWithCustomToken(auth, result.data.token);
    await _completeLogin(result.data.name || _pendingName, result.data.phone || _pendingPhone, {
      saveProfile: false,
    });
  } catch (err) {
    console.error("[auth] Customer account creation failed:", err);
    _setError("otpNameError", "Could not create your account. Please try again.");
    document.getElementById("otpConfirmStep")?.classList.add("hidden");
    document.getElementById("otpProfileStep")?.classList.remove("hidden");
  } finally {
    _setLoadingBtn("otpCreateAccountBtn", false, "Create Account");
  }
}

async function _completeLogin(name, phone, { saveProfile = true } = {}) {
  if (saveProfile) {
    throw new Error("Direct customer profile writes are disabled; use customerAuth.");
  }
  await _authReady;
  _currentUser = { name, phone, uid: auth.currentUser?.uid || "" };
  _saveSession(_currentUser);
  _updateGreeting();
  _dispatchAuthChange(_currentUser);
  _hideModal();

  const cb = _pendingCb;
  _pendingCb = null;
  _pendingPhone = "";
  _pendingName = "";
  if (cb) cb();
}

async function _ensureFirebaseSession() {
  await _authReady;
  if (auth.currentUser) return auth.currentUser;
  if (!_currentUser?.phone) throw new Error("Customer session is not available.");
  const customerAuth = httpsCallable(functions, "customerAuth");
  const result = await customerAuth({ action: "lookup", phone: _currentUser.phone });
  if (!result.data?.found || !result.data?.token) {
    throw new Error("Customer account was not found.");
  }
  await signInWithCustomToken(auth, result.data.token);
  return auth.currentUser;
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function _onLogout() {
  if (!confirm("Log out? You'll need to verify your phone again before placing the next order.")) return;
  _currentUser = null;
  _pendingPhone = "";
  _pendingName = "";
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem("qrmenu_history");
  localStorage.removeItem("qrmenu_moved_to_history");
  await signOut(auth).catch(() => {});
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

function _formatPhone(phone) {
  const digits = String(phone || "").replace(/^\+91/, "");
  return `+91 ${digits}`;
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
