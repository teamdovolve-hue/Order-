# Adding Incoming Orders + Order Status to Your Billing Panel

4 steps. Copy the file, add a script tag, expose two functions, and hook into KOT/Settle.

---

## Step 1 — Copy the JS file

Copy `js/incoming-orders.js` from this folder into your billing panel's `js/` folder:

```
your-billing-panel/
  js/
    incoming-orders.js   ← add / replace this file
    firebase-config.js
    tables.js
    cart.js
    ...
```

---

## Step 2 — Add one `<script>` tag to index.html

Open your billing panel's `index.html` and paste this **just before `</body>`**:

```html
<script type="module" src="js/incoming-orders.js"></script>
```

---

## Step 3 — Expose `openPOS` and `loadGrid` in tables.js

Open `js/tables.js`. After the closing `}` of the `openPOS` function (around line 126–150), add:

```javascript
    window._posOpenTable = openPOS;   // ← NEW
    window._posLoadGrid  = loadGrid;  // ← NEW
```

---

## Step 4 — Hook KOT and Settle into order-status (NEW)

This makes the customer panel show **"Preparing • X min"** live timers and move orders
to history automatically when you settle a table.

### 4a — KOT hook

Wherever you print the KOT in your billing panel (the function / button handler that
prints the kitchen order ticket), add **one line**:

```javascript
// Your existing KOT print code here …
window._orderStatusKOT?.(currentTableName);   // ← ADD THIS
```

Replace `currentTableName` with the variable that holds the active table's name
(e.g. `"Table 4"`, `selectedTable`, `activeTable`, etc.).

### 4b — Save & Exit hook

In your "Save & Exit" handler:

```javascript
window._orderStatusComplete?.(currentTableName, 'save_exit');   // ← ADD THIS
// … rest of your save/exit code
```

### 4c — Bill & Settle hook

In your "Bill & Settle" handler:

```javascript
window._orderStatusComplete?.(currentTableName, 'bill_settle');  // ← ADD THIS
// … rest of your settle code
```

> **Note:** `window._orderStatusKOT` and `window._orderStatusComplete` are defined by
> `incoming-orders.js` and are safe to call with `?.` — they no-op if the file isn't
> loaded or if no QR order was accepted for that table.

---

## What you'll see after setup

| Action in billing panel | Customer panel updates to |
|---|---|
| Order placed via QR | **Order Received** — kitchen notified soon |
| You press KOT | **Preparing • 0 min** (timer starts, ticks live) |
| You press Save & Exit | Order disappears from Active Orders, saved to history |
| You press Bill & Settle | Same as above |

---

## Table ID mapping

| QR URL param | Maps to |
|---|---|
| `?table=Table 4` | Table 4 ✅ |
| `?table=T4` | Table 4 ✅ auto |
| `?table=4` | Table 4 ✅ auto |

---

## Firestore Security Rules

```javascript
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

---

## Home screen layout (after setup)

```
┌──────────────┬──────────────┐
│  🪑 Dine-In  │  📦 Parcel   │
├──────────────┴──────────────┤
│      ⚡ Quick Sale Entry     │
├──────────────┬──────────────┤
│ 💸 Expense   │ 🔔 Orders ←  │
└──────────────┴──────────────┘
```
