/**
 * pwa-install.js — installable-PWA prompt (popup → banner above Search)
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] New file — PWA upgrade.
 *
 * Uses ONLY the real browser install flow: the `beforeinstallprompt` event is
 * captured (preventDefault) and replayed with event.prompt() when the customer
 * taps Install. Nothing is faked. A PWA can never be installed silently.
 *
 * The install UI exists ONLY while installation is genuinely available:
 *   • no `beforeinstallprompt` (iOS Safari, Firefox, unsupported browsers, or
 *     Chrome already knows the app is installed) → nothing is ever shown
 *   • already running as an installed app → nothing is shown
 *   • `appinstalled` (or display-mode flips to standalone) → everything is removed
 *
 * Flow (per page load — NOTHING is persisted, so the customer is never
 * "opted out"; a refresh may show the banner again):
 *   1. popup   "🍕 Install New Pizza Hut App" [Install]   (floating card)
 *        • tap outside it (or Esc, or ~12 s) → dismissed immediately, the tap is
 *          NOT swallowed, so the customer is never interrupted
 *   2. banner  compact bar directly above the Search bar   [Install] [✕]
 *        • ✕ hides it until the next page load
 *   Only one of the two is ever visible. While the "scan your table" screen
 *   (js/table-gate.js) is open, neither is shown; the popup appears once the
 *   customer is at a table.
 *
 * Also registers /sw.js (required for installability).
 */

import { isStandaloneDisplay, isTableEntryRequired } from "./table-session.js";

const POPUP_AUTO_DISMISS_MS = 12000;

let _deferred    = window.__pwaDeferredPrompt || null; // the captured beforeinstallprompt event
let _installed   = false;
let _phase       = "idle";      // idle → (popup) → banner → hidden   (in-memory only)
let _popup       = null;
let _banner      = null;
let _popupTimer  = null;

// ─────────────────────────────────────────────────────────────────────────────

export function initPwaInstall() {
  _registerServiceWorker();

  _installed = isStandaloneDisplay();
  if (_installed) return; // already installed → never show install UI

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();            // suppress the browser's own mini-infobar; we show ours
    _deferred = e;
    window.__pwaDeferredPrompt = e;
    _evaluate();
  });
  // index.html captures an early event before this module runs — pick it up.
  window.addEventListener("pwa:promptready", () => {
    _deferred = window.__pwaDeferredPrompt || _deferred;
    _evaluate();
  });

  window.addEventListener("appinstalled", _onInstalled);

  try {
    window.matchMedia("(display-mode: standalone)").addEventListener("change", (e) => {
      if (e.matches) _onInstalled();
    });
  } catch (_) {}

  // Table screen opening/closing, tab becoming visible again.
  window.addEventListener("tableGateChange", _evaluate);
  document.addEventListener("visibilitychange", _evaluate);

  _evaluate();
}

// ─────────────────────────────────────────────────────────────────────────────

function _canShowUi() {
  if (_installed || !_deferred) return false;   // not actually installable right now
  if (isTableEntryRequired()) return false;     // customer is on the "scan your table" screen
  if (document.visibilityState === "hidden") return false;
  const offline = document.getElementById("orderingOfflineScreen");
  if (offline && !offline.classList.contains("hidden")) return false; // ordering-paused screen
  return true;
}

function _evaluate() {
  if (!_canShowUi()) { _removePopup(); _removeBanner(); return; }
  if (_phase === "idle")        _showPopup();
  else if (_phase === "banner") _showBanner();
}

// ── Popup ────────────────────────────────────────────────────────────────────

