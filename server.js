// server.js — versi FIX TOTAL

import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;

// URL CoinGlass Resmi (v4)
const COINGLASS_BASE = "https://open-api-v4.coinglass.com";

// API KEY (HARUS DIISI DI ENV)
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || "";

// Mapping endpoint proxy
const mapping = {
  "/funding": "/api/pro/v1/futures/funding",                          // funding current
  "/funding-history": "/api/pro/v1/futures/funding-rate/history",     // funding history
  "/funding-rate": "/api/pro/v1/futures/funding-rate",                // funding rate endpoint (if ada)
  "/oi": "/api/pro/v1/futures/openInterest",                          // open interest
  "/healthz": "/api/pro/v1/healthz"                                   // health check
};

// Build URL lengkap ke CoinGlass
function buildUrl(path, qs = "") {
  const upstream = MAP[path] || path;

  const url =
    COINGLASS_BASE +
    upstream +
    (qs.startsWith("?") ? qs : qs ? `?${qs}` : "");

  return url;
}

// Request ke upstream CoinGlass
async function upstreamFetch(path, qs = "") {
  const url = buildUrl(path, qs);

  const headers = {
    accept: "application/json",
    "CG-API-KEY": COINGLASS_API_KEY,
    "User-Agent": "coinglass-proxy/1.0"
  };

  const res = await fetch(url, { headers });

  const contentType = res.headers.get("content-type") || "";

  if (!res.ok) {
    const bodyText = await res.text();
    return {
      ok: false,
      status: res.status,
      message: bodyText,
      url
    };
  }

  if (contentType.includes("application/json")) {
    return {
      ok: true,
      data: await res.json(),
      url
    };
  }

  return {
    ok: true,
    data: await res.text(),
    url
  };
}

// =========================
// ENDPOINT PROXY
// =========================
app.get("/:type", async (req, res) => {
  const type = "/" + req.params.type;
  const qs = req.url.includes("?") ? req.url.split("?")[1] : "";

  console.log("INCOMING:", type, "qs:", qs);

  const result = await upstreamFetch(type, qs);

  if (!result.ok) {
    return res.status(500).json({
      success: false,
      error: result.message,
      upstream_status: result.status,
      url: result.url
    });
  }

  res.json(result.data);
});

// Health
app.get("/", (req, res) => {
  res.send("CoinGlass Proxy is running");
});

app.listen(PORT, () => {
  console.log("===========================================");
  console.log(" CoinGlass Proxy Running on Port", PORT);
  console.log(" Available:", "/funding /oi /funding-history /healthz");
  console.log("===========================================");
});

