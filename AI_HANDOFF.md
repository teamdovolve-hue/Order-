# AI_HANDOFF.md

# Customer Panel — Project State

---

## [AI UPDATE 2026-09-20] — Fix: My Orders (order history) now shows the POS "Custom Discount" line

### Problem
An order billed with a Custom Instant Discount (e.g. Oreo ₹10 + Candle ₹10, discount −₹5, paid ₹15) showed the
items and the final ₹15 in Customer Panel → My Orders, but not the discount, so the numbers looked like they
didn't add up.

### Trace of the existing data path (nothing new was invented)
- The Billing Panel (POS) already saves the discount on the history doc:
  `customer_order_history/{uid}/orders/{orderId}` → `customDiscount` (flat ₹, `0` = none) and `subtotal`
  (pre-discount). `total` on that doc is already the FINAL payable. Written by BOTH `syncCustomerOrderCompletion()`
  (online/QR customers) and `syncManualCustomerProfile()` (manually attached customers), and re-written on every
  Edit History re-settle (removing the discount during an edit resets it to `0`). Absent on older docs.
- Customer Panel read path: `js/order-status.js` Listener 2 (`onSnapshot` on that subcollection) → maps each doc →
  `_syncHistoryToLocalStorage()` maps again (`total → totalPrice`) → `updateFromFirestore()` → `js/history.js`
  `renderHistory()`. Both mapping steps dropped every field they did not list, so `customDiscount` never reached
  the renderer.

### Files / functions changed (Customer Panel repo only)
| File | Function | Change |
|---|---|---|
| `js/order-status.js` | `startOrderTracking()` Listener 2 mapper | added `customDiscount: Number(d.data().customDiscount) \|\| 0` (pass-through of the existing field) |
| `js/order-status.js` | `_syncHistoryToLocalStorage()` | added `customDiscount: order.customDiscount \|\| 0` to the mapped object |
| `js/history.js` | new `discountRow(order)`; `renderHistory()` | renders `Custom Discount  −₹X` between the item `<ul>` and `.history-order-footer`, only when `Number(customDiscount) > 0` |
| `css/style.css` | new `.history-discount-row` / `-label` / `-amount` (just above `.history-order-footer`) | same 13px row style as an item row; amount in `var(--green)` |
No new field, no new collection, no Firestore/rules change, no Billing Panel change required (the field is already written).

### Behaviour
- `totalPrice` (footer) is still the saved final `total` — never recalculated, never `items − discount` in this panel.
- Amount is formatted with the panel's existing `fmt()` (Intl INR), so it reads `-₹5.00`, same style as every other amount in the drawer (items show `₹10.00`).
- No row when `customDiscount` is `0`, absent (old orders) or non-numeric. Works for online orders, manually attached customers, edited orders, and repeated edits (the Billing Panel updates the SAME doc, the live snapshot re-renders the drawer — confirmed below).

### Tests performed (headless Chromium, real `index.html` + real `auth.js`/`order-status.js`/`history.js`; Firebase stubbed with an in-memory Firestore that re-fires `onSnapshot` on writes — real Firestore NOT available)
16/16 pass on the fixed code; the same script on the untouched code fails the 7 discount checks (rows never rendered) while all total checks pass.
- Online order: Oreo/Candle, discount −₹5.00, total ₹15.00; row is directly below the list and directly above the footer (DOM sibling order checked, plus a visual screenshot).
- Manually attached customer doc (`billNumber`, `customerPhone`), edited order (`isEdited`), decimal discount (₹12.50, total ₹87.49), `customDiscount: 0`, field absent (legacy doc), edit that removed the discount → no row.
- Displayed totals equal the saved `total` for all 7 orders.
- Three live edits of one order (₹15 → ₹115 → ₹125 → discount removed, ₹120): drawer updated without reopening, no duplicate cards, row appears/disappears correctly.
- NOT tested: real Firestore, a real phone/browser theme other than the default dark theme.

### Known limitation (pre-existing, deliberately not changed)
`qrmenu_history` (localStorage) is only an offline fallback used before the first Firestore snapshot, and `saveOrderToHistory()` skips an order whose `firestoreId` is already cached — so a cached copy of an order billed/edited earlier is not refreshed and would not show the discount until the live snapshot arrives. Once online, `renderHistory()` uses the live snapshot (`_firestoreOrders`), which is correct.

### Billing Panel changes required
None. (The Billing Panel handoff already noted this panel only showed `total`; the fields it writes are used as-is.)

---

## [AI UPDATE 2026-09-14] — Fix: POS-created customer + Customer Panel account activation

### Problem

A customer can be created at the Billing Panel counter with just **Name + Phone**
(Billing Panel `js/cart.js` → `syncManualCustomerProfile()`), before ever opening
the Customer Panel. That profile has no `passwordHash`, and its `uid` field is
set to the phone number itself (the POS convention, so
`customer_order_history/{phone}/orders` resolves correctly without any
Customer Panel changes).

When that same customer later opened the Customer Panel and entered their phone
number, `js/auth.js` treated "profile exists but no passwordHash" exactly like
a brand-new registration: it showed the full "Create your account" form, and on
submit `_onCreateAccount()` did a **full, non-merge `setDoc`** on
`customers/{phone}`. That:

1. Reset `totalOrders` / `lifetimeSpend` / `lastOrderAt` to `0` / `0` / `null`,
   silently wiping the customer's existing stats.
2. Reset `createdAt` to "now".
3. Assigned a **brand-new anonymous Firebase Auth uid**, replacing the POS
   convention (`uid === phone`). This orphaned the existing
   `customer_order_history/{phone}/orders` subcollection — the order history
   documents still existed in Firestore, but the customer's session now
   pointed at a different (empty) `uid`, so their history appeared to vanish.

Net effect: same phone number, but a second "shadow" identity was effectively
created every time a POS-created customer activated their account.

### Fix

Added a dedicated **activation step**, separate from the registration step,
for the specific case "profile exists, no password yet":

- `_onPhoneSubmit()` now branches into three cases instead of two:
  1. `snap.exists() && profile.passwordHash` → **login step** (unchanged).
  2. `snap.exists() && !profile.passwordHash` → **NEW: activation step**
     (`_showActivateStep()`).
  3. `!snap.exists()` → **registration step** (unchanged — brand-new phone
     numbers are completely unaffected).
- The activation step (new `otpActivateStep` markup in `index.html`) shows
  *only* a password + confirm-password field, with the message:
  > Welcome back, {name}!
  > Your customer profile already exists.
  > Set a password to activate your online account.

  Name and phone are never re-entered or shown as editable — they come from
  the existing document.
- `_onActivateSubmit()` writes with `setDoc(..., { merge: true })`, touching
  **only** `passwordHash`, `phoneVerified` (kept as-is), `updatedAt`,
  `lastLoginAt`. Every other existing field — `uid`, `createdAt`,
  `totalOrders`, `lifetimeSpend`, `lastOrderAt`, `source` — is left completely
  untouched.
- The session is completed with the **existing** `uid` (`existing.uid ||
  existing.authUid || phone`), never a freshly-generated anonymous auth uid.
  For POS-created customers this means the session continues to use
  `uid === phone`, so `customer_order_history/{phone}/orders` keeps resolving
  to the same data it always did.
- No second `customers/{phone}` document, no second uid, no duplicate history
  bucket is ever created.

### What was verified unaffected

- **Existing online customers (have a `passwordHash`)** — `_onPhoneSubmit()`
  still routes them to the unchanged login step / `_onLoginSubmit()`.
- **Completely new phone numbers** — still go through the unchanged
  `_showProfileStep()` → `_onProfileSubmit()` → confirm →
  `_onCreateAccount()` full registration flow.
- **Forgot Password / staff recovery-code flow** — untouched; it's a separate
  `otpForgotBtn` / `_openRecovery()` flow with its own Cloudflare Worker calls
  and only applies to accounts that already have a `passwordHash`.
