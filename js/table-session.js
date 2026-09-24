/**
 * table-session.js — TEMPORARY table session (leaf module: imports nothing)
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] New file — PWA upgrade.
 *
 * WHY THIS EXISTS
 *   An installed PWA can be re-opened days after the customer left the
 *   restaurant, without scanning a QR code. The table the customer scanned
 *   earlier must therefore be a TEMPORARY table session (3 hours), never a
 *   permanent identity of the installed app.
 *
 * WHAT THIS IS NOT
 *   This has NOTHING to do with customer login. The login session
 *   (localStorage["qrmenu_user"], js/auth.js) is never read, written, or
 *   cleared here. Expiry of a table session must never log anyone out or
 *   touch the customer's account, cart, history, coupons or loyalty data.
 *
 * STORAGE
 *   localStorage["qrmenu_table_session"] =
 *     { tableNumber: 5, sessionStartedAt: <epoch ms>, sessionExpiresAt: <epoch ms> }
 *   (localStorage, not sessionStorage: it must survive closing/re-opening the
 *   installed app — the whole point of the 3-hour window.)
 *
 * TIME
 *   Timestamps use a "trusted now": the device clock corrected by the Date
 *   header of a same-origin request (see syncTrustedTime), so a customer whose
 *   phone clock is wrong — or who moves it — cannot stretch or shrink a
 *   session. Offline, it falls back to Date.now().
 *
 * TABLE NUMBER RULES
 *   TOTAL_TABLES must stay equal to TOTAL_TABLES in server.js (the /t/:n
 *   validator). order.js takes its VALID_TABLES from here.
 */

export const TOTAL_TABLES         = 10;
export const TABLE_SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

const STORAGE_KEY = "qrmenu_table_session";
// sessionStorage key that order.js getTableId() has always used — cleared on
// expiry so a stale value can never resurrect an expired table.
const LEGACY_SESSION_KEY = "qrmenu_locked_table";

let _clockOffsetMs = 0;      // server time − device time (0 until synced)
let _memSession    = null;   // fallback when localStorage is unavailable
let _entryRequired = false;  // true → the customer must scan / enter a table

// ── Validation / parsing ─────────────────────────────────────────────────────

/** True only for a configured table: an integer from 1 to TOTAL_TABLES. */
export function isValidTableNumber(n) {
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_TABLES;
}

/** "5", " 5 ", "Table 5", "table5" → 5 (validated). Anything else → null. */
export function parseTableInput(raw) {
  const m = String(raw ?? "").trim().match(/^(?:table\s*)?(\d{1,3})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isValidTableNumber(n) ? n : null;
}

/** A scanned QR payload ("https://host/t/8", "/t/8") → 8 (validated), else null. */
export function parseTableFromQr(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s, window.location.origin);
    const m = u.pathname.match(/^\/t\/([1-9]\d{0,2})\/?$/);
    if (m) {
      const n = parseInt(m[1], 10);
      return isValidTableNumber(n) ? n : null;
    }
  } catch (_) { /* not a URL — fall through */ }
  return parseTableInput(s);
}

/** The table encoded in the current page URL (/t/:n) or server injection. */
export function getTableFromPageUrl() {
  if (typeof window.__TABLE_ID__ === "number") {
    return isValidTableNumber(window.__TABLE_ID__) ? window.__TABLE_ID__ : null;
  }
  const m = window.location.pathname.match(/^\/t\/([1-9]\d{0,2})\/?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isValidTableNumber(n) ? n : null;
}

/** Running as an installed app (not a normal browser tab)? */
export function isStandaloneDisplay() {
  try {
    if (window.navigator.standalone === true) return true; // iOS home-screen apps
    return ["standalone", "fullscreen", "minimal-ui"].some(
      (m) => window.matchMedia(`(display-mode: ${m})`).matches
    );
  } catch (_) { return false; }
}

// ── Trusted time ─────────────────────────────────────────────────────────────

export function getTrustedNow() { return Date.now() + _clockOffsetMs; }

/**
 * Learn the real time from the server's Date header (HEAD on our own origin,
 * cache-busted). Never throws; resolves false when it could not sync.
 */
export async function syncTrustedTime(timeoutMs = 2500) {
  let timer = null;
  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (ctrl) timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0  = Date.now();
    const res = await fetch(`/?_tt=${t0}`, { method: "HEAD", cache: "no-store", signal: ctrl?.signal });
    const t1  = Date.now();
    const dateHdr = res.headers.get("date");
    let serverMs = dateHdr ? Date.parse(dateHdr) : NaN;
    if (Number.isFinite(serverMs)) {
      // A CDN may answer from cache: real time = Date + Age.
      serverMs += (Number(res.headers.get("age")) || 0) * 1000;
      // Date has 1 s resolution (truncated) → +500 ms; compare with the request midpoint.
      _clockOffsetMs = serverMs + 500 - (t0 + t1) / 2;
      return true;
    }
  } catch (_) { /* offline / blocked / timed out → keep the device clock */ }
  finally { if (timer) clearTimeout(timer); }
  return false;
}

