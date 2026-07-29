# AI_HANDOFF.md

# Customer Panel — Project State

**Repository:** https://github.com/teamdovolve-hue/Order-
**Production URL:** https://newpizzahutlivecake.in (Vercel, static site)
**Last Updated:** 2026-07-27

---

## Project Purpose

Customer-facing restaurant ordering application.

Responsibilities:
- QR table detection
- Customer login (phone-based, no OTP while DLT approval pending)
- Menu display (real-time Firestore)
- Cart management
- Order placement via Firebase callable
- Live order tracking
- Customer order history (localStorage)

This repository should **NEVER** contain Billing Panel logic.

---

## Stack

- Pure HTML / CSS / Vanilla JavaScript (ES Modules, no build step)
- Firebase Firestore v10 (real-time `onSnapshot`)
- Firebase Auth v10 (custom tokens issued by Billing Panel callable)
- Firebase Callable Functions in `asia-south1` region
- **Development:** `node server.js` on port 5000 (Express, injects `window.__TABLE_ID__`)
- **Production:** Vercel static site (`vercel.json` with `/t/:n` rewrite)

---

## File Structure

```
index.html                ← App shell + login modal
css/style.css             ← Full dark theme (#0f0f0f bg, #f5a623 amber accent)
js/
  firebase-config.js      ← Firebase init — exports db, auth, functions
  app.js                  ← Entry point; boot sequence + table gate
  auth.js                 ← Phone login bridge (no OTP); session in localStorage
  customer.js             ← Thin shim over auth.js (backward-compat API)
  menu.js                 ← Real-time menu via onSnapshot
  cart.js                 ← Cart state + DOM updates
  order.js                ← Order submission via createCustomerOrder callable
  order-status.js         ← Live order tracking (pending → preparing → history)
  search.js               ← Real-time menu search
  history.js              ← Order history drawer (localStorage key: qrmenu_history)
billing-integration/
  js/incoming-orders.js   ← Drop into billing panel
  HOW-TO-ADD.md           ← 4-step setup guide
server.js                 ← Dev-only Express server (not used on Vercel)
vercel.json               ← Static site config (framework:null, /t/:n rewrite)
_redirects                ← Netlify rewrite rules (legacy, kept for reference)
```

---

## Completed Features

✅ QR-based table detection (`/t/1` … `/t/10`)
✅ Automatic table assignment via Firestore session
✅ Customer login flow (phone → lookup → sign in or create account)
✅ Returning customer detection (no name re-entry)
✅ Customer profile persistence (localStorage + Firebase Auth custom token)
✅ Menu display (real-time Firestore `onSnapshot`)
✅ Menu search
✅ Category tabs (A-Z sorted)
✅ Item sorting (Low → High price)
✅ Out-of-stock UI (item shown with badge, add disabled)
✅ Live Order Status tracking:
  - `pending` / `accepted` → "Order Received"
  - `kot` → "Preparing • X min" (live elapsed timer)
  - `completed` → removed from Active Orders, saved to history
  - `dismissed` / `rejected` → silently removed (not saved to history)
✅ Customer order history drawer (localStorage, keyed by Firestore doc ID to prevent duplicates)
✅ Vercel deployment (static, no npm install, `/t/:n` rewrite)
✅ Dark theme CSS loading reliably (inline `.hidden` rule guarantees modal stays hidden even if external stylesheet is delayed)
✅ App no longer freezes on slow Firebase Auth (4-second timeout before proceeding)

---

## Current Known Issue

### `customerAuth` callable returns `functions/internal`

**Symptom:** Entering a phone number in the login modal shows  
_"Could not check this number. Please try again."_

**Root cause:** The `customerAuth` Cloud Function crashes server-side.  
This is a **Billing Panel / Firebase backend issue**, not a customer panel code issue.

**To diagnose:** Firebase Console → Functions → Logs → filter `customerAuth`

**Most likely causes (in order):**
1. Missing Firestore composite index on the `customers` collection — deploy with `firebase deploy --only firestore:indexes`
2. `REQUIRE_PHONE_VERIFICATION` environment variable not set — confirm it is set to `false` in function config
3. Firestore security rules blocking the function's admin read on `customers`

