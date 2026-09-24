/**
 * sw.js — service worker for the installable Customer Panel PWA
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] New file. Served from the site ROOT so its scope covers
 * "/" and "/t/:n".
 *
 * Deliberately conservative — this is a LIVE ordering app (Firestore realtime,
 * order status, a menu that changes daily), so a stale cache is worse than none:
 *
 *   • NETWORK-FIRST for the page, /js, /css, /icons and the manifest. When the
 *     customer is online they ALWAYS get the freshest deploy; the cache is only
 *     a fallback for when the network fails. (No stale-while-revalidate: with ES
 *     modules that can mix an old app.js with a new order.js.)
 *   • Everything else passes straight through untouched: Firebase / Firestore /
 *     Auth / Cloud Functions, gstatic SDK files, /api/* (voice), the Worker,
 *     every non-GET request (including the HEAD used for trusted time).
 *   • The offline shell is cached ONLY from a plain "/" response — never from
 *     /t/:n, because the dev server injects window.__TABLE_ID__ into those pages
 *     and replaying one for another table would fake a table session.
 *
 * Bump VERSION to force old caches to be dropped on the next activation.
 */

const VERSION = "v2";
const CACHE   = `nph-customer-${VERSION}`;

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#1A1E29"/><title>Offline</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#0f0f0f;color:#f0f0f0;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px;text-align:center}
.card{background:#222;border:1px solid #333;border-radius:24px;padding:40px 28px;max-width:360px;width:100%}
.i{font-size:52px;margin-bottom:16px}h1{font-size:21px;font-weight:800;margin-bottom:10px}
p{font-size:14px;color:#aaa;line-height:1.6;margin-bottom:22px}
button{background:#f5a623;color:#1a1a1a;border:0;border-radius:999px;padding:12px 28px;font-size:15px;font-weight:800;cursor:pointer}
</style></head><body><div class="card"><div class="i">📡</div><h1>You're offline</h1>
<p>Please check your internet connection. Your table, login and cart are safe.</p>
<button onclick="location.reload()">Try again</button></div></body></html>`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("nph-customer-") && k !== CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

function isStaticAsset(url) {
  const p = url.pathname;
  return p.startsWith("/js/") || p.startsWith("/css/") || p.startsWith("/icons/") ||
         p === "/manifest.webmanifest";
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                    // POST / HEAD / etc. → untouched
  if (req.headers.has("range")) return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // Firebase, gstatic, Worker, CDNs → untouched
  if (url.pathname.startsWith("/api/")) return;        // voice API → untouched
  if (url.pathname === "/sw.js") return;

  // ── Page navigations ───────────────────────────────────────────────────────
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && !res.redirected && url.pathname === "/") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy)).catch(() => {});
        }
        return res;
      } catch (_) {
        const cache = await caches.open(CACHE);
        const shell = await cache.match("/");
        return shell || new Response(OFFLINE_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    })());
    return;
  }

  // ── Same-origin app files: network-first, cache only as an offline fallback ─
  if (isStaticAsset(url)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (err) {
        const hit = await caches.match(req);
        if (hit) return hit;
        throw err;
      }
    })());
  }
  // anything else → default browser handling
});
