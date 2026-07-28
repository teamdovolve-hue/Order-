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

## Next AI Task

1. **Unblock login:** Once Billing Panel agent fixes `customerAuth` `functions/internal` crash, verify end-to-end login works on the live site
2. **Order history sync across devices:** Persist completed orders to Firestore (`customers/{uid}/order_history`) instead of only localStorage — coordinate document structure with Billing Panel agent first
