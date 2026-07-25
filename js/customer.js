/**
 * customer.js
 * ─────────────────────────────────────────────────────────────
 * Thin compatibility shim over login.js.
 * cart.js and order.js import from here — unchanged API.
 */

import {
  getLoginInfo, requireLogin, updateGreeting as _updateGreeting,
} from "./login.js";

/** Returns { name, phone } or null. */
export function getCustomer() {
  return getLoginInfo();
}

/**
 * Call before any cart action.
 * If user is logged in, cb() fires immediately.
 * Otherwise the login screen is shown first, then cb().
 */
export function requireCustomer(cb) {
  requireLogin(cb);
}

/** Refresh the greeting chip in the header. */
export function updateGreeting() {
  _updateGreeting();
}
