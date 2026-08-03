# QR Menu — Customer Order Panel

Mobile-first, dark-themed QR menu for restaurant tables. Customers scan a QR code, browse the menu freely, add items to cart, authenticate through the Billing Panel's callable backend, and their order goes live to Firestore. The billing panel picks it up in real-time.

## Stack
- Pure HTML / CSS / Vanilla JavaScript (ES Modules)
- Firebase Firestore v10 (real-time `onSnapshot` for menu + orders)
- Firebase Authentication v10 (server-issued customer custom tokens)
- Firebase callable functions in the `asia-south1` region
- Served with `node server.js`

## Menu Schema (as of 2026-08-03)
The Admin Panel migrated from flat `menu_items` to a hierarchical schema:
```
categories/{catId}      { name, imageUrl, active, displayOrder }
products/{productId}    { categoryId, categoryName, name, imageUrl, description,
                          inStock, active, hasVariants, price, extras[], flags{},
                          variantsList[], displayOrder }
products/{id}/variants  { name, price, imageUrl, active, inStock, displayOrder }
```
`menu.js` auto-detects which schema is live: if `products` is non-empty it
subscribes to `products` + `categories` with real-time `onSnapshot`. Otherwise
it falls back to the legacy `menu_items` listener. No manual config needed.

## How to Run
The app is served at port 5000 via the **Start application** workflow (`node server.js`).

Open with a table QR path:
```
https://your-repl.repl.co/t/4
```

## Authentication Flow
The login screen does NOT appear on page load. Customers browse freely.

```
Customer opens website
  → Browse menu freely
  → Add items to cart
  → Tap "Place Order"
  → If not logged in: phone-only login modal slides up
  → Existing phone number: server lookup and immediate sign-in
  → New phone number: enter name → confirm details → create account
  → Order is placed automatically
  → Permanently logged in on this device (localStorage session)
```

Customer lookup and account creation go through `customerAuth`; the browser
does not read or write the `customers` collection directly. New profiles are
created with `phoneVerified: false`.

## File Structure
```
index.html                ← App shell + OTP modal
css/
  style.css               ← Full dark theme, OTP modal, menu, active orders
js/
  firebase-config.js      ← Firebase init — exports db, auth + callables
  auth.js                 ← Temporary phone bridge; no OTP in current flow
  customer.js             ← Thin shim over auth.js (backward-compat API)
  app.js                  ← Entry point; wires everything via onAuthStateChanged
  menu.js                 ← Real-time menu via onSnapshot; out-of-stock propagation
  cart.js                 ← Cart state + DOM updates
  order.js                ← Server-validated order submission + table lock
  order-status.js         ← Live order status (pending → preparing → history)
  search.js               ← Real-time menu search
  history.js              ← Order history drawer (localStorage, key: qrmenu_history)
billing-integration/
  js/incoming-orders.js   ← Drop into billing panel: incoming orders + KOT/settle hooks
  HOW-TO-ADD.md           ← 4-step setup guide for the billing panel
```

## Billing Panel callable prerequisites
The linked Billing Panel repository already contains the required
`customerAuth`, `createCustomerOrder`, and `releaseTableLock` Cloud Functions.
They must be deployed in `asia-south1`, with the existing Firestore rules and
composite index deployed as well. Keep `REQUIRE_PHONE_VERIFICATION=false` until
DLT approval is complete; switch it to `true` only after an OTP-success handler
sets `phoneVerified: true`.

## Firestore Collections
| Collection | Purpose |
|---|---|
| `menu_items` | Source of menu cards shown to customers |
| `pending_table_orders` | Orders created by `createCustomerOrder`, read by billing panel |
| `customers` | Server-managed customer profiles keyed by normalized phone |
| `customer_table_sessions` | Server-managed active table assignment and order IDs |
| `table_locks` | Server-managed per-table lock sentinel |

Each order stores the server-derived customer's name, phone number, and Firebase
UID, along with `customerSessionId` and `tableLockId`.

## Order Status Flow
| Firestore `status` | Customer sees |
|---|---|
| `pending` / `accepted` | Order Received — Kitchen notified soon |
| `kot` | Preparing • X min (live timer from `kotAt`) |
| `completed` | Removed from Active Orders → saved to Order History |
| `dismissed` / `rejected` | Silently removed from Active Orders (NOT saved to history) |

## Billing Panel review

The linked Billing Panel repository already has the backend/API and operator
hooks required for this feature. No Billing Panel source change is required:
`createCustomerOrder` atomically reuses an active customer's table assignment,
and `releaseTableLock` is already awaited by both Bill & Settle and Save & Exit.
The only required operator-side action is deployment/configuration of the
existing functions, rules, and index described above.

## User Preferences
- Dark theme (#0f0f0f background, #f5a623 amber accent), mobile-first
- No dummy/hardcoded data — everything from live Firestore
- Firebase is single source of truth for auth + order status
- Modular JS (one concern per file), no build step
- Currency: INR (₹)
- All billing panel ↔ customer panel sync happens instantly via Firestore onSnapshot
