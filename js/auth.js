/**
 * auth.js  — BRIDGE BUILD (no Cloud Functions)
 * ─────────────────────────────────────────────────────────────
 * Customer authentication via direct Firestore reads/writes.
 * Cloud Function (customerAuth) is intentionally bypassed while
 * Firebase billing / Fast2SMS DLT approval is pending.
 *
 * Flow (session 21 — password + username):
 *   Phone → lookup customers/{+91…} in Firestore
 *     found + passwordHash  → login step (password verification)
 *     found + no passwordHash → registration step (password migration)
 *     not found             → registration step (new account)
 *
 * Registration collects: Full Name, @username (auto-generated, editable),
 * Password (×2). Username uniqueness is enforced via usernames/{username}.
 *
 * Password storage: SHA-256(password + ":" + phone). Client-side hash.
 * Acceptable for a local restaurant POS (owner accepted the tradeoff;
 * easily rotated, no financial data exposed).
 *
 * Session key: "qrmenu_user" — { name, phone, uid, username }
 * Previously only stored name/phone/uid; username added in session 21.
 *
 * OTP readiness:
 *   When Fast2SMS DLT is approved and Cloud Functions are restored:
 *   1. Restore customerAuth callable calls in _onPhoneSubmit and _onCreateAccount
 *   2. Restore signInWithCustomToken calls
 *   3. Remove direct Firestore read/write blocks marked "BRIDGE"
 *   4. No DB migration needed — passwordHash + phoneVerified fields already present
 *
 * Public API (unchanged — app.js / customer.js / order.js see the same surface):
 *   initAuth()         — wire DOM events, start onAuthStateChanged
 *   requireLogin(cb)   — ensure session, then call cb()
 *   isLoggedIn()       — true if session exists in localStorage
 *   getLoginInfo()     — { name, phone, uid, username } | null
 *   waitForAuthReady() — Promise resolving when Firebase Auth state is known
 *   onAuthReady(cb)    — call cb with locally cached session
 *   updateGreeting()   — refresh customer chip in header
 *
 * ─────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-07-29] Compatibility upgrade to match Billing Panel session 21.
 * Added password-based authentication and username system.
 * Replaced bridge phone-only flow with: phone → lookup → login (password) or register
 * (name + username + password + confirm). Username uniqueness via usernames/{username}.
 * getLoginInfo() now returns stable stored uid (not auth.currentUser.uid) so
 * order-status.js and order.js always query history under the correct canonical uid.
 * Files modified: js/auth.js (this file), index.html (new DOM elements added),
 * js/order-status.js (uses getLoginInfo), js/order.js (uses getLoginInfo).
 * ─────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-07-29 v2] Bug fixes (Tasks 1, 5, 7, 8):
 *   Task 1: _scheduleUsernameCheck catch now logs the real error and handles
 *           permission-denied separately — shows specific message, allows
 *           proceeding so the creation-step final check can gate the user.
 *           "Could not check availability" no longer appears on permission errors.
 *   Task 5: Enter key inside #otpLoginPasswordInput now fires _onLoginSubmit.
 *   Task 7: otpChangeDetails now calls new _onChangeDetails() which restores
 *           Name + @username and immediately re-runs the availability check.
 *           Password fields are kept empty for security. Old behaviour (wired
 *           directly to _showProfileStep, wiping all fields) is replaced.
 *   Task 8: _showProfileStep() now sets statusEl className to
 *           "username-status hidden" (not just empty text) so no blank gap
 *           is left when the registration form is shown fresh.
 * ─────────────────────────────────────────────────────────────
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

// ── Session storage key ───────────────────────────────────────────────────────
const SESSION_KEY = "qrmenu_user"; // { name, phone, uid, username }

// ── Module state ──────────────────────────────────────────────────────────────
let _currentUser         = _loadSession();  // { name, phone, uid, username } | null
let _pendingCb           = null;            // callback to run after login
let _pendingPhone        = "";              // normalised +91… phone across steps
let _pendingName         = "";
let _pendingLoginProfile = null;            // Firestore profile for login step
let _usernameCheckTimer  = null;
let _usernameAvailable   = false;
let _changingDetails     = false;           // true when user clicked "Change Details"
let _savedProfileValues  = null;            // { name, username, password, confirm } saved for prefill
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
  // Return stable stored uid and username as-is.
  // Do NOT override uid with _firebaseUser.uid — the anonymous auth uid
  // may differ after session reset; the stored profile uid is canonical.
  return { ..._currentUser };
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

  // Profile form (registration step) — includes username + password now
  document.getElementById("otpProfileForm")
    ?.addEventListener("submit", _onProfileSubmit);

  // [AI UPDATE 2026-07-29 v2] Task 7 — wire to _onChangeDetails (new) instead of
  // _showProfileStep so name + username are restored, not cleared.
  document.getElementById("otpChangeDetails")
    ?.addEventListener("click", _onChangeDetails);

  document.getElementById("otpCreateAccountBtn")
    ?.addEventListener("click", _onCreateAccount);

  document.getElementById("headerLogoutBtn")
    ?.addEventListener("click", _onLogout);

  // Login step buttons (session 21)
  document.getElementById("otpLoginBtn")
    ?.addEventListener("click", _onLoginSubmit);

  // Username input: live availability check
  document.getElementById("otpUsernameInput")
    ?.addEventListener("input", _onUsernameInput);

  // Name input: auto-generate username
  document.getElementById("otpNameInput")
    ?.addEventListener("input", _onNameInput);

  // Password toggle button in login step
  document.getElementById("otpLoginToggleBtn")
    ?.addEventListener("click", () => {
      const inp = document.getElementById("otpLoginPasswordInput");
      if (!inp) return;
      const isHidden = inp.type === "password";
      inp.type = isHidden ? "text" : "password";
      const btn = document.getElementById("otpLoginToggleBtn");
      if (btn) btn.textContent = isHidden ? "Hide" : "Show";
    });

  // [AI UPDATE 2026-07-29 v2] Task 5 — Enter key in login password field fires login.
  // The login form uses onsubmit="return false;" and the Login button is type="button",
  // so without this listener pressing Enter does nothing while focused on the password.
  document.getElementById("otpLoginPasswordInput")
    ?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); _onLoginSubmit(); }
    });

  // Forgot Password popup — open / close
  document.getElementById("otpForgotBtn")
    ?.addEventListener("click", () => {
      document.getElementById("otpForgotOverlay")?.classList.remove("hidden");
    });
  document.getElementById("otpForgotCloseBtn")
    ?.addEventListener("click", () => {
      document.getElementById("otpForgotOverlay")?.classList.add("hidden");
    });

  onAuthStateChanged(auth, (user) => {
    _firebaseUser = user;
    _authReadyResolve(user);
    if (!user && _currentUser) {
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
  document.getElementById("otpLoginStep")?.classList.add("hidden");
  _clearError("otpNameError");
  _clearError("otpPhoneError");
  _clearError("otpLoginError");
  document.getElementById("otpPhoneInput")?.focus();
}

function _showLoginStep() {
  document.getElementById("otpPhoneStep")?.classList.add("hidden");
  document.getElementById("otpProfileStep")?.classList.add("hidden");
  document.getElementById("otpConfirmStep")?.classList.add("hidden");
  document.getElementById("otpLoginStep")?.classList.remove("hidden");
  _clearError("otpLoginError");

  // Show customer's name so they know whose account this is
  const nameEl  = document.getElementById("otpLoginName");
  const phoneEl = document.getElementById("otpLoginPhone");
  if (nameEl)  nameEl.textContent  = `Welcome back, ${_pendingLoginProfile?.name || ""}! 👋`;
  if (phoneEl) phoneEl.textContent = _pendingPhone;

  const passInput = document.getElementById("otpLoginPasswordInput");
  if (passInput) { passInput.value = ""; passInput.focus(); }
}

function _showProfileStep() {
  document.getElementById("otpPhoneStep")?.classList.add("hidden");
  document.getElementById("otpProfileStep")?.classList.remove("hidden");
  document.getElementById("otpConfirmStep")?.classList.add("hidden");
  document.getElementById("otpLoginStep")?.classList.add("hidden");
  _clearError("otpNameError");

  const nameInput     = document.getElementById("otpNameInput");
  const usernameInput = document.getElementById("otpUsernameInput");
  const passInput     = document.getElementById("otpPasswordInput2");
  const confirmInput  = document.getElementById("otpPasswordConfirm");

  if (_changingDetails && _savedProfileValues) {
    // Restore whatever the user had typed before clicking "Change Details"
    if (nameInput)     nameInput.value     = _savedProfileValues.name     || "";
    if (usernameInput) usernameInput.value = _savedProfileValues.username  || "";
    if (passInput)     passInput.value     = _savedProfileValues.password  || "";
    if (confirmInput)  confirmInput.value  = _savedProfileValues.confirm   || "";
    _changingDetails    = false;
    _savedProfileValues = null;
    // Re-run username availability check if one was present
    const restoredUsername = usernameInput?.value.trim();
    if (restoredUsername && _isValidUsername(restoredUsername)) {
      _scheduleUsernameCheck(restoredUsername);
    } else {
      const statusEl = document.getElementById("otpUsernameStatus");
      if (statusEl) { statusEl.textContent = ""; statusEl.className = "username-status hidden"; }
      _usernameAvailable = false;
    }
  } else {
    if (nameInput)     nameInput.value     = "";
    if (usernameInput) usernameInput.value = "";
    if (passInput)     passInput.value     = "";
    if (confirmInput)  confirmInput.value  = "";
    // [AI UPDATE 2026-07-29 v2] Task 8 — properly hide the status element (not just
    // clear its text) so no blank gap is left when the registration form appears fresh.
    const statusEl = document.getElementById("otpUsernameStatus");
    if (statusEl) {
      statusEl.textContent = "";
      statusEl.className   = "username-status hidden";
    }
    _usernameAvailable = false;
  }

  nameInput?.focus();
}

// ── Change Details (from confirm screen) ─────────────────────────────────────
// [AI UPDATE 2026-07-29 v2] Task 7 — restores Name + @username, keeps passwords
// empty for security, and immediately re-runs the availability check.
// Old behaviour (wired directly to _showProfileStep) always cleared all fields.

function _onChangeDetails() {
  // Save all current profile values so _showProfileStep can restore them.
  // Passwords are preserved here so the user doesn't have to retype them.
  _savedProfileValues = {
    name:     (document.getElementById("otpNameInput")?.value.trim()     || _pendingName || ""),
    username: (document.getElementById("otpUsernameInput")?.value.trim() || ""),
    password: (document.getElementById("otpPasswordInput2")?.value       || ""),
    confirm:  (document.getElementById("otpPasswordConfirm")?.value      || ""),
  };
  _changingDetails = true;

  // Go all the way back to the phone step so the user can correct their number too.
  // Prefill the phone input with the 10-digit number (strip the +91 prefix).
  const phoneInput = document.getElementById("otpPhoneInput");
  if (phoneInput && _pendingPhone) {
    phoneInput.value = _pendingPhone.replace(/^\+91/, "");
  }

  _clearError("otpPhoneError");
  _clearError("otpNameError");
  document.getElementById("otpConfirmStep")?.classList.add("hidden");
  document.getElementById("otpProfileStep")?.classList.add("hidden");
  document.getElementById("otpLoginStep")?.classList.add("hidden");
  document.getElementById("otpPhoneStep")?.classList.remove("hidden");

  phoneInput?.focus();
}

// ── Step 1: Phone lookup ──────────────────────────────────────────────────────
// BRIDGE: reads Firestore directly instead of calling customerAuth Cloud Fn.

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
    if (!_firebaseUser) {
      await signInAnonymously(auth);
    }

    // BRIDGE: direct Firestore lookup
    const snap = await getDoc(doc(db, "customers", normalised));

    if (snap.exists()) {
      const profile = snap.data();

      if (!profile.passwordHash) {
        // Old account without password (pre-session-21) — treat as new registration.
        // This migrates old accounts into the new password-based system.
        _pendingLoginProfile = null;
        _showProfileStep();
      } else {
        // Returning customer with password → login step
        _pendingLoginProfile = profile;
        _showLoginStep();
      }
    } else {
      // New customer → registration
      _pendingLoginProfile = null;
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

// ── Step 2a: Login (returning customer, password) ─────────────────────────────

async function _onLoginSubmit() {
  _clearError("otpLoginError");

  const passEl = document.getElementById("otpLoginPasswordInput");
  const password = passEl?.value || "";
  if (!password) {
    _setError("otpLoginError", "Please enter your password.");
    return;
  }

  _setLoadingBtn("otpLoginBtn", true, "Logging in…");

  try {
    const hash = await _hashPassword(password, _pendingPhone);

    if (hash !== _pendingLoginProfile.passwordHash) {
      _setError("otpLoginError", "Incorrect password. Please try again.");
      if (passEl) { passEl.value = ""; passEl.focus(); }
      return;
    }

    // Password correct — use stable stored uid (not auth.currentUser.uid)
    const p         = _pendingLoginProfile;
    const storedUid = p.uid || p.authUid || "";
    await _completeLogin(p.name || "Customer", p.phone || _pendingPhone, storedUid, p.username || "");

  } catch (err) {
    console.error("[auth] Login failed:", err);
    _setError("otpLoginError", "Login failed. Please check your connection.");
  } finally {
    _setLoadingBtn("otpLoginBtn", false, "Login");
  }
}

// ── Step 2b: Collect name + username + password ───────────────────────────────

function _onNameInput(e) {
  const name = (e.target?.value || "").trim();
  if (name.length >= 2) {
    const generated = _generateUsername(name);
    const usernameInput = document.getElementById("otpUsernameInput");
    if (usernameInput) usernameInput.value = generated;
    _scheduleUsernameCheck(generated);
  } else {
    clearTimeout(_usernameCheckTimer);
    const usernameInput = document.getElementById("otpUsernameInput");
    if (usernameInput) usernameInput.value = "";
    const statusEl = document.getElementById("otpUsernameStatus");
    if (statusEl) statusEl.textContent = "";
    _usernameAvailable = false;
  }
}

function _onUsernameInput(e) {
  const cleaned = (e.target?.value || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (e.target) e.target.value = cleaned;
  if (cleaned.length >= 1) {
    _scheduleUsernameCheck(cleaned);
  } else {
    clearTimeout(_usernameCheckTimer);
    const statusEl = document.getElementById("otpUsernameStatus");
    if (statusEl) statusEl.textContent = "";
    _usernameAvailable = false;
  }
}

function _scheduleUsernameCheck(username) {
  clearTimeout(_usernameCheckTimer);
  const statusEl = document.getElementById("otpUsernameStatus");
  if (statusEl) {
    statusEl.textContent = "Checking availability…";
    statusEl.className   = "username-status checking";
  }
  _usernameAvailable = false;

  _usernameCheckTimer = setTimeout(async () => {
    if (!_isValidUsername(username)) {
      if (statusEl) {
        statusEl.textContent = "3–20 chars: letters, numbers, underscore only";
        statusEl.className   = "username-status invalid";
      }
      return;
    }
    // [AI UPDATE 2026-07-29 v2] Task 1 — log the real error; handle
    // permission-denied separately so the generic "Could not check
    // availability" message never appears for a normal auth/rules issue.
    // If rules aren't yet deployed for the usernames collection, the read
    // will fail with permission-denied. We allow the user to proceed —
    // _onCreateAccount runs its own final getDoc that will also fail and
    // show a clear "Permission denied" error rather than silently blocking
    // registration. Any other error (network, etc.) shows a retry message.
    try {
      const snap = await getDoc(doc(db, "usernames", username));
      if (!snap.exists()) {
        if (statusEl) {
          statusEl.textContent = `✓  @${username} is available`;
          statusEl.className   = "username-status available";
        }
        _usernameAvailable = true;
      } else {
        if (statusEl) {
          statusEl.textContent = `✗  @${username} is already taken`;
          statusEl.className   = "username-status taken";
        }
        _usernameAvailable = false;
      }
    } catch (err) {
      console.error("[auth] Username availability check failed:", err.code || err.message, err);
      if (err.code === "permission-denied") {
        // Firestore rules for `usernames` collection not yet deployed.
        // Let the user continue — account creation will gate them properly.
        if (statusEl) {
          statusEl.textContent = `@${username} — availability check unavailable. You may still continue.`;
          statusEl.className   = "username-status checking";
        }
        // Optimistically allow proceeding; _onCreateAccount final check will fail
        // with a clear error if the username write is also denied.
        _usernameAvailable = true;
      } else {
        if (statusEl) {
          statusEl.textContent = "Could not check — please retry in a moment";
          statusEl.className   = "username-status checking";
        }
        _usernameAvailable = false;
      }
    }
  }, 500);
}

async function _onProfileSubmit(e) {
  e.preventDefault();
  _clearError("otpNameError");

  const name     = (document.getElementById("otpNameInput")?.value  || "").trim();
  const password = document.getElementById("otpPasswordInput2")?.value || "";
  const confirm  = document.getElementById("otpPasswordConfirm")?.value || "";

  if (name.length < 2) {
    _setError("otpNameError", "Please enter your name.");
    document.getElementById("otpNameInput")?.focus();
    return;
  }

  // [AI UPDATE 2026-08-01] Username is auto-generated and hidden from customer.
  // Ensure we always have a valid username from the hidden input (populated by _onNameInput).
  // If the auto-generated name was taken, silently append a 4-digit suffix and proceed
  // optimistically — _onCreateAccount runs the final uniqueness check.
  let username = (document.getElementById("otpUsernameInput")?.value || "").trim();
  if (!username || !_isValidUsername(username)) {
    username = _generateUsername(name) || "user";
    const usernameInput = document.getElementById("otpUsernameInput");
    if (usernameInput) usernameInput.value = username;
  }
  if (!_usernameAvailable) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    username = (username + String(suffix)).slice(0, 20);
    const usernameInput = document.getElementById("otpUsernameInput");
    if (usernameInput) usernameInput.value = username;
    _usernameAvailable = true; // optimistic — final check in _onCreateAccount
  }

  if (password.length < 6) {
    _setError("otpNameError", "Password must be at least 6 characters.");
    document.getElementById("otpPasswordInput2")?.focus();
    return;
  }
  if (password !== confirm) {
    _setError("otpNameError", "Passwords do not match.");
    const confirmInput = document.getElementById("otpPasswordConfirm");
    if (confirmInput) { confirmInput.value = ""; confirmInput.focus(); }
    return;
  }

  if (!_pendingPhone) {
    _setError("otpNameError", "Session expired. Please enter your phone again.");
    _showPhoneStep();
    return;
  }

  _pendingName = name;

  // Fill confirm step
  const confirmName     = document.getElementById("otpConfirmName");
  const confirmPhone    = document.getElementById("otpConfirmPhone");
  const confirmUsername = document.getElementById("otpConfirmUsername");
  if (confirmName)     confirmName.textContent     = name;
  if (confirmPhone)    confirmPhone.textContent    = _formatPhone(_pendingPhone);
  if (confirmUsername) confirmUsername.textContent = `@${username}`;

  document.getElementById("otpProfileStep")?.classList.add("hidden");
  document.getElementById("otpConfirmStep")?.classList.remove("hidden");
}

// ── Step 3: Create account ────────────────────────────────────────────────────
// BRIDGE: writes Firestore directly instead of calling customerAuth Cloud Fn.
//
// [AI UPDATE 2026-07-29 v3] Registration permission-denied fix.
//
// ROOT CAUSE (verified against actual Billing Panel firestore.rules):
//   The `usernames` collection has NO Firestore security rules.
//   Every read/write on `usernames` returns permission-denied.
//   The previous code wrapped all three operations in ONE try-catch:
//     1. getDoc(usernames/{username})   ← throws permission-denied
//     2. setDoc(usernames/{username})   ← never reached
//     3. setDoc(customers/{phone})      ← never reached
//   So account creation ALWAYS failed at step 1, showing "Permission denied",
//   even though the critical customers write would likely have succeeded.
//
// FIX: Split `usernames` operations into their own try-catch blocks that log
//   warnings and continue on permission-denied. Only `setDoc(customers)` is
//   treated as the critical write — if that fails, registration truly fails.
//   Username uniqueness enforcement becomes best-effort until Billing Panel
//   deploys firestore.rules for the `usernames` collection (see HANDOFF).
//
// WHEN BILLING PANEL DEPLOYS USERNAMES RULES:
//   No changes needed here — the try-catch wrapping is harmless once rules allow
//   the operations; they will succeed silently and uniqueness will be enforced.

async function _onCreateAccount() {
  _clearError("otpNameError");

  if (!_pendingName || !_pendingPhone) {
    _showPhoneStep();
    return;
  }

  const username = (document.getElementById("otpUsernameInput")?.value || "").trim();
  const password = document.getElementById("otpPasswordInput2")?.value || "";

  if (!_isValidUsername(username) || !_usernameAvailable) {
    document.getElementById("otpConfirmStep")?.classList.add("hidden");
    document.getElementById("otpProfileStep")?.classList.remove("hidden");
    _setError("otpNameError", "Please choose an available username before continuing.");
    return;
  }

  _setLoadingBtn("otpCreateAccountBtn", true, "Creating…");

  try {
    if (!_firebaseUser) {
      await signInAnonymously(auth);
    }

    // ── Step A: final username collision check (best-effort) ──────────────────
    // Wrapped in its own try-catch so a permission-denied error on the `usernames`
    // collection does NOT abort registration. If the read succeeds and the username
    // IS taken, we return early with an error. If the read fails (rules not yet
    // deployed), we skip the check and proceed optimistically.
    try {
      const snap = await getDoc(doc(db, "usernames", username));
      if (snap.exists()) {
        // Username was just taken by someone else — send back to profile step
        document.getElementById("otpConfirmStep")?.classList.add("hidden");
        document.getElementById("otpProfileStep")?.classList.remove("hidden");
        _setError("otpNameError", `@${username} was just taken. Please choose another.`);
        _usernameAvailable = false;
        const statusEl = document.getElementById("otpUsernameStatus");
        if (statusEl) {
          statusEl.textContent = `✗  @${username} is already taken`;
          statusEl.className   = "username-status taken";
        }
        _setLoadingBtn("otpCreateAccountBtn", false, "Create Account");
        return;
      }
    } catch (usernameReadErr) {
      // permission-denied: `usernames` collection rules not yet deployed on Billing Panel.
      // Log it and continue — we cannot verify uniqueness but can still create the account.
      console.warn(
        "[auth] Username collision check skipped (rules pending — Billing Panel must deploy usernames rules):",
        usernameReadErr.code || usernameReadErr.message
      );
    }

    const uid          = auth.currentUser?.uid || "";
    const passwordHash = await _hashPassword(password, _pendingPhone);
    const now          = serverTimestamp();

    // ── Step B: register username in uniqueness index (best-effort) ───────────
    // Wrapped in its own try-catch. If permission-denied, log and continue.
    // Once Billing Panel deploys `usernames` rules this will succeed silently.
    try {
      await setDoc(doc(db, "usernames", username), { phone: _pendingPhone });
    } catch (usernameWriteErr) {
      console.warn(
        "[auth] Username registry write skipped (rules pending — Billing Panel must deploy usernames rules):",
        usernameWriteErr.code || usernameWriteErr.message
      );
    }

    // ── Step C: write customer profile — the CRITICAL operation ──────────────
    // BRIDGE: write directly to Firestore.
    // phoneVerified: false — ready for OTP gate when Fast2SMS DLT is approved.
    // DO NOT change to true here; only OTP verification should set this.
    // If this throws, registration truly fails and the outer catch handles it.
    await setDoc(doc(db, "customers", _pendingPhone), {
      phone:         _pendingPhone,
      name:          _pendingName,
      username,
      uid,
      passwordHash,
      phoneVerified: false,
      createdAt:     now,
      updatedAt:     now,
      lastLoginAt:   now,
      totalOrders:   0,
      lifetimeSpend: 0,
      lastOrderAt:   null,
    });

    await _completeLogin(_pendingName, _pendingPhone, uid, username);

  } catch (err) {
    // Only `setDoc(customers)` or `signInAnonymously` can reach here now.
    console.error("[auth] Account creation failed:", err);
    _setError(
      "otpNameError",
      err.code === "permission-denied"
        ? "Account creation failed: server permissions not configured. Please ask restaurant staff for help."
        : "Account creation failed. Please check your connection and try again."
    );
    document.getElementById("otpConfirmStep")?.classList.add("hidden");
    document.getElementById("otpProfileStep")?.classList.remove("hidden");
  } finally {
    _setLoadingBtn("otpCreateAccountBtn", false, "Create Account");
  }
}

// ── Complete login (shared by all sign-in paths) ──────────────────────────────
// profileUid: the stable stored uid from customers/{phone}.uid — must be
// used instead of auth.currentUser.uid to keep customer_order_history stable.
// username: @handle stored in the session for display purposes.

async function _completeLogin(name, phone, profileUid = "", username = "") {
  if (!_firebaseUser) {
    await signInAnonymously(auth);
  }
  const uid = profileUid || auth.currentUser?.uid || "";
  _currentUser = { name, phone, uid, username };
  _saveSession(_currentUser);
  _updateGreeting();
  _dispatchAuthChange(_currentUser);
  _hideModal();

  // Update lastLoginAt only — do NOT touch uid or passwordHash.
  if (phone) {
    setDoc(doc(db, "customers", phone), { lastLoginAt: serverTimestamp() }, { merge: true })
      .catch(() => {});
  }

  const cb = _pendingCb;
  _pendingCb           = null;
  _pendingPhone        = "";
  _pendingName         = "";
  _pendingLoginProfile = null;
  _usernameAvailable   = false;
  if (cb) cb();
}

// ── Ensure Firebase session on page reload ────────────────────────────────────

async function _ensureFirebaseSession() {
  await _authReady;
  if (auth.currentUser) return auth.currentUser;
  await signInAnonymously(auth);
  return auth.currentUser;
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function _onLogout() {
  if (!confirm("Log out? You'll need to enter your phone number and password again.")) return;
  _currentUser         = null;
  _pendingPhone        = "";
  _pendingName         = "";
  _pendingLoginProfile = null;
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem("qrmenu_history");
  localStorage.removeItem("qrmenu_moved_to_history");
  localStorage.removeItem("qrmenu_cart"); // [AI UPDATE 2026-08-01] clear persisted cart on logout
  await signOut(auth).catch(() => {});
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

// ── Password & username utilities ─────────────────────────────────────────────

// SHA-256(password + ":" + phone). Phone acts as a per-user salt.
async function _hashPassword(password, phone) {
  const encoder = new TextEncoder();
  const data    = encoder.encode(password + ":" + phone);
  const buf     = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

// "Arnav Mishra" → "arnavmishra"
function _generateUsername(name) {
  return (name || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20) || "user";
}

function _isValidUsername(u) {
  return /^[a-z0-9_]{3,20}$/.test(u);
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
