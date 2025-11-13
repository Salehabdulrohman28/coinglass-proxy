// server.js
import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || "";
const BASE = process.env.CG_BASE || "https://open-api-v4.coinglass.com"; // official v4 base

if (!COINGLASS_API_KEY) {
  console.error("ERROR: COINGLASS_API_KEY is not set in env");
  process.exit(1);
}

// simple in-memory cache for endpoints: { key: { ts, body } }
const cache = new Map();
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 60_000); // 60s default

async function fetchWithRetry(url, opts = {}, maxAttempts = 3) {
  let attempt = 0;
  let backoff = 500;
  while (attempt < maxAttempts) {
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      // try parse as json
      let data;
      try { data = JSON.parse(text); } catch(e){ data = text; }
      if (!res.ok) {
        // non 2xx => throw so caller handles / retry
        const err = new Error(`Upstream ${res.status} ${res.statusText}`);
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts) throw err;
      await new Promise(r => setTimeout(r, backoff));
      backoff *= 2;
    }
  }
}

app.get("/funding", async (req, res) => {
  const symbol = (req.query.symbol || "").toUpperCase();
  if (!symbol) return res.status(400).json({ error: "missing symbol" });

  const path = `/api/futures/funding-rate/history?symbol=${encodeURIComponent(symbol)}&limit=1`;
  const url = `${BASE}${path}`;
  const cacheKey = `funding:${symbol}`;

  // Return cached if fresh
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return res.json({ code: 0, fromCache: true, data: cached.body });
  }

  const opts = {
    method: "GET",
    headers: {
      "accept": "application/json",
      "CG-API-KEY": COINGLASS_API_KEY
    },
    timeout: 10_000
  };

  try {
    const data = await fetchWithRetry(url, opts, 3);
    // cache if looks valid
    cache.set(cacheKey, { ts: Date.now(), body: data });
    return res.json({ code: 0, fromCache: false, data });
  } catch (err) {
    console.error("Upstream error:", err.status ?? err.message, err.body ?? "");
    // if we have any cache return it (best-effort)
    if (cached) {
      return res.json({ code: "cached", fromCache: true, data: cached.body, note: "upstream failed" });
    }
    // No cache => return error to caller
    const status = err.status || 502;
    return res.status(502).json({ error: "Upstream failed and no cache", detail: err.body ?? err.message });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CoinGlass Proxy running on Port ${PORT}`);
  console.log(`Available endpoints: /funding?symbol=BTC  /healthz`);
});