**Required action:** Tell Billing Panel agent to check Firebase Functions logs for the `customerAuth` function and fix the server-side crash.

---

## Pending Work

### Complete customer order history synchronization

Current state: History saves to **localStorage** when Firestore order status → `completed`.
This works per-device but orders placed on one device won't appear on another.

Expected full flow:
```
Customer places order
  ↓ Order Received (pending/accepted)
  ↓ Preparing (after Billing Panel KOT)
  ↓ Billing Panel: Save & Exit or Bill & Settle
  ↓ status → "completed" in Firestore
  ↓ Removed from Active Orders
  ↓ Saved to Customer Order History (currently localStorage only)
```

Future improvement: sync history to Firestore under `customers/{uid}/order_history` so it persists across devices. Requires Billing Panel to confirm the completed order document structure.

---

## API / Firestore Contract

| Collection | Purpose | Who writes |
|---|---|---|
| `menu_items` | Menu cards | Billing Panel |
| `pending_table_orders` | Orders | `createCustomerOrder` callable |
| `customers` | Customer profiles | `customerAuth` callable |
| `customer_table_sessions` | Active table assignment | Billing Panel callables |
| `table_locks` | Per-table lock sentinel | Billing Panel callables |

**Rules:**
- Do not change database structure without necessity
- Do not rename existing collections or document IDs
- Maintain compatibility with the Billing Panel at all times

---

## Required Billing Panel Changes

### Fix `customerAuth` callable crash (BLOCKING)

- **File:** Firebase Cloud Function `customerAuth` (in Billing Panel repo)
- **Change:** Investigate and fix the `functions/internal` error thrown when called with `{ action: "lookup", phone: "+91XXXXXXXXXX" }`
- **Reason:** Without this, customers cannot log in and cannot place orders
- **Diagnosis:** Firebase Console → Functions → Logs → `customerAuth`

### Firestore indexes (likely missing)

- **File:** `firestore.indexes.json` in Billing Panel repo
- **Change:** Deploy composite index required by `customerAuth` phone lookup query
- **Command:** `firebase deploy --only firestore:indexes`

---

## Deployment

| Environment | URL | How |
|---|---|---|
| Development | Replit preview port 5000 | `node server.js` — run "Start application" workflow |
| Production | https://newpizzahutlivecake.in | Vercel, auto-deploys from `main` branch of GitHub repo |

**Important:** Never commit `package-lock.json` regenerated inside Replit — it contains Replit's internal package-firewall URLs that break `npm install` on Vercel. (Vercel is configured with `"installCommand": "echo 'skip install'"` to avoid this entirely.)

**To deploy a change:**
1. Make changes in Replit
2. Verify in Replit preview (`/t/4`)
3. Push from Replit Git panel (do NOT use agent `gitPush` — Vercel rejects pushes from the agent token)
4. Vercel auto-deploys within ~1 minute

---

## Last Modified Files

- `index.html` — inline `.hidden` CSS + diagnostic error script
- `js/app.js` — 4-second `waitForAuthReady()` timeout
- `js/auth.js` — (no functional change; debug code added then reverted)
- `vercel.json` — `framework:null`, `installCommand: skip`, MIME type headers, `/t/:n` rewrite

---

## [AI UPDATE 2026-07-28 v5] — Order History Not Persistent Across Login Sessions

### Files Modified
- `js/auth.js` only

### Root Cause
`_onLogout()` called `signOut(auth)`, which **permanently destroys** the anonymous Firebase Auth session (deleted from IndexedDB — unrecoverable). On the next visit, `signInAnonymously(auth)` creates a brand-new anonymous user with a different UID. The history query in `order-status.js`:

```javascript
where("customer.uid", "==", uid)   // uid = NEW anonymous UID after re-login
```

found zero documents because every historical order was written under the **old** anonymous UID (set at order placement time in `order.js` → `customer.uid = auth.currentUser.uid`). The v4 architecture (reading completed orders from `pending_table_orders`) is correct; the break was entirely upstream in the auth layer.

