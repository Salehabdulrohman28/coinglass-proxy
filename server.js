// server.js (replace whole file)
import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;

// Default upstream CoinGlass base (v4)
const COINGLASS_BASE = process.env.COINGLASS_BASE_URL || "https://open-api-v4.coinglass.com";
// Your CoinGlass API key (if you want proxy to call CoinGlass directly)
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || "";

function buildUpstreamUrl(path, qs = "") {
  // ensure path starts with /
  const p = path.startsWith("/") ? path : `/${path}`;

  // mapping short proxy paths to official CoinGlass API paths (v4)
const mapping = {
  "/funding": "/api/pro/v1/futures/funding-rate",
  "/funding-history": "/api/pro/v1/futures/funding-rate/history",
  "/oi": "/api/pro/v1/futures/openInterest",
  "/healthz": "/api/pro/v1/healthz"
};



  // pick upstream path
  const upstreamPath = mapping[p] || p;

  // query string
  const qsPart = qs ? (qs.startsWith("?") ? qs : `?${qs}`) : "";

  // ensure base has no trailing slash
  const base = COINGLASS_BASE.replace(/\/+$/, "");

  return `${base}${upstreamPath}${qsPart}`;
}

async function fetchUpstream(path, qs = "") {
  const url = buildUpstreamUrl(path, qs);
  const headers = {
    "accept": "application/json",
  };
  if (COINGLASS_API_KEY) headers["CG-API-KEY"] = COINGLASS_API_KEY;
  // --- debug logging (temporary) ---
  console.log("DEBUG -> fetchUpstream:");
  console.log("  url:", url);
  console.log("  headers:", headers);
  // --- end debug logging ---

  const res = await fetch(url, { method: "GET", headers, redirect: "follow" });
  const contentType = res.headers.get("content-type") || "";
  console.log("DEBUG -> upstream response status:", res.status);
  const ct = res.headers.get("content-type") || "";
  console.log("DEBUG -> upstream contentType:", ct);

  // only read small preview for debugging if not JSON parse attempt
  const preview = await res.text().catch(() => "");
  console.log("DEBUG -> upstream body (preview):", preview.slice(0, 500));

  if (!res.ok) {
    // try to get text for debugging
    const text = await res.text().catch(() => "");
    throw { status: res.status, body: text, contentType };
  }

  // if response is JSON, parse it, otherwise return text
  if (contentType.includes("application/json")) {
    const json = await res.json();
    return json;
  } else {
    const text = await res.text();
    return { raw: text, contentType };
  }
}

// Simple proxy endpoints you need
app.get("/funding", async (req, res) => {
  try {
    const symbol = req.query.symbol || req.query.s || "BTC";
    // Example upstream path: /api/futures/funding
    const data = await fetchUpstream("/api/futures/funding", `symbol=${encodeURIComponent(symbol)}`);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("Upstream error:", err);
    // return structured error so monitor can handle nicely
    return res.status(err.status || 502).json({
      success: false,
      upstream_status: err.status || 502,
      upstream_ok: !!(err.status && err.status >= 200 && err.status < 300),
      message: err.body || "Upstream failed and no cache",
      contentType: err.contentType || null
    });
  }
});

app.get("/oi", async (req, res) => {
  try {
    const symbol = req.query.symbol || "BTC";
    const data = await fetchUpstream("/api/futures/open_interest", `symbol=${encodeURIComponent(symbol)}`);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("Upstream error:", err);
    return res.status(err.status || 502).json({
      success: false,
      upstream_status: err.status || 502,
      message: err.body || "Upstream failed"
    });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`Coinglass Proxy Running on Port ${PORT}`);
  console.log("Available endpoints: /funding /oi /healthz");
  console.log(`COINGLASS_BASE=${COINGLASS_BASE}`);
});




