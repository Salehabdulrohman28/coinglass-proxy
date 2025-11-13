// monitor.js
import fetch from "node-fetch";

const PROXY_BASE = process.env.PROXY_BASE || "https://coinglass-proxy-9con.onrender.com";
const SYMBOL = (process.env.SYMBOL || "BTC").toUpperCase();
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || "";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const ERROR_ALERT_THRESHOLD = Number(process.env.ERROR_ALERT_THRESHOLD || 3);

let lastFundingRaw = null;
let consecutiveErrors = 0;

async function postDiscord(payload) {
  if (!DISCORD_WEBHOOK) {
    console.warn("No DISCORD_WEBHOOK_URL set");
    return;
  }
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error("discord post failed:", e);
  }
}

function buildErrorEmbed(title, message, symbol, url) {
  return {
    username: "COINGLASS BOT",
    embeds: [
      {
        title,
        description: `\`\`\`${message}\`\`\``,
        color: 15158332,
        fields: [
          { name: "symbol", value: symbol, inline: true },
          { name: "url", value: url || `${PROXY_BASE}/funding?symbol=${symbol}`, inline: false }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  };
}

function buildInfoEmbed(title, text) {
  return {
    username: "COINGLASS BOT",
    embeds: [{ title, description: text, color: 3066993, timestamp: new Date().toISOString() }]
  };
}

async function fetchFunding() {
  const url = `${PROXY_BASE}/funding?symbol=${SYMBOL}`;
  try {
    const r = await fetch(url, { timeout: 10000 });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
    return { ok: r.ok, status: r.status, body: json, url };
  } catch (err) {
    return { ok: false, status: 0, body: { error: String(err) }, url };
  }
}

async function poll() {
  console.log("Fetch funding for", SYMBOL, new Date().toISOString());
  const res = await fetchFunding();
  if (!res.ok || (res.body && res.body.success === false && res.status >= 400)) {
    consecutiveErrors++;
    console.warn("Fetch attempt failed", res.status, res.body);
    // send error only when exceeds threshold to avoid spam
    if (consecutiveErrors >= ERROR_ALERT_THRESHOLD) {
      await postDiscord(buildErrorEmbed("Monitor error: funding fetch failed", JSON.stringify(res.body), SYMBOL, res.url));
    } else {
      console.log("Not alerting yet, consecutiveErrors", consecutiveErrors);
    }
  } else {
    // success
    consecutiveErrors = 0;
    const nowRaw = JSON.stringify(res.body);
    if (nowRaw !== lastFundingRaw) {
      lastFundingRaw = nowRaw;
      // post a short info or you can change to only post important changes
      await postDiscord(buildInfoEmbed("Monitor started / update", `Symbol: ${SYMBOL}\nData received (truncated):\n\`\`\`${JSON.stringify(res.body).slice(0,400)}...\`\`\``));
    } else {
      // unchanged -> do nothing (suppress duplicates)
      console.log("No change in funding -> suppressed");
    }
  }
}

(async () => {
  console.log("Monitor starting {");
  console.log(" PROXY_BASE:", PROXY_BASE);
  console.log(" SYMBOL:", SYMBOL);
  console.log(" POLL_INTERVAL_MS:", POLL_INTERVAL_MS);
  console.log("}");
  // send startup message
  await postDiscord(buildInfoEmbed("Monitor started", `Symbol: ${SYMBOL}`));
  // loop
  setInterval(poll, POLL_INTERVAL_MS);
  // run once immediately
  poll();
})();
