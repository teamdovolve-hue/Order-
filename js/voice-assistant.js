/**
 * voice-assistant.js
 * ─────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-21] New file — Voice Assistant (mic button beside Search).
 *
 * WHAT IT DOES
 *   Tap the mic → the page blurs and a focused assistant panel expands with
 *   example commands and (immediately) starts listening. The clip is sent to
 *   POST /api/voice/transcribe (Deepgram speech-to-text), the transcript plus a
 *   compact snapshot of data the app ALREADY has goes to POST /api/voice/interpret
 *   (Groq understanding + reply), and this file then performs the returned action
 *   through the EXISTING customer-panel code. API keys live only in Vercel
 *   environment variables on the server side of those two endpoints — nothing
 *   secret is in this file.
 *
 * REUSE, NOT DUPLICATION — no second cart / coupon / history / stats / loyalty system:
 *   • Add to cart      → smart-assistant.js addToCartByName()  (its product matching,
 *                        variant + out-of-stock + "ordering paused" rules → cart.js addItem())
 *   • Coupons screen   → clicks the existing #offersBtn  (→ requireLogin → offers.js drawer,
 *                        real `coupons` data — exactly what tapping the 🎟️ icon does)
 *   • Order history    → clicks the existing #historyBtn (→ history.js drawer, real history)
 *   • View cart        → clicks the existing #placeOrderBtn ("View Details" → Order Review)
 *   • Customer facts   → smart-assistant.js getAssistantSnapshot()  (cached customers/{phone}
 *                        + coupons reads, getHistory(), active orders, cart — same sources as
 *                        the text Smart Assistant and the My Offers / My Orders screens)
 *   Triggering the header buttons (instead of re-implementing their drawers) guarantees a
 *   voice command and a normal tap can never behave differently, including login gating.
 *
 * SAFETY
 *   • The model is never trusted: the server whitelists its output, and
 *     addToCartByName() re-validates every item/size against the live menu — anything
 *     ambiguous becomes a short question instead of a guess.
 *   • Every string from the transcript / model / menu is rendered with textContent.
 *   • Closing the panel (or starting a new request) invalidates in-flight work through a
 *     session counter, so a late reply can never add to the cart after the panel was closed.
 *
 * VOICE REPLIES (Siya)
 *   The assistant is named "Siya" (see the panel header + the model's system prompt in
 *   api/voice/interpret.js). Every reply shown in the panel is also spoken aloud using the
 *   browser's built-in Web Speech API (SpeechSynthesisUtterance) — no extra API key, no
 *   server round-trip. Speech is cancelled whenever the panel closes or a new listen/request
 *   starts, so replies never pile up or talk over each other.
 *
 * WAKE WORD ("Hey Siya") — [AI UPDATE 2026-09-22]
 *   While the customer is on the HOME/MENU screen (panel closed, tab visible, no other
 *   drawer/modal/sheet open — see _isHomeScreenActive()), the browser's own built-in
 *   speech recognizer (Web Speech API — NOT Deepgram/Groq) listens locally for "Hey/Hi/Hello
 *   Siya". On a match it stops that recognizer and calls the SAME _openPanel() a mic-button
 *   tap calls, which then runs the EXISTING unchanged listening flow (record → Deepgram →
 *   Groq). No second assistant UI, no new network calls for the wake phrase itself — only the
 *   real command afterward goes through Deepgram/Groq, exactly as a manual tap always did.
 *   See "── Wake word" below and AI_HANDOFF.md for details/limitations.
 *
 * PUBLIC API
 *   initVoiceAssistant() — wire the mic button + panel + wake word. Call once on boot (app.js).
 */

import { getLoginInfo } from "./auth.js";
import { cart } from "./cart.js";
import { getAssistantMenu, getAssistantSnapshot, addToCartByName } from "./smart-assistant.js";

// ── Config ────────────────────────────────────────────────────────────────────
const API_TRANSCRIBE = "/api/voice/transcribe";
const API_INTERPRET  = "/api/voice/interpret";

const MAX_RECORD_MS         = 12000; // hard stop for one utterance
const NO_SPEECH_MS          = 6000;  // give up if nothing is heard
const SILENCE_AFTER_SPEECH  = 1500;  // auto-stop after this much quiet following speech
const MIN_RECORD_MS         = 500;   // shorter than this is an accidental tap
const FETCH_TIMEOUT_MS      = 20000;
const SNAPSHOT_TIMEOUT_MS   = 4000;  // never let a slow Firestore read block a voice request
const HISTORY_KEEP          = 6;