### Fix (two-part)

#### Part 1 — Stable UID across logout/re-login
Removed `await signOut(auth)` from `_onLogout()`. The local session (`SESSION_KEY` = `qrmenu_user`) is still cleared, so:
- `isLoggedIn()` returns false ✅
- The login modal appears when the customer tries to place an order ✅
- `initOrderStatus()` is NOT called until after re-authentication ✅

The anonymous Firebase session persists in IndexedDB. When the same customer re-enters their phone:
- `_firebaseUser` is already set → `signInAnonymously` is **skipped**
- `auth.currentUser.uid` is the **same UID** used when orders were originally placed
- `startOrderTracking` queries `where("customer.uid", "==", uid)` → finds all history ✅

#### Part 2 — Shared-device customer isolation
A new localStorage key `DEVICE_PHONE_KEY` (`qrmenu_device_phone`) records which phone currently "owns" this device's anonymous UID. In `_onPhoneSubmit`, before the Firestore lookup:
- If a **different** phone is logging in → call `signOut(auth)` + fresh `signInAnonymously` → isolated UID for the new customer → they cannot see the previous customer's orders
- If the **same** phone is logging in → no rotation → stable UID → full history ✅

`_completeLogin` writes the current phone to `DEVICE_PHONE_KEY` after every successful login so the binding stays current.

### Complete Flow (after fix)

**Same customer re-logs in:**
```
Customer logs out
  ↓ SESSION_KEY cleared; DEVICE_PHONE_KEY = "+91XXXXXXXX" (retained)
  ↓ Firebase anonymous session retained in IndexedDB
  ↓ location.reload()
Customer re-opens page
  ↓ isLoggedIn() → false; _firebaseUser restored by onAuthStateChanged
Customer taps "Place Order" → modal
  ↓ Enters same phone → lastDevicePhone == normalised → NO rotation
  ↓ _firebaseUser already set → signInAnonymously skipped
  ↓ _completeLogin → same UID → initOrderStatus() → history query finds all orders ✅
```

**Different customer on same device:**
```
Customer B logs in after Customer A
  ↓ lastDevicePhone (+91A) ≠ normalised (+91B)
  ↓ signOut(auth) → destroys A's session; signInAnonymously → fresh UID for B
  ↓ B's orders are placed under new UID; B's history is scoped to that UID ✅
  ↓ DEVICE_PHONE_KEY updated to B's phone
```

### Billing Panel Changes Required
**None.** No Firestore rules, collection structure, or callable interfaces are affected.

### What Was NOT Changed
- Login flow (UX unchanged), order placement, active orders, KOT timer, UI
- `order-status.js`, `history.js`, `app.js`, `order.js`
- Firestore collection names, document structure, or query fields

---

## [AI UPDATE 2026-07-28 v4] — History Persistence, Duplicates, Invalid Date (three bugs)

### Files Modified
- `js/order-status.js`
- `js/history.js`

### Bug 1 Root Cause — History disappears after logout
`_writeCompletedOrderToHistory` was writing to `customer_order_history/{uid}/orders`, but the Billing Panel's Firestore rules had not been updated to allow customer writes, so every write failed silently with `permission-denied`. Listener 2 then fired with 0 documents → `updateFromFirestore([])` → `_firestoreOrders = []` — which overrode localStorage data with an empty array. The drawer rendered empty even when localStorage had valid history.

### Bug 2 Root Cause — Duplicate history entries
Two parallel paths were feeding history simultaneously: (1) the `docChanges()` write path in Listener 1 triggered `_writeCompletedOrderToHistory` → triggered Listener 2 → fed history; (2) on page reload, the same completed order appeared as an "added" event again and went through the same path. The Set-based dedup was per-session and was cleared on logout, allowing re-writes.

