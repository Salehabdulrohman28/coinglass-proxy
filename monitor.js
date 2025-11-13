// monitor.js (ESM)
// Usage: node monitor.js
// Requires node-fetch (v2) or you can change to global fetch in Node18+
// npm install node-fetch@2 node-html-parser

import fetch from "node-fetch";
import { parse as parseHTML } from "node-html-parser";

/**
 * Config from env
 */
const BASE_URL = process.env.BASE_URL || ""; // proxy URL (no trailing slash)
const COINGLASS_BASE = process.env.COINGLASS_BASE || "https://open-api-v4.coinglass.com";
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || "";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const SYMBOLS = (process.env.SYMBOLS || "BTC").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const CONSECUTIVE_THRESHOLD = Number(process.env.CONSECUTIVE_THRESHOLD || 2);
const DEBUG = (process.env.DEBUG || "false").toLowerCase() === "true";

/**
 * Which internal endpoints we want to monitor and the mapping to upstream
 * The server proxy should implement the equivalent paths:
 * - /funding?symbol=BTC
 * - /funding-history?symbol=BTC&limit=1
 * - /oi?symbol=BTC
 * - /healthz
 *
 * If BASE_URL empty -> we'll call CoinGlass direct using COINGLASS_BASE paths below.
 */
const MONITOR_PATHS = [
  { name: "funding", proxyPath: "/funding", upstreamPath: "/api/pro/v1/futures/funding" },
  { name: "funding-history", proxyPath: "/funding-history", upstreamPath: "/api/pro/v1/futures/funding-rate/history" },
  { name: "oi", proxyPath: "/oi", upstreamPath: "/api/pro/v1/futures/open-interest" },
];

function log(...args) {
  if (DEBUG) console.log(new Date().toISOString(), ...args);
  else console.log(...args);
}

/**
 * Utility: robust JSON/text parser for fetch responses
 */
async function parseResponseSafely(res) {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const text = await res.text();
  // If JSON-like try parse
  if (contentType.includes("application/json")) {
    try {
      return { ok: res.ok, parsed: JSON.parse(text), text, contentType };
    } catch (err) {
      // fallback: sometimes server returns JSON-encoded string inside text
      try {
        const maybe = JSON.parse(text.trim());
        return { ok: res.ok, parsed: maybe, text, contentType };
      } catch (_e) {
        return { ok: res.ok, parsed: null, text, contentType };
      }
    }
  }
  // If HTML try extract pre or body text
  if (contentType.includes("text/html")) {
    try {
      const root = parseHTML(text);
      const pre = root.querySelector("pre");
      const bodyText = pre ? pre.text.trim() : root.text.trim();
      // try parse bodyText as json
      try {
        const parsed = JSON.parse(bodyText);
        return { ok: res.ok, parsed, text: bodyText, contentType };
      } catch (_e) {
        return { ok: res.ok, parsed: null, text: bodyText, contentType };
      }
    } catch (_e) {
      return { ok: res.ok, parsed: null, text, contentType };
    }
  }
  // fallback try parse json from text
  try {
    const parsed = JSON.parse(text);
    return { ok: res.ok, parsed, text, contentType };
  } catch (_) {
    return { ok: res.ok, parsed: null, text, contentType };
  }
}

/**
 * Compose the URL we'll call for a given path and symbol.
 * If BASE_URL provided, call proxy endpoint (BASE_URL + proxyPath)
 * else call CoinGlass direct (COINGLASS_BASE + upstreamPath)
 */
function buildUrl(pathDef, symbol, qs = {}) {
  const q = new URLSearchParams(qs);
  if (symbol) q.set("symbol", symbol);
  if (BASE_URL) {
    // ensure base has no trailing slash
    const base = BASE_URL.replace(/\/+$/, "");
    return `${base}${pathDef.proxyPath}?${q.toString()}`;
  } else {
    const base = COINGLASS_BASE.replace(/\/+$/, "");
    return `${base}${pathDef.upstreamPath}?${q.toString()}`;
  }
}

/**
 * low-level fetch wrapper with small retries
 */
async function fetchWithRetries(url, options = {}, retries = 2, retryDelay = 500) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }
  }
  throw lastErr;
}

/**
 * Send alert to Discord (webhook). Basic embed style.
 */
async function sendDiscordAlert(title, description, fields = []) {
  if (!DISCORD_WEBHOOK) {
    log("No DISCORD_WEBHOOK configured, skipping alert:", title);
    return;
  }
  try {
    const payload = {
      username: "COINGLASS BOT",
      embeds: [
        {
          title,
          description,
          color: 13107300,
          fields: fields.map(f => ({ name: f.name, value: f.value, inline: f.inline || false })),
          timestamp: new Date().toISOString()
        }
      ]
    };
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    log("Discord alert sent:", title);
  } catch (err) {
    console.error("Failed to send discord alert:", err);
  }
}

