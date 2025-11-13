// monitor.js
// Robust CoinGlass monitor + Discord notifier
// Usage: node monitor.js
// Env vars:
//   DISCORD_WEBHOOK  -> discord webhook url (required for alerts)
//   COINGLASS_API_KEY -> optional CoinGlass API key
//   SYMBOL -> symbol to monitor (BTC default)
//   POLL_INTERVAL_MS -> polling interval (ms), default 30000
//   BASE_URL -> optional override for CoinGlass base, default open-api-v4

import fetchPkg from "node-fetch";
const fetch = fetchPkg.default || fetchPkg; // ensure compatibility

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || "";
const SYMBOL = (process.env.SYMBOL || "BTC").toUpperCase();
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const BASE_URL = (process.env.BASE_URL || "https://open-api-v4.coinglass.com").replace(/\/+$/,"");

if (!DISCORD_WEBHOOK) {
  console.warn("WARNING: DISCORD_WEBHOOK not set — alerts will be skipped.");
}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// Candidate upstream paths to try (order matters). These are *relative* to BASE_URL.
// We attempt each until one returns a successful JSON or text body.
const CANDIDATE_PATHS = [
  "/api/pro/v1/futures/funding",                     // older/possible path
  "/api/pro/v1/futures/funding-rate/history",       // funding history
  "/api/futures/funding",                            // alternate
  "/api/futures/funding-rate/history",               // alternate
  "/api/pro/v1/futures/funding-rate",                // another guess
  "/api/pro/v1/futures/funding-rate/history?limit=1" // fallback with query
];

// small helper to build final url
function buildUrl(base, path, params = {}) {
  let url = base + (path.startsWith("/") ? path : "/" + path);
  // if params object -> append as query string
  const q = new URLSearchParams(params).toString();
  if (q) url += (url.includes("?") ? "&" : "?") + q;
  return url;
}

async function fetchUpstreamTry(url) {
  const headers = {
    accept: "application/json, text/plain, */*",
    "user-agent": "coinglass-proxy-monitor/1"
  };
  if (COINGLASS_API_KEY) headers["CG-API-KEY"] = COINGLASS_API_KEY;
  try {
    const res = await fetch(url, { method: "GET", headers, redirect: "follow", timeout: 15000 });
    const contentType = res.headers.get("content-type") || "";
    const status = res.status;
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch (e) {
      bodyText = "";
    }
    // If JSON-like return parsed JSON
    if (contentType.includes("application/json") || (/^\s*\{/.test(bodyText) || /^\s*\[/.test(bodyText))) {
      try {
        const json = JSON.parse(bodyText || "{}");
        return { ok: res.ok, status, contentType, body: json, raw: bodyText };
      } catch (e) {
        // invalid JSON but we still return text
        return { ok: res.ok, status, contentType, body: null, raw: bodyText, parseError: e.message };
      }
    } else {
      // non-JSON -> return text
      return { ok: res.ok, status, contentType, body: null, raw: bodyText };
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function findWorkingEndpoint() {
  // try each candidate with symbol param
  for (const p of CANDIDATE_PATHS) {
    // ensure symbol param present if no query already present
    const url = p.includes("?") ? buildUrl(BASE_URL, p + `&symbol=${SYMBOL}`) : buildUrl(BASE_URL, p, { symbol: SYMBOL });
    console.debug("DEBUG -> fetchUpstream trying url:", url);
    const res = await fetchUpstreamTry(url);
    if (res.ok && (res.body !== null || (res.raw && res.raw.length > 0))) {
      // Good response (200-ish). Return endpoint + body
      return { url, res };
    } else {
      // log why not ok (for debugging)
      console.debug("DEBUG -> upstream not ok:", res);
    }
    // small pause between attempts
    await sleep(300);
  }
  return null;
}

async function postDiscord(content, embeds) {
  if (!DISCORD_WEBHOOK) return;
  const payload = {
    content,
    embeds: embeds ? embeds : undefined
  };
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error("Error sending Discord webhook:", e.message || e);
  }
}

// Monitoring loop
let consecutiveErrors = 0;
const ERROR_ALERT_THRESHOLD = 3; // after this many consecutive fails we send alert

async function monitorLoop() {
  console.log(`Monitor starting — SYMBOL=${SYMBOL} BASE=${BASE_URL} POLL_INTERVAL_MS=${POLL_INTERVAL_MS}`);
  while (true) {
    try {
      const found = await findWorkingEndpoint();
      if (!found) {
        consecutiveErrors++;
        console.warn(`No working upstream path found (attempt). consecutiveErrors=${consecutiveErrors}`);
        if (consecutiveErrors >= ERROR_ALERT_THRESHOLD) {
          await postDiscord(`:warning: ALERT — Funding fetch repeatedly failed for ${SYMBOL}. Tried candidate endpoints against ${BASE_URL} (see logs). consecutiveErrors=${consecutiveErrors}`);
        }
        // wait and retry with backoff
        await sleep(Math.min(POLL_INTERVAL_MS * Math.max(1, consecutiveErrors), 120000));
        continue;
      }

      // reset error counter
      consecutiveErrors = 0;

      const { url, res } = found;
      // Inspect res.status / body for expected fields
      if (!res.ok) {
        console.warn(`Upstream returned not-ok status ${res.status} url=${url}`);
        await postDiscord(`:x: Monitor error: upstream returned status ${res.status} for ${SYMBOL}. url: ${url}`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Parse the data: depends on what CoinGlass returns. We'll try to normalize:
      let data = res.body;
      if (!data && res.raw) {
        // not JSON or empty JSON — include raw
        console.log("Upstream returned text:", res.raw.slice(0, 800));
        await postDiscord(`:information_source: Monitor info: upstream returned non-JSON body for ${SYMBOL}. url: ${url}\n\`\`\`\n${res.raw.slice(0,1000)}\n\`\`\``);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // If data includes error code returned by CoinGlass, handle
      if (typeof data === "object" && (data.code || data.error || data.success === false)) {
        console.warn("Upstream body indicates error:", data);
        await postDiscord(`:warning: Monitor error from upstream for ${SYMBOL} — ${JSON.stringify(data).slice(0,1000)}`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // At this point we assume data is the expected funding object/array.
      // Customize parsing if you know exact fields. For safety we just stringify a small payload.
      const short = JSON.stringify(data).slice(0, 1500);
      console.log(`Funding update ${SYMBOL}: ${short}`);
      // Post to Discord summary (compact)
      await postDiscord(`:white_check_mark: Funding update ${SYMBOL}\nSource: ${url}\n\`\`\`json\n${short}\n\`\`\``);

      // normal poll interval
      await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      consecutiveErrors++;
      console.error("Monitor loop exception:", err && err.stack ? err.stack : err);
      if (consecutiveErrors >= ERROR_ALERT_THRESHOLD) {
        await postDiscord(`:rotating_light: Monitor crashed repeatedly. Error: ${err && err.message ? err.message : String(err)}\nconsecutiveErrors=${consecutiveErrors}`);
      }
      // wait & continue
      await sleep(Math.min(POLL_INTERVAL_MS * consecutiveErrors, 120000));
    }
  }
}

// start
monitorLoop().catch((e) => {
  console.error("Fatal monitor error:", e);
  process.exit(1);
});
