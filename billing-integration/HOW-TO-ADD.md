# Adding Incoming Orders to Your Billing Panel

3 changes. That's it.

---

## Step 1 — Copy the JS file

Copy `js/incoming-orders.js` from this folder into your billing panel's `js/` folder.

```
your-billing-panel/
  js/
    incoming-orders.js   ← add this
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

So the bottom of your `<body>` looks like:

```html
    <!-- ... existing scripts ... -->
    <script type="module" src="js/incoming-orders.js"></script>
  </body>
</html>
```

---

## Step 3 — Expose `openPOS` in `tables.js`

Open `js/tables.js`. Find the line that reads:

```javascript
function openPOS(name, targetTab = 'C1') {
```

(it's around line 126)

Go to **just after** the closing `}` of the `openPOS` function, and add these two lines:

```javascript
window._posOpenTable = openPOS;
window._posLoadGrid  = loadGrid;
```

So it looks like:

```javascript
    function openPOS(name, targetTab = 'C1') {
        // ... existing code ...
    }
    window._posOpenTable = openPOS;   // ← ADD THIS
    window._posLoadGrid  = loadGrid;  // ← ADD THIS
```

---

## That's it.

Reload your billing panel. You'll see a **🔔 Orders** button appear next to the History button on your home screen.

- When a customer orders via QR → red badge appears + alert sound loops
- Touch **🔔 Orders** → sound stops → drawer slides in
- Each order shows: table, customer name & phone, **Nth order** tag, items, total
- **Accept** → items auto-added to that table's cart → you're taken straight to the POS screen
- **Reject** → order marked rejected, disappears from the list

---

## Table ID mapping

Your QR code URLs should use the same format as your billing panel table names.

| QR URL | Billing panel |
|--------|---------------|
| `?table=Table 4` | Table 4 ✅ |
| `?table=T4`      | Table 4 ✅ (auto-mapped) |
| `?table=4`       | Table 4 ✅ (auto-mapped) |

So you can use any of those formats in your QR codes — the module handles the conversion.

---

## Firestore Security Rules (add if not already present)

In Firebase Console → Firestore → Rules:

```javascript
match /pending_table_orders/{doc} {
  allow read, update: if true;   // billing panel reads + accepts/rejects
  allow create: if true;          // customer panel writes
}
```
