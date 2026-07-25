/**
 * auth.js
 * ─────────────────────────────────────────────────────────────
 * Firebase Phone Authentication (OTP).
 *
 * Flow:
 *   Customer browses freely → taps "Place Order" → if not logged in →
 *   OTP modal appears → enters name and phone → enters OTP → order placed.
 *
 * After first login, Firebase Auth persists the session permanently
 * (IndexedDB-backed localStorage). No login prompt on subsequent visits.
 */

import { auth } from "./firebase-config.js";
import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  onAuthStateChanged,
  updateProfile,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

// ── One-time cleanup: purge old localStorage-based login data ────────────────
const _OLD_KEYS = ["qrmenu_login", "qrmenu_moved_to_history", "qrmenu_orders"];
_OLD_KEYS.forEach((k) => {
  if (localStorage.getItem(k) !== null) {
    localStorage.removeItem(k);
    console.info("[auth] Removed legacy key:", k);
  }
});

// ── Module state ─────────────────────────────────────────────────────────────
let _currentUser         = null;   // Firebase User | null
let _pendingCb           = null;   // callback to run after login
let _confirmationResult  = null;   // result from signInWithPhoneNumber
let _recaptchaVerifier   = null;   // RecaptchaVerifier instance
let _authReady           = false;  // true once onAuthStateChanged has fired once
let _pendingCustomerName = "";     // name collected before phone verification

// ── Auth state listener ──────────────────────────────────────────────────────

onAuthStateChanged(auth, (user) => {
  _currentUser = user;
  _authReady   = true;
  _updateGreeting();

  // A newly verified user must wait until their submitted name is applied
  // before the pending order callback runs.
  if (user && _pendingCb && !_pendingCustomerName) {
    _runPendingCallback();
  }
});

// ── Public API ────────────────────────────────────────────────────────────────

/** True once the first auth-state event has fired. */
export function isAuthReady() { return _authReady; }

/** True when a Firebase user is signed in. */
export function isLoggedIn() { return !!_currentUser; }

/**
 * Returns { name, phone, uid } for the current user, or null.
 * phone is the E.164 format string from Firebase (+91XXXXXXXXXX).
 */
export function getLoginInfo() {
  if (!_currentUser) return null;
  const phone = _currentUser.phoneNumber || "";
  return {
    name:  _currentUser.displayName || phone,
    phone,
    uid:   _currentUser.uid,
  };
}

/**
 * Ensures the user is logged in, then calls cb().
 * If already signed in, cb() fires immediately.
 * Otherwise the OTP modal is shown first, and cb() fires after verification.
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

/** Register a one-time listener called when auth state first resolves. */
export function onAuthReady(cb) {
  if (_authReady) { cb(_currentUser); return; }
  const unsub = onAuthStateChanged(auth, (user) => {
    unsub();
    cb(user);
  });
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
  document.getElementById("otpCodeInput")?.focus();
}

// ── Phone submission ──────────────────────────────────────────────────────────

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

  try {
    // Reset old verifier if any
    if (_recaptchaVerifier) {
      try { _recaptchaVerifier.clear(); } catch (_) {}
      _recaptchaVerifier = null;
    }

    _recaptchaVerifier = new RecaptchaVerifier(auth, "recaptcha-container", {
      size: "invisible",
      callback: () => {},
      "expired-callback": () => {
        _recaptchaVerifier = null;
      },
    });

    _confirmationResult = await signInWithPhoneNumber(
      auth, `+91${phone}`, _recaptchaVerifier
    );
    _showCodeStep(phone);
  } catch (err) {
    console.error("[auth] signInWithPhoneNumber:", err);
    _setError("otpPhoneError", _friendly(err));
    if (_recaptchaVerifier) {
      try { _recaptchaVerifier.clear(); } catch (_) {}
      _recaptchaVerifier = null;
    }
  } finally {
    _setLoadingBtn("otpSendBtn", false, "Send OTP");
  }
}

// ── OTP verification ──────────────────────────────────────────────────────────

async function _onOTPSubmit(e) {
  e.preventDefault();
  _clearError("otpCodeError");

  const code = (document.getElementById("otpCodeInput")?.value || "").trim();
  if (code.length < 4) {
    _setError("otpCodeError", "Enter the OTP you received.");
    return;
  }
  if (!_confirmationResult) {
    _setError("otpCodeError", "Session expired. Please go back and resend OTP.");
    return;
  }

  _setLoadingBtn("otpVerifyBtn", true, "Verifying…");

  try {
    const result = await _confirmationResult.confirm(code);
    if (_pendingCustomerName && result.user) {
      await updateProfile(result.user, { displayName: _pendingCustomerName });
    }
    _currentUser = result.user;
    _updateGreeting();
    _runPendingCallback();
    _hideModal();
  } catch (err) {
    console.error("[auth] OTP confirm:", err);
    _setError("otpCodeError", _friendly(err));
  } finally {
    _setLoadingBtn("otpVerifyBtn", false, "Verify OTP");
  }
}

function _runPendingCallback() {
  if (!_pendingCb) return;
  const cb = _pendingCb;
  _pendingCb = null;
  _pendingCustomerName = "";
  cb();
}

// ── Logout ─────────────────────────────────────────────────────────────────

async function _onLogout() {
  if (!confirm("Log out? You'll need to verify your phone again before placing the next order.")) return;
  try { await signOut(auth); } catch (_) {}
  // Clear history from storage so the next user starts fresh
  localStorage.removeItem("qrmenu_history");
  localStorage.removeItem("qrmenu_moved_to_history");
  location.reload();
}

// ── Greeting chip ─────────────────────────────────────────────────────────────

function _updateGreeting() {
  const chip      = document.getElementById("customerChip");
  const logoutBtn = document.getElementById("headerLogoutBtn");

  if (_currentUser?.phoneNumber) {
    const last4 = _currentUser.phoneNumber.slice(-4);
    if (chip) {
      chip.textContent = `👤 ${_currentUser.displayName || `···${last4}`}`;
      chip.classList.remove("hidden");
    }
    logoutBtn?.classList.remove("hidden");
  } else {
    chip?.classList.add("hidden");
    logoutBtn?.classList.add("hidden");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function _friendly(err) {
  const c = err?.code || "";
  if (c.includes("unauthorized-domain"))      return "This website domain is not authorized in Firebase. Add the exact domain shown in your browser to Firebase → Authentication → Settings → Authorized domains.";
  if (c.includes("operation-not-allowed"))   return "Firebase rejected Phone Auth for project billing-system-f8531. Confirm Phone is saved in this exact project, then enable the Identity Toolkit API in Google Cloud Console → APIs & Services → Library.";
  if (c.includes("invalid-api-key"))         return "Firebase configuration is invalid. Check the web app configuration in Firebase.";
  if (c.includes("app-not-authorized"))      return "This app is not authorized for Firebase Phone Auth. Check the Firebase web app and authorized domains.";
  if (c.includes("invalid-phone-number"))       return "Invalid phone number. Check and try again.";
  if (c.includes("too-many-requests"))           return "Too many attempts. Please wait a moment.";
  if (c.includes("quota-exceeded"))             return "Service busy. Try again in a minute.";
  if (c.includes("invalid-verification-code"))  return "Wrong OTP. Please try again.";
  if (c.includes("code-expired"))               return "OTP expired. Go back and resend.";
  if (c.includes("missing-phone-number"))       return "Please enter your phone number.";
  if (c.includes("captcha-check-failed"))       return "Verification failed. Please refresh and retry.";
  return err?.message || "Something went wrong. Please try again.";
}