const ASSISTANT_NAME = "Siya";
const TTS_LANG_PREF  = ["en-IN", "hi-IN"]; // preferred voice languages, in order

const EXAMPLES = [
  "Add Paneer Pizza Regular to cart",
  "What coupons do I have?",
  "Show my order history",
  "How many orders have I made?",
  "What is my current loyalty progress?",
  "What offers are available?",
];

/** state → [status line, hint line] */
const STATE_COPY = {
  idle:         ["Tap the mic and speak",   "Or tap one of the examples below"],
  requesting:   ["Allow microphone access", "Approve the prompt from your browser"],
  listening:    ["Listening…",              "Speak now — tap the mic when you're done"],
  transcribing: ["Transcribing…",           "Turning your voice into text"],
  thinking:     ["Working on it…",          "Checking your menu and account"],
  ask:          ["Tap the mic to answer",   ""],
  done:         ["Done",                    "Tap the mic to ask something else"],
  error:        ["Couldn't do that",        ""],
};
const BUSY_STATES = new Set(["requesting", "transcribing", "thinking"]);
/** Topics whose answer is the logged-in customer's own account data. */
const ACCOUNT_TOPICS = new Set(["coupons", "orders", "loyalty", "spend"]);

const _inr = new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2,
});
const $ = (id) => document.getElementById(id);

// ── Module state ──────────────────────────────────────────────────────────────
let _open = false;
let _state = "idle";
let _session = 0;          // bumped on open / new request / close — stale async work checks it
let _history = [];         // [{ role: "user"|"assistant", text }] — this panel session only

let _stream = null;
let _recorder = null;
let _chunks = [];
let _sendOnStop = true;
let _startedAt = 0;
let _audioCtx = null;
let _srcNode = null;
let _analyser = null;
let _rafId = 0;
let _maxTimer = 0;
let _noSpeechTimer = 0;
let _peak = 0;
let _speechSeen = false;
let _level = 0;

let _abort = null;         // AbortController for the request in flight
let _lastTranscript = "";

// ── Speech (Siya talks back) ──────────────────────────────────────────────────
const _tts = window.speechSynthesis || null;
let _ttsVoice = null;
let _ttsVoiceReady = false;

function _pickTtsVoice() {
  if (!_tts) return null;
  const voices = _tts.getVoices();
  if (!voices.length) return null;
  for (const lang of TTS_LANG_PREF) {
    const exact = voices.find((v) => v.lang === lang);
    if (exact) return exact;
    const partial = voices.find((v) => v.lang?.startsWith(lang.split("-")[0]));
    if (partial) return partial;
  }
  return voices[0];
}

if (_tts) {
  // Voice list loads async in most browsers.
  _tts.addEventListener?.("voiceschanged", () => {
    _ttsVoice = _pickTtsVoice();
    _ttsVoiceReady = true;
  });
}

/** Cancel anything Siya is currently saying (panel close / new request / new listen). */
function _stopSpeaking() {
  try { _tts?.cancel(); } catch (_) {}
}

/** Speak a reply out loud. Silently does nothing if the browser can't do TTS. */
function _speak(text) {
  if (!_tts || !text) return;
  _stopSpeaking();
  if (!_ttsVoiceReady) _ttsVoice = _pickTtsVoice();
  try {
    const u = new SpeechSynthesisUtterance(text);
    if (_ttsVoice) u.voice = _ttsVoice;
    u.lang = _ttsVoice?.lang || "en-IN";
    u.rate = 1;
    u.pitch = 1;
    _tts.speak(u);
  } catch (_) {}
}

// ── Wake word ("Hey Siya") ───────────────────────────────────────────────────

const _SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const WAKE_PHRASE_RE          = /\b(hey|hi|hello)[,]?\s+siya\b/i;
const WAKE_RESTART_DELAY_MS   = 300;   // normal restart right after the recognizer ends
const WAKE_ERROR_BACKOFF_MS   = 4000;  // backoff after a recoverable recognition error
const WAKE_MAX_ERROR_STREAK   = 6;     // give up for this page load after this many in a row
const WAKE_RESUME_COOLDOWN_MS = 800;   // pause after the panel/another overlay closes

