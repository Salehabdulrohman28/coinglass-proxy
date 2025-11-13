// server.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || "";
const BASE_URL = process.env.BASE_URL || "https://open-api-v4.coinglass.com";
const CACHE_TTL_MS = 30 * 1000; // 30s

if (!COINGLASS_API_KEY) {
  console.error("WARNING: COINGLASS_API_KEY not set in env!");
}

const cache = new Map();

function now() { return Date.now(); }

async function fetchWithRetry(url, opts = {}, attempts = 3, backoff = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch(e) { body = text; }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return body;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, backoff * (i+1)));
    }
  }
  throw lastErr;
}

app.get("/", (req, res) => res.json({ ok: true, msg: "coinglass-proxy alive" }));

app.get("/funding", async (req, res) => {
  const symbol = (req.query.symbol || process.env.SYMBOL || "BTC").toUpperCase();
  const cacheKey = `funding:${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached && (now() - cached.ts) < CACHE_TTL_MS) {
    return res.json({ code: 0, fromCache: true, data: cached.body });
  }

  const headers = { "CG-API-KEY": COINGLASS_API_KEY, "Accept": "application/json" };
  const primary = `${BASE_URL}/api/futures/funding-rate/history?symbol=${encodeURIComponent(symbol)}&limit=1`;

  // fallback endpoints to try if primary fails
  const fallbacks = [
    primary,
    `${BASE_URL}/api/pro/v1/futures/funding?symbol=${encodeURIComponent(symbol)}`,
    // add more variations if needed
  ];

  let lastErr = null;
  const opts = { method: "GET", headers };

  try {
    for (const u of fallbacks) {
      try {
        const data = await fetchWithRetry(u, opts, 3);
        cache.set(cacheKey, { ts: now(), body: data });
        return res.json({ code: 0, fromCache: false, data, urlUsed: u });
      } catch (err) {
        console.error("Fetch attempt failed for", u, { message: err.message, status: err.status, body: err.body });
        lastErr = err;
        // try next fallback
      }
    }

    // all fallbacks failed
    if (cached) {
      return res.json({ code: "cached", fromCache: true, data: cached.body, note: "upstream failed" });
    }
    const detail = lastErr ? (lastErr.body ?? lastErr.message) : "unknown";
    return res.status(502).json({ error: "Upstream failed and no cache", detail });
  } catch (err) {
    console.error("Unexpected proxy error:", err);
    return res.status(500).json({ error: "Internal proxy error", message: err.message });
  }
});

// healthz
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(PORT, ()=> {
  console.log(`CoinGlass Proxy Running on Port ${PORT}`);
  console.log("Available endpoints: /funding /healthz");
});
