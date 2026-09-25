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
  │     ├── history.js                   — localStorage order history
  │     ├── smart-assistant.js           — [AI UPDATE 2026-09-18] rule-based
  │     │                                   chat widget (no external AI API)
  │     ├── voice-assistant.js           — [AI UPDATE 2026-09-21] mic button +
  │     │                                   voice panel; calls api/voice/* below
  │     ├── table-session.js             — [AI UPDATE 2026-09-24] 3-hour TABLE session
  │     │                                   (leaf module; NOT the login session)
  │     ├── table-gate.js                — [AI UPDATE 2026-09-24] "scan your table" screen,
  │     │                                   QR scanner, manual fallback, expiry watcher
  │     └── pwa-install.js               — [AI UPDATE 2026-09-24] install popup/banner + SW register
  │
  ├── manifest.webmanifest, sw.js, icons/ — [AI UPDATE 2026-09-24] installable PWA shell
  │
  ├── api/voice/*.js  (Vercel Serverless Functions — also mounted in server.js
  │     for local/Replit dev, so behaviour is identical in both places)
  │     ├── transcribe.js                — proxies one recorded clip to Deepgram
  │     └── interpret.js                 — proxies transcript+context to Groq
  │           DEEPGRAM_API_KEY / GROQ_API_KEY read from process.env on the
  │           server only — never sent to the browser (Section 6, Section 7 rule 15)
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
| Customer Session | `js/auth.js` (localStorage key: `qrmenu_user`) — [AI UPDATE 2026-09-24] completely separate from the Table Session below |
| QR Table Detection | `server.js`, `js/order.js` (`getTableId`) |
| Table Session (3 h) | `js/table-session.js` (localStorage key: `qrmenu_table_session`), `js/table-gate.js` — [AI UPDATE 2026-09-24] NOT frozen yet (brand new); `getTableId()` consults it |
| PWA shell | `manifest.webmanifest`, `sw.js`, `js/pwa-install.js` — [AI UPDATE 2026-09-24] NOT frozen yet (brand new) |
| Active Table Lock | `js/order.js` (`loadActiveTableAssignment`) |
| Cart | `js/cart.js` |
| Menu Rendering | `js/menu.js` |
| Search | `js/search.js` |
| Order Placement | `js/order.js` (`placeOrder`) |
| Active Orders | `js/order-status.js` (`startOrderTracking`) |
| Order Tracking | `js/order-status.js` |
| Order History | `js/history.js` (localStorage key: `qrmenu_history`) |
| Smart Assistant | `js/smart-assistant.js` — [AI UPDATE 2026-09-18] NOT a frozen system yet (brand new); reuses every frozen system above through their public interfaces only, never bypasses them |
| Voice Assistant | `js/voice-assistant.js`, `api/voice/transcribe.js`, `api/voice/interpret.js` — [AI UPDATE 2026-09-21] NOT a frozen system yet (brand new); calls Deepgram + Groq through a private server-side proxy (Section 6, Section 7 rule 15), but performs every actual action (cart add, opening coupons/history, reading account data) through the frozen systems above and `js/smart-assistant.js`'s public interface only — never a second data path |
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

#### `settings/seasonal_effects` — Seasonal Effects switches (added 2026-09-24)
```
{ effects: { rain: boolean, rainSound: boolean /* optional opt-in sound, needs rain ON */, /* future: christmas, diwali, newyear, holi, valentine */ }, updatedAt: number }
```
Written by the Billing/Admin Panel (`js/effects-admin.js`, "✨ Effects" tab). Read by this panel (`js/effects/seasonal-effects-manager.js`, `onSnapshot`).
Missing doc / missing key / listener error = effect **OFF**. Public read via the existing `settings/{docId}` rule. Only on/off flags belong here.

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

**Written by:** Customer Panel (`order-status.js` → `_writeCompletedOrderToHistory`) when `pending_table_orders` status → `completed`; Billing Panel may also write (with richer fields such as `completionReason`) when their implementation is complete.  
**Read by:** `order-status.js` (via `onSnapshot` subcollection query, Listener 2).  
**Note:** `history.js` also caches to localStorage (`qrmenu_history`) as an offline fallback. The Firestore snapshot is the source of truth; localStorage is used only before the first snapshot arrives.

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
// [AI UPDATE 2026-09-18] — added for js/smart-assistant.js:
export function getMenuIndex()       // → { items: [...flat items], groups: [...variant-grouped entries] }
export function isItemOos(item)      // → boolean — same availability check the menu grid uses
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

> **[AI UPDATE 2026-09-24]** Behaviour only — signatures unchanged: `getTableId()` returns `null` while the
> "scan your table" screen is open; otherwise server lock → 3-hour table session → legacy URL logic.
> `VALID_TABLES` now comes from `js/table-session.js` `TOTAL_TABLES`.

### `js/table-session.js`, `js/table-gate.js`, `js/pwa-install.js`
```js
// [AI UPDATE 2026-09-24] New files.
// table-session.js (imports nothing — keep it a leaf so order.js can import it without a cycle)
export const TOTAL_TABLES, TABLE_SESSION_TTL_MS   // 10, 3 h — TOTAL_TABLES must equal server.js
export function isValidTableNumber(n), parseTableInput(raw), parseTableFromQr(text)
export function getTrustedNow(), async syncTrustedTime()
export function getActiveTableSession()           // → { tableNumber, sessionStartedAt, sessionExpiresAt } | null (null once expired)
export function startTableSession(n), expireTableSession(), isTableEntryRequired(), reconcileTableSession()
// table-gate.js
export function initTableGate()                   // boot: decide panel vs scan screen; events "tableGateChange", "tableSessionChanged"
// pwa-install.js
export function initPwaInstall()                  // register /sw.js; popup → banner via the real beforeinstallprompt
```

### `js/order-status.js`
```js
export function getStatusLabel(status)     // → human-readable string for a status value
export function getStatusColor(status)     // → hex colour string for a status value
export function initOrderStatus()          // Wire Active Orders panel (called once on boot)
export function stopOrderStatus()          // Stop all listeners and clear panel
export async function startOrderTracking(callbacks)  // Start onSnapshot for active orders + history
export function stopOrderTracking()        // Unsubscribe all order tracking listeners
// [AI UPDATE 2026-09-18] — added for js/smart-assistant.js:
export function getActiveOrdersSnapshot()  // → last-known array from the existing onActiveOrders listener (no new listener)
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

