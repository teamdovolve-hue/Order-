/**
 * pwa-install.js — installable-PWA prompt (popup → banner above Search)
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] New file — PWA upgrade.
 * [AI UPDATE 2026-09-24 v2] Fallback added: Chrome sometimes never fires
 *   `beforeinstallprompt` (already installed, earlier dismissal cool-down, …). Before,
 *   that meant NO install UI at all. Now, on a phone, if the event has not arrived
 *   after FALLBACK_DELAY_MS the same popup/banner is shown with a "How to" button
 *   that opens a small step-by-step sheet (Chrome ⋮ menu / iOS Safari Share). If the
 *   real event arrives later the button turns into the real "Install" button.
 *   Also: `/?pwadebug=1` opens an on-screen checklist (SW / manifest / event status)
 *   for debugging on a phone without a PC.
 *
 * [AI UPDATE 2026-09-24 v3]
 *   • While the popup is visible the page behind it is softly blurred + dimmed
 *     (".pwa-backdrop", pointer-events:none so taps/scroll still pass through) and
 *     the popup uses a brighter amber card so it cannot be missed.
 *   • The banner above Search now comes back on EVERY page load / refresh until the
 *     app is installed — the ✕ only hides it for the current page load (also in
 *     fallback mode; the old 3-day hide was removed).
 *
 * The real install flow is unchanged: the `beforeinstallprompt` event is captured
 * (preventDefault) and replayed with event.prompt() when the customer taps Install.
 * A PWA can never be installed silently, and nothing here fakes an install.
 *
 * Install UI is never shown when:
 *   • already running as an installed app (standalone) or `appinstalled` fired
 *   • the "scan your table" screen (js/table-gate.js) or the ordering-paused screen is open
 *   • desktop browser without a real beforeinstallprompt event
 *
 * Flow (per page load):
 *   1. popup   "🍕 Install New Pizza Hut App" [Install | How to]   (floating card)
 *        • tap outside it (or Esc, or ~12 s) → dismissed immediately, the tap is
 *          NOT swallowed, so the customer is never interrupted
 *   2. banner  compact bar directly above the Search bar   [Install | How to] [✕]
 *        • ✕ hides it for this page load only; it comes back on every refresh
 *          until the app is installed (real-event AND fallback mode).
 *   Only one of the two is ever visible.
 *
 * Also registers /sw.js (required for installability). index.html registers it too,
 * early, so installability never depends on the app boot sequence finishing.
 */

import { isStandaloneDisplay, isTableEntryRequired } from "./table-session.js";

const POPUP_AUTO_DISMISS_MS = 20000;
const FALLBACK_DELAY_MS     = 4000;
const LS_INSTALLED          = "nph_pwa_installed";

let _deferred      = window.__pwaDeferredPrompt || null; // the captured beforeinstallprompt event
let _installed     = false;
let _phase         = "idle";      // idle → (popup) → banner → hidden   (in-memory only)
let _popup         = null;
let _backdrop      = null;
let _banner        = null;
let _help          = null;
let _popupTimer    = null;
let _fallbackReady = false;

// ── tiny safe localStorage helpers ───────────────────────────────────────────
function _lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function _lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

function _isIOS() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function _isMobile() {
  return _isIOS() || /Android|Mobile/i.test(navigator.userAgent || "");
}
function _fallbackAllowed() {
  if (!_fallbackReady || !_isMobile()) return false;
  return _lsGet(LS_INSTALLED) !== "1";
}

// ─────────────────────────────────────────────────────────────────────────────

export function initPwaInstall() {
  _registerServiceWorker();

  _installed = isStandaloneDisplay();
  if (_installed) { _lsSet(LS_INSTALLED, "1"); return; } // already installed → never show install UI

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

  // No real event after a few seconds → offer the manual "How to" fallback (phones only).
  setTimeout(() => { _fallbackReady = true; _evaluate(); }, FALLBACK_DELAY_MS);

  _initDebugPanel();
  _evaluate();
}

// ─────────────────────────────────────────────────────────────────────────────

function _canShowUi() {
  if (_installed) return false;
  if (!_deferred && !_fallbackAllowed()) return false; // neither real install nor fallback available
  if (_help) return false;                             // instruction sheet is open
  if (isTableEntryRequired()) return false;            // customer is on the "scan your table" screen
  if (document.visibilityState === "hidden") return false;
  const offline = document.getElementById("orderingOfflineScreen");
  if (offline && !offline.classList.contains("hidden")) return false; // ordering-paused screen
  return true;
}

function _evaluate() {
  if (!_canShowUi()) { _removePopup(); _removeBanner(); return; }
  if (_phase === "idle")        _showPopup();
  else if (_phase === "banner") _showBanner();
  _syncLabels();
}

