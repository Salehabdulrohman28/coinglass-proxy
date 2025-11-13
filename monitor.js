// monitor.js — versi FIX TOTAL

import fetch from "node-fetch";

const BASE_URL = process.env.BASE_URL;            // contoh: https://coinglass-proxy.onrender.com
const SYMBOL = process.env.SYMBOL || "BTC";
const INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 30000;

let failCount = 0;
const FAIL_LIMIT = 3;

async function checkFunding() {
  const url = `${BASE_URL}/funding?symbol=${SYMBOL}`;

  console.log("Polling:", url);

  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });

    if (!res.ok) {
      const text = await res.text();
      console.log("❌ ERROR", res.status, text);
      failCount++;
    } else {
      const data = await res.json();
      console.log("✅ OK", JSON.stringify(data).slice(0, 200));
      failCount = 0;
    }

    if (failCount >= FAIL_LIMIT) {
      console.log("⚠️ ALERT — Funding fetch repeatedly failed!");
    }
  } catch (err) {
    console.log("❌ FETCH FAILED:", err.message);
    failCount++;
  }
}

console.log("Monitor started:", { BASE_URL, SYMBOL, INTERVAL });

setInterval(checkFunding, INTERVAL);
checkFunding();