- **Firestore rules** — no change needed. `customers/{phone}` already allows
  `update: if isOperator()`, and `isOperator()` accepts *any* anonymous
  Firebase Auth session (which is what both the Billing Panel and Customer
  Panel use) — this is the same rule `_completeLogin()` already relies on for
  its existing `lastLoginAt` merge-write on every login.
- Ordering, billing, and coupon logic — not touched.

### Files changed

- `js/auth.js` — new `_pendingActivationProfile` state, new
  `_showActivateStep()`, new `_onActivateSubmit()`, updated `_onPhoneSubmit()`
  branch logic, updated step-switch functions (`_showPhoneStep`,
  `_showLoginStep`, `_showProfileStep`) to also hide the new step, updated
  reset points (`_completeLogin`, `_onLogout`) to clear the new state var.
- `index.html` — new `otpActivateStep` markup (welcome message + password +
  confirm-password fields + "Wrong number? Go back" link), placed between the
  existing login step and registration step in the auth modal.

### Manual test checklist

1. POS creates "Arnav" + `9876543210` (no password) → `customers/+919876543210`
   exists with `uid: "+919876543210"`, no `passwordHash`.
2. Customer Panel: enter `9876543210` → activation step appears:
   "Welcome back, Arnav! ... Set a password to activate your online account."
3. Set password → logged in immediately, no duplicate `customers` doc created,
   `uid` on the document is still `"+919876543210"`.
4. Existing order history / lifetime spend from the POS-created profile is
   still visible in "My Orders".
5. Log out, log back in with phone + the new password → works (normal login step).
6. A phone number that already had a password before this change → still logs
   in exactly as before.
7. A completely new phone number → still shows the full
   name/username/password registration + confirm flow, unaffected.
8. Forgot Password (for an account that already has a password) → unaffected,
   still works via the counter recovery-code flow.

---

## [AI UPDATE 2026-08-03] — Bug Fix: Variant Card Badge Overlap + Phase 3 Intelligent Home Screen

### Branch
`test-ux-polish`

---

### Bug Fix: Variant Card Layout (group-cart-badge overlapping ADD button)

**Root Cause:**
`.card-action` (the container holding the amber qty badge + ADD button on group/variant cards) lacked `display: flex`. The `.group-cart-badge` is a block-level flex element — when it became visible it stacked vertically above the ADD button, causing visual overlap inside the `card-footer-inline` row.

**Fix (`css/style.css`):**
```css
.menu-card .card-action {
  display: flex;
  align-items: center;
  gap: 8px;
}
```
Badge and ADD button now appear side by side. Simple (non-variant) cards are unaffected — their `.card-action` only contains the ADD button.

**Files changed:** `css/style.css` only. No JS changes.

---

### Phase 3 — Intelligent Home Screen

**Objective:** When the "All" category is selected and no search is active, replace the flat menu list with four dynamic discovery sections. Any specific category or search restores normal behavior exactly.

#### Architecture: Circular-Import-Free Design

`menu.js` and `home-sections.js` are kept decoupled via a registered-callback pattern:

```
app.js
 ├─ initMenu()           — registers Firestore listener, calls applyFilter()
 └─ initHomeSections()   — calls setHomeSectionsRenderer(fn) on menu.js

menu.js                  — never imports home-sections.js
 ├─ setHomeSectionsRenderer(cb)  — stores the renderer callback
 ├─ showFlatMenu()               — sets _forceFlat=true, re-runs applyFilter
 ├─ buildCardElement(entry, q)   — exported; reuses _createGroupCard/_createRegularCard
 └─ wireCardContainer(el)        — exported; attaches delegated click handler

home-sections.js         — imports from menu.js (no circular dep)
 └─ initHomeSections()   — registers renderer + wires #homeSections container once
```

Because Firestore `onSnapshot` fires asynchronously, `initHomeSections()` (called synchronously after `initMenu()`) is always registered before the first `applyFilter()` runs.

#### State machine in `applyFilter()` (`js/menu.js`)

| Condition | Behaviour |
|---|---|
| `activeSearch` truthy | Hide home sections → show flat filtered `#menuGrid` |
| `activeCategory === "All"` + `!_forceFlat` + renderer registered | Show `#homeSections`, hide `#menuGrid`, call renderer |
| `activeCategory === "All"` + `_forceFlat` | Hide `#homeSections` → show flat full list in `#menuGrid` |
| Any specific category | Hide `#homeSections` → show filtered `#menuGrid` |

`_forceFlat` is reset to `false` whenever `_selectCategory()` is called (user taps a category button or the FAB category list).

#### Section Algorithms (all in-memory, zero extra Firestore reads)

Sections operate on `grouped` — the output of `_groupItems(allItems)` — which now carries all original Firestore fields via `...rep` spread. Fields used: `isFeatured`, `orderCount`, `isNew`, `displayOrder`, `createdAt`.

| Section | Primary sort | Fallback |
|---|---|---|
| ⭐ Recommended | `isFeatured` first, then `orderCount` desc | All available items by `orderCount` |
| 🔥 Most Ordered | `orderCount` desc (only items with count > 0) | Featured items → then all available |
| ✨ New Arrivals | `isNew === true` items first | All items by `createdAt` desc (newest first) |
| 👨‍🍳 Chef's Picks | `isFeatured` by `displayOrder` asc | All available by `displayOrder` asc |

Limits: Recommended/Most Ordered/Chef's Picks → 8 items. New Arrivals → 6 items. Sections with 0 qualifying items are silently omitted. OOS-only groups and OOS single items are excluded from all sections.

#### `_groupItems` change (`js/menu.js`)

Previously the group entry only contained a fixed set of fields. Now:
```js
result.push({
  ...rep,         // ALL fields from representative variant item (isFeatured, orderCount, etc.)
  isGroup: true, groupKey, displayName, category, imageUrl, description, extraOptions, variants,
});
```
This is safe: all code that branches on `isGroup === true` was already explicit.

#### Card Rendering

`buildCardElement(entry, query)` exported from `menu.js` delegates to the existing `_createGroupCard` / `_createRegularCard` builders. Home section cards are **identical DOM elements** to main menu cards — no CSS duplication. Width is fixed to `272px` via `.home-section-scroll .menu-card { flex: 0 0 272px; }`.

`wireCardContainer(container)` attaches a single delegated click handler on `#homeSections` (called once at init). Handles ADD (opens item sheet), qty-minus, qty-plus, and Read More — same logic as `_wireCardEvents` but without the cloneNode/replaceChild replacement pattern.

Cart quantity badges update automatically on home section cards: `restoreCartUI()` (from `cart.js`) queries the entire DOM by `data-id` / `data-group-key`, so hidden or visible home section cards are updated alongside main menu cards.

#### "See All" behaviour

Every section has a "See All" button. Clicking it calls `showFlatMenu()` which sets `_forceFlat = true` and re-runs `applyFilter()`, rendering the full flat menu list in `#menuGrid`. The "All" category tab remains active. Tapping any other category (or tapping "All" again) resets `_forceFlat` and returns to home sections.

#### New file: `js/home-sections.js`

- `initHomeSections()` — exported; called once from `app.js`
- `_render(allItems, grouped)` — registered renderer, builds sections and injects cards
- `_computeSections(grouped)` — pure function; returns `[{id, title, entries}]` array
- `_isOos`, `_tsOf`, `_orderCount`, `_isFeatured`, `_isNew`, `_dispOrder`, `_limit` — private helpers

#### Files Changed

| File | Change |
|---|---|
| `js/home-sections.js` | **NEW** — section algorithms, renderer, init |
| `js/menu.js` | Added `_forceFlat`, `_renderHomeSectionsCb`, `setHomeSectionsRenderer`, `showFlatMenu`, `buildCardElement`, `wireCardContainer`; modified `_groupItems` to spread `...rep`; modified `applyFilter` to branch on home sections; added `_showHomeSections`/`_hideHomeSections` |
| `js/app.js` | Added `import { initHomeSections }` and `initHomeSections()` call at step 5d |
| `css/style.css` | Added `.home-sections`, `.home-section`, `.home-section-header`, `.home-section-title`, `.home-section-see-all`, `.home-section-scroll`, and scroll-card overrides |
| `index.html` | Added `<div class="home-sections hidden" id="homeSections">` before `#menuGrid` |

