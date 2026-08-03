---
name: UX Polish — Special Request & FAB
description: Key decisions and constraints from the UX polish pass (image fix, special request, category FAB redesign)
---

## cartExtras special request
`cartExtras` Map (in `cart.js`) now stores `{ extras: [{name, price}], specialRequest: string }` per item.
**Special requests are NOT persisted to localStorage** — cartExtras is session-only. A page refresh loses special requests (cart items survive; extras/requests don't).

**Why:** The original design stored only extras (price baked in). Adding localStorage persistence for specialRequest is a follow-up task.

**How to apply:** If persisting, only save `specialRequest` (plain string), never extras price data.

## order.js special request in payload
`placeOrder()` spreads `specialRequest` onto each item only when non-empty:
```js
...(specialRequest && { specialRequest })
```
Billing Panel KOT must be updated to display the field — it's additive and optional.

## Git push from agent
`git push origin <branch>` times out from the agent — no output, exit -1.
**User must push via Replit Git panel** (documented in AI_HANDOFF.md deploy instructions).

## Category FAB pill
Changed from circle (52×52px, amber fill, grid SVG) to pill (`height: 46px; border-radius: 999px; background: #171923; border: 1.5px solid var(--accent); color: var(--accent); ☰ + "Menu" text`).
Open/active state flips to solid amber fill.
