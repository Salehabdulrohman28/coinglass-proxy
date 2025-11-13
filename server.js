// server.js (ES module)
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const COINGLASS_API_KEY = process.env.API_KEY || process.env.COINGLASS_API_KEY || "";
const BASE_URL_OVERRIDE = process.env.BASE_URL || ""; // optional override

// helper fetch wrapper (timeout)
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, ...opts });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function jsonError(res, code = 500, msg = "Internal error") {
  return res.status(code).json({ code, msg, success: false });
}

// health
app.get("/healthz", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// funding endpoint (proxy)
app.get("/funding", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "BTC").toUpperCase();
    // If you want to use your own base URL (render service) you can set BASE_URL_OVERRIDE
    // but for proxied calls to coinglass, we call their official endpoint:
    // Replace with the correct coinglass endpoint you have access to.
    // Example below uses what many use for coinglass open-api (may require API key)
    const url = `https://open-api.coinglass.com/api/pro/v1/futures/funding?symbol=${encodeURIComponent(symbol)}`;

    const headers = {};
    if (COINGLASS_API_KEY) headers["coinglassSecret"] = COINGLASS_API_KEY;

    const upstream = await fetchWithTimeout(url, { headers }, 15000);

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return jsonError(res, 502, `Upstream returned ${upstream.status} ${upstream.statusText}: ${text}`);
    }

    const data = await upstream.json().catch(() => null);
    if (!data) return jsonError(res, 502, "Invalid JSON from upstream");

    return res.json({ code: 0, success: true, data });
  } catch (e) {
    if (e.name === "AbortError") return jsonError(res, 504, "Upstream timeout");
    console.error("funding error:", e);
    return jsonError(res, 500, e.message || "Unknown error");
  }
});

// open interest endpoint
app.get("/oi", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "BTC").toUpperCase();
    const url = `https://open-api.coinglass.com/api/pro/v1/futures/open_interest?symbol=${encodeURIComponent(symbol)}`;
    const headers = {};
    if (COINGLASS_API_KEY) headers["coinglassSecret"] = COINGLASS_API_KEY;

    const upstream = await fetchWithTimeout(url, { headers }, 15000);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return jsonError(res, 502, `Upstream returned ${upstream.status} ${upstream.statusText}: ${text}`);
    }
    const data = await upstream.json().catch(() => null);
    if (!data) return jsonError(res, 502, "Invalid JSON from upstream");

    return res.json({ code: 0, success: true, data });
  } catch (e) {
    if (e.name === "AbortError") return jsonError(res, 504, "Upstream timeout");
    console.error("oi error:", e);
    return jsonError(res, 500, e.message || "Unknown error");
  }
});

app.listen(PORT, () => {
  console.log(`Coinglass Proxy Running on Port ${PORT}`);
  console.log("Available endpoints: /funding /oi /healthz");
});