#### What Was NOT Changed

- Auth, Firestore schema, order placement, cart logic
- `_wireCardEvents` on `#menuGrid` — untouched
- Category filter, search, OOS badge behaviour
- Any Billing Panel interface

---

## [AI UPDATE 2026-08-03] — UX Polish: Image, Special Request, Category FAB

### Branch
`test-ux-polish` (pushed to GitHub for preview; not yet merged to `main`)

### Files Modified
- `css/style.css`
- `index.html`
- `js/item-sheet.js`
- `js/review.js`
- `js/order.js`

### Change 1 — Product Image Fix (Item Details Bottom Sheet)

**Problem:** The image inside the item sheet was cropped because the container used `height: 220px` + `object-fit: cover`.

**Fix (css/style.css):**
- `.item-sheet-img-wrap`: Changed from full-width fixed-height to `width: calc(100% - 32px)` + `margin: 12px auto 0` + `aspect-ratio: 4/3` + `border-radius: 18px`. Added `box-shadow` for premium feel. Background changed to `rgba(255,255,255,0.04)` (translucent) so it blends with the sheet.
- `.item-sheet-img`: Changed `object-fit: cover` → `object-fit: contain`. Added `padding: 10px` so the food never touches the edges.
- Shimmer placeholder updated to match rounded corners.

**Result:** Full image always visible, original aspect ratio preserved, rounded corners, premium shadow.

### Change 2 — Special Request Shown in Cart / Order Review

**Problem:** The special request typed in the item sheet was stored nowhere — it was cleared on "Add to Cart" and never reached the review or order payload.

**Fix (js/item-sheet.js):**
- `_onAddToCart()` now reads `#itemSheetRequest` textarea value.
- Stored in `cartExtras.set(cartId, { extras, specialRequest })` alongside existing extras.
- If both extras and specialRequest are empty, the Map entry is deleted (unchanged from before).

**Fix (js/review.js):**
- `_render()` reads `cartExtras.get(item.id)?.specialRequest` for every cart item.
- If a request exists: renders it in an amber pill with "Edit" + "✕" buttons.
- If no request: renders a dashed "+ Special request" button.
- `data-review-action` values added: `add-req`, `edit-req`, `save-req`, `cancel-req`, `clear-req`.

**Fix (js/order.js):**
- `placeOrder()` now reads `cartExtras.get(item.id)?.specialRequest`.
- Included in the Firestore order item as `specialRequest` field (only when non-empty via `...spread`).
- Billing Panel / KOT will automatically see the request in the order items array.

### Change 3 — Edit Special Request from Cart

**Implementation (js/review.js):**
- Module-level `_editingRequestId` tracks which item is in edit mode.
- When "Edit" is tapped: `_editingRequestId = item.id`, re-render shows inline `<textarea>` pre-filled with current request + "Save" / "Cancel" buttons.
- `requestAnimationFrame` auto-focuses the textarea and positions cursor at end.
- On "Save": updates `cartExtras`, clears `_editingRequestId`, re-renders.
- On "Cancel": clears `_editingRequestId`, re-renders (no save).
- On "✕": sets `specialRequest = ""`, re-renders (request removed).
- `closeReview()` also resets `_editingRequestId = null`.

**No changes to:** `cart.js`, `order-status.js`, `auth.js`, Firestore schema.

### Change 4 — Floating Category Button Redesign

**Problem:** The generic circle icon FAB didn't communicate its purpose.

**Fix (index.html):**
- Replaced SVG grid icon with `☰` emoji + "Menu" text label.
- New HTML: `<span class="category-fab-pill-icon">☰</span> <span class="category-fab-pill-text">Menu</span>`

**Fix (css/style.css):**
- `.category-fab`: Removed `width: 52px; height: 52px; border-radius: 50%; background: var(--accent); color: #000`.
- New: `height: 46px; padding: 0 18px; border-radius: 999px; background: #171923; color: var(--accent); border: 1.5px solid var(--accent)`.
- Shadow: amber glow `rgba(245,166,35,0.25)` + deep dark `rgba(0,0,0,0.55)`.
- Hover: subtle amber tint background.
- Active/open state: flips to solid amber fill.
- `.category-fab-pill-icon` / `.category-fab-pill-text` added.

### Change 5 — Category Bottom Sheet Polish

**Fix (css/style.css):**
- `.category-fab-row`: `padding: 13px` → `padding: 15px`; added `min-height: 56px` for better touch targets on mobile; added `-webkit-tap-highlight-color: transparent`.
- Animation remains `otpSlideUp 0.35s cubic-bezier(0.32, 0.72, 0, 1)` — smooth and snappy.

### New CSS Classes Added
| Class | Purpose |
|---|---|
| `.review-special-req` | Amber pill showing existing special request |
| `.review-special-text` | Request text inside the pill |
| `.review-special-btns` | Edit + Clear button group |
| `.review-special-edit` | "Edit" button |
| `.review-special-clear` | "✕" clear button |
| `.review-add-req` | Dashed "+ Special request" trigger button |
| `.review-req-edit-wrap` | Inline edit container |
| `.review-req-textarea` | Special request edit textarea |
| `.review-req-edit-actions` | Save + Cancel button row |
| `.review-req-save` | Save button (amber) |
| `.review-req-cancel` | Cancel button (muted) |
| `.category-fab-pill-icon` | ☰ emoji inside the pill FAB |
| `.category-fab-pill-text` | "Menu" text inside the pill FAB |

### What Was NOT Changed
- Auth flow, Firestore schema, order status values, callable interfaces
- `cart.js` public API (addItem, removeItem, clearCart, refreshCartUI, updateCardUI)
- `order.js` placeOrder() submission logic (only items array gained optional `specialRequest` field)
- `order-status.js`, `history.js`, `menu.js`, `search.js`, `restaurant-status.js`
- Billing Panel compatibility — `specialRequest` is an additive optional field; existing orders without it are unaffected

### Billing Panel Changes Required
**None for existing functionality.** The `specialRequest` field is now present on order items when the customer typed a request. The Billing Panel / KOT printer will show it naturally if it already renders item fields. No schema migration needed — the field is additive and optional.

### Testing Performed
- ✓ App loads at `/t/1` with no console errors
- ✓ Category FAB renders as amber-bordered pill "☰ Menu"
- ✓ Tapping FAB opens category bottom sheet with improved touch targets
- ✓ Item sheet image uses contain (no cropping), rounded, shadowed
- ✓ Special request field preserved in cartExtras through add → review → order flow

---

## [AI UPDATE 2026-08-02] — Phase 1: Premium Menu Cards + Item Details Bottom Sheet

### Files Modified
- `js/item-sheet.js` ← **NEW FILE**
- `js/menu.js`
- `js/app.js`
- `index.html`
- `css/style.css`

### Architectural Decisions

#### 1. ADD button now opens Item Details Sheet (not direct addItem)
The ADD button on every menu card no longer calls `addItem()` directly. Instead it calls `openItemSheet(item)` from the new `js/item-sheet.js` module. From the sheet, the customer sets qty and optional extras, then taps "Add to Cart" which calls `addItem(id, name, unitPrice)` N times (once per qty unit).

**addItem(id, name, price) interface is unchanged.** The item sheet is a pure presentation layer inserted before the existing cart flow.

#### 2. Qty controls on already-in-cart cards still call addItem/removeItem directly
When an item is already in the cart, the ADD button is replaced by a ±/qty control. Tapping these controls still calls `addItem()` / `removeItem()` directly without opening the sheet. This is intentional — the sheet is for first-add discovery, not for in-cart adjustments.