### Bug 3 Root Cause — Invalid Date
`placedAt` was set from `data.createdAt` (a Firestore Timestamp `{seconds, nanoseconds}` object). `history.js` rendered it with `new Date(order.placedAt)` — `new Date()` does not unwrap Firestore Timestamp objects → `Invalid Date`. The `completedAt` already had a `?.seconds` guard but `placedAt` did not.

### Fix — All Three Bugs

**Core architectural change (`order-status.js`):**
- Removed Listener 2 (`customer_order_history` onSnapshot) entirely.
- Removed `_writeCompletedOrderToHistory` (the failing Firestore write).
- Removed `_trackedUid`, `_writtenToHistory` Set, and `setDoc`/`serverTimestamp` imports — no longer needed.
- Listener 1 (`pending_table_orders`) now handles BOTH active orders and history from a single snapshot:
  - Active orders: filtered by status NOT in [completed, dismissed, rejected] → `onActiveOrders` callback (unchanged)
  - History: filtered by `status === "completed"`, sorted newest-first → `onHistory` callback (new)
  - All Firestore Timestamps converted to ms integers (`_tsToMs`) before passing to callbacks — no raw Timestamp objects reach `history.js`.
- `_syncHistoryToLocalStorage` simplified: orders arrive pre-mapped, just calls `updateFromFirestore` + `saveOrderToHistory`.

**Date rendering fix (`history.js`):**
- Added `_toDate(val)` helper that safely handles ms integers, ISO strings, Firestore Timestamp objects `{seconds, nanoseconds}`, and null/undefined → never returns an invalid Date.
- `renderHistory()` uses `_toDate(order.placedAt)` and `_toDate(order.completedAt)` — `Invalid Date` is impossible.
- Updated file header comment.

### Persistence flow (after fix)
```
Customer logs in (any device, any session)
  ↓ initOrderStatus() → startOrderTracking()
  ↓ Listener 1 fires immediately (Firestore snapshot of all customer orders)
  ↓ Completed orders extracted and mapped (timestamps → ms integers)
  ↓ onHistory(mappedHistory) → _syncHistoryToLocalStorage
  ↓ updateFromFirestore(orders) → _firestoreOrders = [all completed orders]
  ↓ saveOrderToHistory (localStorage cache, deduped by firestoreId)
  ↓ Customer opens history drawer → renders from _firestoreOrders (Firestore data)
```

### Billing Panel Changes Required
**None for this fix.** The previous approach required a Billing Panel `firestore.rules` change (allow create on `customer_order_history/{uid}/orders`) — that dependency is now eliminated entirely. The Customer Panel reads only from `pending_table_orders`, which it already has permission to read.

### What Was NOT Changed
- Order placement, active order rendering, KOT timer
- Login flow, UI design, CSS
- Firestore collection names or document structure
- `saveOrderToHistory` localStorage logic (kept as offline cache)
- `updateFromFirestore`, `_firestoreOrders`, `_drawerOpen`, `_toDate` remain as-is
- `getHistory()`, `initHistory()`, `openHistory()` public API unchanged

---

## [AI UPDATE 2026-07-28] — Persistent Order History (Firestore-backed)

### Files Modified
- `js/order-status.js`
- `js/history.js`

### Root Cause
Order history was stored in `localStorage` only. `localStorage` is per-device and is lost on logout or page clear. The Firestore collection `customer_order_history/{uid}/orders` was already being read by Listener 2 in `order-status.js`, but **nothing was writing to it** — the Billing Panel implementation was marked as pending, and the Customer Panel had no write path either.

### What Was Changed

**`js/order-status.js`:**
- Added `doc`, `setDoc`, `serverTimestamp` to Firestore imports
- Added module-level `_trackedUid` and `_writtenToHistory` (Set) for tracking
- `startOrderTracking`: sets `_trackedUid = uid` on start
- `stopOrderTracking`: clears `_trackedUid` and `_writtenToHistory` on logout
- In Listener 1 (`pending_table_orders` snapshot): added `snap.docChanges()` loop — when any doc's status transitions to `"completed"`, calls `_writeCompletedOrderToHistory(uid, docId, data)`. Uses `_writtenToHistory` Set to prevent duplicate writes within a session.
- Added `_writeCompletedOrderToHistory(uid, docId, data)`: writes to `customer_order_history/{uid}/orders/{docId}` using `setDoc` with `merge: true` so Billing Panel writes are not overwritten.
- `_syncHistoryToLocalStorage`: now also calls `updateFromFirestore(mapped)` (new `history.js` export) so the drawer renders live Firestore data rather than re-reading localStorage.
- Imported `updateFromFirestore` from `history.js`.

