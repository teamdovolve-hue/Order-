# Customer QR Menu Panel

A mobile-first, dark-themed QR code menu for restaurant tables. Customers scan a QR code, browse items, and place orders — all saved live to Firestore.

## Stack
- Pure HTML / CSS / Vanilla JavaScript (ES Modules)
- Firebase Firestore v10 (CDN, no build step)

## File Structure
```
index.html            ← App shell & layout
css/
  style.css           ← Dark theme, mobile-first styles
js/
  firebase-config.js  ← Firebase init & db export
  menu.js             ← Fetch & render menu items
  cart.js             ← Cart state + DOM updates
  order.js            ← Order submission to Firestore
  app.js              ← Entry point, wires everything together
```

## How to Run
Open `index.html` directly (no build needed).  
Append `?table=T4` to the URL to simulate table T4, e.g.:
```
https://your-repl.repl.co/?table=T4
```

## Firebase Setup

### Firestore Collections
| Collection | Purpose |
|---|---|
| `menu_items` | Source of menu cards shown to customers |
| `pending_table_orders` | Destination for placed orders |

### `menu_items` document fields
| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | ✅ | Displayed as card title |
| `price` | number | ✅ | In INR |
| `category` | string | optional | Used for filter tabs (e.g. "Starters") |
| `description` | string | optional | Short description under name |
| `available` | boolean | optional | Set `false` to hide an item |

> **Rename the collection?** Edit `MENU_COLLECTION` at the top of `js/menu.js`.

### Firestore Security Rules (minimum)
```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /menu_items/{doc} {
      allow read: if true;
    }
    match /pending_table_orders/{doc} {
      allow create: if true;
    }
  }
}
```

## User Preferences
- Dark theme, mobile-first
- No dummy/hardcoded data — everything from live Firestore
- Modular JS (one concern per file)
- Currency: INR (₹)
