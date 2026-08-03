---
name: Products schema migration
description: Admin Panel migrated from flat menu_items to categories+products+variants; customer panel js/menu.js now reads from the new schema automatically.
---

# Products Schema Migration (2026-08-03)

## The rule
`js/menu.js` auto-detects which schema is active at runtime. No manual config is required. Do not add a manual flag or environment variable — the detection is intentional.

**Why:** The Admin Panel rewrote its menu management to use a hierarchical `categories` → `products` → `variants` schema. The Customer Panel must read from the same schema to stay in sync.

**How to apply:** Any future menu-related work in the Customer Panel must be aware that `allItems` may now come from two sources:
1. **Products path** (new): `products` collection + `categories` collection → flat items via `_productsToFlatItems()`
2. **Legacy path**: `menu_items` collection → flat items directly

Both paths produce the same flat item shape. All downstream code (`_groupItems`, `_createRegularCard`, `_createGroupCard`, `item-sheet.js`, `home-sections.js`, etc.) is unchanged.

## Key field mappings (products → flat item)
| products field | flat item field | notes |
|---|---|---|
| `categoryName` | `category` | string category name |
| `extras[].{name,price}` | `extraOptions[].{name,price}` | item-sheet.js reads `extraOptions` |
| `flags.recommended` | `isFeatured` | home-sections Recommended |
| `flags.mostOrdered` | `orderCount: 999 \| 0` | home-sections Most Ordered |
| `flags.newArrival` | `isNew` | |
| `categories.displayOrder` | `_catDisplayOrderMap` | global Map used by sort+tabs |
| `variantsList[i].{id,name,price}` | `id`, `name: "Prod (Variant)"`, `price` | one flat item per variant |

## Firestore rules
`products` and `categories` both have `allow read: if true` — customers can read them without authentication. Confirmed in `firestore.rules` (billing panel repo).

## Important notes
- `_catDisplayOrderMap` is a module-level `const Map` in `menu.js`. It is populated by the products listener and respected by both `_sortItems()` and `renderCategoryTabs()`.
- When `_catDisplayOrderMap` is empty (legacy path), sorting falls back to alphabetical — unchanged behavior.
- The products check uses `getDocs` (one-shot). After confirming non-empty, real-time `onSnapshot` takes over. This means the very first render may lag by one network round-trip (< 1s).
