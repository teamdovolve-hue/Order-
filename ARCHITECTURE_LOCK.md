# ARCHITECTURE_LOCK.md

> **Permanent architectural contract for the Customer Panel.**
> Read this file before touching any code in this repository.
> Read `AI_HANDOFF.md` second for current implementation state and known issues.

---

## 1. Project Overview

### Purpose

This repository is the **Customer Panel** of a production restaurant ordering system. Customers scan a QR code on their table, browse the menu, log in with their phone number, and place orders. Orders flow in real-time to the Billing Panel operated by restaurant staff.

### Relationship with the Billing Panel

This panel and the Billing Panel at  
**https://github.com/Arnavmishra142/Billing-system-Pizza-hut-**  
form **one single application**. They are not independent repositories.

| What is shared | Details |
|---|---|
| Firebase project | `billing-system-f8531` |
| Firestore database | All collections are shared |
| Firebase Auth | Same tenant; anonymous + custom tokens |
| Firebase Callable Functions | `customerAuth`, `createCustomerOrder`, `releaseTableLock` — deployed and owned by Billing Panel |
| Order lifecycle | Initiated here; processed and completed by Billing Panel |
| QR table system | Table IDs assigned here; sessions/locks managed by Billing Panel |
| Customer profiles | Created here via callable; read/written by both panels |
| Menu management | Menu items written exclusively by Billing Panel; read here |
| Realtime sync | `onSnapshot` listeners here respond to Billing Panel writes |

A change in one repository may require a corresponding change in the other. **Never treat these repositories as independent.**

### High-Level Architecture

```
Customer's phone (this repo)
  │
  ├── Express dev server (server.js)      — dev only, port 5000
  │     └── Injects window.__TABLE_ID__  — validates /t/1…/t/10
  │
  ├── Static HTML / CSS / ES Modules     — no build step
  │     ├── firebase-config.js           — db, auth, functions exports
  │     ├── app.js                       — boot sequence, wires all modules
  │     ├── auth.js                      — phone login, session management
  │     ├── customer.js                  — thin shim over auth.js
  │     ├── menu.js                      — real-time Firestore menu
  │     ├── cart.js                      — in-memory cart state + DOM
  │     ├── order.js                     — order submission to Firestore
  │     ├── order-status.js              — live order tracking
  │     ├── search.js                    — real-time menu search
  │     └── history.js                   — localStorage order history
  │
  └── Firebase SDK v10 (CDN, ES modules) — Firestore + Auth + Functions
        └── Firestore region: asia-south1

Billing Panel (separate repo)
  ├── Firebase Cloud Functions            — customerAuth, createCustomerOrder, releaseTableLock
  ├── Firestore rules + indexes
  └── Operator web app                   — receives orders, manages KOT, billing
```

### Production Deployment

| Environment | URL | Host |
|---|---|---|
| Production | https://newpizzahutlivecake.in | Vercel (static, auto-deploy from `main`) |
| Development | Replit preview port 5000 | `node server.js` |

---

## 2. Frozen Core Architecture

The following systems are **production-stable**. Future AI agents **MUST NOT** modify these unless explicitly instructed by the repository owner.

| System | Primary File(s) |
|---|---|
| Customer Login | `js/auth.js` |
| Customer Profile | `js/auth.js`, `js/customer.js` |
| Customer Session | `js/auth.js` (localStorage key: `qrmenu_user`) |
| QR Table Detection | `server.js`, `js/order.js` (`getTableId`) |
| Active Table Lock | `js/order.js` (`loadActiveTableAssignment`) |
| Cart | `js/cart.js` |
| Menu Rendering | `js/menu.js` |
| Search | `js/search.js` |
| Order Placement | `js/order.js` (`placeOrder`) |
| Active Orders | `js/order-status.js` (`startOrderTracking`) |
| Order Tracking | `js/order-status.js` |
| Order History | `js/history.js` (localStorage key: `qrmenu_history`) |
| Out of Stock UI | `js/menu.js` |
| Realtime Synchronization | `js/menu.js`, `js/order-status.js` (`onSnapshot`) |
| Firebase Integration | `js/firebase-config.js` |
| Firestore Collections | See Section 5 — Database Contract |

**These are protected systems. Do not refactor, redesign, or restructure them without explicit instruction.**

---

## 3. Frozen Order Lifecycle

The following sequence is the complete, production order lifecycle. It is **frozen** and must remain backward-compatible. Do not alter any step or status value without coordinating with the Billing Panel.

