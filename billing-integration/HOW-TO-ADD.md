# Adding Incoming Orders to Your Billing Panel

3 changes. That's it.

---

## Step 1 — Copy the JS file

Copy `js/incoming-orders.js` from this folder into your billing panel's `js/` folder:

```
your-billing-panel/
  js/
    incoming-orders.js   ← add this file here
    firebase-config.js
    tables.js
    cart.js
    ...
```

---

## Step 2 — Add one `<script>` tag to `index.html`

Open your billing panel's `index.html` and paste this **just before the closing `</body>` tag**:

```html
<script type="module" src="js/incoming-orders.js"></script>
```

---

## Step 3 — Expose `openPOS` in `tables.js`

Open `js/tables.js`. Find the closing `}` of the `openPOS` function (around line 126–150).
Add these **two lines immediately after** that closing brace:

```javascript
    window._posOpenTable = openPOS;   // ← ADD THIS
    window._posLoadGrid  = loadGrid;  // ← ADD THIS
```

Like this:

```javascript
    function openPOS(name, targetTab = 'C1') {
        // ... existing code stays as-is ...
    }
    window._posOpenTable = openPOS;   // ← NEW
    window._posLoadGrid  = loadGrid;  // ← NEW
```

---

## What you'll see

After reload, a red **🔔 Orders** button appears in your home screen grid,
**right next to your Expense button** — same size, same style.

```
┌──────────────┬──────────────┐
│  🪑 Dine-In  │  📦 Parcel   │
├──────────────┴──────────────┤
│      ⚡ Quick Sale Entry     │
├──────────────┬──────────────┤
│ 💸 Expense   │ 🔔 Orders ← │
└──────────────┴──────────────┘
```

- **New order arrives** → red number badge appears on the button + alert beep loops
- **Touch Orders** → beep stops, drawer slides in
- **Drawer shows** → Table, customer name, phone, "3rd order from this customer", items, total
- **Accept** → items added to that table's cart → you're taken straight to the POS screen
- **Reject** → order marked rejected, disappears

---

## Table ID mapping (your QR code URLs)

| QR URL param | Maps to |
|---|---|
| `?table=Table 4` | Table 4 ✅ |
| `?table=T4` | Table 4 ✅ auto |
| `?table=4` | Table 4 ✅ auto |

---

## Firestore Security Rules

In Firebase Console → Firestore → Rules, make sure these paths are allowed:

```javascript
match /pending_table_orders/{doc} {
  allow read, update: if true;  // billing panel: reads + accept/reject
  allow create: if true;         // customer QR panel: writes new orders
}
```
