// server.js (update) — simple proxy to Coinglass v4
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
// support either environment names (change to whatever you set in Render)
const API_KEY = process.env.CG_API_KEY || process.env.API_KEY || process.env.coinglass || "";

if (!API_KEY) {
  console.warn("WARNING: No Coinglass API key found in env (CG_API_KEY / API_KEY / coinglass)");
}

// helper to call coinglass v4 endpoints
async function callCoinglass(path, params = "") {
  const base = "https://open-api-v4.coinglass.com";
  const url = base + path + (params ? ("?" + params) : "");
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "accept": "application/json",
      "CG-API-KEY": API_KEY
    },
    timeout: 10000
  });
  const txt = await resp.text();
  try {
    return JSON.parse(txt);
  } catch (e) {
    // return raw text if not JSON
    return { raw: txt, status: resp.status };
  }
}

// === Funding Rate endpoint (aggregated by exchange) ===
// Example: /funding?symbol=BTC
app.get("/funding", async (req, res) => {
  const symbol = (req.query.symbol || "BTC").toUpperCase();
  try {
    // v4 endpoint: futures funding rate exchange list (supports symbol param)
    const out = await callCoinglass("/api/futures/funding-rate/exchange-list", `symbol=${encodeURIComponent(symbol)}`);
    return res.json(out);
  } catch (e) {
    console.error("funding proxy error:", e);
    return res.status(500).json({ error: "Proxy Error", detail: e.message });
  }
});

// === Open Interest endpoint (aggregated by exchange) ===
// Example: /oi?symbol=BTC
app.get("/oi", async (req, res) => {
  const symbol = (req.query.symbol || "BTC").toUpperCase();
  try {
    // v4 endpoint: futures open interest exchange list
    const out = await callCoinglass("/api/futures/open-interest/exchange-list", `symbol=${encodeURIComponent(symbol)}`);
    return res.json(out);
  } catch (e) {
    console.error("oi proxy error:", e);
    return res.status(500).json({ error: "Proxy Error", detail: e.message });
  }
});

// simple root
app.get("/", (req, res) => res.send("Coinglass proxy (v4) running"));

app.listen(PORT, () => {
  console.log("Coinglass Proxy Running on Port", PORT);
});