// ── Storage ──────────────────────────────────────────────────────────────────

function _read() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return _validShape(JSON.parse(raw));
  } catch (_) { /* unavailable or corrupt → fall through */ }
  return _validShape(_memSession);
}

function _validShape(s) {
  if (!s || typeof s !== "object") return null;
  const { tableNumber, sessionStartedAt, sessionExpiresAt } = s;
  if (!isValidTableNumber(tableNumber)) return null;
  if (!Number.isFinite(sessionStartedAt) || !Number.isFinite(sessionExpiresAt)) return null;
  return { tableNumber, sessionStartedAt, sessionExpiresAt };
}

function _write(session) {
  _memSession = session;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch (_) {}
}

function _isExpired(s, now) {
  // Never trust an expiry longer than the TTL after the start (tampered value).
  const hardExpiry = Math.min(s.sessionExpiresAt, s.sessionStartedAt + TABLE_SESSION_TTL_MS);
  // Clock moved backwards past the start of the session → cannot be trusted.
  if (now < s.sessionStartedAt - 60_000) return true;
  return now >= hardExpiry;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** The stored record (valid OR expired), or null when none was ever stored. */
export function getStoredTableSession() { return _read(); }

/** The current table session, or null when there is none / it has expired. */
export function getActiveTableSession() {
  const s = _read();
  return s && !_isExpired(s, getTrustedNow()) ? s : null;
}

/** Milliseconds until the active session expires (0 when none). */
export function msUntilTableSessionExpiry() {
  const s = getActiveTableSession();
  if (!s) return 0;
  const hardExpiry = Math.min(s.sessionExpiresAt, s.sessionStartedAt + TABLE_SESSION_TTL_MS);
  return Math.max(0, hardExpiry - getTrustedNow());
}

/** Begin a NEW 3-hour table session (replaces any previous one). */
export function startTableSession(tableNumber) {
  if (!isValidTableNumber(tableNumber)) return null;
  const now = getTrustedNow();
  const session = {
    tableNumber,
    sessionStartedAt: now,
    sessionExpiresAt: now + TABLE_SESSION_TTL_MS,
  };
  _write(session);
  try { window.sessionStorage.setItem(LEGACY_SESSION_KEY, `Table ${tableNumber}`); } catch (_) {}
  _entryRequired = false;
  return session;
}

/**
 * Mark the table as "needs a new scan": clears ONLY the active-table state
 * (the sessionStorage table + the entry flag). The stored record is left as an
 * expired record — it is overwritten by the next startTableSession() — and
 * NOTHING about login, cart, history or coupons is touched.
 */
export function expireTableSession() {
  try { window.sessionStorage.removeItem(LEGACY_SESSION_KEY); } catch (_) {}
  _entryRequired = true;
}

/** True while the customer must scan a QR / enter a table before ordering. */
export function isTableEntryRequired() { return _entryRequired; }

/**
 * Boot-time reconciliation of "what table is this customer at?".
 *   • Page URL carries a table (/t/:n or injected) → that is a fresh QR scan:
 *     start a NEW session — unless it is the same table with a still-valid
 *     session (a plain refresh must not extend the window), or it is a
 *     reload/back-forward of a URL whose session already expired (a reload is
 *     not a scan; otherwise reloading would bypass the expiry screen).
 *   • No table in the URL (installed app opened at "/") → use the stored
 *     session while it is valid, otherwise require a new scan.
 *   • Never scanned + plain browser tab → legacy behaviour (table "Unknown",
 *     menu browsable) is preserved: status "legacy".
 * Returns "active" | "expired" | "none" | "legacy".
 */
export function reconcileTableSession() {
  const urlTable = getTableFromPageUrl();
  const current  = getActiveTableSession();
  const stored   = getStoredTableSession();

  if (urlTable) {
    if (current && current.tableNumber === urlTable) { _entryRequired = false; return "active"; }
    if (!current && stored && _navigationType() !== "navigate") {
      expireTableSession();
      return "expired";
    }
    startTableSession(urlTable);
    return "active";
  }

  if (current) { _entryRequired = false; return "active"; }

  if (stored) { expireTableSession(); return "expired"; }

  if (isStandaloneDisplay()) { expireTableSession(); return "none"; }

  _entryRequired = false;
  return "legacy";
}

function _navigationType() {
  try { return performance.getEntriesByType("navigation")[0]?.type || "navigate"; }
  catch (_) { return "navigate"; }
}
