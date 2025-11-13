// monitor.js
import fetch from "node-fetch";

const BASE = process.env.BASE_URL || "https://coinglass-proxy-9con.onrender.com"; // ganti sesuai base proxy URL (atau set env)
const SYMBOL = (process.env.SYMBOL || "BTC").toUpperCase();
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || ""; // optional if proxy handles key
const DEBUG = (process.env.DEBUG === "true");
const ALERT_THRESHOLD = parseInt(process.env.ALERT_THRESHOLD || "2", 10); // jumlah consecutive errors sebelum kirim alert

if (!DISCORD_WEBHOOK) console.warn("DISCORD_WEBHOOK not set; alerts disabled.");

let consecutiveErrors = 0;
let lastFunding = null;
let dedupeMap = new Map();

function log(...args){ if (DEBUG) console.log(...args); }

async function fetchProxyFunding(symbol) {
  const url = `${BASE.replace(/\/$/,'')}/funding?symbol=${encodeURIComponent(symbol)}`;
  try {
    const res = await fetch(url, { method: "GET" });
    const txt = await res.text();
    let body;
    try { body = JSON.parse(txt); } catch(e) { body = txt; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  } catch (err) {
    throw err;
  }
}

async function sendDiscordAlert(payload) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error("Discord webhook send failed:", err.message);
  }
}

function buildEmbedError(err, symbol, url) {
  const text = `Monitor error: ${err.status ?? ""} -> ${JSON.stringify(err.body ?? err.message)}`;
  return {
    embeds: [{
      title: "Monitor error: funding fetch failed",
      color: 15158332,
      description: `\`\`\`${text}\`\`\``,
      fields: [
        { name: "symbol", value: symbol, inline: true },
        { name: "url", value: url, inline: false }
      ],
      timestamp: new Date().toISOString()
    }]
  };
}

function buildEmbedStarted(symbol){
  return {
    embeds: [{
      title: "Monitor started",
      color: 3066993,
      fields: [{ name: "Symbol", value: symbol }],
      timestamp: new Date().toISOString()
    }]
  };
}

function shouldDedupe(key, ttlMs=60_000) {
  const now = Date.now();
  const prev = dedupeMap.get(key);
  if (prev && (now - prev) < ttlMs) {
    // suppressed
    return true;
  }
  dedupeMap.set(key, now);
  // cleanup old keys occasionally
  for (const [k, t] of dedupeMap.entries()) {
    if (now - t > 10 * ttlMs) dedupeMap.delete(k);
  }
  return false;
}

async function checkOnce(){
  const url = `${BASE.replace(/\/$/,'')}/funding?symbol=${encodeURIComponent(SYMBOL)}`;
  try {
    const data = await fetchProxyFunding(SYMBOL);
    log("fetched", data);
    consecutiveErrors = 0;

    // put some basic validation depending on data shape (CoinGlass v4 returns array etc)
    let fundingValue = null;
    if (Array.isArray(data?.data) && data.data.length) {
      fundingValue = data.data[0];
    } else if (data?.data) {
      fundingValue = data.data;
    } else if (data?.open_interest_usd) {
      fundingValue = data;
    } else {
      // unknown shape -> just record raw
      fundingValue = data;
    }

    // If funding changed, optionally send info message (customize as needed)
    const asString = JSON.stringify(fundingValue).slice(0, 1000);
    if (lastFunding !== asString) {
      console.log("Funding update:", SYMBOL, asString.slice(0,200));
      lastFunding = asString;
      // you can send a success/info message if desired (commented by default)
      // await sendDiscordAlert({ embeds: [{ title: "Funding update", description: `Symbol ${SYMBOL}\n\`\`\`${asString}\`\`\`` }]});
    }
  } catch (err) {
    consecutiveErrors++;
    console.error("Funding fetch error:", err.status ?? "", err.body ?? err.message ?? err);
    // only alert if reached threshold
    const key = JSON.stringify({ status: err.status ?? "ERR", path: err.body?.path ?? "" });
    if (!shouldDedupe(key)) {
      if (consecutiveErrors >= ALERT_THRESHOLD) {
        await sendDiscordAlert(buildEmbedError(err, SYMBOL, url));
      } else {
        console.log("Not alerting yet, consecutiveErrors", consecutiveErrors, "< threshold", ALERT_THRESHOLD);
      }
    } else {
      log("Suppressed duplicate alert by dedupe.");
    }
  }
}

(async function main(){
  console.log("Monitor starting {");
  console.log("  BASE_URL:", BASE);
  console.log("  SYMBOL:", SYMBOL);
  console.log("  POLL_INTERVAL_MS:", POLL_INTERVAL_MS);
  console.log("}");
  await sendDiscordAlert(buildEmbedStarted(SYMBOL));
  // run first check immediately
  await checkOnce();
  setInterval(checkOnce, POLL_INTERVAL_MS);
})();
