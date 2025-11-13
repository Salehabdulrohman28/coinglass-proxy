// monitor.js
// Node 18+ recommended. Uses native fetch (or node-fetch if older Node).

import fetch from "node-fetch"; // kalau Node >=18 bisa gunakan global fetch (hapus import)
import { URL } from "url";

const BASE_URL = process.env.BASE_URL || "https://coinglass-proxy-9con.onrender.com";
const SYMBOL = process.env.SYMBOL || "BTC";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const API_KEY = process.env.API_KEY || ""; // optional, jika proxy pakai secret

// Config
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30_000);
const RETRY_COUNT = Number(process.env.RETRY_COUNT || 3);
const INITIAL_BACKOFF_MS = Number(process.env.INITIAL_BACKOFF_MS || 500);
const MIN_SEND_INTERVAL_MS = Number(process.env.MIN_SEND_INTERVAL_MS || 10 * 60_000); // dedupe per 10 menit

if (!DISCORD_WEBHOOK) {
  console.error("DISCORD_WEBHOOK not set — script will still run but won't send to Discord.");
}

// for dedupe
const lastSent = new Map(); // key -> timestamp

function dedupeAllowed(key) {
  const now = Date.now();
  const prev = lastSent.get(key) || 0;
  if (now - prev >= MIN_SEND_INTERVAL_MS) {
    lastSent.set(key, now);
    return true;
  }
  return false;
}

async function discordSend(content, opts = {}) {
  if (!DISCORD_WEBHOOK) {
    console.log("discordSend skipped (no webhook):", content);
    return;
  }
  try {
    const body = {};
    if (opts.embed) {
      body.embeds = [opts.embed];
    } else {
      body.content = content;
    }
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn("Discord webhook returned non-ok:", res.status, await res.text());
    }
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
      if (API_KEY) headers["coinglassSecret"] = API_KEY; // sesuai server.js proxy header
      const res = await fetch(url, { headers, timeout: 20_000 });
      const text = await res.text();
      // try parse
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      if (res.ok) {
        return { ok: true, status: res.status, data: json ?? text };
      }
      // non-ok status
      const err = { ok: false, status: res.status, text, json };
      // retry on 5xx
      if (res.status >= 500 && attempt < tries) {
        console.warn(`Fetch attempt ${attempt} failed with ${res.status}. Retrying in ${backoff}ms...`);
        await new Promise(r => setTimeout(r, backoff));
        backoff *= 2;
        continue;
      }
      return err;
    } catch (e) {
      // network error -> retry
      console.warn(`Network error on attempt ${attempt}:`, e.message || e);
      if (attempt < tries) {
        await new Promise(r => setTimeout(r, backoff));
        backoff *= 2;
        continue;
      }
      return { ok: false, status: 0, error: String(e) };
    }
  }
}

function formatNumber(n) {
  if (typeof n !== "number") return n;
  return n.toLocaleString();
}

async function checkFunding() {
  const url = `${BASE_URL}/funding?symbol=${encodeURIComponent(SYMBOL)}`;
  const resp = await fetchWithRetry(url, RETRY_COUNT);
  if (!resp.ok) {
    // prepare readable message
    const errKey = `funding_error_${resp.status || "network"}`;
    if (dedupeAllowed(errKey)) {
      const embed = {
        title: "Monitor error: funding fetch failed",
        description: `HTTP ${resp.status || "network"} -> ${resp.json ? JSON.stringify(resp.json) : (resp.text || resp.error || "no body")}`,
        color: 16733525, // red
        fields: [
          { name: "symbol", value: SYMBOL, inline: true },
          { name: "url", value: url, inline: false }
        ],
        timestamp: new Date().toISOString()
      };
      await discordSend(null, { embed });
    } else {
      console.log("Suppressed duplicate funding error.");
    }
    return;
  }

  // success: resp.data may be JSON with code/success/data etc.
  const body = resp.data;
  // Some proxies return {code:0,data: ... } or direct array/object
  let successFlag = true;
  if (body && typeof body === "object") {
    if ("success" in body && body.success === false) successFlag = false;
    if ("code" in body && Number(body.code) !== 0) successFlag = false;
  }

  if (!successFlag) {
    const errKey = `funding_api_resp_false`;
    if (dedupeAllowed(errKey)) {
      const embed = {
        title: "Monitor warning: API returned success=false",
        description: JSON.stringify(body).slice(0, 2000),
        color: 16753920,
        timestamp: new Date().toISOString()
      };
      await discordSend(null, { embed });
    } else {
      console.log("Suppressed duplicate API success=false.");
    }
    return;
  }

  // extract useful value (try common shapes)
  let fundingRate = null;
  try {
    // if body.data is array of exchanges with funding_rate fields, try to find Binance or symbol
    const data = body.data ?? body;
    if (Array.isArray(data)) {
      // try to find object with symbol==SYMBOL or exchange "Binance"
      let found = data.find(d => d.symbol === SYMBOL && d.funding_rate !== undefined) || data.find(d => d.exchange === "Binance" && d.funding_rate !== undefined);
      if (!found && data.length && data[0].funding_rate !== undefined) found = data[0];
      if (found) fundingRate = found.funding_rate ?? found.funding_rate_percent ?? found.funding_rate_value;
    } else if (typeof data === "object") {
      // maybe token_margin_list etc
      if (data.funding_rate !== undefined) fundingRate = data.funding_rate;
      else if (data.data && Array.isArray(data.data) && data.data[0] && data.data[0].funding_rate !== undefined) fundingRate = data.data[0].funding_rate;
    }
  } catch (e) {
    console.warn("extract funding error", e);
  }

  // Build a nice status message
  const msg = {
    title: `Funding ${SYMBOL}`,
    description: fundingRate !== null ? `Funding rate: **${fundingRate}**` : "Could not read funding rate from response",
    color: 3066993,
    timestamp: new Date().toISOString()
  };
  // Only send info messages occasionally to avoid noise. For demo we'll log and only send if rate exists.
  console.log(`${new Date().toISOString()} funding%`, fundingRate ?? "N/A");
  if (fundingRate !== null && dedupeAllowed(`funding_ok_${Math.round(Number(fundingRate)*1000)}`)) {
    await discordSend(null, { embed: msg });
  }
}

async function mainLoop() {
  console.log("Monitor started. Poll interval:", POLL_INTERVAL_MS);
  // initial notification
  if (dedupeAllowed("monitor_start")) {
    await discordSend(null, { embed: { title: "Monitor started", description: `Symbol: ${SYMBOL}`, color: 3066993, timestamp: new Date().toISOString() }});
  }

  while (true) {
    try {
      await checkFunding();
    } catch (e) {
      console.error("Unhandled checkFunding error:", e);
      if (dedupeAllowed("unhandled_check_err")) {
        await discordSend(null, { embed: { title: "Monitor unhandled error", description: String(e).slice(0, 2000), color: 16711680, timestamp: new Date().toISOString() }});
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// run
mainLoop().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