let _wakeRecognizer  = null;
let _wakeWanted      = false;  // true once initVoiceAssistant() has enabled wake word
let _wakeActive      = false;  // true while the recognizer instance is actually running
let _wakeDisabled    = false;  // unsupported / denied / too many errors — stop trying
let _wakeGestureSeen = false;  // has the customer interacted with the page yet?
let _wakeErrorStreak = 0;
let _wakeRestartTimer = 0;
let _wakeResumeTimer  = 0;
let _wakeBodyObserver = null;

function _wakeWordSupported() {
  return !!_SpeechRecognitionCtor && !!window.isSecureContext;
}

/**
 * "HOME/MENU screen": the Siya panel itself is closed, the tab is visible, and no other
 * drawer/modal/sheet is open. Every existing overlay (history, offers, item sheet, variant
 * picker, review, smart-assistant chat, login) sets `document.body.style.overflow = "hidden"`
 * while open — the same signal this file already uses for its own panel — so this reads that
 * one shared, already-existing convention instead of importing/duplicating per-module state.
 */
function _isHomeScreenActive() {
  return !_open && document.visibilityState === "visible" && document.body.style.overflow !== "hidden";
}

/** Watches for other overlays opening/closing so the wake recognizer pauses/resumes with them. */
function _watchHomeScreenState() {
  if (_wakeBodyObserver || typeof MutationObserver === "undefined") return;
  _wakeBodyObserver = new MutationObserver(() => {
    if (_isHomeScreenActive()) _scheduleWakeResume();
    else _pauseWakeListening();
  });
  try { _wakeBodyObserver.observe(document.body, { attributes: true, attributeFilter: ["style"] }); }
  catch (_) {}
}

function _setupWakeWord() {
  if (!_wakeWordSupported()) return; // unsupported browser: manual mic button is unaffected
  _wakeWanted = true;
  _watchHomeScreenState();
  _armWakeListening(); // try right away — works in many desktop browsers with no gesture needed
  // Some browsers withhold the mic permission prompt until a user gesture. Retry once on the
  // customer's first tap/key/touch anywhere on the page so that case doesn't look like a denial.
  const onGesture = () => { _wakeGestureSeen = true; _wakeErrorStreak = 0; _armWakeListening(); };
  ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
    document.addEventListener(ev, onGesture, { once: true, passive: true })
  );
}

/** Start the wake-word recognizer now, if wanted, allowed, on the home screen, and not already running. */
function _armWakeListening() {
  if (!_wakeWanted || _wakeDisabled || _wakeActive) return;
  if (!_isHomeScreenActive()) return;
  window.clearTimeout(_wakeResumeTimer);

  if (!_wakeRecognizer) {
    let rec;
    try { rec = new _SpeechRecognitionCtor(); } catch (_) { _wakeDisabled = true; return; }
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = _ttsVoice?.lang || TTS_LANG_PREF[0];

    rec.onresult = (e) => {
      if (!_isHomeScreenActive()) return; // an overlay opened between speaking and this callback
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i]?.[0]?.transcript || "";
        if (WAKE_PHRASE_RE.test(transcript)) { _onWakeDetected(); return; }
      }
    };
    rec.onerror = (e) => _onWakeError(e?.error);
    rec.onend = () => {
      _wakeActive = false;
      if (!_wakeWanted || _wakeDisabled) return;
      window.clearTimeout(_wakeRestartTimer);
      _wakeRestartTimer = window.setTimeout(_armWakeListening, WAKE_RESTART_DELAY_MS);
    };
    _wakeRecognizer = rec;
  }

  try {
    _wakeRecognizer.start();
    _wakeActive = true;
  } catch (_) {
    _wakeActive = false; // already starting / transient — onend or the next check retries
  }
}

function _onWakeError(code) {
  _wakeActive = false;
  if (code === "not-allowed" || code === "service-not-allowed") {
    if (!_wakeGestureSeen) return; // likely just the browser's gesture requirement — wait for a tap
    _wakeDisabled = true;          // denied after a real interaction: stop asking for this session
    return;
  }
  if (code === "no-speech" || code === "aborted") return; // routine — onend already restarts it
  _wakeErrorStreak++;
  if (_wakeErrorStreak >= WAKE_MAX_ERROR_STREAK) { _wakeDisabled = true; return; }
  window.clearTimeout(_wakeRestartTimer);
  _wakeRestartTimer = window.setTimeout(_armWakeListening, WAKE_ERROR_BACKOFF_MS);
}

/** Stop the wake recognizer (panel opening, tab hidden, another overlay opened, page leaving). */
function _pauseWakeListening() {
  window.clearTimeout(_wakeRestartTimer);
  window.clearTimeout(_wakeResumeTimer);
  if (_wakeRecognizer && _wakeActive) { try { _wakeRecognizer.abort(); } catch (_) {} }
  _wakeActive = false;
}