#### 3. `_itemsById` Map in menu.js
A `Map<id, fullItem>` is populated every time the Firestore snapshot fires. This allows `_wireCardEvents` to pass the full item object (including `imageUrl`, `description`, `extraOptions`) to `openItemSheet()` without encoding all fields in `data-*` attributes.

#### 4. Extra options modify the per-unit price
If a Firestore `menu_items` document has `extraOptions: [{name, price}]`, they are shown as checkboxes in the sheet. Selected extras are added to the base price before `addItem()` is called. **Known limitation:** if the customer adds an item, then re-opens the sheet and adds it again with different extras, the cart item's price is not updated (only qty increments). This is a `cart.js` Map design constraint; fix in a future phase if needed.

#### 5. Image lazy loading
Images use `loading="lazy"` + `decoding="async"` on `<img>`. The shimmer placeholder is a sibling `<div>` hidden via inline `onload`. On error the entire `.card-img-wrap` is hidden. This requires no JS IntersectionObserver — browser-native lazy loading handles it.

#### 6. Description "Read More" expand
Description is clamped to 2 lines via `-webkit-line-clamp: 2`. A "Read More" button is rendered alongside every description but only becomes visible after `_wireReadMore()` checks `scrollHeight > clientHeight`. Clicking toggles the `card-desc--expanded` class which removes the clamp.

### Firestore Fields Consumed (NEW — read-only, no writes)
| Field | Type | Notes |
|---|---|---|
| `imageUrl` | string? | Product photo URL. Optional — cards show food emoji placeholder if absent |
| `description` | string? | Item description. Optional — shown in card (2-line clamp) and sheet (full) |
| `extraOptions` | array? | `[{name: string, price: number}]`. Optional — section hidden if absent |

All other fields (`name`, `price`, `category`, `available`, `inStock`) unchanged.

### Dynamic Rendering Flow
```
Firestore menu_items → onSnapshot → allItems array + _itemsById Map populated
  ↓
renderMenuItems() → _createRegularCard(item) for each item
  ↓
Card shows: [imageUrl or emoji placeholder] [name] [description 2-line] [price] [ADD]
  ↓
Customer taps ADD
  ↓
openItemSheet(fullItem) — sheet slides up
  ↓
Sheet shows: [large image] [full name] [full description] [extraOptions checkboxes] [custom request] [qty] [live price]
  ↓
Customer taps "Add to Cart"
  ↓
addItem(id, name, unitPrice) × qty — existing cart flow, unchanged
```

### Performance Improvements
- Images lazy-loaded natively (`loading="lazy"`) — no Firestore reads involved
- Shimmer placeholder prevents layout shift during image load
- `_itemsById` Map avoids DOM data-attribute encoding of full item objects

### Compatibility Notes
- All existing Firestore queries unchanged (no new reads, no new listeners)
- `addItem(id, name, price)` interface unchanged
- `placeOrder()` → `pending_table_orders` order schema unchanged
- Half/Full and Triple variant cards: tapping a side opens the sheet for that specific variant document — backward compatible with existing Billing Panel variant structure
- Search now also matches `description` field (additive — no breaking change to `filterBySearch` API)

### Scalability Notes
- Any new `menu_items` document field (`imageUrl`, `description`, `extraOptions`) renders automatically — zero code changes required
- Extra option names and prices come from Firestore — never hardcoded
- Variant names come from Firestore document names — never hardcoded

### Testing Performed
- ✓ App loads on `/t/4` with no JS errors
- ✓ Card layout shows image placeholder, item name, price, ADD button
- ✓ Category tabs functional
- ✓ Search functional (now also searches description)
- ✓ Item sheet modal present in DOM
- ✓ Existing frozen systems (auth, order, order-status, cart) untouched

### Remaining Phases
| Phase | Scope |
|---|---|
| 2 | Floating Category FAB + Category Bottom Sheet |
| 3 | Home Screen Intelligent Sections (Recommended, New Items, etc.) |
| 4 | Cart UI + Animation Polish |
| 5 | Search Improvements + Performance |

### Billing Panel Changes Required
**None.** Phase 1 is purely a Customer Panel frontend change. No Firestore schema, callable interface, or order payload was changed.

---


**Repository:** https://github.com/teamdovolve-hue/Order-
**Production URL:** https://newpizzahutlivecake.in (Vercel, static site)
**Last Updated:** 2026-08-01

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

✅ Cart persistence across page refreshes (localStorage, key: `qrmenu_cart`)
✅ Username auto-generation hidden from registration UI (still stored in Firestore)
✅ Input field glow/border highlight on dark background (amber soft glow on focus)
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

## [AI UPDATE 2026-08-01] — Cart Persistence, Hidden Username, Input Visibility

### Files Modified
- `js/cart.js`
- `js/menu.js`
- `js/auth.js`
- `index.html`
- `css/style.css`

### Change 1 — Cart persists across page refreshes

**localStorage key:** `qrmenu_cart`

Every `addItem` / `removeItem` immediately serializes the cart Map to `localStorage.setItem("qrmenu_cart", …)`. `clearCart()` removes the key instead.

On module load, `_loadCart()` restores the Map before the menu renders. After each menu render, `restoreCartUI()` (new export from `cart.js`) is called from `menu.js` → `renderMenuItems()` to sync all qty-control DOM elements and the cart bar to the restored state.

Logout (`_onLogout` in `auth.js`) removes `"qrmenu_cart"` from localStorage alongside the session and history keys.

**Constraint:** `restoreCartUI()` must always be called after menu items are rendered, not before — `updateCardUI` queries live DOM elements.

### Change 2 — Username hidden from registration UI

The `.username-row` div and `#otpUsernameStatus` paragraph in `index.html` are hidden via `style="display:none" aria-hidden="true"`. The hidden `#otpUsernameInput` still exists in the DOM.

Username is still auto-generated in `_onNameInput` using `_generateUsername(name)` and stored in the hidden input. Firestore write and `usernames/{username}` uniqueness index are unchanged.

`_onProfileSubmit` no longer shows user-facing errors for username issues (field is hidden). Instead:
- If the hidden input is empty or invalid, it re-generates from name.
- If `_usernameAvailable` is false (generated name taken), a random 4-digit suffix is appended and `_usernameAvailable` is set optimistically. `_onCreateAccount` still runs the final uniqueness check.

The confirm step's Username row is also hidden (`style="display:none"`). The `#otpConfirmUsername` element is still updated by JS (no code change needed there).

### Change 3 — Input field visibility (subtle glow)

All modal input containers now have:
- Resting border: `rgba(255,255,255,0.14)` (slightly more visible than before)
- Focus: `border-color: rgba(245,166,35,0.55)` + `box-shadow: 0 0 0 3px rgba(245,166,35,0.10), 0 0 18px rgba(245,166,35,0.07)`

Affected containers: `.otp-name-input`, `.otp-phone-row`, `.username-row`, `.otp-password-row`.

`.otp-password-row` now renders its own `background` + `border` (previously the password inputs inside were fully transparent/invisible). The Show/Hide toggle's own border is removed since the row provides the outer frame.

Registration password inputs (`#otpPasswordInput2`, `#otpPasswordConfirm`) were previously class `otp-field-input` only (transparent, borderless). They now also carry `otp-name-input` class, inheriting the visible border + focus glow.

---

## [AI UPDATE 2026-08-01] — Order Review Sheet Before Submission

### Files Modified
- `js/review.js` ← **NEW FILE**
- `js/app.js`
- `index.html`
- `css/style.css`

### What Changed

#### New checkout flow
```
Customer adds items to cart
  ↓ Cart bar shows "View Details" button
  ↓ openReview() — Order Review Sheet slides up
  ↓ Customer reviews items, adjusts quantities, sees grand total
  ↓ Taps "Place Order →" inside review sheet
  ↓ requireLogin() — if not logged in, login modal appears (unchanged)
  ↓ closeReview() — sheet dismissed
  ↓ placeOrder() — existing submission flow (unchanged)
  ↓ Success/error overlay (unchanged)
```

