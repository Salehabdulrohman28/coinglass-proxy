// monitor.js (UPDATED: error aggregation + deprecated handling)
// Node 18+ recommended. If using older node keep node-fetch and import accordingly.

import fetch from "node-fetch";

const BASE_URL = process.env.BASE_URL || "https://coinglass-proxy-9con.onrender.com";
const SYMBOL = process.env.SYMBOL || "BTC";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const API_KEY = process.env.API_KEY || "";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30_000);
const RETRY_COUNT = Number(process.env.RETRY_COUNT || 3);
const INITIAL_BACKOFF_MS = Number(process.env.INITIAL_BACKOFF_MS || 500);

// Alerting / dedupe config
const MIN_SEND_INTERVAL_MS = Number(process.env.MIN_SEND_INTERVAL_MS || 10 * 60_000); // per type
const ERROR_THRESHOLD_BEFORE_ALERT = Number(process.env.ERROR_THRESHOLD_BEFORE_ALERT || 2); // consecutive errors needed

// state
const lastSent = new Map();
const consecutiveErrors = new Map();
let deprecatedStopped = false;

function now() { return Date.now(); }
function dedupeAllowed(key) {
  const prev = lastSent.get(key) || 0;
  if (now() - prev >= MIN_SEND_INTERVAL_MS) {
    lastSent.set(key, now());
    return true;
  }
  return false;
}

async function discordSend(embedOrContent = null) {
  if (!DISCORD_WEBHOOK) {
    console.log("discordSend skipped (no webhook).", embedOrContent);
    return;
  }
  try {
    const payload = typeof embedOrContent === "string" ? { content: embedOrContent } : { embeds: [embedOrContent] };
    const r = await fetch(DISCORD_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) console.warn("Discord webhook non-ok", r.status, await r.text());
  } catch (e) {
    console.error("discordSend error:", e);
  }
}

async function fetchWithRetry(url, tries = RETRY_COUNT) {
  let attempt = 0;
  let backoff = INITIAL_BACKOFF_MS;
  while (attempt < tries) {
    attempt++;
    try {
      const headers = {};
      if (API_KEY) headers["coinglassSecret"] = API_KEY;
      const r = await fetch(url, { headers, timeout: 20000 });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch(e) { json = null; }
      if (r.ok) return { ok: true, status: r.status, data: json ?? text, rawText: text };
      // non-ok
      if (r.status >= 500 && attempt < tries) {
        await new Promise(res => setTimeout(res, backoff));
        backoff *= 2;
        continue;
      }
      return { ok: false, status: r.status, data: json ?? null, rawText: text };
    } catch (e) {
      if (attempt < tries) {
        await new Promise(res => setTimeout(res, backoff));
        backoff *= 2;
        continue;
      }
      return { ok: false, status: 0, error: String(e) };
    }
  }
}

function incrConsec(key) {
  consecutiveErrors.set(key, (consecutiveErrors.get(key) || 0) + 1);
  return consecutiveErrors.get(key);
}
function resetConsec(key) { consecutiveErrors.set(key, 0); }

async function handleErrorResponse(type, resp, url) {
  const cnt = incrConsec(type);
  console.warn(`Error (${type}) count = ${cnt}, status=${resp.status}`);
  // Special: deprecated code from API (eg code===40001) -> notify once and stop repeated alerts
  const body = resp.data ?? resp.rawText ?? resp.error ?? "";
  if (body && typeof body === "object" && body.code === 40001) {
    if (!deprecatedStopped) {
      deprecatedStopped = true;
      const embed = {
        title: "Monitor: API Deprecated",
        description: `API returned deprecated code (40001). Endpoint likely changed.\nResponse: \`${JSON.stringify(body).slice(0,1200)}\``,
        color: 15105570,
        timestamp: new Date().toISOString()
      };
      await discordSend(embed);
    } else {
      console.log("Deprecated warning already sent; suppressing.");
    }
    return;
  }

  // For general 5xx/network errors: only alert after threshold
  if (cnt >= ERROR_THRESHOLD_BEFORE_ALERT) {
    const key = `error_${type}_${resp.status || "network"}`;
    if (dedupeAllowed(key)) {
      const embed = {
        title: `Monitor error: ${type} fetch failed`,
        description: `HTTP ${resp.status || "network"} -> \`${(body && typeof body === "string") ? body : JSON.stringify(body).slice(0,1200)}\``,
        color: 15548997,
        fields: [
          { name: "symbol", value: SYMBOL, inline: true },
          { name: "url", value: url, inline: false }
        ],
        timestamp: new Date().toISOString()
      };
      await discordSend(embed);
    } else {
      console.log("Suppressed duplicate alert by dedupe.");
    }
  } else {
    console.log(`Not alerting yet, consecutiveErrors (${cnt}) < threshold (${ERROR_THRESHOLD_BEFORE_ALERT})`);
  }
}

async function checkFunding() {
  if (deprecatedStopped) {
    console.log("Deprecated flag set — skipping funding check.");
    return;
  }
  const url = `${BASE_URL}/funding?symbol=${encodeURIComponent(SYMBOL)}`;
  const resp = await fetchWithRetry(url, RETRY_COUNT);
  if (!resp.ok) {
    await handleErrorResponse("funding", resp, url);
    return;
  }

  // success
  resetConsec("funding");
  // attempt to parse meaningful funding number if present
  const body = resp.data;
  // If body.success === false -> treat as warning
  if (body && typeof body === "object" && body.success === false) {
    const key = "api_success_false";
    if (dedupeAllowed(key)) {
      const embed = {
        title: "Monitor warning: API returned success=false",
        description: JSON.stringify(body).slice(0,1200),
        color: 16753920,
        timestamp: new Date().toISOString()
      };
      await discordSend(embed);
    }
    return;
  }

  // optional: extract funding_rate
  let fundingRate = null;
  try {
    const data = body.data ?? body;
    if (Array.isArray(data) && data.length) {
      const found = data.find(d => d.symbol === SYMBOL && d.funding_rate !== undefined) || data.find(d => d.exchange === "Binance" && d.funding_rate !== undefined) || data[0];
      if (found) fundingRate = found.funding_rate ?? found.funding_rate_percent ?? found.funding_rate_value ?? null;
    } else if (data && typeof data === "object") {
      fundingRate = data.funding_rate ?? (Array.isArray(data.data) && data.data[0] && data.data[0].funding_rate) ?? null;
    }
  } catch (e) {
    console.warn("extract funding error:", e);
  }

  console.log(new Date().toISOString(), "funding:", fundingRate ?? "N/A");
  // Send occasional successful update (deduped). Only send when fundingRate exists (avoid noise).
  if (fundingRate !== null && dedupeAllowed(`funding_ok_${Math.round(Number(fundingRate)*1000)}`)) {
    const embed = {
      title: `Funding ${SYMBOL}`,
      description: `Funding rate: **${fundingRate}**`,
      color: 3066993,
      timestamp: new Date().toISOString()
    };
    await discordSend(embed);
  }
}

async function main() {
  console.log("Monitor starting", { BASE_URL, SYMBOL, POLL_INTERVAL_MS });
  if (dedupeAllowed("monitor_start")) {
    await discordSend({ title: "Monitor started", description: `Symbol: ${SYMBOL}`, color: 3066993, timestamp: new Date().toISOString() });
  }
  while (true) {
    try {
      await checkFunding();
    } catch (e) {
      console.error("Unhandled error:", e);
      if (dedupeAllowed("unhandled")) {
        await discordSend({ title: "Monitor unhandled error", description: String(e).slice(0,1200), color: 15548997, timestamp: new Date().toISOString() });
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
