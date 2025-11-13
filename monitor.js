// monitor.js
import fetch from "node-fetch";

const BASE_URL = process.env.BASE_URL || "https://your-proxy-url.onrender.com";
const SYMBOL = process.env.SYMBOL || "BTC";
const INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30_000);
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const ERROR_THRESHOLD = Number(process.env.ERROR_THRESHOLD || 2);

if (!DISCORD_WEBHOOK) {
  console.error("No DISCORD_WEBHOOK set. Exiting.");
  process.exit(1);
}

let consecutiveErrors = 0;
let lastFundingHash = null;

async function postDiscord(content, embed=null) {
  const body = { content: content || null };
  if (embed) body.embeds = [embed];
  await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
}

async function checkOnce() {
  const url = `${BASE_URL}/funding?symbol=${encodeURIComponent(SYMBOL)}`;
  try {
    const r = await fetch(url, { timeout: 10_000 });
    const json = await r.json();
    if (r.ok && json.code === 0 && json.data) {
      // success
      consecutiveErrors = 0;
      // build short status and only send when changed (or first run)
      const payloadStr = JSON.stringify(json.data).slice(0,2000);
      const hash = payloadStr; // naive
      if (lastFundingHash !== hash) {
        lastFundingHash = hash;
        await postDiscord(null, {
          title: "Monitor update",
          description: `Symbol: ${SYMBOL}\nData (truncated):\n\`\`\`${payloadStr}\`\`\``,
          color: 3066993,
          timestamp: new Date().toISOString()
        });
      }
    } else {
      // upstream reported an error
      consecutiveErrors++;
      const detail = JSON.stringify(json).slice(0,1500);
      console.warn("Monitor error:", detail);
      if (consecutiveErrors >= ERROR_THRESHOLD) {
        await postDiscord(null, {
          title: "Monitor error: funding fetch failed",
          description: `HTTP ${r.status} -> ${detail}`,
          color: 16711680,
          fields: [
            { name: "symbol", value: SYMBOL, inline: true },
            { name: "url", value: url, inline: false }
          ],
          timestamp: new Date().toISOString()
        });
      } else {
        console.log("Not alerting yet, consecutiveErrors", consecutiveErrors);
      }
    }
  } catch (err) {
    consecutiveErrors++;
    console.error("Fetch failed:", err.message);
    if (consecutiveErrors >= ERROR_THRESHOLD) {
      await postDiscord(null, {
        title: "Monitor error: fetch failed",
        description: `${err.message}`,
        color: 16711680,
        fields: [{ name:"symbol", value: SYMBOL }],
        timestamp: new Date().toISOString()
      });
    }
  }
}

(async function run(){
  console.log("Monitor started");
  await postDiscord(null, { title:"Monitor started", description:`Symbol: ${SYMBOL}`, color: 3066993, timestamp: new Date().toISOString() });
  await checkOnce();
  setInterval(checkOnce, INTERVAL_MS);
})();