```
Customer opens QR URL (/t/1 … /t/10)
  ↓
server.js validates table number and injects window.__TABLE_ID__
  ↓
Table badge shown (e.g. "Table 4")
  ↓
Menu loads in real-time (Firestore onSnapshot — no login required to browse)
  ↓
Customer adds items to cart
  ↓
Customer taps "Place Order"
  ↓
If not logged in → phone login modal
    └─ Phone entered → Firestore lookup (customers collection)
         ├─ Existing customer → sign in anonymously → session saved → proceed
         └─ New customer → name entry → confirm screen → account created → proceed
  ↓
Order written to pending_table_orders (status: "pending")
  ↓
Billing Panel receives order in real-time (onSnapshot)
  ↓
Billing Panel accepts order (status: "accepted")
  ↓
Customer sees: "Order Received — Kitchen notified soon"
  ↓
Billing Panel sends to KOT (status: "kot", kotAt: timestamp written)
  ↓
Customer sees: "Preparing 🍕 • X min" (live elapsed timer from kotAt)
  ↓
Billing Panel: "Bill & Settle" or "Save & Exit"
  ↓
Order status → "completed" in Firestore
  ↓
Customer Panel removes order from Active Orders
  ↓
Order saved to Customer Order History (currently localStorage; Firestore sync pending)
  ↓
Order lifecycle complete
```

**Side branches (do not alter):**
- `dismissed` / `rejected` → order silently removed from Active Orders, NOT saved to history
- `releaseTableLock` callable fired by Billing Panel on Bill & Settle / Save & Exit

---

## 4. Cross-Repository Contract (CRITICAL)

This repository depends on the Billing Panel at  
**https://github.com/Arnavmishra142/Billing-system-Pizza-hut-**

### Before changing any of the following, verify compatibility with the Billing Panel:

- Firestore collection names
- Firestore document IDs
- Order `status` string values
- Order document field names
- Customer profile field names
- QR table ID format (`"Table N"`)
- Firebase callable function names and argument shapes
- Firebase Auth configuration (project, region)
- Realtime listener query predicates

### If a Billing Panel modification is required

**DO NOT assume the change already exists in the Billing Panel.**

Instead, document clearly:

1. **File name** in the Billing Panel repository
2. **Reason** the change is needed
3. **Exact modification required**

Then wait for the user to apply the Billing Panel change before shipping the Customer Panel change.

---

## 5. Database Contract

### Firestore Collections

#### `customers` — Customer profiles

Keyed by normalised phone number (`+91XXXXXXXXXX`).  
**Written by:** `customerAuth` callable (Billing Panel) / BRIDGE: direct `setDoc` from `auth.js`.  
**Read by:** both panels.

| Field | Type | Notes |
|---|---|---|
| `phone` | string | Normalised `+91XXXXXXXXXX` — also the document ID |
| `name` | string | Customer display name |
| `authUid` | string | Firebase anonymous Auth UID |
| `phoneVerified` | boolean | `false` until Fast2SMS DLT OTP approved — do NOT set to `true` here |
| `createdAt` | Timestamp | Server timestamp — set once at creation |
| `updatedAt` | Timestamp | Server timestamp — updated on every write |
| `lastLoginAt` | Timestamp | Server timestamp — updated non-critically on every sign-in |

---

#### `menu_items` — Menu cards

**Written by:** Billing Panel exclusively.  
**Read by:** Customer Panel (`menu.js` via `onSnapshot`).  
**Do not write to this collection from the Customer Panel.**

Relevant fields consumed by `menu.js`:

| Field | Type | Notes |
|---|---|---|
| `name` | string | Item display name |
| `price` | number | Price in INR (₹) |
| `category` | string | Used for category tab rendering |
| `available` | boolean | `false` → item shown with out-of-stock badge, Add disabled |

---

#### `pending_table_orders` — Active orders

**Written by:** `createCustomerOrder` callable (Billing Panel) / BRIDGE: direct `addDoc` from `order.js`.  
**Read by:** Customer Panel (`order-status.js`) and Billing Panel.

| Field | Type | Notes |
|---|---|---|
| `tableId` | string | Format: `"Table N"` — do not change format |
| `status` | string | See Status Values below |
| `items` | array | `[{ id, name, price, qty, subtotal }]` |
| `totalPrice` | number | Rounded to 2 decimal places (INR) |
| `createdAt` | Timestamp | Server timestamp |
| `kotAt` | Timestamp | Set by Billing Panel when status → `kot`; used for live timer |
| `customer.uid` | string | Firebase Auth UID |
| `customer.name` | string | Customer display name |
| `customer.phone` | string | Normalised phone number |
| `customerSessionId` | string | From Billing Panel callable — do not change |
| `tableLockId` | string | From Billing Panel callable — do not change |

