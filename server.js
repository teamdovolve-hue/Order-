const express        = require("express");
const fetch          = require("node-fetch");
const path           = require("path");
const fs             = require("fs");

const app         = express();
const PORT        = 5000;
const TOTAL_TABLES = 10;
const FAST2SMS_KEY = "x0v38I3oRTe1UpDhCMbpbeT86z5bNJPYmu0E4FQ9g1MirVJh6Gp9Hkm0uuW8";

// ── Cache index.html in memory (re-read on change in dev) ─────────────────────
function readIndex() {
  return fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
}

// ── Error pages ───────────────────────────────────────────────────────────────
function invalidQRPage(raw) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta name="theme-color" content="#1A1E29"/>
  <title>Invalid QR Code</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      min-height:100dvh;display:flex;align-items:center;justify-content:center;
      background:#1A1E29;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      padding:24px;text-align:center;
    }
    .card{
      background:#242838;border:1px solid rgba(255,255,255,0.08);
      border-radius:20px;padding:40px 32px;max-width:360px;width:100%;
    }
    .icon{font-size:56px;margin-bottom:20px}
    h1{font-size:22px;font-weight:800;margin-bottom:10px;color:#fff}
    p{font-size:14px;color:rgba(255,255,255,0.55);line-height:1.6;margin-bottom:8px}
    .code{
      margin-top:20px;padding:8px 16px;border-radius:8px;
      background:rgba(255,255,255,0.05);font-size:12px;color:rgba(255,255,255,0.3);
      font-family:monospace;display:inline-block;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🚫</div>
    <h1>Invalid QR Code</h1>
    <p>This QR code is not recognised.</p>
    <p>Please scan the QR code printed on your table to place an order.</p>
    <div class="code">Table not found: ${String(raw).slice(0, 20)}</div>
  </div>
</body>
</html>`;
}

function scanQRPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta name="theme-color" content="#1A1E29"/>
  <title>Scan QR Code</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      min-height:100dvh;display:flex;align-items:center;justify-content:center;
      background:#1A1E29;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      padding:24px;text-align:center;
    }
    .card{
      background:#242838;border:1px solid rgba(255,255,255,0.08);
      border-radius:20px;padding:40px 32px;max-width:360px;width:100%;
    }
    .icon{font-size:56px;margin-bottom:20px}
    h1{font-size:22px;font-weight:800;margin-bottom:10px;color:#fff}
    p{font-size:14px;color:rgba(255,255,255,0.55);line-height:1.6}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📷</div>
    <h1>Scan Your Table QR</h1>
    <p>Please scan the QR code printed on your table to view the menu and place an order.</p>
  </div>
</body>
</html>`;
}

// ── Send OTP proxy endpoint ───────────────────────────────────────────────────
app.get("/api/send-otp", async (req, res) => {
  const { phone, otp } = req.query;

  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.json({ return: false, message: "Invalid phone number." });
  }
  if (!otp || !/^\d{6}$/.test(otp)) {
    return res.json({ return: false, message: "Invalid OTP." });
  }

  try {
    const url = `https://www.fast2sms.com/dev/bulkV2?authorization=${FAST2SMS_KEY}&route=otp&variables_values=${otp}&numbers=${phone}`;
    const response = await fetch(url, { method: "GET" });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("[send-otp] Fast2SMS error:", err.message);
    res.json({ return: false, message: "Could not reach SMS service. Try again." });
  }
});

// ── /t/:n — QR table entry point (server-validated) ──────────────────────────
//
//   Valid:   /t/1  …  /t/10
//   Invalid: /t/0, /t/11, /t/abc  → 400 error page
//
//   The validated table number is injected as window.__TABLE_ID__ (integer)
//   directly into the served HTML so the frontend never needs to parse the URL.
//   A <base href="/"> tag is also injected so all relative asset paths (css/,
//   js/) continue to resolve correctly even though the page URL is /t/:n.

app.get("/t/:n", (req, res) => {
  const raw = req.params.n;
  const n   = parseInt(raw, 10);

  // Reject: non-integer, out of range, or sneaky inputs like "1abc"
  if (!Number.isInteger(n) || n < 1 || n > TOTAL_TABLES || String(n) !== raw) {
    return res.status(400).send(invalidQRPage(raw));
  }

  try {
    const html = readIndex();
    // Inject the validated table number before </head>.
    // <base href="/"> is already in index.html so no duplicate needed here.
    // window.__TABLE_ID__ is a safe integer literal — no XSS risk.
    const injected = html
      .replace("</head>", `  <script>window.__TABLE_ID__ = ${n};</script>\n</head>`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(injected);
  } catch (err) {
    console.error("[t/:n] Failed to read index.html:", err.message);
    res.status(500).send("Server error. Please try again.");
  }
});

// ── Root — remind customer to scan their table QR ────────────────────────────
app.get("/", (req, res) => {
  res.status(200).send(scanQRPage());
});

// ── Serve static assets (js/, css/, images, etc.) ────────────────────────────
//   index:false prevents express.static from auto-serving index.html for /,
//   which would bypass the scanQRPage() handler above.
app.use(express.static(path.join(__dirname), { index: false }));

// ── Catch-all — invalid path ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send(invalidQRPage(req.path));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Tables:  /t/1  …  /t/${TOTAL_TABLES}`);
});
