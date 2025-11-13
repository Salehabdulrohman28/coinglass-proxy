// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.COINGLASS_API_KEY || process.env.API_KEY || "";
if (!API_KEY) {
  console.warn("Warning: COINGLASS_API_KEY not set — proxy requests will likely be rejected by Coinglass.");
}

// Simple in-memory cache
const cache = new Map(); // key -> { ts, ttl, data }
const DEFAULT_TTL_MS = 15 * 1000; // 15 sec (ubah kalau perlu)

function getCache(key) {
  const rec = cache.get(key);
  if (!rec) return null;
  if (Date.now() - rec.ts > rec.ttl) {
    cache.delete(key);
    return null;
  }
  return rec.data;
}
function setCache(key, data, ttl = DEFAULT_TTL_MS) {
  cache.set(key, { ts: Date.now(), ttl, data });
}

// Helper to call Coinglass
async function callCoinglass(url) {
  const headers = {};
  if (API_KEY) headers["coinglassSecret"] = API_KEY;

  const resp = await fetch(url, { headers, method: "GET" });
  const text = await resp.text();

  // try parse JSON (some endpoints return JSON)
  try {
    return { status: resp.status, body: JSON.parse(text) };
  } catch (e) {
    return { status: resp.status, body: text };
  }
}

// -- Endpoints --
// 1) /funding?symbol=BTC
app.get("/funding", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "BTC").toString().toUpperCase();
    const cacheKey = `funding:${symbol}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    // Coinglass funding endpoint (pro v1)
    const url = `https://open-api.coinglass.com/api/pro/v1/futures/funding?symbol=${encodeURIComponent(symbol)}`;

    const { status, body } = await callCoinglass(url);

    // store in cache (short TTL)
    setCache(cacheKey, body, DEFAULT_TTL_MS);

    return res.status(status >= 200 && status < 300 ? 200 : status).json(body);
  } catch (err) {
    console.error("Error /funding:", err);
    return res.status(500).json({ error: "proxy error", detail: err?.message || err });
  }
});

// 2) /oi?symbol=BTC
app.get("/oi", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "BTC").toString().toUpperCase();
    const cacheKey = `oi:${symbol}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    // Coinglass open interest endpoint (pro v1)
    // Note: endpoint paths change across Coinglass versions; sesuaikan jika perlu
    const url = `https://open-api.coinglass.com/api/pro/v1/futures/openInterest?symbol=${encodeURIComponent(symbol)}`;

    const { status, body } = await callCoinglass(url);

    setCache(cacheKey, body, DEFAULT_TTL_MS);

    return res.status(status >= 200 && status < 300 ? 200 : status).json(body);
  } catch (err) {
    console.error("Error /oi:", err);
    return res.status(500).json({ error: "proxy error", detail: err?.message || err });
  }
});

// Health
app.get("/healthz", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Root - quick info
app.get("/", (req, res) => {
  res.send(
    `<pre>Coinglass proxy running\nEndpoints:\n/funding?symbol=BTC\n/oi?symbol=BTC\nHealth: /healthz\nCacheTTL(ms): ${DEFAULT_TTL_MS}</pre>`
  );
});

app.listen(PORT, () => {
  console.log(`Coinglass Proxy Running on Port ${PORT}`);
  console.log(`Available endpoints: /funding /oi /healthz`);
});
