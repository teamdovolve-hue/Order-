/**
 * auth.js  — BRIDGE BUILD (no Cloud Functions)
 * ─────────────────────────────────────────────────────────────
 * Customer authentication via direct Firestore reads/writes.
 * Cloud Function (customerAuth) is intentionally bypassed while
 * Firebase billing / Fast2SMS DLT approval is pending.
 *
 * [AI UPDATE 2026-07-28 v5] Fix: Order History not persistent across sessions.
 *
 * Root cause: signOut(auth) in _onLogout permanently destroyed the anonymous
 * Firebase session. The next signInAnonymously() on re-login created a NEW UID,
 * so order-status.js queried pending_table_orders where customer.uid == NEW_UID
 * and found nothing — all historical orders were written under the OLD UID.
 *
 * Fix (two-part):
 *
 * 1. _onLogout no longer calls signOut(auth). The local session (SESSION_KEY)
 *    is still cleared so isLoggedIn() returns false and the login modal appears
 *    on the next visit. The anonymous Firebase session is retained in IndexedDB.
 *    On re-login, _firebaseUser is already set → signInAnonymously is skipped →
 *    auth.currentUser.uid is the SAME stable UID → history query finds all orders.
 *
 * 2. Shared-device isolation: DEVICE_PHONE_KEY ("qrmenu_device_phone") records
 *    which phone last owned this device's anonymous UID. In _onPhoneSubmit, if a
 *    DIFFERENT phone logs in, signOut(auth) + signInAnonymously is called first
 *    to give the new customer an isolated UID. Same phone → no rotation → stable
 *    UID → full history.
 *
 * Files changed: js/auth.js only. No Billing Panel changes required.
 *
 * [AI UPDATE 2026-07-28] Fix: "Change Details" now returns the customer to
 * the phone step with the phone number pre-filled, making both phone and name
 * editable. Previously it only showed the name step (_showProfileStep) which
 * left the phone number uneditable. Also updated _showProfileStep to pre-fill
 * the name from _pendingName so values are preserved when navigating back.
 * Files changed: js/auth.js only. No Billing Panel changes required.
 *
 * Flow (unchanged UX):
 *   Phone → lookup customers/{+91…} in Firestore
 *     found  → signInAnonymously → session saved → login complete
 *     not found → name step → confirm step → setDoc → login complete
 *
 * All accounts are created with phoneVerified: false.
 * When Fast2SMS DLT is approved and Cloud Functions are restored:
 *   1. Restore customerAuth callable calls in _onPhoneSubmit and _onCreateAccount
 *   2. Restore signInWithCustomToken calls
 *   3. Remove direct Firestore read/write blocks marked "BRIDGE"
 *   4. No DB migration needed — phoneVerified field is already present
 *
 * Public API (unchanged — app.js / customer.js / order.js see the same surface):
 *   initAuth()         — wire DOM events, start onAuthStateChanged
 *   requireLogin(cb)   — ensure session, then call cb()
 *   isLoggedIn()       — true if session exists in localStorage
 *   getLoginInfo()     — { name, phone, uid } | null
 *   waitForAuthReady() — Promise resolving when Firebase Auth state is known
 *   onAuthReady(cb)    — call cb with locally cached session
 *   updateGreeting()   — refresh customer chip in header
 */

import { auth, db }      from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInAnonymously,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ── One-time cleanup: purge old localStorage-based login data ────────────────
const _OLD_KEYS = ["qrmenu_login", "qrmenu_moved_to_history", "qrmenu_orders"];
_OLD_KEYS.forEach((k) => {
  if (localStorage.getItem(k) !== null) {
    localStorage.removeItem(k);
    console.info("[auth] Removed legacy key:", k);
  }
});

// ── Session storage keys ──────────────────────────────────────────────────────
const SESSION_KEY     = "qrmenu_user";        // stores { name, phone, uid }
const DEVICE_PHONE_KEY = "qrmenu_device_phone"; // phone of customer who owns this device's anon UID

// ── Module state ──────────────────────────────────────────────────────────────
let _currentUser         = _loadSession();  // { name, phone, uid } | null
let _pendingCb           = null;            // callback to run after login
let _pendingPhone        = "";              // normalised +91… phone across steps
let _pendingName         = "";
let _firebaseUser        = null;
let _authReadyResolve;
const _authReady         = new Promise((resolve) => { _authReadyResolve = resolve; });