**`js/history.js`:**
- Added `_firestoreOrders = null` and `_drawerOpen = false` module state.
- Added `export function updateFromFirestore(orders)`: stores the Firestore snapshot in memory; immediately re-renders the drawer if it is open.
- `openHistory()`: sets `_drawerOpen = true` before rendering.
- `closeHistory()`: sets `_drawerOpen = false`.
- `renderHistory()`: uses `_firestoreOrders` when not null; falls back to `localStorage` for initial render before the first Firestore snapshot arrives.

### Persistence Flow (After Fix)
```
Order status → "completed" in pending_table_orders
  ↓ Listener 1 docChanges() detects the transition
  ↓ _writeCompletedOrderToHistory writes to customer_order_history/{uid}/orders/{orderId}
  ↓ Listener 2 (already running) fires with updated snapshot
  ↓ _syncHistoryToLocalStorage → updateFromFirestore (in-memory) + saveOrderToHistory (localStorage cache)
  ↓ history drawer re-renders from Firestore data if open

Customer logs out → logs back in with same phone
  ↓ startOrderTracking called → Listener 2 fires immediately with all history docs
  ↓ updateFromFirestore → history drawer has full history from Firestore
```

### Billing Panel Change Required
**File:** `firestore.rules` in the Billing Panel repository  
**Reason:** The Customer Panel now writes to `customer_order_history/{uid}/orders/{orderId}`. The current rules only have `allow read` for this path. Without a write rule, `_writeCompletedOrderToHistory` will fail with `permission-denied`.  
**Required change — add to the `customer_order_history` match block:**
```
match /customer_order_history/{uid}/orders/{orderId} {
  allow read:   if request.auth.uid == uid;
  allow create: if request.auth.uid == uid;
}
```
Use `allow create` (not `allow write`) to prevent customers from modifying or deleting past history entries. The Customer Panel uses `setDoc` with `merge: true`, which maps to a `create` or `update` — if you want to also allow updates (so Billing Panel data can be merged safely), use:
```
match /customer_order_history/{uid}/orders/{orderId} {
  allow read, write: if request.auth.uid == uid;
}
```

### What Was NOT Changed
- Order placement (`order.js`)
- Active Orders rendering logic
- KOT / Preparing timer
- Login flow
- UI design / CSS
- Firestore collection names or document structure
- `saveOrderToHistory` localStorage logic (kept as offline cache)

---

## [AI UPDATE 2026-07-28] — "Change Details" Bug Fix

### Files Modified
- `js/auth.js` only

### Root Cause
The `otpChangeDetails` button was wired directly to `_showProfileStep()`, which only revealed the name input (`otpProfileStep`). The phone number was never made editable from the confirm screen. Additionally, `_showProfileStep()` always blanked the name input (`nameInput.value = ""`), so any previously entered name was lost when navigating back.

### What Was Changed
1. **New `_onChangeDetails()` function** — registered as the click handler for `otpChangeDetails`. Returns the customer to the phone step (`otpPhoneStep`) with their phone number pre-filled (10-digit, +91 stripped). The customer can change the phone or press Continue with the same one.
2. **`_showProfileStep()` updated** — now pre-fills the name input with `_pendingName` (if set) instead of always clearing it. This means when the customer resubmits the same phone and lands on the name step, their previously entered name is already filled in.
3. **`initAuth()` updated** — changed event listener on `otpChangeDetails` from `_showProfileStep` to `_onChangeDetails`.

