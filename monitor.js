// monitor.js — Coinglass Funding + OI Monitor (Discord Alerts)
import fetch from "node-fetch";

const BASE = process.env.BASE_URL || "https://coinglass-proxy-9con.onrender.com";
const SYMBOL = process.env.SYMBOL || "BTC";
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 30);

// Discord Webhook
const DISCORD_URL = process.env.DISCORD_WEBHOOK || "";

// Thresholds (percent)
const FUND_HIGH = Number(process.env.FUND_HIGH || 0.5);   // percent
const FUND_LOW  = Number(process.env.FUND_LOW  || -0.5);  // percent

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function sendDiscord(text) {
  if (!DISCORD_URL) return;
  await fetch(DISCORD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text })
  }).catch(e=>console.error("Discord send error:", e.message));
}

let lastFunding = null;

async function checkOnce() {
  try {
    const fJson = await getJson(`/funding?symbol=${SYMBOL}`);
    const oJson = await getJson(`/oi?symbol=${SYMBOL}`);

    // Detect numeric values (tweak if structure differs)
    const fRaw = fJson?.data?.[0]?.fundingRate ?? fJson?.data?.[0]?.funding_rate ?? fJson?.fundingRate ?? fJson?.funding_rate;
    const f = Number(fRaw) * 100;

    const oiRaw = oJson?.data?.[0]?.openInterestUsd ?? oJson?.data?.[0]?.openInterest ?? oJson?.openInterestUsd ?? oJson?.openInterest ?? null;
    const oi = oiRaw ? Number(oiRaw) : NaN;

    console.log(new Date().toISOString(), "funding%", f, "oi", oi);

    if (!isNaN(f)) {
      if (lastFunding === null) lastFunding = f;

      if (f >= FUND_HIGH && lastFunding < FUND_HIGH) {
        await sendDiscord(`🚨 **FUNDING HIGH ALERT**\n**${SYMBOL}** funding: **${f.toFixed(4)}%**\nThreshold: >= ${FUND_HIGH}%`);
      }

      if (f <= FUND_LOW && lastFunding > FUND_LOW) {
        await sendDiscord(`🟢 **FUNDING LOW ALERT**\n**${SYMBOL}** funding: **${f.toFixed(4)}%**\nThreshold: <= ${FUND_LOW}%`);
      }

      lastFunding = f;
    }
  } catch (e) {
    console.error("check error:", e.message || e);
  }
}

console.log("Monitor started for", SYMBOL, "interval:", POLL_SECONDS, "seconds");

(async () => {
  await checkOnce();
  setInterval(checkOnce, POLL_SECONDS * 1000);
})();