### `js/smart-assistant.js`
```js
// [AI UPDATE 2026-09-18] New file.
export function initSmartAssistant()  // Wire the 🤖 floating button + chat panel — call once on boot
// [AI UPDATE 2026-09-21] — added for js/voice-assistant.js (additive; nothing above changed):
export function getAssistantMenu()      // → [{ name, variants: string[] }] — real menu names/sizes only
export async function getAssistantSnapshot()  // → { loggedIn, customer: {...}|null, cart: {...} } — read-only, cached
export async function addToCartByName({ item, variant, quantity })
  // → { status: "added"|"clarify"|"failed", message, added? } — re-validates against the live
  //   menu and adds through the SAME _resolveAndAdd()/cart.js addItem() path as the text chat and
  //   the Item Details sheet; never guesses an ambiguous item/size — returns "clarify" instead
```
100% rule-based (no external/paid AI API — see AI_HANDOFF.md for the full
write-up). Reads customer/menu/cart/order-history/coupon data through the
public interfaces listed above; writes only through `js/cart.js`'s
`addItem`/`removeItem`/`clearCart`. Do not add a second cart, customer, or
order-history data path to this file — extend the existing ones instead.

### `js/voice-assistant.js`
```js
// [AI UPDATE 2026-09-21] New file.
export function initVoiceAssistant()  // Wire the mic button (#vaMicBtn) + voice panel — call once on boot
```
Calls `POST /api/voice/transcribe` and `POST /api/voice/interpret` (below),
then performs the returned action ONLY by calling
`js/smart-assistant.js`'s exports above or by clicking the existing
`#offersBtn` / `#historyBtn` / `#placeOrderBtn` header buttons — it has no
direct Firestore access and holds no API key.

### `api/voice/transcribe.js`, `api/voice/interpret.js`
```js
// [AI UPDATE 2026-09-21] New files. Plain (req, res) handlers — Vercel Serverless Functions,
// also mounted directly in server.js for local/Replit dev parity.
POST /api/voice/transcribe   // body: raw audio bytes  → { transcript, confidence }
POST /api/voice/interpret    // body: JSON { transcript, history, context } → { action, items?, topic?, reply }
```
Read `DEEPGRAM_API_KEY` / `GROQ_API_KEY` (+ optional `DEEPGRAM_MODEL`,
`DEEPGRAM_LANGUAGE`, `GROQ_MODEL`) from `process.env` only. These two files
are the **only** place in either repository that calls an external, paid AI
API — see Section 7 rule 15. They touch no Firestore collection and hold no
cart/customer/coupon logic of their own; `api/voice/interpret.js`'s output is
whitelisted (`normalizeResult()`) before being returned, so a malformed or
adversarial model response can never reach the browser un-validated.

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
15. **External/paid AI API calls (Deepgram, Groq) are allowed ONLY inside `api/voice/transcribe.js` and `api/voice/interpret.js`, and their API keys ONLY as server-side environment variables** (`DEEPGRAM_API_KEY`, `GROQ_API_KEY`) **read via `process.env`.** [AI UPDATE 2026-09-21] Never hardcode a key in any frontend file, never call Deepgram/Groq (or any other paid AI API) directly from `js/*.js`, and never widen what these two functions return to the browser beyond the whitelisted `{ action, items?, topic?, reply }` / `{ transcript, confidence }` shapes documented in Section 6 — the model's raw output must always be re-validated (`normalizeResult()`), never trusted or forwarded as-is. This does not apply to `js/smart-assistant.js`'s own text chat, which remains 100% rule-based per its Section 6 entry.