### Flow After Fix
```
Confirm screen → "Change Details"
  ↓ Phone step (phone pre-filled)
  ↓ Customer edits phone or keeps it → Continue
  ↓ New phone lookup → not found → name step (name pre-filled)
  ↓ Customer edits name or keeps it → Review Details
  ↓ Confirm screen (updated values) → Create Account
```

### Billing Panel Changes Required
**None.** This is a pure frontend change in the Customer Panel. No Firestore structure, callable interface, or order flow is affected.

---

---

## [AI UPDATE 2026-07-29] — Billing Panel Compatibility Sync (Session 21)

### Files Modified
- `js/auth.js` — Replaced bridge phone-only flow with password + username system
- `js/order-status.js` — Restored two-listener architecture; uses stable profile uid
- `js/order.js` — Uses stable profile uid from `getLoginInfo()` when writing orders
- `js/menu.js` — Added AI update comment confirming `inStock` compatibility
- `index.html` — Added all missing DOM elements required by the upgraded auth.js
- `css/style.css` — Added styles for login step, username row, availability indicator, password toggle

### Root Cause
The Billing Panel was upgraded to session 21 (password + username authentication) and the `order-panel-updates/` directory in the Billing Panel repo contained updated versions of `auth.js`, `order-status.js`, and `order.js` for the Customer Panel. The Customer Panel was missing these updates, causing:
- Login failures (password/username DOM elements null)
- Registration failures (no password/username collection)
- Order history misalignment (wrong uid used after re-login)
- History not loading from Firestore (Listener 2 removed in previous version; Billing Panel now writes `customer_order_history`)

### What Changed

#### `js/auth.js`
- Added password-based login step (`_showLoginStep`, `_onLoginSubmit`)
- Added username generation and availability checking (`_generateUsername`, `_scheduleUsernameCheck`)
- Registration now collects: Full Name, @username (auto-generated, editable), Password (×2)
- Password stored as `SHA-256(password + ":" + phone)` — client-side hash, accepted tradeoff
- `getLoginInfo()` now returns stable stored profile uid (not `auth.currentUser.uid`)
- `_onPhoneSubmit`: branches to login step (existing account with `passwordHash`) vs registration (new or legacy)
- Session key `qrmenu_user` now stores `{ name, phone, uid, username }`
- New Firestore write: `usernames/{username} → { phone }` for uniqueness enforcement
- Logout now calls `signOut(auth)` (cleaned up — stable uid is now the stored profile uid, not the anonymous uid)
- Removed DEVICE_PHONE_KEY shared-device isolation (replaced by password-based isolation)

#### `js/order-status.js`
- Uses `getLoginInfo().uid` (stable stored profile uid) instead of `auth.currentUser?.uid`
- Restored two-listener architecture: Listener 1 (active orders from `pending_table_orders`), Listener 2 (history from `customer_order_history/{uid}/orders`)
- Added `orderBy` import for Listener 2 query
- Preserved `"rejected"` status in active-orders filter (silently removed, not saved to history)
- `_syncHistoryToLocalStorage` updated to match new Listener 2 field shape

#### `js/order.js`
- Uses `getLoginInfo().uid` (stable stored profile uid) when writing `customer.uid` to new orders
- This ensures `pending_table_orders.customer.uid` matches the uid used for `customer_order_history` lookups

#### `js/menu.js`
- No logic changes — `_isItemOos()` already checks both `inStock` and `available` fields
- Added AI update comment confirming the `inStock` field is already the primary availability check

#### `index.html` — New DOM elements added
- `#otpLoginStep`: welcome-back message, phone display, password input, show/hide toggle, login button, error display
- Inside `#otpProfileStep`: username row (`#otpUsernameInput`), availability status (`#otpUsernameStatus`), password input (`#otpPasswordInput2`), confirm password (`#otpPasswordConfirm`)
- Inside `#otpConfirmStep`: username confirmation row (`#otpConfirmUsername`)

#### `css/style.css` — New styles added
- `.otp-login-welcome`, `.otp-login-phone` — Login step greeting
- `.otp-password-row`, `.otp-btn-toggle` — Password input with show/hide
- `.username-row`, `.username-at`, `.username-input` — @username field
- `.username-status` with variants `.available`, `.taken`, `.checking`, `.invalid`

