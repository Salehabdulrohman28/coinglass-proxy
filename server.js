// FILE: server.js
// Usage: replace your existing server.js with this file (ESM style)
// Node 18+ recommended. Ensure package.json has "type":"module" or use ESM in render.

import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;

// Config (via env)
const COINGLASS_BASE = process.env.COINGLASS_BASE || "https://open-api-v4.coinglass.com"; // v4 base
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || ""; // your API key (optional but recommended)

// Mapping of friendly proxy paths -> official CoinGlass v4 paths
const MAPPING = {
  "/funding": "/api/futures/funding",
  "/funding-history": "/api/futures/funding-rate/history",
  "/funding-rate-history": "/api/futures/funding-rate/history",
  "/oi": "/api/futures/open-interest",
  "/healthz": "/api/futures/healthz"
};

function ensureLeadingSlash(p) {
  if (!p) return "/";
  return p.startsWith("/") ? p : `/${p}`;
}

function buildUpstreamUrl(path, qs = "") {
  const p = ensureLeadingSlash(path);
  const upstreamPath = MAPPING[p] || p; // prefer mapping if exists
  const base = COINGLASS_BASE.replace(/\/+$/g, "");
  const qsPart = qs ? (qs.startsWith("?") ? qs : `?${qs}`) : "";
  return `${base}${upstreamPath}${qsPart}`;
}

async function fetchUpstream(path, qs = "") {
  const url = buildUpstreamUrl(path, qs);
  const headers = { accept: "application/json" };
  if (COINGLASS_API_KEY) headers["CG-API-KEY"] = COINGLASS_API_KEY;

  const res = await fetch(url, { method: "GET", headers, redirect: "follow" });
  const contentType = res.headers.get("content-type") || "";

  // try to parse body as text always (for debugging)
  const bodyText = await res.text().catch(() => "");

  // if JSON, try parse
  let body = bodyText;
  if (contentType.includes("application/json")) {
    try { body = JSON.parse(bodyText); } catch (e) { /* keep text */ }
  }

  return {
    ok: res.ok,
    status: res.status,
    contentType,
    url,
    body,
    bodyPreview: typeof body === "string" ? body.slice(0, 1000) : JSON.stringify(body).slice(0, 1000)
  };
}

// Simple JSON proxy endpoints (safe list)
const ALLOWED = ["/funding", "/funding-history", "/oi", "/healthz"];

app.get("/", (req, res) => {
  res.type("json").send({ ok: true, message: "CoinGlass proxy is running" });
});

app.get("/:proxyPath", async (req, res) => {
  try {
    const p = `/${req.params.proxyPath}`;
    if (!ALLOWED.includes(p)) {
      return res.status(404).json({ success: false, message: "Proxy path not allowed" });
    }

    const qs = Object.keys(req.query).length ? new URLSearchParams(req.query).toString() : "";
    const upstream = await fetchUpstream(p, qs);

    if (!upstream.ok) {
      // return structured error for monitor to display
      return res.status(502).json({
        success: false,
        upstream_status: upstream.status,
        upstream_ok: upstream.ok,
        message: upstream.body || upstream.bodyPreview || "upstream error",
        url: upstream.url,
        contentType: upstream.contentType,
      });
    }

    // On success, forward parsed JSON if available, otherwise raw text
    return res.status(200).type(upstream.contentType || "application/json").send(upstream.body);
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Health check for Render
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`CoinGlass Proxy Running on Port ${PORT}`);
  console.log(`COINGLASS_BASE=${COINGLASS_BASE}`);
  console.log(`Available endpoints: ${ALLOWED.join(' ')}`);
});


// ---------------------------------------------------------------------------
// FILE: monitor.js
// Usage: this script runs as a background worker that polls the proxy endpoints
// and posts messages to Discord webhook when data updates or when errors occur.
// Put this file in your project and run with `node monitor.js` (or create a Render worker service)

import fetch from 'node-fetch';