#### `js/review.js` (new)
- `initReview()` — wires static DOM events once on boot
- `openReview(onPlaceOrder)` — renders current cart, shows sheet, stores callback
- `closeReview()` — hides sheet
- Delegated `click` listener on `#reviewItems` handles +/− per-item without closing
  - Uses `addItem` / `removeItem` from `cart.js` — cart state + menu card UI stay in sync
  - Auto-closes if cart reaches zero items after a removal
- `_render()` — re-renders item list and totals from live `cart` Map on every change
- Tapping backdrop (`.review-backdrop`) also closes the sheet

#### `js/app.js`
- Imported `initReview`, `openReview`, `closeReview` from `review.js`
- Boot step 5: calls `initReview()`
- `#placeOrderBtn` listener: now calls `openReview(cb)` instead of `requireLogin(cb)` directly
  - Inside the callback: `requireLogin(() => { closeReview(); placeOrder(); })`
- Success overlay close handler: removed the stale `btn.textContent = "Place Order →"` reset
  (cart is cleared by `placeOrder()` → `refreshCartUI()` hides the bar anyway)

#### `index.html`
- `#placeOrderBtn` text changed from "Place Order →" to "View Details"
- Added `#reviewModal` with backdrop, drag handle, header, scrollable item list, totals, and two action buttons (`#reviewBackBtn`, `#reviewPlaceBtn`)

#### `css/style.css`
- Added `.review-modal`, `.review-backdrop`, `.review-sheet` — mirrors OTP modal pattern
- Added `.review-item`, `.review-item-info`, `.review-item-right`, `.review-item-name`, `.review-item-unit-price`, `.review-item-line-total`
- Added `.review-qty-ctrl`, `.review-qty-btn`, `.review-qty-num`
- Added `.review-divider`, `.review-total-row`, `.review-grand-total`, `.review-grand-amount`
- Added `.review-actions`, `.btn-review-back`, `.btn-review-place`
- Responsive: `border-radius: 28px` on ≥600 px, safe-area inset on notched phones

### What Was NOT Changed
- `js/order.js` — `placeOrder()` is called identically, not touched
- `js/auth.js` — `requireLogin()` called identically, not touched
- `js/cart.js` — `addItem()`, `removeItem()`, `clearCart()`, `refreshCartUI()` not touched
- `js/order-status.js`, `js/history.js`, `js/menu.js`, `js/search.js` — untouched
- Firestore collections, document structure, order schema — unchanged
- Billing Panel compatibility — no changes required

### Billing Panel Changes Required
None. This is a pure Customer Panel frontend change.

---

## [AI UPDATE 2026-08-01] — Online Ordering Paused Screen Always Shown (Regression Fix)

### Files Modified
- `index.html`
- `js/restaurant-status.js`

### Root Cause
Three compounding problems caused `#orderingOfflineScreen` to show permanently even when `settings/restaurant_status.onlineOrderingEnabled = true` in Firestore:

1. **HTML default state:** `#orderingOfflineScreen` had no `hidden` class — it was visible (`position:fixed; inset:0; z-index:9999`) by default on every page load, covering the entire viewport until `_applyStatus(true)` ran. Any delay in Firestore responding meant customers saw "paused".

2. **Stale IndexedDB cache (`persistentLocalCache`):** `firebase-config.js` uses `persistentLocalCache` which caches documents in IndexedDB. The document `settings/restaurant_status` was created on 2026-07-31 (likely initially as `false` during testing). Customer browsers that visited the production site on or after that date had the stale `false` value cached. Without `{ includeMetadataChanges: true }`, there is no way to distinguish a cached `false` from a server-confirmed `false` — so the code applied "paused" from the cached value permanently (or until the network update arrived, which could be never on a slow connection).

3. **No fallback timeout:** If Firestore was slow but didn't error, the error handler (which defaults to ON) was never triggered. The listener simply stalled, leaving the paused screen visible indefinitely.

### Fix

**`index.html`:**
- Added `class="hidden"` to `#orderingOfflineScreen` — the paused screen now starts hidden. Loading state ≠ disabled state. The screen only appears after Firestore SERVER confirms `false`.

**`js/restaurant-status.js`:**
- Added `{ includeMetadataChanges: true }` to `onSnapshot`. This makes the listener fire twice per round-trip: once from IndexedDB cache (`snap.metadata.fromCache = true`) and once from the server (`snap.metadata.fromCache = false`).
- Added guard: if `!enabled && snap.metadata.fromCache` → skip (return early). Stale cached `false` values no longer show the paused screen.
- Added `FIRESTORE_TIMEOUT_MS = 8000` fallback timer. If the server does not respond within 8 seconds, defaults to ON. Prevents permanent "paused" on slow connections where the SDK is still connecting but has not errored.
- Existing error handler (defaults to ON) preserved unchanged.

### What Was NOT Changed
- Firestore path (`settings/restaurant_status`) and field (`onlineOrderingEnabled`) — both verified correct against live Firestore
- `_applyStatus()` logic — unchanged
- `app.js`, `auth.js`, `order.js`, `order-status.js`, `menu.js`, `cart.js` — untouched
- `isOrderingEnabled()` export — unchanged

### Verified Scenarios
- ✓ Fresh page load while ON → menu visible immediately
- ✓ Fresh page load while OFF → "Online Ordering Paused" screen shown (server-confirmed)
- ✓ Toggle OFF → ON → menu appears in real-time via `onSnapshot`
- ✓ Toggle ON → OFF → paused screen appears in real-time via `onSnapshot`

### Billing Panel Changes Required
None. The Billing Panel's write path (`settings/restaurant_status.onlineOrderingEnabled`) was already correct.

---

## [AI UPDATE 2026-07-31] — Per-Item Timers and Per-Item Served Status

### Files Modified
- `js/order-status.js`
- `css/style.css`

### Root Cause
The Billing Panel's `printKOT()` in `js/cart.js` wrote `{ status: 'kot', kotAt: serverTimestamp() }` to **every** active `pending_table_orders` document for the current table on every KOT press — including documents already in `kot` status. This reset all existing timers to zero whenever a second order triggered a new KOT.

Additionally, the old rendering showed one status row and one timer for the entire order document. There was no per-item granularity.

### Fix (Customer Panel side)

**`js/order-status.js`:**
- Listener 1 mapping now forwards `itemMeta: o.itemMeta || null` alongside the existing fields. `itemMeta` is a map written by the Billing Panel (`js/cart.js`, `js/incoming-orders.js`) containing per-item `kotAt`, `servedAt`, and `itemStatus` keyed by stable item ID.
- `_renderActiveOrders` rewritten: each item in `order.items` now renders as its own `.aos-item-row` with its own status class and elapsed timer. The single order-level `.aos-status` / `.aos-dot` row is removed.
- `_startPreparingTimer` interval updated: now targets `.aos-item-row[data-kot-at]` (per-item) instead of `.aos-card[data-kot-at]` (per-order). Patches `.aos-item-status-label` within each matched row.
- Backward compatibility: orders without `itemMeta` (placed before the Billing Panel deploys its fix) fall back to order-level `status` + `kotAt` — existing behaviour fully preserved.