### Billing Panel Changes Required
- **Firestore rules**: The `usernames` collection must be readable and writable by authenticated customers. Add to `firestore.rules`:
  ```
  match /usernames/{username} {
    allow read: if request.auth != null;
    allow create: if request.auth != null;
  }
  ```
- **`customer_order_history` rules**: Must allow authenticated customers to read their own history sub-collection (Listener 2 reads it). This was documented in previous handoff and may already be deployed.

### What Was NOT Changed
- QR flow (server.js, app.js, table detection)
- Order placement core logic (order.js — only uid source updated)
- Active Orders rendering, KOT timer
- History drawer rendering (history.js)
- CSS dark theme, layout, animations
- Firestore collection names, document IDs, or status values
- Firebase project configuration (firebase-config.js)

---

## Next AI Task

1. **Deploy Firestore rules**: Add `usernames` collection rules to Billing Panel `firestore.rules` so username availability checks work in production (rules required for both `read` and `create` — see Required Billing Panel Changes below)
2. **Verify password login end-to-end**: Existing customers without `passwordHash` will be sent to registration flow (migration path) — confirm they can re-register cleanly
3. **Order history sync**: Confirm Billing Panel's `syncCustomerOrderCompletion()` is writing to `customer_order_history/{uid}/orders` with the correct `uid` (the stored profile uid, not the anonymous auth uid)

---

## [AI UPDATE 2026-07-29 v2] — 11-Task Bug Fix Session

### Files Modified
- `js/auth.js`
- `js/order-status.js`
- `index.html`

### What Was Fixed

#### Task 1 — Username Availability (js/auth.js)
**Root cause:** `_scheduleUsernameCheck` had a bare `catch (_)` that silenced all errors, including `permission-denied` from Firestore (the `usernames` collection rules are not yet deployed on the Billing Panel). Every check failed silently and showed the generic "Could not check availability" message.

**Fix:** Replaced `catch (_)` with `catch (err)`. Now logs the real error to console. On `permission-denied`: shows "@username — availability check unavailable. You may still continue." and sets `_usernameAvailable = true` so the user can proceed to account creation (the final `getDoc` in `_onCreateAccount` will catch any permission issue with a clear error). On other errors: shows "Could not check — please retry in a moment".

**Billing Panel action required:** Deploy Firestore rules for the `usernames` collection (see Required Billing Panel Changes). Once deployed, the availability check will show `✓ @username is available` or `✗ @username is already taken` correctly.

#### Task 2 — order-status.js (js/order-status.js)
Verified the current two-listener architecture (Listener 1: `pending_table_orders`, Listener 2: `customer_order_history/{uid}/orders`) is correct and matches the documented session-21 compatible version. No replacement needed — this IS the latest implementation.

#### Task 3 — Menu availability (js/menu.js)
Already fixed in the previous session. `_isItemOos()` checks both `inStock === false` AND `available === false`. No code changes needed — verified correct.

#### Task 4 — Password auth DOM elements (index.html)
Already complete from previous session. All required elements exist: `#otpLoginStep`, `#otpLoginPasswordInput`, `#otpLoginToggleBtn`, `#otpLoginBtn`, `#otpLoginName`, `#otpLoginPhone`, `#otpLoginError`, `#otpUsernameInput`, `#otpUsernameStatus`, `#otpPasswordInput2`, `#otpPasswordConfirm`, `#otpConfirmUsername`. No changes needed.

#### Task 5 — Enter key in login password field (js/auth.js)
**Root cause:** `#otpLoginForm` uses `onsubmit="return false;"` and the Login button is `type="button"`, so pressing Enter in the password field did nothing.

**Fix:** Added `keydown` listener on `#otpLoginPasswordInput` in `initAuth()` — `Enter` key calls `_onLoginSubmit()` directly.