const BASE_URL = process.env.BASE_URL || process.env.BASE_URL_PROXY || process.env.BASE_URL_PROX || process.env.COINGLASS_PROXY_URL || process.env.BASE_URL || '';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const SYMBOL = process.env.SYMBOL || 'BTC';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10); // default 30s
const CONSECUTIVE_THRESHOLD = parseInt(process.env.CONSECUTIVE_THRESHOLD || '2', 10);

if (!BASE_URL) console.warn('Warning: BASE_URL is empty. Set env BASE_URL to your proxy base URL (https://xxx.onrender.com)');
if (!DISCORD_WEBHOOK) console.warn('Warning: DISCORD_WEBHOOK not set. Alerts will not be sent to Discord.');

let consecutiveErrors = 0;
let lastFundingValue = null; // simple dedupe
let lastSentHash = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function discordSend(content, embed) {
  if (!DISCORD_WEBHOOK) return;
  try {
    const payload = embed ? { content, embeds: [embed] } : { content };
    await fetch(DISCORD_WEBHOOK, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Discord send failed', e.message);
  }
}

function makeHash(obj) { try { return JSON.stringify(obj); } catch(e) { return String(obj); } }

async function fetchProxy(path, qs = '') {
  const url = `${BASE_URL}${path}${qs ? (qs.startsWith('?') ? qs : `?${qs}`) : ''}`;
  try {
    const res = await fetch(url, { method: 'GET' });
    const text = await res.text().catch(() => '');
    let body = text;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { body = JSON.parse(text); } catch(e) { /* keep as text */ }
    }
    return { ok: res.ok, status: res.status, body, url, contentType: ct };
  } catch (err) {
    return { ok: false, status: 0, body: err.message || 'fetch error', url };
  }
}

async function pollOnce() {
  // try funding endpoint first
  const path = '/funding-history';
  const qs = `?symbol=${encodeURIComponent(SYMBOL)}&limit=1`;
  const result = await fetchProxy(path, qs);

  if (!result.ok) {
    console.warn('Funding fetch error:', result.status, result.body);
    consecutiveErrors++;

    // notify only after threshold reached
    if (consecutiveErrors >= CONSECUTIVE_THRESHOLD) {
      const embed = {
        title: 'Monitor error: funding fetch failed',
        description: `Status: ${result.status} -> ${typeof result.body === 'string' ? result.body : JSON.stringify(result.body)}`,
        fields: [ { name: 'symbol', value: SYMBOL, inline: true }, { name: 'url', value: result.url, inline: false } ],
        timestamp: new Date().toISOString()
      };
      await discordSend(null, embed);
    }
    return;
  }

  consecutiveErrors = 0; // reset

  // if success, parse value(s) and send alert if changed
  const body = result.body;
  // supporting several body shapes: array, object...
  let fundingVal = null;
  if (Array.isArray(body) && body.length) {
    fundingVal = body[0];
  } else if (body && typeof body === 'object') {
    // some endpoints return {data: [...]}
    if (Array.isArray(body.data) && body.data.length) fundingVal = body.data[0];
    else fundingVal = body;
  } else {
    fundingVal = body; // fallback
  }

  const hash = makeHash(fundingVal);
  if (hash !== lastSentHash) {
    lastSentHash = hash;
    const embed = {
      title: 'Funding update',
      description: `Symbol: ${SYMBOL}`,
      fields: [ { name: 'result_preview', value: typeof fundingVal === 'string' ? fundingVal.slice(0,200) : JSON.stringify(fundingVal).slice(0,1000) } ],
      timestamp: new Date().toISOString()
    };
    await discordSend(null, embed);
  } else {
    console.log('No change for', SYMBOL);
  }
}

async function mainLoop() {
  while (true) {
    try {
      await pollOnce();
    } catch (e) {
      console.error('Poll error', e.stack || e.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

if (require.main === module) {
  // run loop
  console.log('Monitor starting {');
  console.log(' BASE_URL:', BASE_URL);
  console.log(' SYMBOL:', SYMBOL);
  console.log(' POLL_INTERVAL_MS:', POLL_INTERVAL_MS);
  console.log(' DISCORD_WEBHOOK set:', !!DISCORD_WEBHOOK);
  console.log('}');
  mainLoop();
}