// ── Public API ────────────────────────────────────────────────────────────────

export function isAuthReady() { return true; }

export function waitForAuthReady() {
  return _authReady;
}

export function isLoggedIn() { return !!_currentUser; }

export function getLoginInfo() {
  if (!_currentUser) return null;
  return {
    ..._currentUser,
    uid: _firebaseUser?.uid || _currentUser.uid || "",
  };
}

export function requireLogin(cb) {
  if (_currentUser) {
    _ensureFirebaseSession()
      .then(() => cb())
      .catch((err) => {
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

export function initAuth() {
  document.getElementById("otpPhoneForm")
    ?.addEventListener("submit", _onPhoneSubmit);
  document.getElementById("otpProfileForm")
    ?.addEventListener("submit", _onProfileSubmit);
  document.getElementById("otpChangeDetails")
    ?.addEventListener("click", _onChangeDetails);
  document.getElementById("otpCreateAccountBtn")
    ?.addEventListener("click", _onCreateAccount);
  document.getElementById("headerLogoutBtn")
    ?.addEventListener("click", _onLogout);

  onAuthStateChanged(auth, (user) => {
    _firebaseUser = user;
    _authReadyResolve(user);
    if (!user && _currentUser) {
      // Firebase session expired but local session exists — re-auth silently
      signInAnonymously(auth).catch(() => {});
    } else if (user && _currentUser) {
      _dispatchAuthChange(_currentUser);
    }
  });
  _updateGreeting();
}

export function onAuthReady(cb) {
  cb(_currentUser);
}

export function updateGreeting() { _updateGreeting(); }

// ── Modal lifecycle ───────────────────────────────────────────────────────────

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
  document.getElementById("otpPhoneInput")?.focus();
}

function _showProfileStep() {
  document.getElementById("otpPhoneStep")?.classList.add("hidden");
  document.getElementById("otpProfileStep")?.classList.remove("hidden");
  document.getElementById("otpConfirmStep")?.classList.add("hidden");
  _clearError("otpNameError");
  const nameInput = document.getElementById("otpNameInput");
  // Pre-fill with any previously entered name so it is preserved when the
  // customer navigates back from the confirm step via "Change Details".
  if (nameInput) nameInput.value = _pendingName || "";
  nameInput?.focus();
}

// ── "Change Details" — return to phone step with phone pre-filled ─────────────
// Both phone and name are now editable:
//   1. Customer lands on phone step with their number already filled in.
//   2. They can change the number or press Continue with the same one.
//   3. If the phone is new, they land on the name step with the name pre-filled
//      (because _showProfileStep now restores _pendingName).
//   4. They return to the confirm step and can press Create Account normally.

function _onChangeDetails() {
  document.getElementById("otpPhoneStep")?.classList.remove("hidden");
  document.getElementById("otpProfileStep")?.classList.add("hidden");
  document.getElementById("otpConfirmStep")?.classList.add("hidden");
  _clearError("otpPhoneError");
  _clearError("otpNameError");
  const phoneInput = document.getElementById("otpPhoneInput");
  if (phoneInput && _pendingPhone) {
    // Strip the +91 prefix — the input expects the bare 10-digit number.
    phoneInput.value = _pendingPhone.replace(/^\+91/, "");
  }
  phoneInput?.focus();
}

// ── Step 1: Phone lookup ──────────────────────────────────────────────────────
// BRIDGE: reads Firestore directly instead of calling customerAuth Cloud Fn.
// When Cloud Functions are restored, replace the getDoc block with:
//   const customerAuth = httpsCallable(functions, "customerAuth");
//   const result = await customerAuth({ action: "lookup", phone: `+91${phone}` });
//   const profile = result.data || {};
//   if (profile.found) {
//     await signInWithCustomToken(auth, profile.token);
//     await _completeLogin(profile.name, profile.phone || `+91${phone}`);
//   } else { _pendingPhone = profile.phone || `+91${phone}`; _showProfileStep(); }

async function _onPhoneSubmit(e) {
  e.preventDefault();
  _clearError("otpPhoneError");

  const raw   = document.getElementById("otpPhoneInput")?.value || "";
  const phone = raw.replace(/\D/g, "");
  if (phone.length !== 10) {
    _setError("otpPhoneError", "Enter a valid 10-digit mobile number.");
    return;
  }

  const normalised = `+91${phone}`;
  _pendingPhone = normalised;
  _setLoadingBtn("otpSendBtn", true, "Checking…");

  try {
    // ── Shared-device isolation ───────────────────────────────────────────────
    // DEVICE_PHONE_KEY stores the phone number that currently "owns" this
    // device's anonymous Firebase UID. If a DIFFERENT phone is logging in, we
    // must rotate to a fresh anonymous session so the new customer never
    // inherits the previous customer's UID (and thus their order history).
    //
    // If the SAME phone is logging in, the existing anonymous session is kept.
    // Its UID matches the UID stored on every order placed by that customer,
    // so the Firestore query in order-status.js finds their full history.
    const lastDevicePhone = localStorage.getItem(DEVICE_PHONE_KEY);
    if (lastDevicePhone && lastDevicePhone !== normalised) {
      // Different customer — destroy previous anonymous session and create a
      // fresh one so this customer gets an isolated UID.
      try { await signOut(auth); } catch (_) {}
      _firebaseUser = null;
    }

    // BRIDGE: ensure anonymous Firebase Auth UID before Firestore read
    if (!_firebaseUser) {
      await signInAnonymously(auth);
    }

    // BRIDGE: direct Firestore lookup
    const snap = await getDoc(doc(db, "customers", normalised));

    if (snap.exists()) {
      const profile = snap.data();
      await _completeLogin(profile.name || "Customer", profile.phone || normalised);
    } else {
      _showProfileStep();
    }
  } catch (err) {
    console.error("[auth] Phone lookup failed:", err);
    _setError(
      "otpPhoneError",
      err.code === "permission-denied"
        ? "Permission denied. Please ask restaurant staff for help."
        : "Could not check your number. Please check your connection and try again."
    );
  } finally {
    _setLoadingBtn("otpSendBtn", false, "Continue");
  }
}

// ── Step 2: Collect name ──────────────────────────────────────────────────────

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
    _setError("otpNameError", "Session expired. Please enter your phone again.");
    _showPhoneStep();
    return;
  }

  _pendingName = name;
  const confirmName  = document.getElementById("otpConfirmName");
  const confirmPhone = document.getElementById("otpConfirmPhone");
  if (confirmName)  confirmName.textContent  = name;
  if (confirmPhone) confirmPhone.textContent = _formatPhone(_pendingPhone);
  document.getElementById("otpProfileStep")?.classList.add("hidden");
  document.getElementById("otpConfirmStep")?.classList.remove("hidden");
}

// ── Step 3: Create account ────────────────────────────────────────────────────
// BRIDGE: writes Firestore directly instead of calling customerAuth Cloud Fn.
// When Cloud Functions are restored, replace the setDoc block with:
//   const customerAuth = httpsCallable(functions, "customerAuth");
//   const result = await customerAuth({ action: "create", phone: _pendingPhone, name: _pendingName });
//   await signInWithCustomToken(auth, result.data.token);
//   await _completeLogin(result.data.name || _pendingName, result.data.phone || _pendingPhone);

async function _onCreateAccount() {
  _clearError("otpNameError");
  if (!_pendingName || !_pendingPhone) {
    _showPhoneStep();
    return;
  }
  _setLoadingBtn("otpCreateAccountBtn", true, "Creating…");

  try {
    if (!_firebaseUser) {
      await signInAnonymously(auth);
    }

    const uid = auth.currentUser?.uid || "";
    const now = serverTimestamp();

    // BRIDGE: write customer profile directly to Firestore.
    // phoneVerified: false — ready for OTP gate when Fast2SMS DLT is approved.
    // DO NOT change to true here; only OTP verification should set this.
    await setDoc(doc(db, "customers", _pendingPhone), {
      phone:         _pendingPhone,
      name:          _pendingName,
      authUid:       uid,
      phoneVerified: false,
      createdAt:     now,
      updatedAt:     now,
      lastLoginAt:   now,
    });

    await _completeLogin(_pendingName, _pendingPhone);
  } catch (err) {
    console.error("[auth] Account creation failed:", err);
    _setError(
      "otpNameError",
      err.code === "permission-denied"
        ? "Permission denied. Please ask restaurant staff for help."
        : "Account creation failed. Please check your connection and try again."
    );
    document.getElementById("otpConfirmStep")?.classList.add("hidden");
    document.getElementById("otpProfileStep")?.classList.remove("hidden");
  } finally {
    _setLoadingBtn("otpCreateAccountBtn", false, "Create Account");
  }
}

// ── Complete login (shared by all sign-in paths) ──────────────────────────────

async function _completeLogin(name, phone) {
  // Ensure Firebase anonymous session exists
  if (!_firebaseUser) {
    await signInAnonymously(auth);
  }
  _currentUser = { name, phone, uid: auth.currentUser?.uid || "" };
  _saveSession(_currentUser);

  // Bind this device's anonymous UID to the current customer's phone.
  // On re-login, _onPhoneSubmit reads DEVICE_PHONE_KEY:
  //   • same phone  → no session rotation → same UID → history query finds all orders
  //   • diff phone  → session rotated before this point → isolated UID for new customer
  try { localStorage.setItem(DEVICE_PHONE_KEY, phone); } catch (_) {}

  _updateGreeting();
  _dispatchAuthChange(_currentUser);
  _hideModal();

  // Update lastLoginAt non-critically
  if (phone) {
    setDoc(doc(db, "customers", phone), { lastLoginAt: serverTimestamp() }, { merge: true })
      .catch(() => {});
  }

  const cb = _pendingCb;
  _pendingCb    = null;
  _pendingPhone = "";
  _pendingName  = "";
  if (cb) cb();
}

// ── Ensure Firebase session on page reload ────────────────────────────────────
// BRIDGE: uses signInAnonymously instead of calling customerAuth to get a token.

async function _ensureFirebaseSession() {
  await _authReady;
  if (auth.currentUser) return auth.currentUser;
  await signInAnonymously(auth);
  return auth.currentUser;
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function _onLogout() {
  if (!confirm("Log out? You'll need to enter your phone number again before placing the next order.")) return;
  _currentUser  = null;
  _pendingPhone = "";
  _pendingName  = "";
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem("qrmenu_history");
  localStorage.removeItem("qrmenu_moved_to_history");

  // NOTE: signOut(auth) is intentionally NOT called here.
  //
  // Root cause of history-persistence bug (fixed 2026-07-28):
  //   Firebase anonymous auth sessions are destroyed permanently on signOut.
  //   The next signInAnonymously() call creates a NEW UID, so the history
  //   query in order-status.js (where customer.uid == uid) finds zero docs
  //   — the old orders were written under the previous UID.
  //
  // Fix: keep the anonymous Firebase session alive across logout.
  //   The customer's personal data (SESSION_KEY) is already cleared above,
  //   so isLoggedIn() returns false and initOrderStatus() is never called
  //   until the customer re-authenticates with their phone number.
  //   When they do, _firebaseUser is already set → signInAnonymously is
  //   skipped → auth.currentUser.uid is the SAME stable UID used when the
  //   original orders were placed → history query returns full history.
  //
  // Security: anonymous UIDs carry no personal info. Retaining the session
  //   only preserves the stable DB key; it does not expose any customer
  //   data to anyone who picks up the device after logout.

  _dispatchAuthChange(null);
  location.reload();
}

// ── Custom auth-state event ───────────────────────────────────────────────────

function _dispatchAuthChange(user) {
  window.dispatchEvent(new CustomEvent("customAuthStateChanged", { detail: { user } }));
}

// ── Greeting chip ─────────────────────────────────────────────────────────────

function _updateGreeting() {
  const chip      = document.getElementById("customerChip");
  const logoutBtn = document.getElementById("headerLogoutBtn");
  if (_currentUser?.name) {
    if (chip) { chip.textContent = `👤 ${_currentUser.name}`; chip.classList.remove("hidden"); }
    logoutBtn?.classList.remove("hidden");
  } else {
    chip?.classList.add("hidden");
    logoutBtn?.classList.add("hidden");
  }
}

// ── Session helpers ───────────────────────────────────────────────────────────

function _loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (_) { return null; }
}
function _saveSession(user) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(user)); } catch (_) {}
}
function _formatPhone(phone) {
  const digits = String(phone || "").replace(/^\+91/, "");
  return `+91 ${digits}`;
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
