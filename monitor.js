// monitor.js (ES module)
import fetch from "node-fetch"; // optional; on Node22 you can remove and use global fetch
import process from "process";

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const BASE_URL = process.env.BASE_URL || process.env.PRIMARY_URL || "https://your-render-url.example.com";
const SYMBOL = process.env.SYMBOL || "BTC";
const INTERVAL = Number(process.env.INTERVAL_SECONDS || 30) * 1000;

if (!DISCORD_WEBHOOK) {
  console.error("ERROR: DISCORD_WEBHOOK environment variable not set. Exiting.");
  process.exit(1);
}

async function sendDiscord(content, embeds) {
  try {
    const body = { content: content || undefined, embeds: embeds || undefined };
    const r = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("discord send failed:", r.status, r.statusText, t);
      return false;
    }
    return true;
  } catch (e) {
    console.error("discord send error:", e.message || e);
    return false;
  }
}

async function getJson(path) {
  try {
    const url = `${BASE_URL.replace(/\/$/, "")}${path}`;
    const r = await fetch(url, { timeout: 15000 });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} ${r.statusText} -> ${t}`);
    }
    const j = await r.json();
    return j;
  } catch (e) {
    throw e;
  }
}

async function job() {
  const ts = new Date().toISOString();
  try {
    const f = await getJson(`/funding?symbol=${SYMBOL}`);
    const o = await getJson(`/oi?symbol=${SYMBOL}`);
    // Parse chosen fields — adapt if structure differs
    // Try to pick top exchange 'Binance' or first entry
    const fundingData = Array.isArray(f?.data) ? f.data : (f?.data?.[0] ? f.data : f);
    const oiData = Array.isArray(o?.data) ? o.data : (o?.data?.[0] ? o.data : o);

    // try to extract Binance funding and open interest for readability
    let fundingRate = "N/A";
    try {
      const post = Array.isArray(fundingData) ? fundingData.find(x => x.exchange?.toLowerCase() === "binance") || fundingData[0] : fundingData;
      fundingRate = post?.funding_rate ?? post?.fundingRate ?? JSON.stringify(post).slice(0,60);
    } catch(e){}

    let oiUsd = "N/A";
    try {
      const post = Array.isArray(oiData) ? oiData.find(x => x.exchange?.toLowerCase() === "binance") || oiData[0] : oiData;
      oiUsd = post?.open_interest_usd ?? post?.openInterestUsd ?? JSON.stringify(post).slice(0,60);
    } catch(e){}

    const content = `📡 [${ts}] ${SYMBOL} • Funding: ${fundingRate} • Open Interest (USD): ${oiUsd}`;
    const ok = await sendDiscord(content);
    if (!ok) console.error("Failed to send Discord");
    else console.log("sent:", content);
  } catch (err) {
    console.error("check error:", err.message || err);
    // send small error message to Discord but avoid spamming
    await sendDiscord(`⚠️ [${ts}] Monitor error: ${err.message?.slice(0,1900) || err}`);
  }
}

console.log("Monitor started for", SYMBOL, "interval", INTERVAL/1000, "s, BASE_URL=", BASE_URL);
job();
setInterval(job, INTERVAL);
