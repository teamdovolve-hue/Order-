const express  = require("express");
const fetch    = require("node-fetch");
const path     = require("path");

const app  = express();
const PORT = 5000;
const FAST2SMS_KEY = "x0v38I3oRTe1UpDhCMbpbeT86z5bNJPYmu0E4FQ9g1MirVJh6Gp9Hkm0uuW8";

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
    const url = `https://www.fast2sms.com/dev/otp/send?otp=${otp}&mobile_number=${phone}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "authorization": FAST2SMS_KEY,
        "Content-Type": "application/json",
      },
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("[send-otp] Fast2SMS error:", err.message);
    res.json({ return: false, message: "Could not reach SMS service. Try again." });
  }
});

// ── Serve static files ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// SPA fallback
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