16. **The table is a TEMPORARY 3-hour session, never a permanent identity, and it is independent of login.** [AI UPDATE 2026-09-24] Table-session expiry must never log a customer out or touch `qrmenu_user`, Firebase Auth, the cart, order history, coupons or loyalty data; logout must not be required for, or clear, the table session. Any new code that needs "the current table" must use `getTableId()` (never read `sessionStorage`/`localStorage` for a table directly). The table-number rule (1…`TOTAL_TABLES`) lives in `js/table-session.js` and must stay equal to `server.js`. Installed-app `start_url` is `/` — never bake a table into `manifest.webmanifest`.
17. **The service worker stays network-first and never touches Firebase, `/api/*` or non-GET requests, and never caches a `/t/:n` page as the offline shell.** [AI UPDATE 2026-09-24] Do not add stale-while-revalidate/cache-first for `/js` or `/css` (ES-module version mixing). Install UI uses the real `beforeinstallprompt` event; [v2 2026-09-24] on phones where Chrome/Safari never provides it, a clearly-labelled "How to" fallback (instruction sheet, no fake install) is shown instead. Only that fallback's ✕ persists (3 days); the real-event UI holds no persistent "never show again" flag. Everything is hidden when installed.

16. **Seasonal Effects are registry-driven (added 2026-09-24).** Each effect is a self-contained module `{ start(), stop() }` in `js/effects/`, registered in `REGISTRY` of `seasonal-effects-manager.js`; the panel only calls `initSeasonalEffects()`. Never hard-code an effect into menu/cart/app code. Effect layers must be `pointer-events:none`, at `z-index:-1` (behind all UI — relies on `html` having NO background and `body` NOT creating a stacking context; keep it that way), canvas/CSS only (no per-particle DOM), honour `prefers-reduced-motion`, pause when hidden, and fully release rAF/timers/listeners/DOM in `stop()`. Keys must match the Admin `EFFECTS` list.

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
- ✓ Smart Assistant (AI UPDATE [2026-09-18]) — floating button opens/closes; quick actions and typed commands add real items to the real cart; unavailable items are correctly refused; no external AI API call is ever made
- ✓ Voice Assistant (AI UPDATE [2026-09-21]) — mic button opens/closes the panel with the page blurred behind it; add-to-cart/coupons/history/account-question voice commands drive the SAME cart/offers/history/Smart-Assistant code the text/manual paths use (never a second data path); an unresolvable item or size asks instead of guessing; `DEEPGRAM_API_KEY`/`GROQ_API_KEY` are read only inside `api/voice/*.js` and never appear in any browser-visible response

- ✓ Table Session / PWA (AI UPDATE [2026-09-24]) — scanning `/t/N` starts a 3-hour session; re-opening the installed app within 3 h keeps the table; after 3 h the "scan your table" screen appears while login, cart, history and coupons stay intact; a new QR/manual valid table starts a fresh 3-hour session and updates the table chip; a reload of an expired `/t/N` tab does not bypass the screen; install popup → banner above Search appears only when the browser offers install, never after install, and never permanently suppressed

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

## 9a. Weather + Manual Effect Engine [AI UPDATE 2026-09-24]

The Customer Panel's visual atmosphere (previously just a Rainy Days on/off
flag) is now governed by a fixed pipeline:

```
Weather Service -> Weather Normalizer -> Effect Resolver -> Active Effect
```

Rules that must be preserved:

1. **One active effect at a time.** `seasonal-effects-manager.js` tracks a
   single `activeKey`; it must never run two full-screen effects
   simultaneously. A new effect always fully `stop()`s the previous one
   before starting.
2. **Effect priority is centralized in `js/effects/effect-resolver.js`.**
   No other file may re-implement the OFF > manual > automatic-weather > none
   ordering. Changing the priority means changing that one function.
3. **OpenWeather condition -> effect id mapping lives ONLY in
   `js/effects/weather-normalizer.js`.** No other file may branch on a raw
   OpenWeather condition id, `main` string, or icon code.
4. **The OpenWeather API key is read only inside `api/weather.js`, from
   `process.env.OPENWEATHER_API_KEY`.** It must never be sent to the
   browser, committed to the repo, or written to Firestore.
5. **Every effect module exports `{ start(), stop(), update?(flags) }`** and
   registers a lazy `import()` loader in `seasonal-effects-manager.js`'s
   `REGISTRY` — effect code must not add to the initial bundle unless that
   effect is actually active.
6. **Weather lookups must stay cheap.** Both the server (`api/weather.js`,
   in-memory + `Cache-Control`) and the client (`weather-service.js`,
   `sessionStorage`) cache for 10 minutes. Do not remove either cache layer
   or call `/api/weather` on every render.
7. **Failure of the weather API or the `settings/seasonal_effects` /
   `settings/restaurant_location` Firestore docs must never block menu
   rendering or throw a visible error** — always fail to "no effect" or the
   previously active effect.
8. **New collections:** `settings/restaurant_location` (`{ lat, lon }`,
   public-read, operator-write — covered by the existing
   `match /settings/{docId}` rule).

## 10. Source of Truth

This document is the **permanent source of truth** for the architectural constraints of the Customer Panel. Its goal is to keep the architecture stable while allowing small, isolated, backward-compatible improvements without breaking existing functionality.

**When in doubt: make the smallest possible change. Preserve all existing behaviour. Document everything.**