**`css/style.css`:**
- Added `.aos-item-row` — per-item row container (flex, border-left, padding).
- Added `.aos-item-row-name` — flex column for item name + qty.
- Added `.aos-item-status-label` — small bold timer/status label per item.
- Added `.aos-item-preparing` — green tint (#10b981), shows "Preparing 🍕 • X min".
- Added `.aos-item-pending` — amber tint, shows "Order Received — Kitchen notified soon".
- Added `.aos-item-served` — muted, shows "Order Received ✓", name opacity reduced.
- Existing `.aos-status`, `.aos-dot`, `.aos-dot-pend`, `.aos-dot-prep` CSS kept in place.

### Billing Panel Changes Required
The Customer Panel is now ready to consume `itemMeta`. The Billing Panel must deploy matching changes to `js/incoming-orders.js`, `js/cart.js`, and `firestore.rules` as described in the architecture audit. Until those are deployed, the Customer Panel falls back to order-level status/timer (backward compat).

### What Was NOT Changed
- `startOrderTracking`, `stopOrderTracking`, `initOrderStatus`, `stopOrderStatus` public API
- Listener 2 (`customer_order_history`) — untouched
- `_syncHistoryToLocalStorage` — untouched
- `getStatusLabel`, `getStatusColor`, `_tsToMs`, `_elapsedMin` helpers — untouched
- Firestore query predicate (customer.uid filter, status exclusion list) — untouched
- Auth flow, order placement, menu, cart, search, history, QR detection — untouched
- Dark theme, login modal styles, all non-`.aos-item-*` CSS — untouched
- ARCHITECTURE_LOCK.md — no architectural changes (additive field read, rendering enhancement)

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

---

## [AI UPDATE 2026-07-29 v3] — Registration Permission-Denied Root Cause + Fix

### Symptoms Reported
1. Username availability always shows: "Availability check unavailable. You may still continue."
2. Clicking Create Account fails with: "Permission denied. Please ask restaurant staff for help."

### Forensic Investigation

**Step 1 — Fetched actual Billing Panel `firestore.rules` from GitHub.**

The file has the correct rules:
```js
match /customers/{phone} {
  allow read:   if request.auth != null;
  allow create: if request.auth != null && request.resource.data.phoneVerified == false;
  allow update: if isOperator();
  allow delete: if isOperator();
}
match /usernames/{username} {
  allow read:   if request.auth != null;
  allow create: if request.auth != null;
  allow update: if false;
  allow delete: if isOperator();
}
```

**Step 2 — Cross-checked against observed behaviour.**

| Operation | Expected result (rules correct) | Observed result |
|---|---|---|
| `getDoc(customers/{phone})` (phone lookup) | ✅ success | ✅ success |
| `getDoc(usernames/{username})` (availability) | ✅ success | ❌ permission-denied |
| `setDoc(customers/{phone})` (registration) | ✅ success | never reached |
| `setDoc(usernames/{username})` (username reg) | ✅ success | never reached |

**Conclusion:** The `usernames` rules are in the file on GitHub but **have not been deployed** to Firebase. The `customers` rules were deployed earlier (phone lookup works); the `usernames` rules were added in session 21 but `firebase deploy --only firestore:rules` was never run.

**Step 3 — Traced the exact failure in `_onCreateAccount` (Customer Panel code bug).**

The old code had ONE outer `try { } catch` wrapping all three Firestore operations in sequence:
```
1. getDoc(usernames/{username})  ← throws permission-denied (rules not deployed)
2. setDoc(usernames/{username})  ← NEVER REACHED
3. setDoc(customers/{phone})     ← NEVER REACHED
```
The outer catch shows "Permission denied" and returns. The critical `setDoc(customers)` is
**never attempted**, so the account is never created — even though `customers` create IS allowed.

### Fix Applied (Customer Panel — `js/auth.js`)

Split the three Firestore operations into **separate try-catch scopes**:

- **Step A** (`getDoc(usernames)`) — wrapped in its own try-catch. On `permission-denied`:
  logs a warning, skips the collision check, continues. On success: still enforces uniqueness
  (username taken → back to profile step).

- **Step B** (`setDoc(usernames)`) — wrapped in its own try-catch. On `permission-denied`:
  logs a warning, continues. Once Billing Panel deploys rules, this silently succeeds.

- **Step C** (`setDoc(customers)`) — **the critical write**. Remains in the outer try-catch.
  If this fails with permission-denied, a specific error is shown. If it succeeds,
  `_completeLogin` runs and registration is complete.

**Result after fix:**
- Registration NOW works: customers/{phone} document is created, login completes.
- Username uniqueness enforcement is best-effort until Billing Panel deploys rules.
- Once rules are deployed: no Customer Panel changes needed — the inner try-catch wrapping
  is harmless; the operations will succeed normally.

### Files Modified
- `js/auth.js` — `_onCreateAccount` refactored as described above

### Billing Panel Action Required — DEPLOY THE RULES

The rules are **already correctly written** in
`firestore.rules` in the Billing Panel repository. They just need to be deployed.

**Command to run in the Billing Panel repository:**
```bash
firebase deploy --only firestore:rules
```

**What this unlocks:**
- Username availability check shows ✓/✗ correctly (currently shows "unavailable")
- Username uniqueness is enforced at registration time
- The `usernames` `getDoc` + `setDoc` in `_onCreateAccount` succeed and log no warnings
- The username availability check in `_scheduleUsernameCheck` succeeds cleanly

**No code changes are needed in the Billing Panel.** The rules are already correct.

### End-to-End Registration Flow After This Fix

```
Customer enters phone → getDoc(customers) → not found → showProfileStep()
  ↓
Enters Name (auto-generates @username), Password × 2
  ↓
_scheduleUsernameCheck → getDoc(usernames/{username})
  If rules deployed:  ✓ @username is available  (or ✗ taken)
  If rules pending:   "Availability check unavailable — you may still continue"
  _usernameAvailable = true (either way)
  ↓
Review Details → confirm screen
  ↓
Create Account → _onCreateAccount()
  Step A: getDoc(usernames)    — skipped with warning if permission-denied
  Step B: setDoc(usernames)    — skipped with warning if permission-denied
  Step C: setDoc(customers)    — EXECUTES (rules deployed for create)
  → _completeLogin → session saved → modal closed → customer logged in ✅
```

### What Was NOT Changed
- Registration UX flow, confirmation screen, field validation
- `customers` document structure (all fields preserved)
- Login flow (`_onLoginSubmit`, `_onPhoneSubmit`)
- Order placement, active orders, history
- Any other file outside `js/auth.js`
- ARCHITECTURE_LOCK.md (no architectural changes)

---

## [AI UPDATE 2026-08-02] — Footer Button State Fix (Stale "Placing…" After First Order)

### File Modified
- `js/order.js`

### Bug
After a successful order the footer cart-bar button (`#placeOrderBtn`) was left with
`disabled = true` and `textContent = "Placing…"`. `clearCart()` hides the cart bar
immediately after submission, so the stale state was invisible — until the customer
added a new item and the bar reappeared, showing "Placing…" with the button disabled
before any order was in progress.

### Root Cause
`placeOrder()` sets `btn.disabled = true; btn.textContent = "Placing…"` at the start
of submission. On the **success path** the button was never reset — only `clearCart()`
and `_showSuccess()` were called. On the **error path** the button was reset, but to
the old pre-review text `"Place Order →"` instead of the current `"View Details"`.

### Fix
Two lines changed inside the `try/catch` block in `placeOrder()` (`js/order.js`):

1. **Success path** — added reset immediately after `clearCart()` and before
   `_showSuccess()`:
   ```js
   if (btn) { btn.disabled = false; btn.textContent = "View Details"; }
   ```

2. **Error path** — corrected the existing reset from `"Place Order →"` to
   `"View Details"`:
   ```js
   if (btn) { btn.disabled = false; btn.textContent = "View Details"; }
   ```

### What Was NOT Changed
- Cart logic (`cart.js`)
- Order payload / Firestore write
- Billing Panel callable contracts
- Auth flow
- Any UI layout or CSS
- All other files

---

# Customer Password Recovery — Customer Panel (AI UPDATE [2026-09-12])

Implements the customer half of the staff-assisted recovery flow specified by the
Billing Panel agent in `Arnavmishra142/Billing-system-Pizza-hut-` → `AI_HANDOFF.md`
("Customer Password Recovery — Customer Panel Changes"). The billing panel + the
Cloudflare Worker endpoints were already implemented and deployed there.

## Audit performed before coding (handoff vs. actual code)

| Handoff claim | Verified in this repo |
|---|---|
| Account = `customers/{+91XXXXXXXXXX}` | ✅ `js/auth.js` `_onPhoneSubmit` → `+91${phone}` doc lookup |
| Password = hex SHA-256(`password + ":" + phone`) computed in browser | ✅ `_hashPassword()` |
| Firebase Auth is anonymous/custom-token only, holds no password | ✅ `signInAnonymously` / `onAuthStateChanged` only |
| Session in `localStorage["qrmenu_user"]` | ✅ `SESSION_KEY` |
| "Forgot Password?" was a dead-end static overlay | ✅ `#otpForgotBtn` → `#otpForgotOverlay` |

No discrepancies found. No new architecture introduced.

## Files changed

| File | Change |
|---|---|
| `index.html` | The `#otpForgotOverlay` popup body replaced with a 3-step recovery card (`#otpRecStep1/2/3`). `#otpForgotOverlay` and `#otpForgotCloseBtn` IDs kept. |
| `js/auth.js` | Forgot-password listeners now call the new flow; added `_recoveryCall`, `_recoveryMessage`, `_recShowStep`, `_openRecovery`, `_closeRecovery`, `_onRecoveryVerify`, `_onRecoverySetPassword`, module state `_recResetToken` / `_recPhone`. Nothing existing modified apart from those two listeners. |
| `css/style.css` | Appended a block of `.rec-*` rules scoped under `#otpForgotOverlay`. No global/base styles touched. |

## New flow

1. **Step 1** — "Please contact the billing counter to get your temporary recovery code."
   Phone (prefilled from the login/phone step) + 6-digit code → **Verify Code**.
2. **Step 2** — New Password + Confirm Password (min 6 chars, must match) → **Set New Password**.
3. **Step 3** — Success message → **Back to Login**, login screen prefilled with the same number.

## Backend dependency

Worker base `https://pizza-billing-functions.mishrarnav142.workers.dev`, plain
`fetch` POST, body `{ data: {...} }`, no auth header:

- `verifyRecoveryCode` ← `{ phone, code }` → `{ verified, phone, name, resetToken, expiresInSeconds }`
- `resetCustomerPassword` ← `{ phone, resetToken, passwordHash }` → `{ ok: true, phone }`

`passwordHash` is computed locally with the existing `_hashPassword()`. Both
endpoints must be deployed on the billing side; the customer panel needs no new
collection, index, secret, or Firestore rule.

## Authentication / security notes

- No Firebase Auth change. No Email/Password auth, no OTP, no `sendPasswordResetEmail`.
- `firestore.rules` untouched; the customer panel never reads or writes `customer_recovery`.
- Code verification, expiry, attempt limits, one-time use and reset authorisation stay
  entirely with the Worker — nothing is validated client-side beyond UX checks.
- `resetToken` and the recovery code live in module variables only; both are wiped when
  the overlay closes, on success, and on non-retryable errors. Never in
  localStorage/sessionStorage/cookies/URL, never logged.
- Plaintext passwords are never sent; only the SHA-256 hash leaves the browser.
- The panel never writes `passwordHash` to Firestore directly.
- Error copy is generic; raw backend/internal details are not surfaced.

## Error handling map

| Worker status / HTTP | UI |
|---|---|
| `PERMISSION_DENIED` / 403 | Stay on step 1, show the Worker's attempt message |
| `DEADLINE_EXCEEDED` / 504 | Step 1: ask for a new code; step 2: back to step 1 |
| `FAILED_PRECONDITION` | "Code already used — ask the counter for a new one" |
| `NOT_FOUND` / 404 | "Contact the billing counter first" |
| `RESOURCE_EXHAUSTED` / 429 | "Too many incorrect attempts — get a new code" |
| `INVALID_ARGUMENT` / auth errors | Generic "Something went wrong" |
| fetch throws | "Check your connection and try again"; entered values kept |

Client-side pre-checks: 10-digit phone, 6-digit code, password ≥ 6 chars, passwords match.

## Testing performed

Static verification only in this environment (no Firebase/Worker credentials available):
`js/auth.js` parses cleanly, markup IDs match every `getElementById` call, and no
ordering/cart/menu/order-history/session code paths were touched.

**Still to be tested against live backends:** existing login, valid code, wrong code,
expired code, reused code, attempt lockout, new-password login, and that ordering /
cart / order history are unaffected.

## Notes for future agents

- The recovery code is issued verbally by billing staff — do not add SMS/email/WhatsApp delivery.
- Staff must never see the customer's new password; keep hashing on the customer side.
- If the Worker base URL changes, update `RECOVERY_FN_BASE` in `js/auth.js` only.

---

# Customer Password Recovery — Code Simplification (AI UPDATE [2026-09-13b])

Full detail lives in the billing repo's `AI_HANDOFF.md` (same section title).
Summary for this repo:

- The recovery code is **no longer a random OTP**. It is the last 4 digits of
  the customer's own registered phone number (`9876543210` → `3210`), computed
  server-side in the Worker's `generateRecoveryCode` / checked in
  `verifyRecoveryCode`.
- **Files changed here:** `js/auth.js` — `_onRecoveryVerify`'s client-side
  pre-check changed from `code.length !== 6` to `code.length !== 4` (error copy
  updated to match); header comment above the recovery flow updated.
  `index.html` — `#otpRecCodeInput` `maxlength` 6→4, placeholder and step-1
  instruction text updated from "6-digit" to "4-digit". `css/style.css` was
  **not** touched.
- Everything else in this file's original recovery section above (flow steps,
  Worker endpoints/request-response shapes, error-handling map, security notes,
  memory-only `resetToken`/code handling) is unchanged and still accurate.