/** Button text follows reality: real event → "Install", otherwise → "How to". */
function _syncLabels() {
  const real = !!_deferred;
  const btnText = real ? "Install" : "How to";
  const subText = real ? "Faster ordering &amp; live order tracking" : "Add it to your home screen in 2 taps";
  if (_popup) {
    _popup.querySelector(".pwa-btn").textContent = btnText;
    _popup.querySelector(".pwa-popup-text span").innerHTML = subText;
  }
  if (_banner) _banner.querySelector(".pwa-banner-install").textContent = btnText;
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
  const bd = document.createElement("div");
  bd.className = "pwa-backdrop";
  bd.setAttribute("aria-hidden", "true");
  document.body.appendChild(bd);
  _backdrop = bd;
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
  if (_backdrop) { _backdrop.remove(); _backdrop = null; }
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
    _phase = "hidden";          // this page load only — it returns on the next refresh until installed
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

  // No real install event (Chrome withheld it / iOS Safari) → show the manual steps.
  if (!ev) {
    _phase = "banner";
    _removePopup();
    _removeBanner();
    _showHelp();
    return;
  }

  // The event is single-use. Take it, and hide our UI so there is never a
  // button that can't do anything. If the customer cancels the native dialog
  // the UI stays hidden until the browser offers a fresh event / next load.
  _deferred = null;
  window.__pwaDeferredPrompt = null;
  _phase = "banner";
  _removePopup();
  _removeBanner();
  _fallbackReady = false;       // cancelled the native dialog → do not nag with the manual sheet

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
  _lsSet(LS_INSTALLED, "1");
  _closeHelp();
  _removePopup();
  _removeBanner();
}

// ── Manual "How to install" sheet ────────────────────────────────────────────

function _showHelp() {
  if (_help) return;
  const ios = _isIOS();
  const steps = ios
    ? [
        "Open this page in <b>Safari</b>.",
        "Tap the <b>Share</b> button (square with an arrow) at the bottom.",
        "Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.",
      ]
    : [
        "Tap the <b>⋮</b> menu at the top-right of Chrome.",
        "Tap <b>Install app</b> (or <b>Add to Home screen</b>).",
        "Tap <b>Install</b> — the app icon appears on your home screen.",
      ];
  const note = ios ? "" : "Tip: use Chrome for the best result.";

  const el = document.createElement("div");
  el.className = "pwa-help";
  el.id = "pwaHelpSheet";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "How to install the app");
  el.innerHTML = `
    <div class="pwa-help-card">
      <h3>🍕 Install New Pizza Hut App</h3>
      <ol>${steps.map((s) => `<li>${s}</li>`).join("")}</ol>
      ${note ? `<p class="pwa-help-note">${note}</p>` : ""}
      <button type="button" class="pwa-btn">Got it</button>
    </div>`;
  el.addEventListener("click", (e) => { if (e.target === el) _closeHelp(); });
  el.querySelector(".pwa-btn").addEventListener("click", _closeHelp);
  document.body.appendChild(el);
  _help = el;
}

function _closeHelp() {
  if (!_help) return;
  _help.remove();
  _help = null;
  _evaluate();                  // → banner above Search (unless installed)
}

// ── Service worker ───────────────────────────────────────────────────────────

function _registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const reg = () => navigator.serviceWorker.register("/sw.js", { scope: "/" })
    .catch((err) => console.warn("[pwa] service worker registration failed:", err));
  if (document.readyState === "complete") reg();
  else window.addEventListener("load", reg, { once: true });
}

// ── On-phone debug checklist: open  /?pwadebug=1  ────────────────────────────

function _initDebugPanel() {
  if (!/[?&]pwadebug=1/.test(location.search)) return;
  setTimeout(async () => {
    const rows = [];
    const add = (k, v, ok) => rows.push(`${ok === false ? "❌" : ok === true ? "✅" : "•"} ${k}: ${v}`);
    add("HTTPS", window.isSecureContext, window.isSecureContext);
    add("Running as installed app", isStandaloneDisplay());
    add("Install event received", !!_deferred, !!_deferred);
    add("Marked installed before", _lsGet(LS_INSTALLED) === "1");
    try {
      const r = await navigator.serviceWorker.getRegistration("/");
      add("Service worker registered", !!r, !!r);
      add("SW state", r && r.active ? r.active.state : "none", !!(r && r.active));
    } catch (e) { add("Service worker", "error " + e.message, false); }
    try {
      const res = await fetch("/manifest.webmanifest", { cache: "no-store" });
      const type = res.headers.get("content-type") || "?";
      add("Manifest", `${res.status} ${type}`, res.ok && /json|manifest/i.test(type));
      const j = await res.json();
      add("Manifest icons", (j.icons || []).length, (j.icons || []).length >= 2);
      for (const ic of (j.icons || []).slice(0, 3)) {
        const r2 = await fetch(ic.src, { cache: "no-store" });
        add("Icon " + ic.sizes, `${r2.status} ${r2.headers.get("content-type") || ""}`, r2.ok);
      }
    } catch (e) { add("Manifest", "ERROR " + e.message, false); }
    add("Chrome/Browser", (navigator.userAgent.match(/(Chrome|CriOS|Firefox|SamsungBrowser|Version)\/[\d.]+/) || ["?"])[0]);

    const p = document.createElement("div");
    p.style.cssText = "position:fixed;left:8px;right:8px;top:8px;z-index:99999;background:#111;color:#eee;" +
      "border:1px solid #f5a623;border-radius:12px;padding:12px;font:12px/1.6 monospace;white-space:pre-wrap;" +
      "max-height:80vh;overflow:auto";
    p.textContent = "PWA DEBUG\n" + rows.join("\n") + "\n\n(tap to close)";
    p.addEventListener("click", () => p.remove());
    document.body.appendChild(p);
  }, 6000);
}