/** Resume listening after a short cooldown once we're back on the home screen. */
function _scheduleWakeResume() {
  if (!_wakeWanted || _wakeDisabled) return;
  window.clearTimeout(_wakeResumeTimer);
  _wakeResumeTimer = window.setTimeout(_armWakeListening, WAKE_RESUME_COOLDOWN_MS);
}

function _onWakeDetected() {
  if (_open) return;      // already open — prevents a duplicate assistant opening
  _wakeErrorStreak = 0;
  _pauseWakeListening();  // never run wake recognition and the command recorder at the same time
  _openPanel();           // EXISTING modal, then EXISTING record → Deepgram → Groq flow
}

// ── Public ────────────────────────────────────────────────────────────────────

export function initVoiceAssistant() {
  const mic = $("vaMicBtn");
  if (!mic || !$("vaOverlay")) return;

  mic.addEventListener("click", () => _openPanel());
  $("vaCloseBtn")?.addEventListener("click", _closePanel);
  $("vaBackdrop")?.addEventListener("click", _closePanel);
  $("vaOrb")?.addEventListener("click", _onOrbTap);

  // Example commands: tap = run it exactly as if it had been spoken (skips the microphone).
  $("vaExamples")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".va-example");
    if (btn?.dataset.cmd) _runTextCommand(btn.dataset.cmd);
  });

  // Result buttons (Open My Offers / View cart / Retry …)
  $("vaActions")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-va-nav], [data-va-retry]");
    if (!btn) return;
    if (btn.dataset.vaRetry) { _retryLast(); return; }
    _navigateTo(btn.dataset.vaNav, btn.dataset.vaLabel || "Opening…");
  });

  document.addEventListener("keydown", (e) => {
    if (_open && e.key === "Escape") _closePanel();
  });

  // Never keep the microphone running in the background.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && _state === "listening") _cancelListening();
    if (document.hidden) _pauseWakeListening(); else _scheduleWakeResume();
  });
  window.addEventListener("pagehide", () => { _cancelListening(); _pauseWakeListening(); });

  // [AI UPDATE 2026-09-22] "Hey Siya" wake word — DISABLED (was constantly re-arming the
  // background mic in a loop, causing the mic indicator to keep activating on its own).
  // The manual mic button above is unaffected. To re-enable, uncomment the line below.
  // try { _setupWakeWord(); } catch (err) { console.warn("[voice] wake word init failed:", err); }
}

// ── Open / close ──────────────────────────────────────────────────────────────

function _openPanel() {
  if (_open) return;
  _open = true;
  _history = [];
  _session++;

  _buildExamples();
  _clearResult();
  _setState("idle");

  const overlay = $("vaOverlay");
  const panel = $("vaPanel");
  overlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  // "Expand from the mic": grow the panel out of the mic button's position.
  try {
    const m = $("vaMicBtn").getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    panel.style.transformOrigin = `${m.left + m.width / 2 - p.left}px ${m.top + m.height / 2 - p.top}px`;
  } catch (_) {}

  // Start listening right away, inside the tap's user-gesture (needed for the audio
  // context on iOS). Permission errors / unsupported browsers are handled there and the
  // example commands stay usable either way.
  _startListening();
  $("vaOrb")?.focus({ preventScroll: true });
}

function _closePanel() {
  if (!_open) return;
  _open = false;
  _session++;                 // orphan anything still in flight
  _cancelListening();
  _stopSpeaking();
  _abort?.abort();
  _abort = null;
  if (_audioCtx) { try { _audioCtx.close(); } catch (_) {} _audioCtx = null; }

  $("vaOverlay")?.classList.add("hidden");
  document.body.style.overflow = "";
  _setLevel(0);
  _clearResult();
  _history = [];
  $("vaMicBtn")?.focus({ preventScroll: true });
  _scheduleWakeResume(); // back on the home screen — listen for "Hey Siya" again
}

// ── State + UI helpers ────────────────────────────────────────────────────────