#### Task 6 — History synchronization (js/order-status.js)
**Root cause:** `_syncHistoryToLocalStorage` called `saveOrderToHistory` (localStorage write) but never called `updateFromFirestore` (in-memory update). So `history.js` kept serving stale localStorage data; the drawer only refreshed on the next open after a manual trigger.

**Fix:** Added `updateFromFirestore` to the import from `history.js`. `_syncHistoryToLocalStorage` now maps orders to the history.js shape once, calls `updateFromFirestore(mapped)` first (triggers immediate re-render if drawer is open), then calls `saveOrderToHistory` for each order as the localStorage cache.

#### Task 7 — Change Details restores fields (js/auth.js)
**Root cause:** `otpChangeDetails` was wired to `_showProfileStep` which always cleared all fields (name, username, password, status element).

**Fix:** Added `_onChangeDetails()` function. It captures the current name (from DOM or `_pendingName`) and username before transitioning back to the profile step, then restores them. Password fields are intentionally left empty (security requirement). Immediately calls `_scheduleUsernameCheck(currentUsername)` if the username is valid so the availability indicator re-appears.

#### Task 8 — Username status reset on form clear (js/auth.js)
**Root cause:** `_showProfileStep()` set `statusEl.textContent = ""` but left the element's CSS class unchanged (e.g. `"username-status available"`). An empty element with a non-hidden class still occupied space.

**Fix:** `_showProfileStep()` now sets `statusEl.className = "username-status hidden"` — the `hidden` class (defined inline in `<head>`) ensures `display: none !important`.

#### Task 9 — Remove debug overlay (index.html)
**Root cause:** A development diagnostic script added a fixed red banner for every JS error. Harmless in dev but inappropriate for production customers.

**Fix:** Removed the entire `<script>` diagnostic block (28 lines). Errors remain visible in DevTools → Console.

#### Task 10 & 11 — Identity verification and end-to-end review
Verified the complete customer identity flow:
- **Registration**: `auth.currentUser.uid` (anonymous) written to `customers/{phone}.uid` → session stores `{ name, phone, uid, username }`
- **Re-login**: reads `p.uid || p.authUid` from Firestore profile → same stable uid restored
- **Orders**: `order.js` uses `getLoginInfo().uid` → `customer.uid` in `pending_table_orders` matches history query
- **History**: `order-status.js` uses `getLoginInfo().uid` → queries `customer_order_history/{uid}/orders` under the correct path
- **Logout/re-login with same phone**: stable uid preserved via Firestore profile read, NOT from `auth.currentUser`
- **Different customer on same device**: `signOut` + fresh `signInAnonymously` → new anonymous uid → new profile uid written at registration → isolated history

### Billing Panel Changes Required

**1. Firestore rules — `usernames` collection (BLOCKING for Task 1)**
Without these rules, username availability checks return `permission-denied` (gracefully handled — users can proceed, but the visual check never shows ✓ or ✗).
```
match /usernames/{username} {
  allow read:   if request.auth != null;
  allow create: if request.auth != null;
}
```

**2. Firestore rules — `customer_order_history/{uid}/orders` (BLOCKING for history)**
Required for Listener 2 in `order-status.js` to read completed orders.
```
match /customer_order_history/{uid}/orders/{orderId} {
  allow read: if request.auth.uid == uid;
}
```
Note: `customer.uid` in orders equals the stored profile uid, NOT `auth.currentUser.uid`. If Billing Panel rules use `request.auth.uid == uid`, the uid paths must match. Confirm with Billing Panel team.

**3. `syncCustomerOrderCompletion()` uid field**
Billing Panel's Bill & Settle / Save & Exit writes to `customer_order_history/{uid}/orders`. Confirm the `uid` used as the path key matches `pending_table_orders[order].customer.uid` — this is the stored profile uid set by `order.js`.

### What Was NOT Changed
- Firestore collection names, document IDs, or status values
- Order placement logic (`order.js`)
- Active Orders rendering, KOT timer, cart
- Login/registration UX flow and styling
- `history.js` public API
- Firebase configuration (`firebase-config.js`)
- ARCHITECTURE_LOCK.md (no architectural changes — bug fixes only)
