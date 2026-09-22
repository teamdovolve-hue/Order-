"use strict";
/**
 * api/_lib/voice-shared.js
 * ─────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-21] New file — small helpers shared by the two Voice
 * Assistant serverless functions (api/voice/transcribe.js, api/voice/interpret.js).
 *
 * Runs as plain CommonJS on Node 18+ with ZERO npm dependencies (the Vercel
 * project skips `npm install` — see vercel.json — so nothing here may require a
 * package). Works unchanged under Vercel Functions AND the Express dev server
 * (server.js): it only uses req.headers / the raw request stream and
 * res.statusCode / res.setHeader / res.end.
 *
 * Secrets: API keys are read from process.env INSIDE the two handlers and are
 * never sent to the browser, never logged, and never included in a response.
 */

/** Sends a JSON response. Never cached. */
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/**
 * Reads the raw request body from the stream (deliberately NOT via req.body:
 * on Vercel, touching req.body triggers its own 1 MB-limited parser and would
 * consume the stream, and in Express it depends on which middleware ran).
 * Rejects with err.code === "too_large" once maxBytes is exceeded.
 */
async function readRawBody(req, maxBytes) {
  const declared = parseInt(req.headers["content-length"] || "0", 10);
  if (declared > maxBytes) {
    const e = new Error("Request body too large");
    e.code = "too_large";
    throw e;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const e = new Error("Request body too large");
      e.code = "too_large";
      throw e;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Browser-only cross-site guard. A browser always sends Origin on a fetch()
 * POST; if it is present it must match the host being served. Requests with no
 * Origin (curl, server-to-server) are allowed through — this is not
 * authentication, it only stops OTHER WEBSITES from using this deployment's
 * API quota from a visitor's browser.
 */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0].trim().toLowerCase();
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch (_) {
    return false;
  }
}

// ── Best-effort per-IP rate limit ─────────────────────────────────────────────
// In-memory sliding window. On serverless this is per warm instance, so it is a
// speed bump against accidental loops and casual abuse — NOT a hard quota. For a
// hard limit, add a Vercel Firewall rate-limit rule on /api/voice/* (see
// AI_HANDOFF.md).
const _hits = new Map(); // key → number[] (timestamps, ms)

function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || "unknown";
}

function isRateLimited(req, bucket, limit, windowMs) {
  const now = Date.now();
  const key = `${bucket}:${clientIp(req)}`;
  const recent = (_hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    _hits.set(key, recent);
    return true;
  }
  recent.push(now);
  _hits.set(key, recent);
  if (_hits.size > 5000) {
    // Keep memory bounded: drop entries whose newest hit is outside the window.
    for (const [k, arr] of _hits) {
      if (!arr.length || now - arr[arr.length - 1] >= windowMs) _hits.delete(k);
    }
  }
  return false;
}

/** Trim + length-cap a value that must be a string. */
function cleanStr(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
}

module.exports = { sendJson, readRawBody, isSameOrigin, isRateLimited, cleanStr };