function _setState(state, statusOverride, hintOverride) {
  _state = state;
  const overlay = $("vaOverlay");
  if (overlay) overlay.dataset.state = state;
  const [status, hint] = STATE_COPY[state] || ["", ""];
  const s = $("vaStatus"); if (s) s.textContent = statusOverride ?? status;
  const h = $("vaHint");   if (h) h.textContent = hintOverride ?? hint;

  const orb = $("vaOrb");
  if (orb) {
    orb.setAttribute("aria-label", state === "listening" ? "Stop listening" : "Start listening");
    orb.setAttribute("aria-disabled", BUSY_STATES.has(state) ? "true" : "false");
  }
}

function _setLevel(v) {
  _level = _level * 0.55 + v * 0.45;
  $("vaOrb")?.style.setProperty("--va-level", _level.toFixed(3));
}

function _buildExamples() {
  const list = $("vaExamples");
  if (!list || list.childElementCount) return;
  for (const cmd of EXAMPLES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "va-example";
    btn.dataset.cmd = cmd;
    const q = document.createElement("span");
    q.className = "va-example-quote";
    q.setAttribute("aria-hidden", "true");
    q.textContent = "“";
    const t = document.createElement("span");
    t.className = "va-example-text";
    t.textContent = cmd;
    btn.append(q, t);
    list.appendChild(btn);
  }
}

function _showTranscript(text) {
  const el = $("vaTranscript");
  if (!el) return;
  el.textContent = text ? `“${text}”` : "";
  el.classList.toggle("hidden", !text);
}

/**
 * @param {{text: string, tone?: "success"|"info"|"warn"|"error"|"ask",
 *          facts?: [string,string][], actions?: {label: string, nav?: string, navLabel?: string, retry?: boolean}[]}} r
 */
function _showResult({ text, tone = "info", facts = [], actions = [] }) {
  const box = $("vaResponse");
  if (!box) return;
  box.className = `va-response va-response--${tone}`;
  $("vaResponseText").textContent = text || "";

  const factsEl = $("vaFacts");
  factsEl.replaceChildren();
  for (const [label, value] of facts) {
    const chip = document.createElement("span");
    chip.className = "va-fact";
    const l = document.createElement("span"); l.className = "va-fact-label"; l.textContent = label;
    const v = document.createElement("span"); v.className = "va-fact-value"; v.textContent = value;
    chip.append(l, v);
    factsEl.appendChild(chip);
  }
  factsEl.classList.toggle("hidden", facts.length === 0);

  const actionsEl = $("vaActions");
  actionsEl.replaceChildren();
  for (const a of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "va-action-btn";
    b.textContent = a.label;
    if (a.nav) { b.dataset.vaNav = a.nav; b.dataset.vaLabel = a.navLabel || "Opening…"; }
    if (a.retry) b.dataset.vaRetry = "1";
    actionsEl.appendChild(b);
  }
  actionsEl.classList.toggle("hidden", actions.length === 0);

  box.classList.remove("hidden");
  const scroller = $("vaScroll");
  if (scroller) scroller.scrollTop = 0;

  _speak(text);
}

function _clearResult() {
  _showTranscript("");
  $("vaResponse")?.classList.add("hidden");
  $("vaFacts")?.replaceChildren();
  $("vaActions")?.replaceChildren();
}

function _showError(message, { retry = false } = {}) {
  _showResult({
    text: message,
    tone: "error",
    actions: retry && _lastTranscript ? [{ label: "↻ Try again", retry: true }] : [],
  });
  _setState("error");
}

function _remember(userText, assistantText) {
  _history.push({ role: "user", text: userText });
  if (assistantText) _history.push({ role: "assistant", text: assistantText });
  _history = _history.slice(-HISTORY_KEEP);
}

// ── Microphone: record one utterance ──────────────────────────────────────────

function _onOrbTap() {
  if (_state === "listening") { _stopListening(true); return; }
  if (BUSY_STATES.has(_state)) return;   // already working on something
  _startListening();
}

function _pickMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return "";
}

function _ensureAudioCtx() {
  if (_audioCtx && _audioCtx.state !== "closed") return _audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { _audioCtx = new AC(); } catch (_) { _audioCtx = null; }
  return _audioCtx;
}

