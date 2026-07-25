/**
 * customer.js
 * ─────────────────────────────────────────────────────────────
 * Thin shim over auth.js — unchanged public API for cart.js and order.js.
 */

import {
  getLoginInfo,
  requireLogin as _requireLogin,
  updateGreeting as _updateGreeting,
} from "./auth.js";

/** Returns { name, phone, uid } or null. */
export function getCustomer() {
  return getLoginInfo();
}

/**
 * Call before any action that needs a logged-in customer.
 * If already signed in, cb() fires immediately.
 * Otherwise the OTP modal is shown first, then cb().
 */
export function requireCustomer(cb) {
  _requireLogin(cb);
}

/** Refresh the greeting chip in the header. */
export function updateGreeting() {
  _updateGreeting();
}
