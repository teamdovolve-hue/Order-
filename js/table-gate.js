/**
 * table-gate.js — "Please scan the QR code on your table" screen
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] New file — PWA upgrade. Read js/table-session.js first.
 *
 * Owns everything the customer SEES about the 3-hour table session:
 *   • decides at boot whether the panel or the scan screen is shown
 *   • the scan screen: primary "📷 Scan QR Code" (in-app camera scanner) and a
 *     small manual "Table No." fallback
 *   • watches for the session expiring while the app is open / in the background
 *
 * It is an OVERLAY on top of the normal panel — the panel keeps booting
 * underneath — so choosing a table returns to the menu instantly, with the
 * customer still logged in and their cart, history and coupons untouched.
 * This file never reads or writes the login session (js/auth.js).
 *
 * Reuses the existing table plumbing instead of duplicating it:
 *   validation → table-session.js (same 1…TOTAL_TABLES rule as server.js /t/:n)
 *   table chip → order.js setActiveTableId() (existing public interface)
 *
 * Events dispatched on window (used by js/pwa-install.js):
 *   "tableGateChange"      detail: { open: boolean }
 *   "tableSessionChanged"  detail: { tableNumber: number }
 */

import { setActiveTableId } from "./order.js";
import {
  reconcileTableSession, getActiveTableSession, getStoredTableSession,
  startTableSession, expireTableSession, isTableEntryRequired,
  msUntilTableSessionExpiry, syncTrustedTime,
  parseTableInput, parseTableFromQr, isValidTableNumber,
} from "./table-session.js";

const JSQR_URL = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"; // fallback decoder only
const MAX_TIMER_MS = 2 ** 31 - 1;

let _gate         = null;   // overlay element (created lazily)
let _expiryTimer  = null;
let _scan         = null;   // { stream, raf, stopped } while the camera is open
let _wired        = false;

// ─────────────────────────────────────────────────────────────────────────────
// Public
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call once at boot, AFTER auth has resolved and BEFORE reading getTableId().
 * Returns the reconcile status: "active" | "expired" | "none" | "legacy".
 */
export function initTableGate() {
  const status = reconcileTableSession();

  if (isTableEntryRequired()) _openGate(status === "expired");
  else _scheduleExpiryCheck();

  if (!_wired) {
    _wired = true;
    // Back from the background / bfcache / another tab changed the session.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") _resume();
    });
    window.addEventListener("pageshow", (e) => { if (e.persisted) _resume(); });
    window.addEventListener("focus", _checkNow);
    window.addEventListener("storage", (e) => {
      if (e.key === "qrmenu_table_session") _checkNow();
    });
  }
  return status;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expiry watching
// ─────────────────────────────────────────────────────────────────────────────

async function _resume() {
  await syncTrustedTime(1500); // never throws
  _checkNow();
}

function _checkNow() {
  const active = getActiveTableSession();

  if (isTableEntryRequired()) {
    // Gate is open. If another tab/window started a session meanwhile, follow it.
    if (active) _applyTable(active.tableNumber, { fromStorage: true });
    return;
  }

  if (active) { _scheduleExpiryCheck(); return; }

  // No active session. Only interrupt if there WAS one (now expired). A
  // browser tab that never scanned a QR keeps the legacy "Unknown" behaviour.
  if (getStoredTableSession()) {
    expireTableSession();
    _openGate(true);
  }
}

function _scheduleExpiryCheck() {
  clearTimeout(_expiryTimer);
  const ms = msUntilTableSessionExpiry();
  if (ms <= 0) return;
  _expiryTimer = setTimeout(_checkNow, Math.min(ms + 250, MAX_TIMER_MS));
}

// ─────────────────────────────────────────────────────────────────────────────
// Choosing a table
// ─────────────────────────────────────────────────────────────────────────────

function _applyTable(tableNumber, { fromStorage = false } = {}) {
  if (!fromStorage && !startTableSession(tableNumber)) return false;

  setActiveTableId(`Table ${tableNumber}`);   // updates the existing table chip
  _syncPageUrl(tableNumber);
  _closeGate();
  _scheduleExpiryCheck();
  window.dispatchEvent(new CustomEvent("tableSessionChanged", { detail: { tableNumber } }));
  return true;
}

