// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.COINGLASS_API_KEY || "";
// primary upstream (example). Adjust if Coinglass docs require different path.
const COINGLASS_BASE = "https://open-api.coinglass.com";

let cache = {
  funding: {},
  oi: {}
};

// generic fetch with retry/backoff
async function fetchWithRetry(url, options = {}, attempts = 3, backoff = 500) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
      return { ok: res.ok, status: res.status, json, url };
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, backoff * (i + 1)));
    }
  }
}

// helper to call coinglass funding endpoint
async function getFunding(symbol = "BTC") {
  // try pro endpoint first, then fallback
  const endpoints = [
    `${COINGLASS_BASE}/api/pro/v1/futures/funding?symbol=${encodeURIComponent(symbol)}`,
    `${COINGLASS_BASE}/api/futures/funding?symbol=${encodeURIComponent(symbol)}`,
    `${COINGLASS_BASE}/api/v1/futures/funding?symbol=${encodeURIComponent(symbol)}`
  ];
  const headers = API_KEY ? { "coinglassSecret": API_KEY } : {};
  for (const url of endpoints) {
    try {
      const r = await fetchWithRetry(url, { headers }, 3, 500);
      if (r.ok) {
        // store last good
        cache.funding[symbol] = { ts: Date.now(), data: r.json };
        return { success: true, status: r.status, data: r.json, url };
      } else {
        // return json even when not ok so caller can examine
        if (r.json && r.json.success === false) {
          // keep trying next endpoint
        } else {
          // keep trying others
        }
      }
    } catch (err) {
      // try next endpoint
    }
  }
  // all endpoints failed -> return last cached if available
  if (cache.funding[symbol]) {
    return { success: false, status: 200, data: cache.funding[symbol].data, cached: true };
  }
  return { success: false, status: 502, data: { error: "Upstream failed and no cache" } };
}

async function getOI(symbol = "BTC") {
  const endpoints = [
    `${COINGLASS_BASE}/api/pro/v1/futures/oi?symbol=${encodeURIComponent(symbol)}`,
    `${COINGLASS_BASE}/api/futures/open_interest?symbol=${encodeURIComponent(symbol)}`
  ];
  const headers = API_KEY ? { "coinglassSecret": API_KEY } : {};
  for (const url of endpoints) {
    try {
      const r = await fetchWithRetry(url, { headers }, 3, 500);
      if (r.ok) {
        cache.oi[symbol] = { ts: Date.now(), data: r.json };
        return { success: true, status: r.status, data: r.json, url };
      }
    } catch (err) {}
  }
  if (cache.oi[symbol]) {
    return { success: false, status: 200, data: cache.oi[symbol].data, cached: true };
  }
  return { success: false, status: 502, data: { error: "Upstream failed and no cache" } };
}

// routes
app.get("/funding", async (req, res) => {
  const symbol = (req.query.symbol || "BTC").toUpperCase();
  try {
    const result = await getFunding(symbol);
    res.status(result.success ? 200 : (result.status || 502)).json(result.data);
  } catch (err) {
    res.status(502).json({ error: "proxy_error", message: String(err) });
  }
});

app.get("/oi", async (req, res) => {
  const symbol = (req.query.symbol || "BTC").toUpperCase();
  try {
    const result = await getOI(symbol);
    res.status(result.success ? 200 : (result.status || 502)).json(result.data);
  } catch (err) {
    res.status(502).json({ error: "proxy_error", message: String(err) });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log("Coinglass Proxy Running on Port", PORT);
  console.log("Available endpoints: /funding /oi /healthz");
});
