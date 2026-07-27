/**
 * auth.js
 * ─────────────────────────────────────────────────────────────
 * Custom OTP verification via Fast2SMS (no Firebase Phone Auth).
 *
 * Flow:
 *   Customer browses freely → taps "Place Order" → if not logged in →
 *   OTP modal appears → enters phone → existing customers continue immediately;
 *   new customers receive an OTP and provide their name after verification.
 *
 * Session is stored in localStorage so the customer stays logged in
 * across page reloads (until they explicitly log out). Firestore stores
 * the permanent customer profile separately from this browser session.
 */

import { db } from "./firebase-config.js";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

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
const CUSTOMER_COLLECTION = "customers";

// ── Module state ─────────────────────────────────────────────────────────────
let _currentUser         = _loadSession();  // { name, phone } | null
let _pendingCb           = null;            // callback to run after login
let _pendingPhone        = "";
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
  document.getElementById("otpProfileForm")
    ?.addEventListener("submit", _onProfileSubmit);
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
  document.getElementById("otpProfileStep")?.classList.add("hidden");
  _clearError("otpNameError");
  _clearError("otpPhoneError");
  _clearError("otpCodeError");
  const phoneInput = document.getElementById("otpPhoneInput");
  phoneInput?.focus();
}

function _showCodeStep(phone) {
  document.getElementById("otpPhoneStep")?.classList.add("hidden");
  document.getElementById("otpCodeStep")?.classList.remove("hidden");
  document.getElementById("otpProfileStep")?.classList.add("hidden");
  const sub = document.getElementById("otpCodeSubtitle");
  if (sub) sub.textContent = `OTP sent to +91\u00a0${phone}`;
  const codeInput = document.getElementById("otpCodeInput");
  if (codeInput) codeInput.value = "";
  document.getElementById("otpCodeInput")?.focus();
}

function _showProfileStep() {
  document.getElementById("otpPhoneStep")?.classList.add("hidden");
  document.getElementById("otpCodeStep")?.classList.add("hidden");
  document.getElementById("otpProfileStep")?.classList.remove("hidden");
  _clearError("otpNameError");
  const nameInput = document.getElementById("otpNameInput");
  if (nameInput) nameInput.value = "";
  nameInput?.focus();
}

// ── DEV BYPASS ────────────────────────────────────────────────────────────────
// Remove these entries when SMS verification is fully configured.
const _DEV_BYPASS_PHONES = new Set(["123456789", "987654321"]);

// ── Phone submission — check profile, then generate OTP if needed ─────────────

async function _onPhoneSubmit(e) {
  e.preventDefault();
  _clearError("otpPhoneError");

  const raw   = document.getElementById("otpPhoneInput")?.value || "";
  const phone = raw.replace(/\D/g, "");
  const isBypassPhone = _DEV_BYPASS_PHONES.has(phone);

  if (!isBypassPhone && phone.length !== 10) {
    _setError("otpPhoneError", "Enter a valid 10-digit mobile number.");
    return;
  }

  _pendingPhone = phone;
  _setLoadingBtn("otpSendBtn", true, "Checking…");

  try {
    const profile = await _getCustomerProfile(phone);

    // Returning customers do not need an OTP or a second name prompt.
    if (profile?.name) {
      await _completeLogin(profile.name, phone);
      return;
    }

    // Development-only numbers skip OTP, but still collect a name for a new profile.
    if (isBypassPhone) {
      _showProfileStep();
      return;
    }

  } catch (err) {
    console.error("[auth] Customer lookup failed:", err);
    _setError("otpPhoneError", "Could not check this number. Please try again.");
  } finally {
    _setLoadingBtn("otpSendBtn", false, "Continue");
  }

  _setLoadingBtn("otpSendBtn", true, "Sending…");

  // Generate a random 6-digit OTP
  _expectedOTP = String(Math.floor(100000 + Math.random() * 900000));

  try {
    // Called from browser (user's IP) — Replit's server IP is blocked by Fast2SMS
    const url = `https://www.fast2sms.com/dev/bulkV2?authorization=x0v38I3oRTe1UpDhCMbpbeT86z5bNJPYmu0E4FQ9g1MirVJh6Gp9Hkm0uuW8&route=otp&variables_values=${_expectedOTP}&numbers=${phone}`;
    const res  = await fetch(url);   // no custom headers — Fast2SMS CORS allows this
    const data = await res.json();

    if (!data.return) {
      throw new Error(data.message || "Failed to send OTP. Please try again.");
    }

    _showCodeStep(phone);
  } catch (err) {
    console.error("[auth] Fast2SMS send:", err);
    _expectedOTP = null;
    _setError("otpPhoneError", err.message || "Could not send OTP. Check your number and try again.");
  } finally {
    _setLoadingBtn("otpSendBtn", false, "Continue");
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
    _expectedOTP = null;
    _showProfileStep();
  } else {
    // ❌ Wrong OTP
    _setError("otpCodeError", "Invalid OTP. Please try again.");
    _setLoadingBtn("otpVerifyBtn", false, "Verify OTP");
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

  _setLoadingBtn("otpProfileBtn", true, "Saving…");
  try {
    await _saveCustomerProfile({ name, phone: _pendingPhone });
    await _completeLogin(name, _pendingPhone, { saveProfile: false });
  } catch (err) {
    console.error("[auth] Customer profile save failed:", err);
    _setError("otpNameError", "Could not save your profile. Please try again.");
    _setLoadingBtn("otpProfileBtn", false, "Continue");
  }
}

async function _getCustomerProfile(phone) {
  const snap = await getDoc(doc(db, CUSTOMER_COLLECTION, phone));
  return snap.exists() ? { phone, ...snap.data() } : null;
}

async function _saveCustomerProfile({ name, phone }) {
  await setDoc(doc(db, CUSTOMER_COLLECTION, phone), {
    name,
    phone,
    updatedAt: serverTimestamp(),
    lastLoginAt: serverTimestamp(),
  }, { merge: true });
}

async function _completeLogin(name, phone, { saveProfile = true } = {}) {
  if (saveProfile) await _saveCustomerProfile({ name, phone });

  _currentUser = { name, phone };
  _saveSession(_currentUser);
  _updateGreeting();
  _dispatchAuthChange(_currentUser);
  _hideModal();

  const cb = _pendingCb;
  _pendingCb = null;
  _pendingPhone = "";
  if (cb) cb();
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function _onLogout() {
  if (!confirm("Log out? You'll need to verify your phone again before placing the next order.")) return;
  _currentUser = null;
  _pendingPhone = "";
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
