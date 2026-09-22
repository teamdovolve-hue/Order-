"use strict";
/**
 * api/voice/transcribe.js   —   POST /api/voice/transcribe
 * ─────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-21] New file — Voice Assistant speech-to-text (Deepgram).
 *
 * The browser (js/voice-assistant.js) records a short clip with MediaRecorder and
 * POSTs the raw audio bytes here. This function forwards them to Deepgram's
 * pre-recorded endpoint using the secret key from the environment and returns
 * only the transcript. The Deepgram key never reaches the browser.
 *
 * Request : POST, Content-Type: audio/webm | audio/mp4 | audio/ogg | …  (raw bytes)
 * Response: 200 { transcript: string, confidence: number|null }
 *           4xx/5xx { error: "<code>", message: "<safe text>" }
 *
 * Environment variables (set in Vercel → Project → Settings → Environment Variables):
 *   DEEPGRAM_API_KEY    (required)
 *   DEEPGRAM_MODEL      (optional, default "nova-3")
 *   DEEPGRAM_LANGUAGE   (optional; omitted by default = Deepgram's English. Examples:
 *                        "en-IN" for Indian English, "hi" for Hindi/Hinglish, "multi"
 *                        for multilingual code-switching — check Deepgram's model /
 *                        language matrix before changing.)
 */

const { sendJson, readRawBody, isSameOrigin, isRateLimited } = require("../_lib/voice-shared.js");

const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // ~2 MB — the client caps a clip at ~12 s (a few dozen KB)
const MIN_AUDIO_BYTES = 600;             // anything smaller cannot contain speech
const UPSTREAM_TIMEOUT_MS = 15000;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "method_not_allowed", message: "Use POST." });
  }
  if (!isSameOrigin(req)) {
    return sendJson(res, 403, { error: "forbidden", message: "Cross-site requests are not allowed." });
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.error("[voice/transcribe] DEEPGRAM_API_KEY is not set.");
    return sendJson(res, 503, { error: "not_configured", message: "Voice transcription is not set up yet." });
  }

  if (isRateLimited(req, "transcribe", 20, 60 * 1000)) {
    return sendJson(res, 429, { error: "rate_limited", message: "Too many voice requests. Please wait a moment." });
  }

  // Content-Type → bare mime type (Deepgram detects the container itself; this is just a hint).
  const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const okType = /^audio\//.test(mime) || mime === "video/webm" || mime === "video/mp4" || mime === "application/octet-stream";
  if (!okType) {
    return sendJson(res, 415, { error: "unsupported_media", message: "Send the recording as audio." });
  }

  let audio;
  try {
    audio = await readRawBody(req, MAX_AUDIO_BYTES);
  } catch (err) {
    if (err && err.code === "too_large") {
      return sendJson(res, 413, { error: "too_large", message: "That recording is too long." });
    }
    console.error("[voice/transcribe] body read failed:", err && err.message);
    return sendJson(res, 400, { error: "bad_request", message: "Could not read the recording." });
  }

  if (audio.length < MIN_AUDIO_BYTES) {
    return sendJson(res, 200, { transcript: "", confidence: null });
  }

  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-3",
    smart_format: "true",
  });
  if (process.env.DEEPGRAM_LANGUAGE) params.set("language", process.env.DEEPGRAM_LANGUAGE);

  let upstream;
  try {
    upstream = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": mime || "application/octet-stream",
      },
      body: audio,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    console.error("[voice/transcribe] Deepgram request failed:", timedOut ? "timeout" : (err && err.message));
    return sendJson(res, timedOut ? 504 : 502, {
      error: timedOut ? "stt_timeout" : "stt_unreachable",
      message: "The speech service didn't respond. Please try again.",
    });
  }

  if (!upstream.ok) {
    // Log the status + a short slice of Deepgram's error body for the operator; never the key/audio.
    let detail = "";
    try { detail = (await upstream.text()).slice(0, 300); } catch (_) {}
    console.error(`[voice/transcribe] Deepgram HTTP ${upstream.status}: ${detail}`);

    if (upstream.status === 401 || upstream.status === 403) {
      return sendJson(res, 502, { error: "stt_auth", message: "Voice transcription is misconfigured. Please tell the staff." });
    }
    if (upstream.status === 402) {
      return sendJson(res, 502, { error: "stt_quota", message: "Voice transcription is unavailable right now." });
    }
    if (upstream.status === 429) {
      return sendJson(res, 429, { error: "rate_limited", message: "The speech service is busy. Try again in a moment." });
    }
    return sendJson(res, 502, { error: "stt_failed", message: "Couldn't transcribe that. Please try again." });
  }

  let data;
  try {
    data = await upstream.json();
  } catch (_) {
    return sendJson(res, 502, { error: "stt_failed", message: "Couldn't transcribe that. Please try again." });
  }

  const alt = data && data.results && data.results.channels && data.results.channels[0]
    && data.results.channels[0].alternatives && data.results.channels[0].alternatives[0];
  const transcript = alt && typeof alt.transcript === "string" ? alt.transcript.trim().slice(0, 500) : "";
  const confidence = alt && typeof alt.confidence === "number" ? alt.confidence : null;

  return sendJson(res, 200, { transcript, confidence });
};

// Vercel: keep the raw body untouched (we read the stream ourselves).
module.exports.config = { api: { bodyParser: false } };
