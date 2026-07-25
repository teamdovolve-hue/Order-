# QR Menu — Customer Order Panel

Mobile-first, dark-themed QR menu for restaurant tables. Customers scan a QR code, log in, browse items, and place orders saved live to Firestore. The billing panel picks them up in real-time.

## Stack
- Pure HTML / CSS / Vanilla JavaScript (ES Modules)
- Firebase Firestore v10 (CDN, no build step)
- Served with `npx serve`

## How to Run
The app is served at port 5000 via the **Start application** workflow (`npx --yes serve . -p 5000 -s`).

Open with a table param in the URL:
```
https://your-repl.repl.co/?table=T4
```

## File Structure
```
index.html                ← App shell & all overlays
css/
  style.css               ← Full dark theme, login, search, active orders
js/
  firebase-config.js      ← Firebase init & db export (live keys inside)
  login.js                ← First-time login (Truecaller → WhatsApp → manual)
  search.js               ← Real-time menu search
  order-status.js         ← Live order status (pending → preparing → history)
  menu.js                 ← Fetch & render menu items, search support
  cart.js                 ← Cart state + DOM updates
  order.js                ← Order submission to Firestore
  customer.js             ← Thin shim over login.js (backward compat)
  history.js              ← Order history drawer (localStorage)
  app.js                  ← Entry point, wires everything together
billing-integration/
  js/incoming-orders.js   ← Drop into billing panel: incoming orders + KOT/settle hooks
  HOW-TO-ADD.md           ← 4-step setup guide for the billing panel
```

## Configuration

### Login system (js/login.js)
```javascript
const WHATSAPP_NUMBER        = "919999999999"; // ← replace with business WhatsApp number
const TRUECALLER_PARTNER_KEY = "";             // ← set for Truecaller 1-tap, or leave ""
```

### Firestore Collections
| Collection | Purpose |
|---|---|
| `menu_items` | Source of menu cards shown to customers |
| `pending_table_orders` | Orders written by customers, read by billing panel |

### Order Status Flow
| Firestore `status` | Customer sees |
|---|---|
| `pending` / `accepted` | Order Received — Kitchen notified soon |
| `kot` | Preparing • X min (live timer from `kotAt`) |
| `completed` | Removed from Active Orders, saved to history |

### Billing Panel Integration
See `billing-integration/HOW-TO-ADD.md` for 4-step setup. Key hooks:
- `window._orderStatusKOT(tableName)` — call when KOT is printed
- `window._orderStatusComplete(tableName, 'save_exit'|'bill_settle')` — call on settle

### Firestore Security Rules (minimum)
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
  }
}
```

## User Preferences
- Dark theme (#0f0f0f background, #f5a623 amber accent), mobile-first
- Login screen background: #1A1E29
- No dummy/hardcoded data — everything from live Firestore
- Modular JS (one concern per file)
- Currency: INR (₹)
- No build step — pure ES modules via CDN