function _showPopup() {
  if (_popup) return;
  _removeBanner();

  const el = document.createElement("div");
  el.className = "pwa-popup";
  el.id = "pwaInstallPopup";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Install New Pizza Hut App");
  el.innerHTML = `
    <div class="pwa-popup-text">
      <strong>🍕 Install New Pizza Hut App</strong>
      <span>Faster ordering &amp; live order tracking</span>
    </div>
    <button type="button" class="pwa-btn">Install</button>`;
  el.querySelector(".pwa-btn").addEventListener("click", _install);
  document.body.appendChild(el);
  _popup = el;
  _phase = "popup";

  // Tap ANYWHERE outside → dismiss at once. Capture phase, and the event is not
  // stopped, so whatever the customer tapped still receives that tap.
  document.addEventListener("pointerdown", _onOutsidePointer, true);
  document.addEventListener("keydown", _onKey, true);
  _popupTimer = setTimeout(_dismissPopup, POPUP_AUTO_DISMISS_MS);
}

function _onOutsidePointer(e) {
  if (_popup && !_popup.contains(e.target)) _dismissPopup();
}
function _onKey(e) { if (e.key === "Escape") _dismissPopup(); }

function _removePopup() {
  clearTimeout(_popupTimer);
  document.removeEventListener("pointerdown", _onOutsidePointer, true);
  document.removeEventListener("keydown", _onKey, true);
  if (_popup) { _popup.remove(); _popup = null; }
  if (_phase === "popup") _phase = "idle"; // interrupted (gate opened…) → offer again later
}

function _dismissPopup() {
  if (!_popup) return;
  _phase = "banner";            // set BEFORE removal so _removePopup keeps it
  _removePopup();
  _evaluate();                  // → banner above Search
}

// ── Banner (directly above the Search bar) ───────────────────────────────────

function _showBanner() {
  if (_banner) return;
  const searchWrap = document.getElementById("searchWrap");
  if (!searchWrap || !searchWrap.parentNode) return;

  const el = document.createElement("div");
  el.className = "pwa-banner";
  el.id = "pwaInstallBanner";
  el.innerHTML = `
    <div class="pwa-banner-inner">
      <span class="pwa-banner-icon" aria-hidden="true">📱</span>
      <span class="pwa-banner-text">Install New Pizza Hut App</span>
      <button type="button" class="pwa-banner-install">Install</button>
      <button type="button" class="pwa-banner-close" aria-label="Hide install banner">✕</button>
    </div>`;
  el.querySelector(".pwa-banner-install").addEventListener("click", _install);
  el.querySelector(".pwa-banner-close").addEventListener("click", () => {
    _phase = "hidden";          // this page load only — never persisted
    _removeBanner();
  });
  // In normal flow (NOT sticky) so the sticky offsets of the header, search bar
  // and category tabs are untouched; it simply scrolls away with the page.
  searchWrap.parentNode.insertBefore(el, searchWrap);
  _banner = el;
}

function _removeBanner() {
  if (_banner) { _banner.remove(); _banner = null; }
}

// ── Install / installed ──────────────────────────────────────────────────────

function _install() {
  const ev = _deferred;
  if (!ev) return;

  // The event is single-use. Take it, and hide our UI so there is never a
  // button that can't do anything. If the customer cancels the native dialog
  // the UI stays hidden until the browser offers a fresh event / next load.
  _deferred = null;
  window.__pwaDeferredPrompt = null;
  _phase = "banner";
  _removePopup();
  _removeBanner();

  try {
    ev.prompt();                                   // MUST run inside the tap handler
    Promise.resolve(ev.userChoice).then((choice) => {
      if (choice && choice.outcome === "accepted") _onInstalled();
    }).catch(() => {});
  } catch (_) { /* prompt() rejected — nothing to show */ }
}

function _onInstalled() {
  _installed = true;
  _deferred  = null;
  window.__pwaDeferredPrompt = null;
  _removePopup();
  _removeBanner();
}

// ── Service worker ───────────────────────────────────────────────────────────

function _registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const reg = () => navigator.serviceWorker.register("/sw.js", { scope: "/" })
    .catch((err) => console.warn("[pwa] service worker registration failed:", err));
  if (document.readyState === "complete") reg();
  else window.addEventListener("load", reg, { once: true });
}