async function _startListening() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    _showError("Voice needs a secure (https) connection and a supported browser. You can still tap an example below.");
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    _showError("This browser can't record audio. Try Chrome or Safari, or tap an example below.");
    return;
  }

  const session = ++_session;
  _stopSpeaking();
  _clearResult();
  _setState("requesting");

  // Created/resumed synchronously inside the tap so iOS allows it.
  const ctx = _ensureAudioCtx();
  try { ctx?.resume?.(); } catch (_) {}

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    if (session !== _session) return;
    _showError(_micErrorMessage(err));
    return;
  }
  if (session !== _session) { stream.getTracks().forEach((t) => t.stop()); return; }

  try {
    const mime = _pickMime();
    _recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    _showError("Couldn't start recording on this device. You can still tap an example below.");
    return;
  }

  _stream = stream;
  _chunks = [];
  _sendOnStop = true;
  _peak = 0;
  _speechSeen = false;
  _level = 0;
  const recorder = _recorder;
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) _chunks.push(e.data); };
  recorder.onerror = () => {
    if (session !== _session) return;
    _releaseMic();
    _showError("The recording failed. Please try again.");
  };
  recorder.onstop = () => _onRecorded(session, recorder);

  recorder.start();
  _startedAt = Date.now();
  _setState("listening");
  _startMeter(session);

  _maxTimer = window.setTimeout(() => _stopListening(true), MAX_RECORD_MS);
  _noSpeechTimer = window.setTimeout(() => {
    if (_state !== "listening" || _speechSeen) return;
    // Nothing clearly detected: still send it if the mic picked up something audible.
    _stopListening(_peak > 0.025);
  }, NO_SPEECH_MS);
}

/** Level meter for the orb + simple voice-activity detection (auto-stop after you finish). */
function _startMeter(session) {
  const ctx = _audioCtx;
  if (!ctx || !_stream) return;
  try {
    _srcNode = ctx.createMediaStreamSource(_stream);
    _analyser = ctx.createAnalyser();
    _analyser.fftSize = 512;
    _srcNode.connect(_analyser);            // not connected to the speakers → no echo
  } catch (_) { _srcNode = null; _analyser = null; return; }

  const buf = new Uint8Array(_analyser.fftSize);
  const t0 = performance.now();
  let floorSum = 0, floorN = 0, noiseFloor = 0.01;
  let loudFrames = 0, lastLoud = 0;

  const tick = () => {
    if (session !== _session || _state !== "listening" || !_analyser) return;
    _analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    _peak = Math.max(_peak, rms);
    _setLevel(Math.min(1, rms * 4));

    const now = performance.now();
    if (now - t0 < 350) {                    // learn the room's background level first
      floorSum += rms; floorN++;
      noiseFloor = floorSum / floorN;
    } else {
      const threshold = Math.max(0.04, noiseFloor * 2.5 + 0.015);
      if (rms > threshold) {
        loudFrames++; lastLoud = now;
        if (loudFrames >= 6) _speechSeen = true;   // ~100 ms of sustained sound = speech, not a click
      } else if (_speechSeen && now - lastLoud > SILENCE_AFTER_SPEECH) {
        _stopListening(true);
        return;
      }
    }
    _rafId = requestAnimationFrame(tick);
  };
  _rafId = requestAnimationFrame(tick);
}

function _stopListening(send) {
  if (!_recorder || _recorder.state === "inactive") return;
  _sendOnStop = !!send;
  window.clearTimeout(_maxTimer);
  window.clearTimeout(_noSpeechTimer);
  cancelAnimationFrame(_rafId);
  try { _recorder.stop(); } catch (_) { _releaseMic(); _setState("idle"); }
}

/** Abort without sending anything (panel closed, tab hidden, example tapped, …). */
function _cancelListening() {
  if (_recorder && _recorder.state !== "inactive") {
    _sendOnStop = false;
    try { _recorder.stop(); } catch (_) {}
  }
  _releaseMic();
}

function _releaseMic() {
  window.clearTimeout(_maxTimer);
  window.clearTimeout(_noSpeechTimer);
  cancelAnimationFrame(_rafId);
  try { _srcNode?.disconnect(); } catch (_) {}
  _srcNode = null;
  _analyser = null;
  if (_stream) { _stream.getTracks().forEach((t) => t.stop()); _stream = null; }
  _recorder = null;
  _setLevel(0);
}

function _micErrorMessage(err) {
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access is blocked. Allow it in your browser settings, or tap an example below.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found on this device. You can still tap an example below.";
    case "NotReadableError":
      return "The microphone is being used by another app. Close it and try again.";
    default:
      return "Couldn't start the microphone. Please try again, or tap an example below.";
  }
}

// ── After recording: transcribe → interpret → act ─────────────────────────────