/**
 * Monitor state
 */
const state = {
  // e.g. state['BTC.funding'] = { consecutiveErrors: 0, lastAlertHash: '' }
};

function keyFor(symbol, name) {
  return `${symbol}.${name}`;
}

/**
 * Check one symbol + path
 */
async function checkOne(symbol, pathDef) {
  const url = buildUrl(pathDef, symbol, { limit: 1 });
  const headers = {};
  // If calling coinGlass directly with API key, set header
  if (!BASE_URL && COINGLASS_API_KEY) {
    headers["CG-API-KEY"] = COINGLASS_API_KEY;
  }

  // attempt fetch
  let res;
  try {
    res = await fetchWithRetries(url, { method: "GET", headers }, 2, 400);
  } catch (err) {
    // network error
    log("Fetch network error:", pathDef.name, symbol, err.message || err);
    await handleError(symbol, pathDef, { success: false, upstream_status: null, message: err.message || String(err), url });
    return;
  }

  const parsed = await parseResponseSafely(res);

  // If res.ok true and parsed.parsed not null -> success
  if (res.ok && parsed.parsed) {
    // reset error counter
    const k = keyFor(symbol, pathDef.name);
    state[k] = state[k] || { consecutiveErrors: 0, lastAlertHash: null };
    if (state[k].consecutiveErrors > 0) {
      log(`Recovered: ${k} -> clearing consecutiveErrors`);
    }
    state[k].consecutiveErrors = 0;
    // Optionally, you could send success messages to Discord (currently we don't)
    log(`OK: ${pathDef.name} ${symbol}`, typeof parsed.parsed === "object" ? "(json)" : parsed.text);
    return;
  }

  // Not ok or no parsed JSON: treat as error
  const bodyPreview = parsed.text ? (parsed.text.length > 200 ? parsed.text.slice(0, 200) + "..." : parsed.text) : "<no-body>";
  const messageObj = {
    success: false,
    upstream_status: res.status,
    upstream_ok: res.ok,
    message: parsed.parsed || bodyPreview,
    contentType: parsed.contentType,
    url
  };

  await handleError(symbol, pathDef, messageObj);
}

/**
 * Handle error state, increment counters, send alert when threshold exceeded
 */
async function handleError(symbol, pathDef, info) {
  const k = keyFor(symbol, pathDef.name);
  state[k] = state[k] || { consecutiveErrors: 0, lastAlertHash: null };
  state[k].consecutiveErrors = (state[k].consecutiveErrors || 0) + 1;

  log(`Error (${pathDef.name} ${symbol}) count=${state[k].consecutiveErrors}`, info.upstream_status || "", info.message ? (typeof info.message === "string" ? info.message : JSON.stringify(info.message)) : "");

  const shouldAlert = state[k].consecutiveErrors >= CONSECUTIVE_THRESHOLD;

  // build small fingerprint to prevent duplicate alerts for same error body
  const bodySnippet = typeof info.message === "string" ? info.message : JSON.stringify(info.message);
  const hash = `${info.upstream_status || "?"}:${bodySnippet.slice(0, 200)}`;

  if (shouldAlert && state[k].lastAlertHash !== hash) {
    state[k].lastAlertHash = hash;
    // Send to Discord
    const title = `Monitor error: ${pathDef.name} ${symbol} -> status:${info.upstream_status || "?"}`;
    const description = `\`\`\`\n${typeof info.message === "string" ? info.message : JSON.stringify(info.message, null, 2)}\n\`\`\``;
    const fields = [
      { name: "symbol", value: symbol },
      { name: "url", value: info.url || "n/a" }
    ];
    await sendDiscordAlert(title, description, fields);
  } else {
    if (shouldAlert) log("Alert suppressed (duplicate)", k);
  }
}

/**
 * Main loop
 */
async function pollOnce() {
  try {
    const tasks = [];
    for (const symbol of SYMBOLS) {
      for (const p of MONITOR_PATHS) {
        tasks.push(checkOne(symbol, p));
      }
    }
    await Promise.all(tasks);
  } catch (err) {
    console.error("Unexpected error in pollOnce:", err);
  }
}

/**
 * Startup
 */
(async function main() {
  console.log("=== Monitor starting ===");
  console.log("BASE_URL:", BASE_URL || "<direct coinGlass>");
  console.log("COINGLASS_BASE:", COINGLASS_BASE);
  console.log("SYMBOLS:", SYMBOLS.join(","));
  console.log("POLL_INTERVAL_MS:", POLL_INTERVAL_MS);
  console.log("CONSECUTIVE_THRESHOLD:", CONSECUTIVE_THRESHOLD);

  // initial run
  await pollOnce();

  // periodic
  setInterval(pollOnce, POLL_INTERVAL_MS);
})();
