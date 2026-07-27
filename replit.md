# QR Menu — Customer Order Panel

Mobile-first, dark-themed QR menu for restaurant tables. Customers scan a QR code, browse the menu freely, add items to cart, tap "Place Order", verify via Firebase Phone OTP, and their order goes live to Firestore. The billing panel picks it up in real-time.

## Stack
- Pure HTML / CSS / Vanilla JavaScript (ES Modules)
- Firebase Firestore v10 (real-time `onSnapshot` for menu + orders)
- Firebase Authentication v10 (Phone OTP — no passwords)
- Served with `npx serve`

## How to Run
The app is served at port 5000 via the **Start application** workflow (`node server.js`).

Open with a table param in the URL:
```
https://your-repl.repl.co/?table=T4
```

## Authentication Flow
The login screen does NOT appear on page load. Customers browse freely.

```
Customer opens website
  → Browse menu freely
  → Add items to cart
  → Tap "Place Order"
  → If not logged in: phone-only login modal slides up
  → Existing phone number: saved profile is used immediately
  → New phone number: enter 6-digit OTP, then enter name once
  → Order is placed automatically
  → Permanently logged in on this device (localStorage session)
```

### Development login bypass

Until SMS verification is configured, `123456789` and `987654321` skip OTP.
They still create a normal customer profile when used for the first time. The
bypass list is isolated in `js/auth.js` and can be removed without changing the
rest of the login flow.

Customer profiles are stored in the shared Firestore `customers` collection,
using the normalized phone number as the document ID. The profile stores the
customer name, phone number, and login timestamps. The customer app continues
to write the existing `customer: { name, phone, uid }` order shape, so the
Billing Panel's order listener and status updates do not need to change.

## File Structure
```
index.html                ← App shell + OTP modal
css/
  style.css               ← Full dark theme, OTP modal, menu, active orders
js/
  firebase-config.js      ← Firebase init — exports db + auth
  auth.js                 ← Firebase Phone OTP auth (replaces old login.js)
  customer.js             ← Thin shim over auth.js (backward-compat API)
  app.js                  ← Entry point; wires everything via onAuthStateChanged
  menu.js                 ← Real-time menu via onSnapshot; out-of-stock propagation
  cart.js                 ← Cart state + DOM updates
  order.js                ← Order submission to Firestore
  order-status.js         ← Live order status (pending → preparing → history)
  search.js               ← Real-time menu search
  history.js              ← Order history drawer (localStorage, key: qrmenu_history)
billing-integration/
  js/incoming-orders.js   ← Drop into billing panel: incoming orders + KOT/settle hooks
  HOW-TO-ADD.md           ← 4-step setup guide for the billing panel
```

## Firebase Phone Auth — One-time Setup
**Before going live**, add your Replit domain to Firebase → Authentication → Settings → Authorized Domains.

For testing, add test phone numbers: Firebase → Authentication → Sign-in method → Phone → Test phone numbers.

## Firestore Collections
| Collection | Purpose |
|---|---|
| `menu_items` | Source of menu cards shown to customers |
| `pending_table_orders` | Orders written by customers, read by billing panel |

Each order stores the verified customer's name, phone number, and Firebase UID.

## Order Status Flow
| Firestore `status` | Customer sees |
|---|---|
| `pending` / `accepted` | Order Received — Kitchen notified soon |
| `kot` | Preparing • X min (live timer from `kotAt`) |
| `completed` | Removed from Active Orders → saved to Order History |
| `dismissed` / `rejected` | Silently removed from Active Orders (NOT saved to history) |

## Billing Panel Integration
See `billing-integration/HOW-TO-ADD.md` for 4-step setup. Key hooks:
- `window._orderStatusKOT(tableName)` — call when KOT is printed
- `window._orderStatusComplete(tableName, 'save_exit'|'bill_settle')` — call on settle

## Firestore Security Rules (minimum)
```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /menu_items/{doc} {
      allow read: if true;
    }
    match /pending_table_orders/{doc} {
      allow read, create, update: if true;
    }
    match /customers/{phone} {
      allow read, create, update: if true;
    }
  }
}
```

The `customers` rule is required for the phone lookup and profile save. Tighten
these client-side rules before production if the app moves to authenticated
Firebase users or a server-side profile API.

## Billing Panel review

The linked Billing Panel repository does not have a customer-profile database,
login API, or separate customer real-time listener. It reads customer details
from each `pending_table_orders.customer` object and updates order status in
that same collection. No Billing Panel repository change is required for this
login flow.

## User Preferences
- Dark theme (#0f0f0f background, #f5a623 amber accent), mobile-first
- No dummy/hardcoded data — everything from live Firestore
- Firebase is single source of truth for auth + order status
- Modular JS (one concern per file), no build step
- Currency: INR (₹)
- All billing panel ↔ customer panel sync happens instantly via Firestore onSnapshot