async function _onRecorded(session, recorder) {
  const mime = (recorder.mimeType || _chunks[0]?.type || "audio/webm").split(";")[0];
  const send = _sendOnStop;
  const blob = new Blob(_chunks, { type: mime });
  const durationMs = Date.now() - _startedAt;
  _releaseMic();
  _chunks = [];

  if (session !== _session) return;          // panel closed / superseded while stopping
  if (!send) {
    _setState("idle", "I didn't hear anything", "Tap the mic and try again, or tap an example below");
    return;
  }
  if (durationMs < MIN_RECORD_MS || blob.size < 600) {
    _setState("idle", "That was too short", "Tap the mic and speak a full sentence");
    return;
  }

  _setState("transcribing");
  try {
    const data = await _fetchJson(API_TRANSCRIBE, {
      method: "POST",
      headers: { "Content-Type": mime },
      body: blob,
    }, session);
    if (session !== _session) return;

    const transcript = (data?.transcript || "").trim();
    if (!transcript) {
      _setState("idle", "I didn't catch that", "Tap the mic and try again, or tap an example below");
      return;
    }
    await _interpretAndAct(transcript, session);
  } catch (err) {
    if (session !== _session || err.code === "cancelled") return;
    _showError(_errorMessage(err), { retry: false });
  }
}

/** Example chips + "Try again": skip the microphone and treat the text as the transcript. */
function _runTextCommand(text) {
  if (!_open) return;
  _cancelListening();
  _abort?.abort();
  const session = ++_session;
  _clearResult();
  _interpretAndAct(text, session);
}

function _retryLast() {
  if (_lastTranscript) _runTextCommand(_lastTranscript);
}

async function _interpretAndAct(text, session) {
  _lastTranscript = text;
  _showTranscript(text);
  _setState("thinking");

  try {
    const menu = getAssistantMenu();
    if (menu.length === 0) {
      _showResult({ text: "The menu is still loading — please try again in a moment.", tone: "warn" });
      _setState("idle", "Menu is loading", "Try again in a moment");
      return;
    }

    let snap = await _withTimeout(getAssistantSnapshot(), SNAPSHOT_TIMEOUT_MS, null);
    if (session !== _session) return;
    if (!snap) {
      // Firestore too slow / offline: still let the assistant handle menu + cart requests.
      snap = { loggedIn: !!getLoginInfo()?.phone, customer: null, cart: { items: [], subtotal: 0 } };
    }

    const result = await _fetchJson(API_INTERPRET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: text,
        history: _history,
        context: { loggedIn: snap.loggedIn, menu, customer: snap.customer, cart: snap.cart },
      }),
    }, session);
    if (session !== _session) return;

    await _act(result, text, snap, session);
  } catch (err) {
    if (session !== _session || err.code === "cancelled") return;
    _showError(_errorMessage(err), { retry: true });
  }
}

async function _act(result, transcript, snap, session) {
  switch (result?.action) {
    case "add_to_cart":
      return _actAdd(result.items || [], transcript, session);

    case "open_coupons":
      _remember(transcript, "Opened your offers.");
      return _navigateTo("offersBtn", "Opening My Offers…");

    case "open_history":
      _remember(transcript, "Opened your order history.");
      return _navigateTo("historyBtn", "Opening My Orders…");

    case "answer": {
      const topic = result.topic || "other";
      // Account questions need a login. Don't rely on the model for that: if nobody is logged
      // in, never show a model-written "answer" about their account.
      if (!snap.loggedIn && ACCOUNT_TOPICS.has(topic)) return _showLoginNeeded(transcript);
      _remember(transcript, result.reply);
      _showResult({
        text: result.reply,
        tone: "info",
        facts: _factsFor(topic, snap),
        actions: _followUpActions(topic, snap),
      });
      _setState("done");
      return;
    }

    case "login_required":
      return _showLoginNeeded(transcript);

    case "clarify":
      _remember(transcript, result.reply);
      _showResult({ text: result.reply, tone: "ask" });
      _setState("ask");
      return;

    default: // unsupported / unknown
      _remember(transcript, result?.reply);
      _showResult({ text: result?.reply || "Sorry, I can't help with that yet.", tone: "info" });
      _setState("done", "I can't do that yet", "Try one of the examples below");
  }
}

function _showLoginNeeded(transcript) {
  const msg = "Please log in first, then ask me again. Tap “Place Order” or the 🎟️ coupon icon to sign in.";
  _remember(transcript, msg);
  _showResult({ text: msg, tone: "warn" });
  _setState("done", "Log in to continue", "");
}