**Order status values — frozen:**

| Value | Customer sees |
|---|---|
| `pending` | Order Received — Kitchen notified soon |
| `accepted` | Order Received — Kitchen notified soon |
| `kot` | Preparing 🍕 • X min (live timer from `kotAt`) |
| `completed` | Removed from Active Orders → saved to History |
| `dismissed` | Silently removed — NOT saved to History |
| `rejected` | Silently removed — NOT saved to History |

**Do not add, rename, or repurpose status values without coordinating with the Billing Panel.**

---

#### `customer_table_sessions` — Active table assignments

**Written by:** Billing Panel callables exclusively (Admin SDK).  
**Read by:** `order.js` (`loadActiveTableAssignment`).  
**Do not write to this collection from the Customer Panel.**

---

#### `table_locks` — Per-table lock sentinels

**Written by:** Billing Panel callables exclusively.  
**Read by:** `order.js` indirectly via Billing Panel callable response.  
**Do not write to this collection from the Customer Panel.**

---

#### `customer_order_history/{uid}/orders` — Completed order history (Firestore)

**Written by:** Billing Panel when order status → `completed`.  
**Read by:** `order-status.js` (via `onSnapshot` subcollection query).  
**Note:** Customer Panel also saves to localStorage (`qrmenu_history`) as a local fallback. Cross-device sync via this Firestore subcollection is a pending feature — see `AI_HANDOFF.md`.

---

### Schema Change Policy

**Schema changes require explicit approval from the repository owner and coordination with the Billing Panel team.** Never rename, remove, or retype a field in any shared collection without going through this process.

---

## 6. Public Interfaces

These are the exported functions and values consumed by other modules. Implementations may be improved. **Interfaces (names, parameters, return shapes) must not change without approval.**

### `js/firebase-config.js`
```js
export const db;        // Firestore instance
export const auth;      // Firebase Auth instance
export const functions; // Firebase Functions instance (region: asia-south1)
```

### `js/auth.js`
```js
export function initAuth()           // Wire DOM events, start onAuthStateChanged — call once on DOMContentLoaded
export function requireLogin(cb)     // Gate any action on login; shows modal if needed, then calls cb()
export function isLoggedIn()         // → boolean — true if localStorage session exists
export function getLoginInfo()       // → { name, phone, uid } | null
export function waitForAuthReady()   // → Promise — resolves when Firebase Auth state is known
export function onAuthReady(cb)      // Call cb with current session (synchronous from cache)
export function updateGreeting()     // Refresh customer chip in header
export function isAuthReady()        // → boolean (always true in current bridge build)
```

### `js/customer.js` (thin shim over `auth.js`)
```js
export function getCustomer()        // → { name, phone, uid } | null
export function requireCustomer(cb)  // Same as requireLogin — used by order.js
export function updateGreeting()     // Delegates to auth.js updateGreeting
```

### `js/menu.js`
```js
export function initMenu()           // Start real-time Firestore listener; render menu
export function filterBySearch(term) // Filter rendered menu items by search term
```

### `js/cart.js`
```js
export const cart                    // Map<id, { name, price, qty }> — in-memory cart state
export function addItem(id, name, price)  // Add or increment item
export function removeItem(id)            // Decrement or remove item
export function clearCart()               // Empty cart and reset UI
export function refreshCartUI()           // Re-render entire cart DOM
export function updateCardUI(itemId)      // Update a single menu card's quantity display
```

### `js/order.js`
```js
export function getTableId()               // → "Table N" string | null
export async function loadActiveTableAssignment()  // Load server-assigned table from Firestore session
export function setActiveTableId(tableId)  // Override active table (used after callable response)
export async function placeOrder()         // Submit cart to Firestore as a new order
```

### `js/order-status.js`
```js
export function getStatusLabel(status)     // → human-readable string for a status value
export function getStatusColor(status)     // → hex colour string for a status value
export function initOrderStatus()          // Wire Active Orders panel (called once on boot)
export function stopOrderStatus()          // Stop all listeners and clear panel
export async function startOrderTracking(callbacks)  // Start onSnapshot for active orders + history
export function stopOrderTracking()        // Unsubscribe all order tracking listeners
```

`startOrderTracking` callbacks shape:
```js
{
  onActiveOrders: (orders) => void,  // orders: [{ id, tableId, status, statusLabel, statusColor, items, total, createdAt, kotAt }]
  onHistory:      (orders) => void,  // completed orders from Firestore subcollection
}
```