// Keep the address bar / injected value in step with the new table so a plain
// browser refresh does not re-read the OLD table's /t/:n and restart it.
function _syncPageUrl(n) {
  try {
    if (typeof window.__TABLE_ID__ === "number") window.__TABLE_ID__ = n;
    if (/^\/t\/\d+\/?$/.test(window.location.pathname)) {
      window.history.replaceState(window.history.state, "", `/t/${n}${window.location.search}${window.location.hash}`);
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate UI
// ─────────────────────────────────────────────────────────────────────────────

function _buildGate() {
  const el = document.createElement("div");
  el.id = "tableGate";
  el.className = "tg-overlay hidden";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "tgTitle");
  el.innerHTML = `
    <div class="tg-card">
      <div class="tg-home" id="tgHome">
        <img class="tg-logo" src="icons/icon-192.png" alt="" width="72" height="72" />
        <h2 class="tg-title" id="tgTitle">🍕 Welcome to New Pizza Hut Live Cake</h2>
        <p class="tg-body">Please scan the QR code on your table to continue.</p>
        <p class="tg-note hidden" id="tgExpiredNote">Your previous table session has ended.</p>

        <button type="button" class="tg-scan-btn" id="tgScanBtn">📷 Scan QR Code</button>
        <p class="tg-msg hidden" id="tgScanMsg" role="status"></p>

        <div class="tg-or" aria-hidden="true"><span>OR</span></div>

        <form class="tg-manual" id="tgManualForm" novalidate autocomplete="off">
          <label class="tg-manual-label" for="tgTableInput">Enter table number manually</label>
          <div class="tg-manual-row">
            <input class="tg-input" id="tgTableInput" type="text" inputmode="numeric"
                   pattern="[0-9]*" maxlength="8" placeholder="Table No." autocomplete="off" />
            <button type="submit" class="tg-continue-btn">Continue</button>
          </div>
          <p class="tg-error hidden" id="tgError" role="alert">Invalid table number.</p>
        </form>
      </div>

      <div class="tg-scanner hidden" id="tgScanner">
        <div class="tg-video-wrap">
          <video class="tg-video" id="tgVideo" playsinline muted></video>
          <div class="tg-frame" aria-hidden="true"></div>
        </div>
        <p class="tg-scanner-hint" id="tgScannerHint">Point your camera at the QR code on your table</p>
        <button type="button" class="tg-cancel-btn" id="tgCancelScan">Cancel</button>
      </div>
    </div>`;

  el.querySelector("#tgScanBtn").addEventListener("click", _startScanner);
  el.querySelector("#tgCancelScan").addEventListener("click", _stopScanner);
  el.querySelector("#tgManualForm").addEventListener("submit", (e) => {
    e.preventDefault();
    _submitManual();
  });
  el.querySelector("#tgTableInput").addEventListener("input", () => {
    el.querySelector("#tgError").classList.add("hidden");
  });
  // If the logo file is missing, hide the broken-image icon rather than show it.
  el.querySelector(".tg-logo").addEventListener("error", (e) => e.target.classList.add("hidden"));

  document.body.appendChild(el);
  return el;
}

function _openGate(expired) {
  if (!_gate) _gate = _buildGate();
  clearTimeout(_expiryTimer);

  setActiveTableId(null); // drop any in-memory table so nothing stale is used
  _gate.querySelector("#tgExpiredNote").classList.toggle("hidden", !expired);
  _gate.querySelector("#tgError").classList.add("hidden");
  _gate.querySelector("#tgScanMsg").classList.add("hidden");
  _showHome();

  const wasOpen = !_gate.classList.contains("hidden");
  _gate.classList.remove("hidden");
  document.documentElement.classList.add("tg-locked");
  if (!wasOpen) {
    window.dispatchEvent(new CustomEvent("tableGateChange", { detail: { open: true } }));
    setTimeout(() => _gate?.querySelector("#tgScanBtn")?.focus?.({ preventScroll: true }), 50);
  }
}

function _closeGate() {
  _stopScanner();
  if (!_gate || _gate.classList.contains("hidden")) return;
  _gate.classList.add("hidden");
  document.documentElement.classList.remove("tg-locked");
  const input = _gate.querySelector("#tgTableInput");
  if (input) input.value = "";
  window.dispatchEvent(new CustomEvent("tableGateChange", { detail: { open: false } }));
}

function _showHome() {
  _gate.querySelector("#tgHome").classList.remove("hidden");
  _gate.querySelector("#tgScanner").classList.add("hidden");
}

function _showMsg(text) {
  const p = _gate?.querySelector("#tgScanMsg");
  if (!p) return;
  p.textContent = text;
  p.classList.remove("hidden");
}

// ── Manual fallback ──────────────────────────────────────────────────────────

function _submitManual() {
  const input = _gate.querySelector("#tgTableInput");
  const n = parseTableInput(input.value);
  if (!isValidTableNumber(n)) {
    _gate.querySelector("#tgError").classList.remove("hidden");
    input.focus();
    return;
  }
  _applyTable(n);
}

// ── QR scanner ───────────────────────────────────────────────────────────────

async function _startScanner() {
  if (_scan) return;
  _gate.querySelector("#tgScanMsg").classList.add("hidden");

  if (!navigator.mediaDevices?.getUserMedia) {
    _showMsg("Camera scanning isn't available here. Scan the table QR with your phone's camera app, or enter the table number below.");
    return;
  }

  const scan = { stream: null, raf: 0, stopped: false };
  _scan = scan;

  try {
    scan.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (_) {
    _scan = null;
    _showMsg("Couldn't open the camera. Allow camera access, scan with your phone's camera app, or enter the table number below.");
    return;
  }

  if (scan.stopped) { scan.stream.getTracks().forEach((t) => t.stop()); return; }

  const video = _gate.querySelector("#tgVideo");
  video.srcObject = scan.stream;
  _gate.querySelector("#tgHome").classList.add("hidden");
  _gate.querySelector("#tgScanner").classList.remove("hidden");
  _gate.querySelector("#tgScannerHint").textContent = "Point your camera at the QR code on your table";
  try { await video.play(); } catch (_) {}

  let decode;
  try { decode = await _makeDecoder(); }
  catch (_) {
    _stopScanner();
    _showMsg("QR scanning isn't supported on this browser. Scan the table QR with your phone's camera app, or enter the table number below.");
    return;
  }
  if (scan.stopped) return;

  let lastBad = 0;
  const tick = async () => {
    if (scan.stopped) return;
    try {
      if (video.readyState >= 2) {
        const text = await decode(video);
        if (scan.stopped) return;
        if (text) {
          const n = parseTableFromQr(text);
          if (n) { _applyTable(n); return; }
          const now = Date.now();
          if (now - lastBad > 1500) {
            lastBad = now;
            _gate.querySelector("#tgScannerHint").textContent = "That isn't a table QR code — try the one on your table";
          }
        }
      }
    } catch (_) { /* a bad frame — keep scanning */ }
    scan.raf = setTimeout(tick, 150); // ≈ 6–7 scans/second is plenty and easy on the battery
  };
  tick();
}

function _stopScanner() {
  const scan = _scan;
  _scan = null;
  if (scan) {
    scan.stopped = true;
    clearTimeout(scan.raf);
    try { scan.stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
  }
  const video = _gate?.querySelector("#tgVideo");
  if (video) { try { video.pause(); } catch (_) {} video.srcObject = null; }
  if (_gate && !_gate.classList.contains("hidden")) _showHome();
}

// Native BarcodeDetector where it exists (Chrome/Android); otherwise jsQR,
// loaded on demand so it costs nothing unless the scanner is actually opened.
async function _makeDecoder() {
  if ("BarcodeDetector" in window) {
    try {
      const formats = (await window.BarcodeDetector.getSupportedFormats?.()) || ["qr_code"];
      if (formats.includes("qr_code")) {
        const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        return async (video) => (await detector.detect(video))[0]?.rawValue || null;
      }
    } catch (_) { /* fall through to jsQR */ }
  }

  if (typeof window.jsQR !== "function") {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = JSQR_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error("jsQR failed to load"));
      document.head.appendChild(s);
    });
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return async (video) => {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, 480 / vw);
    canvas.width  = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data || null;
  };
}