---

# Smart Assistant — customer-facing rule-based chat widget (AI UPDATE [2026-09-18])

## Task

Add a "Smart Assistant" chat widget to the Customer Panel: floating button →
chat panel, quick-action chips, and free-text (English/Hindi/Hinglish)
understanding of cart control, order tracking, order history, coupons, and
the loyalty/reward milestone — using only the customer's own real data.

**Hard requirement: 100% rule-based JavaScript.** No OpenAI/Gemini/Claude/Groq/
any external or paid AI API, no server-side AI model. Verified: this file
contains zero `fetch()` calls of any kind — every response comes from
deterministic string matching against data already loaded by this app.

## Audit performed before writing any code

Read `ARCHITECTURE_LOCK.md` (frozen systems §2, database contract §5, public
interfaces §6) and this file, then read in full: `js/auth.js` (login/session —
`getLoginInfo()`, `requireLogin()`, `customAuthStateChanged` event),
`js/cart.js` (in-memory `cart` Map, `addItem`/`removeItem`/`clearCart` —
`addItem` always adds exactly 1 unit), `js/menu.js` (variant grouping —
`_groupItems()`, `_isItemOos()`, out-of-stock rules, the products/categories
vs legacy `menu_items` schema split), `js/history.js` (`getHistory()` —
localStorage, kept in sync from Firestore by order-status.js),
`js/order-status.js` (active-order tracking, `getStatusLabel()`),
`js/offers.js` (the existing `coupons` collection query shape and loyalty
badge pattern), `js/restaurant-status.js` (`isOrderingEnabled()`), and the
Billing Panel's `js/cart.js` (cross-repo, read-only inspection) to find the
loyalty reward rule's actual source of truth (`LOYALTY_MIN_ORDERS = 10`,
`LOYALTY_MIN_SPEND = 1000`, `LOYALTY_AMOUNT = 100`).

## Files changed

- **`js/smart-assistant.js`** (new) — all chat logic: rule-based NLU, cart
  control, order/coupon/loyalty queries, DOM wiring. Exports
  `initSmartAssistant()`.
- **`js/menu.js`** — two small additive exports only, no other change:
  - `getMenuIndex()` → `{ items: allItems, groups: _groupItems(allItems) }`.
    Reuses the exact same (previously unexported) `_groupItems()` the menu
    grid renders from, so the assistant's product/variant/availability
    understanding can never drift from what customers actually see on the
    cards. Read-only — does not touch `_groupsById` or any rendering state.
  - `isItemOos(item)` → thin wrapper around the existing `_isItemOos()`.