### `js/history.js`
```js
export function saveOrderToHistory(order)  // Persist a completed order to localStorage
export function getHistory()               // → array of completed orders (newest first)
export function initHistory()              // Wire history drawer toggle button
export function openHistory()              // Open drawer and render history list
```

### `js/search.js`
```js
export function initSearch(onSearch)  // Wire search input; calls onSearch(query) on every keystroke
```

---

## 7. AI Engineering Rules

Every future AI agent working in this repository **MUST** follow these rules:

1. **Read `ARCHITECTURE_LOCK.md` first.**
2. **Read `AI_HANDOFF.md` second.** It contains current implementation state, known issues, and the active bridge build notes.
3. **Summarize the current architecture** relevant to your task before writing any code. Confirm which files are involved and how they interact.
4. **Modify only the files required** for the specific task. Do not touch unrelated files.
5. **Never rewrite working code.** Improve or extend it minimally.
6. **Never refactor stable systems.** The frozen systems listed in Section 2 are off-limits unless explicitly instructed.
7. **Never redesign working UI.** Dark theme, layout, and interaction patterns are production-stable.
8. **Never rename Firestore collections or document IDs.**
9. **Never rename or repurpose shared status values** (`pending`, `accepted`, `kot`, `completed`, `dismissed`, `rejected`).
10. **Never introduce breaking changes** to the public interfaces listed in Section 6.
11. **Treat this repository and the Billing Panel as one connected production system.** A change here may require a corresponding change there.
12. **If a Billing Panel change is required:** document the exact file, reason, and modification needed. Do not guess or assume it already exists.
13. **Do not commit a regenerated `package-lock.json`** from inside Replit. It contains Replit-internal package-firewall URLs that break `npm install` on Vercel. Vercel is configured to skip install entirely (`"installCommand": "echo 'skip install'"`).
14. **The BRIDGE BUILD is intentional.** `auth.js` and `order.js` bypass Cloud Functions and write directly to Firestore while Fast2SMS DLT approval is pending. This is documented in both files. Do not remove or "fix" the bridge without explicit instruction.

---

## 8. Regression Checklist

Before considering any task complete, verify that the following still work end-to-end:

- ✓ Customer Login (phone entry → lookup → sign in or create account)
- ✓ Customer Profile (name + phone stored; `phoneVerified: false`)
- ✓ QR Detection (`/t/1` … `/t/10` serve app with correct table badge; invalid tables show error)
- ✓ Active Table Lock (server-side session loaded on page boot)
- ✓ Menu Rendering (real-time Firestore menu loads and renders by category)
- ✓ Search (filters menu items live on keystroke)
- ✓ Cart (add, remove, quantity display, clear on order placed)
- ✓ Place Order (writes to `pending_table_orders` with correct fields)
- ✓ Incoming Order Sync (Billing Panel receives order in real-time)
- ✓ Waiting for Kitchen (`pending` / `accepted` status renders correctly)
- ✓ Preparing Status (`kot` status renders with live elapsed timer)
- ✓ Live Timer (elapsed minutes increment from `kotAt` timestamp)
- ✓ Order History (completed orders appear in history drawer)
- ✓ Out of Stock (unavailable items show badge; Add button disabled)
- ✓ Realtime Updates (status changes from Billing Panel appear without page refresh)
- ✓ Billing Panel Compatibility (no Firestore field, collection, or status changes that break the Billing Panel)

**If any item fails, the implementation is NOT complete.**

---

## 9. Documentation Rules

After every implementation, the agent **must**:

1. **Update `AI_HANDOFF.md`** — add an `[AI UPDATE YYYY-MM-DD]` section documenting:
   - Files modified
   - Root cause of the issue (if a bug fix)
   - What changed
   - What was intentionally left unchanged
   - Any remaining known issues
   - Whether Billing Panel changes are required (and what they are)

2. **Update `ARCHITECTURE_LOCK.md`** — only if the architecture itself changed (new collection, new module, new public interface, new deployment step). Do not update it for bug fixes or minor behavioural changes.

3. **Add AI update comments** in every modified source file at the top of the file or at the modified function, formatted as:
   ```js
   // [AI UPDATE YYYY-MM-DD] <one-line description of what changed and why>
   ```

4. **Do not remove existing AI update comments.** They form the implementation audit trail.

---

## 10. Source of Truth

This document is the **permanent source of truth** for the architectural constraints of the Customer Panel. Its goal is to keep the architecture stable while allowing small, isolated, backward-compatible improvements without breaking existing functionality.

**When in doubt: make the smallest possible change. Preserve all existing behaviour. Document everything.**
