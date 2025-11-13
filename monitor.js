// monitor.js
// Replace whole file with this. Uses node-fetch (same package as server).
import fetch from "node-fetch";

const BASE_URL = process.env.BASE_URL || "https://coinglass-proxy-9con.onrender.com"; // your proxy host
const SYMBOL = process.env.SYMBOL || "BTC";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10); // default 30s
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const DEBUG = (process.env.DEBUG || "false").toLowerCase() === "true";

// Controls for alerting/dedup
const THRESHOLD_ERRORS = parseInt(process.env.THRESHOLD_ERRORS || "2", 10); // errors before alert
const DEDUPE_WINDOW_MS = parseInt(process.env.DEDUPE_WINDOW_MS || "60000", 10); // avoid duplicate alerts in window

let consecutiveErrors = 0;
let lastAlertHash = null;
let lastAlertTs = 0;

function log(...args) {
  if (DEBUG) console.log(...args);
}

function nowIso() {
  return new Date().toISOString();
}

// Simple helper to post to discord webhook
async function sendDiscordEmbed(title, description, color = 0xff0000, fields = []) {
  if (!DISCORD_WEBHOOK) {
    log("No DISCORD_WEBHOOK set, skipping discord post");
    return;
  }

  const payload = {
    embeds: [
      {
        title,
        description,
        color,
        timestamp: new Date().toISOString(),
        fields: fields.slice(0, 10) // discord max fields approx 25, keep small
      }
    ]
  };

  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("Discord webhook failed:", res.status, txt);
    } else {
      log("Discord webhook sent");
    }
  } catch (err) {
    console.error("Discord webhook network error:", err);
  }
}

// Create a short stable "hash" string for dedupe
function makeAlertHash(obj) {
  try {
    // normalize keys order for consistent string
    return JSON.stringify(obj, Object.keys(obj).sort());
  } catch (e) {
    return String(obj);
  }
}

async function fetchFundingOnce() {
  const url = `${BASE_URL}/funding?symbol=${encodeURIComponent(SYMBOL)}`;
  log(`${nowIso()} -> fetching`, url);

  let res;
  try {
    res = await fetch(url, { method: "GET", redirect: "follow" });
  } catch (err) {
    return { ok: false, status: 0, error: "network_error", detail: String(err) };
  }

  const status = res.status;
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const bodyText = await res.text().catch(() => "");

  // try parse JSON if content-type suggests it
  let body = null;
  if (contentType.includes("application/json")) {
    try {
      body = JSON.parse(bodyText);
    } catch (e) {
      // invalid json, keep text
      body = bodyText;
    }
  } else {
    // some upstream returns JSON but with text content-type; still attempt parse
    try {
      body = JSON.parse(bodyText);
    } catch (e) {
      body = bodyText;
    }
  }

  if (!res.ok) {
    return { ok: false, status, error: "upstream_error", body, bodyText, contentType, url };
  }

  return { ok: true, status, body, bodyText, contentType, url };
}

// Decide if response is an error wrapper
function isUpstreamError(result) {
  if (!result.ok) return true;
  // if body has typical "success": false structure
  if (result.body && typeof result.body === "object") {
    if ("success" in result.body && result.body.success === false) return true;
    // coinGlass sometimes returns { code: ..., msg: ... } with HTTP 200 - treat as error
    if ("code" in result.body && result.body.code && result.body.code !== 0) return true;
  }
  return false;
}

async function handleResult(result) {
  if (!result.ok || isUpstreamError(result)) {
    consecutiveErrors += 1;
    log(`${nowIso()} -> Funding fetch error:`, result.status || 0, JSON.stringify(result.body || result.bodyText || result.error).slice(0, 400));

    const payload = {
      type: "funding_error",
      symbol: SYMBOL,
      status: result.status,
      upstream_ok: result.ok,
      message: typeof result.body === "string" ? result.body : (result.body && result.body.msg) ? result.body.msg : JSON.stringify(result.body || result.bodyText || result.error)
    };

    const alertHash = makeAlertHash({ type: "funding_error", symbol: SYMBOL, status: result.status, message: payload.message });

    // only alert if consecutiveErrors >= threshold AND not duplicate recently
    const now = Date.now();
    if (consecutiveErrors >= THRESHOLD_ERRORS) {
      if (alertHash !== lastAlertHash || (now - lastAlertTs) > DEDUPE_WINDOW_MS) {
        lastAlertHash = alertHash;
        lastAlertTs = now;

        const desc = `Monitor error: ${payload.status} -> ${payload.message}`;
        await sendDiscordEmbed(
          "Monitor error: funding fetch failed",
          "```\n" + desc + "\n```",
          0xff3333,
          [
            { name: "symbol", value: SYMBOL, inline: true },
            { name: "url", value: result.url || BASE_URL + "/funding", inline: false },
            { name: "time", value: new Date().toLocaleString(), inline: true }
          ]
        );
      } else {
        log("Duplicate alert suppressed by dedupe");
      }
    } else {
      log(`Not alerting yet, consecutiveErrors (${consecutiveErrors}) < threshold (${THRESHOLD_ERRORS})`);
    }

    return;
  }

  // Success path: reset errors
  consecutiveErrors = 0;

  // Try to extract useful fields for sending to discord: common keys
  const data = result.body;
  // build short summary string — be defensive
  let summary = "";
  if (typeof data === "object") {
    // try common fields
    const parts = [];
    if ("symbol" in data) parts.push(`symbol: ${data.symbol}`);
    if ("fundingRate" in data) parts.push(`fundingRate: ${data.fundingRate}`);
    if ("funding_rate" in data) parts.push(`funding_rate: ${data.funding_rate}`);
    if ("timestamp" in data) parts.push(`ts: ${data.timestamp}`);
    // fallback: if body has length or array
    if (Array.isArray(data)) parts.push(`items:${data.length}`);
    if (parts.length === 0) parts.push(Object.keys(data).slice(0,6).map(k => `${k}`).join(", "));
    summary = parts.join(" · ");
  } else {
    summary = String(data).slice(0, 400);
  }

  // Compose embed (green for success)
  await sendDiscordEmbed(
    "Monitor update: Funding data",
    `Monitor started\nSymbol: ${SYMBOL}\n${summary}`,
    0x2ecc71,
    [
      { name: "symbol", value: SYMBOL, inline: true },
      { name: "source", value: result.url || BASE_URL, inline: true },
      { name: "time", value: new Date().toLocaleString(), inline: true }
    ]
  );

  log(`${nowIso()} -> Funding update:`, summary);
}

async function mainLoop() {
  console.log(`${nowIso()} -> Monitor starting {`);
  console.log(" BASE_URL:", BASE_URL);
  console.log(" SYMBOL:", SYMBOL);
  console.log(" POLL_INTERVAL_MS:", POLL_INTERVAL_MS);
  console.log(" DISCORD_WEBHOOK set:", !!DISCORD_WEBHOOK);
  console.log(" THRESHOLD_ERRORS:", THRESHOLD_ERRORS);
  console.log(" DEBUG:", DEBUG);
  console.log("}");

  // initial immediate check
  while (true) {
    try {
      const result = await fetchFundingOnce();
      await handleResult(result);
    } catch (err) {
      console.error("UNHANDLED ERROR in loop:", err);
    }

    // sleep
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// start
mainLoop().catch(err => {
  console.error("Monitor crashed:", err);
  process.exit(1);
});