async function _actAdd(items, transcript, session) {
  const added = [];
  const notes = [];
  let asking = false;

  for (const it of items) {
    if (session !== _session) return;
    const r = await addToCartByName(it);         // ← the real cart, via smart-assistant.js
    if (r.status === "added") added.push(r.added);
    else { notes.push(r.message); if (r.status === "clarify") asking = true; }
  }
  if (session !== _session) return;

  const lines = [];
  if (added.length) lines.push(`Added ${added.join(", ")} to your cart.`);
  lines.push(...notes);
  const text = lines.join("\n");
  _remember(transcript, text);

  const actions = [];
  if (added.length) {
    let qty = 0, sub = 0;
    for (const i of cart.values()) { qty += i.qty; sub += i.price * i.qty; }
    actions.push({ label: `🛒 View cart · ${qty} item${qty === 1 ? "" : "s"} · ${_inr.format(sub)}`, nav: "placeOrderBtn", navLabel: "Opening your cart…" });
  }

  _showResult({
    text,
    tone: added.length && !notes.length ? "success" : asking ? "ask" : added.length ? "success" : "warn",
    actions,
  });
  if (asking) _setState("ask");
  else if (added.length) _setState("done", "Added to your cart");
  else _setState("done", "Couldn't add that", "Try another item or one of the examples");
}

/** Small "real numbers" strip under an answer, computed from the same snapshot the model got. */
function _factsFor(topic, snap) {
  const c = snap?.customer;
  if (!c) return [];
  const facts = [];
  if (topic === "orders") {
    facts.push(["Orders", String(c.totalOrders ?? 0)]);
  } else if (topic === "spend") {
    if (c.lifetimeSpend != null) facts.push(["Lifetime spend", _inr.format(c.lifetimeSpend)]);
  } else if (topic === "loyalty") {
    if (c.loyalty) {
      facts.push(["Orders", `${c.loyalty.ordersCompleted} / ${c.loyalty.ordersRequired}`]);
      facts.push(["Spend", `${_inr.format(c.loyalty.spendCompleted)} / ${_inr.format(c.loyalty.spendRequired)}`]);
    }
  } else if (topic === "coupons") {
    facts.push(["Available coupons", String(c.coupons?.availableCount ?? 0)]);
  }
  return facts;
}

function _followUpActions(topic, snap) {
  if (topic === "coupons") return [{ label: "🎟️ Open My Offers", nav: "offersBtn", navLabel: "Opening My Offers…" }];
  if (topic === "orders")  return [{ label: "🧾 Open My Orders", nav: "historyBtn", navLabel: "Opening My Orders…" }];
  if (topic === "cart" && snap?.cart?.items?.length) {
    return [{ label: "🛒 View cart", nav: "placeOrderBtn", navLabel: "Opening your cart…" }];
  }
  return [];
}

/**
 * Close the panel, then trigger the EXISTING header/cart button — the same handler a normal
 * tap runs (offersBtn → requireLogin → drawer; historyBtn → drawer; placeOrderBtn → Order Review).
 */
function _navigateTo(buttonId, statusText) {
  const session = _session;
  _setState("done", statusText, "");
  window.setTimeout(() => {
    if (!_open || session !== _session) return;   // closed / superseded during the short pause
    const target = $(buttonId);
    _closePanel();
    target?.click();
  }, 350);
}

// ── Network helpers ───────────────────────────────────────────────────────────

async function _fetchJson(url, init, session) {
  const ctl = new AbortController();
  _abort = ctl;
  const timer = window.setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const e = new Error(data?.message || `HTTP ${res.status}`);
      e.code = data?.error || `http_${res.status}`;
      e.status = res.status;
      throw e;
    }
    return data;
  } catch (err) {
    if (err.code) throw err;
    const e = new Error(err.name === "AbortError" ? "aborted" : "network");
    e.code = err.name === "AbortError" ? (session !== _session ? "cancelled" : "timeout") : "network";
    throw e;
  } finally {
    window.clearTimeout(timer);
    if (_abort === ctl) _abort = null;
  }
}

function _errorMessage(err) {
  switch (err.code) {
    case "network": return "Can't reach the assistant. Check your connection and try again.";
    case "timeout": return "That took too long. Please try again.";
    default:        return err.message && !/^HTTP \d+$/.test(err.message)
      ? err.message
      : "Something went wrong. Please try again.";
  }
}

function _withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const t = window.setTimeout(() => resolve(fallback), ms);
    promise.then((v) => { window.clearTimeout(t); resolve(v); },
                 () => { window.clearTimeout(t); resolve(fallback); });
  });
}