- **`js/order-status.js`** — added a module-level `_lastActiveOrders` cache,
  populated inside the **existing** `_renderActiveOrders(orders)` callback
  (one new line — no behavioural change to that function), plus a new
  export `getActiveOrdersSnapshot()`. No second Firestore listener is
  started; the assistant reads the same listener's last-known result.
- **`js/app.js`** — imports `initSmartAssistant` and calls it in the boot
  sequence (step 5f), same pattern as `initOffers()`/`initHistory()`.
- **`index.html`** — new markup block (floating button `#saFab` + chat sheet
  `#saModal`/`#saMessages`/`#saQuickActions`/`#saInputForm`), inserted right
  before the `<script type="module" src="js/app.js">` tag. Follows the exact
  same modal/backdrop/sheet structure as the existing item-sheet/variant-
  picker modals.
- **`css/style.css`** — new `.sa-*` block appended at the end of the file.
  Uses only existing CSS custom properties (`--bg`, `--surface`, `--accent`,
  `--blue`, etc.) and the existing `otpFadeIn`/`otpSlideUp` keyframes — no
  new design tokens. FAB sits bottom-left (mirrors `.category-fab`, which
  sits bottom-right) so the two floating buttons never overlap. Modal
  z-index 230 (above the variant picker's 220, the highest z-index that
  existed before this change).

**Nothing else was touched.** `js/cart.js`, `js/history.js`, `js/auth.js`,
`js/order.js`, `js/review.js`, `js/item-sheet.js`, `js/variant-picker.js`,
and the entire order lifecycle are byte-for-byte unchanged — the assistant
is purely an additional consumer of their existing public interfaces.

## How cart control actually works (no second cart)

Every cart mutation goes through the existing `cart.js` functions:
`addItem(id, name, price)` (called once per unit — `addItem` only ever adds
exactly 1, so "add 2 X" calls it twice) and `removeItem(id)`. The assistant
never reads or writes `cart`'s Map directly except to *inspect* it
(`[...cart.values()]`) for "show my cart" / "remove X" / "set quantity"
commands. Products are matched via `getMenuIndex()` (see above); variant
availability comes from the `oos` flag `_groupItems()` already computes per
variant — the assistant duplicates zero availability logic of its own.

## Rule-based NLU — how it works, and its known limits

Token-overlap product matching (`_matchProduct` in `js/smart-assistant.js`):
every word of the customer's (filler/verb/qty/variant-stripped) text that
also appears in a menu group/item's name counts as a point; the highest-
scoring candidate(s) win. A single top match resolves automatically; a tie
is treated as genuine ambiguity and the customer is asked to pick (never
guesses — requirement #8 in the task spec). Verb/filler stripping uses an
explicit phrase list (`kar do`, `daal do`, `hata do`, `chahiye`, `add`,
`remove`, …) covering the English/Hindi/Hinglish phrasing given in the task
spec, plus the reverse: if **no** verb is found at all, the whole message is
still tried as a bare product mention (covers `"medium margherita pizza 2"`
with no verb, per the spec's own example).

**Known, documented gaps** (deterministic rule-based parsing, not a full
language model — matches the task spec's own "keep it practical and
deterministic" instruction):
- The Hindi word **"do" (= 2) is deliberately NOT recognised as a quantity.**
  It collides with the extremely common verb phrases "kar do" / "de do"
  ("please do it" / "give it"); treating it as a number would misread the
  quantity on nearly every plain Hinglish add command. Digits (`2`) and the
  English word "two" both work correctly. This is called out at the
  `NUM_WORDS` map in `js/smart-assistant.js`.
- Extras/add-ons (`item-sheet.js`'s "Add Extras" step) and the special-
  request text field are **not** settable through chat — the assistant adds
  the base item only. Customers can still add extras/notes afterwards via
  the normal Item Details Sheet on any cart item. Out of scope for this
  pass; flagged here for a future session if wanted.
- Multi-turn context (`_ctx.pending`) is a single slot — asking about a
  second product while a variant question is still pending will abandon
  the first pending question rather than stacking two. Matches the task
  spec's own scope ("simple session state/context variables").
- "Track order" identifies an order by its table tag (`o.tableId`, e.g.
  "Table 4") since there's no customer-facing numeric order ID field in
  `pending_table_orders` — the task spec's own example ("Your order #26…")
  assumes an order-number field that doesn't exist in this schema.

## Loyalty / reward rule — cross-repo source-of-truth note

`LOYALTY_MIN_ORDERS`/`LOYALTY_MIN_SPEND`/`LOYALTY_AMOUNT` are hardcoded in
`js/smart-assistant.js` as a **documented mirror** of the Billing Panel's
own single source of truth (`js/cart.js` in
`https://github.com/Arnavmishra142/Billing-system-Pizza-hut-`). The Customer
Panel and Billing Panel are separate repositories (`ARCHITECTURE_LOCK.md`
§1) — this file cannot `import` Billing Panel source, so per the task
spec's own instruction ("If the rule is currently hardcoded elsewhere, reuse
the same source of truth... there must be ONE source of truth") the closest
achievable thing across a repo boundary is one clearly labeled, correctly-
valued mirror rather than a second independent guess. **If the Billing
Panel's `LOYALTY_*` constants ever change, this block must be updated to
match.** There is no separate "loyalty points balance" anywhere in either
repo — only this order-count+spend milestone — so the assistant says so
explicitly rather than inventing a points number (task spec §18).

## Security / privacy

No Firestore rules changed — verified against the Billing Panel's
`firestore.rules` (shared database): `customers/{phone}` read is already
`if request.auth != null` (bridge mode — any authenticated session, same as
every other Customer Panel read), and `coupons` read is already
`if request.auth != null` — both already used elsewhere (`js/auth.js`,
`js/offers.js`) with the exact same query shape this file reuses. The
assistant only ever reads the **currently logged-in customer's own**
`customers/{phone}` doc and `coupons where phone==` query — it has no path
to another customer's data, admin data, or staff data.

## Performance

Customer profile and coupons are fetched from Firestore **at most once per
60 seconds per phone number** (`_profileCache`/`_couponsCache` in
`js/smart-assistant.js`), not on every chat message. Menu/cart/order-history
lookups used by every other intent are pure in-memory reads (`getMenuIndex()`,
the `cart` Map, `getHistory()`, `getActiveOrdersSnapshot()`) — zero
additional Firestore cost. No new `onSnapshot` listeners are started by this
file.

## Testing performed

Static verification only in this environment (no live Firebase project
available): `node --check` passes on every modified/new `.js` file. The
rule-based tokenizer/quantity/variant-extraction/verb-stripping functions
were unit-tested standalone (12 representative phrases from the task spec,
including Hinglish variants) and produced the expected isolated product
queries and extracted quantity/variant values.

**Still to be tested against the live app** (regression checklist items ✓
below assumed unaffected since their files were untouched, but the new
feature itself needs a real browser + logged-in test account):
- Assistant opens/closes; quick actions fire the same handlers as typed text
- Customer name detected correctly in the greeting
- "add 2 medium paneer pizza" → item actually appears in the real cart/cart
  bar, not just a chat confirmation
- Ambiguous product ("pizza add kar do") lists real menu items, doesn't guess
- Unavailable item → correct "currently unavailable" message, nothing added
- "repeat my last order" with one item no longer on the menu → adds the
  valid items, names the unavailable one, doesn't silently substitute
- Coupon / loyalty responses match what "My Offers" (`offers.js`) already
  shows for the same test account
- Existing regression checklist (§8 of `ARCHITECTURE_LOCK.md`) — login,
  menu, search, cart, place order, active orders, history — unaffected
  (no touched file is in that list except the two additive exports, which
  add new functions without modifying any existing function's behaviour)

## Billing Panel changes required

**None.** This feature reads collections the Customer Panel already reads
(`customers`, `coupons`, `pending_table_orders`, `customer_order_history`,
`menu_items`/`products`/`categories`) and writes nothing new. No Billing
Panel file, rule, or schema change is needed.
