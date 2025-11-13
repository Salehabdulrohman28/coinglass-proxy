// monitor.js
// Node (ES module). Uses global fetch (Node >=18). Replace whole file in repo.

import { setTimeout as wait } from "node:timers/promises";

const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const SYMBOL = (process.env.SYMBOL || "BTC").toUpperCase();
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

function logDebug(...args) { if (["debug"].includes(LOG_LEVEL)) console.debug(...args); }
function logInfo(...args) { if (["debug","info"].includes(LOG_LEVEL)) console.log(...args); }
function logWarn(...args) { console.warn(...args); }
function logError(...args) { console.error(...args); }

/**
 * Candidate upstream endpoints to try (relative to https://open-api-v4.coinglass.com)
 * We will try these in order until one returns a successful JSON response.
 * If CoinGlass changes endpoints, add/remove candidates here.
 */
const CANDIDATE_PATHS = [
  "/api/pro/v1/futures/funding",                    // funding (current)
  "/api/pro/v1/futures/funding-rate",               // funding rate
  "/api/pro/v1/futures/funding-rate/history",       // funding history
  "/api/pro/v1/futures/funding-rate?limit=1",       // variant
];

/** build full url for a candidate with symbol query */
function buildUrl(path, symbol) {
  const base = "https://open-api-v4.coinglass.com";
  const sep = path.includes("?") ? "&" : "?";
  return `${base}${path}${sep}symbol=${encodeURIComponent(symbol)}`;
}

/** safe fetch with headers */
async function fetchJson(url, timeoutMs = 10000) {
  const headers = {
    "accept": "application/json",
    "user-agent": "coinglass-monitor/1.0 (+https://github.com/)",
  };
  if (COINGLASS_API_KEY) headers["CG-API-KEY"] = COINGLASS_API_KEY;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    logDebug("fetchJson ->", url, "headers:", Object.keys(headers));
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    clearTimeout(id);
    const contentType = res.headers.get("content-type") || "";

    // If not ok, try to get text for debugging
    if (!res.ok) {
      const raw = await res.text().catch(() => null);
      return { ok: false, status: res.status, contentType, raw };
    }

    // If JSON
    if (contentType.includes("application/json")) {
      const json = await res.json().catch(e => ({ parseError: String(e) }));
      return { ok: true, status: res.status, contentType, json };
    }

    // fallback: text
    const text = await res.text().catch(() => null);
    return { ok: true, status: res.status, contentType, text };
  } catch (err) {
    clearTimeout(id);
    return { ok: false, error: String(err) };
  }
}

/** try candidate endpoints sequentially */
async function tryCandidates(symbol) {
  for (const path of CANDIDATE_PATHS) {
    const url = buildUrl(path, symbol);
    logInfo(`Trying upstream: ${url}`);
    const r = await fetchJson(url, 12000);
    if (r.ok && (r.json || r.text)) {
      logInfo("Upstream success:", path, "status:", r.status || "200");
      return { url, path, resp: r };
    } else {
      logWarn("Upstream not ok:", { path, status: r.status, contentType: r.contentType, raw: r.raw || r.error });
      // small delay between tries
      await wait(250);
    }
  }
  return null;
}

/** send to discord */
async function postDiscord(content, embed = null) {
  if (!DISCORD_WEBHOOK_URL) {
    logWarn("DISCORD_WEBHOOK_URL not configured; skipping Discord post");
    return;
  }
  const payload = embed ? { content, embeds: [embed] } : { content };
  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logWarn("Discord webhook returned non-OK:", res.status, text);
    } else {
      logInfo("Discord webhook sent");
    }
  } catch (err) {
    logError("Error posting to Discord:", err);
  }
}

/** format limited JSON preview */
function preview(obj, max = 1200) {
  try {
    const s = JSON.stringify(obj, null, 2);
    if (s.length <= max) return s;
    return s.slice(0, max-3) + "...";
  } catch (e) {
    return String(obj).slice(0, max);
  }
}

/** main loop */
async function mainLoop() {
  logInfo("Monitor starting:", SYMBOL, "interval(ms):", POLL_INTERVAL_MS);
  let consecutiveErrors = 0;
  let backoffMs = 0;

  while (true) {
    try {
      if (backoffMs > 0) {
        logInfo("Backing off for", backoffMs, "ms");
        await wait(backoffMs);
      }

      const result = await tryCandidates(SYMBOL);

      if (!result) {
        // no working upstream found
        consecutiveErrors++;
        logWarn("No working upstream path found. consecutiveErrors=", consecutiveErrors);
        if (consecutiveErrors >= 3) {
          await postDiscord(`:warning: ALERT — Funding fetch repeatedly failed for ${SYMBOL}. Tried candidate endpoints but none returned JSON. consecutiveErrors=${consecutiveErrors}`, {
            title: "Funding fetch repeatedly failed",
            description: `Tried endpoints: ${CANDIDATE_PATHS.join(", ")}`,
          });
        }
        backoffMs = Math.min(60000, (consecutiveErrors ** 2) * 1000);
        await wait(Math.min(5000, backoffMs));
        continue;
      }

      // success
      consecutiveErrors = 0;
      backoffMs = 0;

      const { url, path, resp } = result;
      logInfo("Got upstream response from:", url, "status:", resp.status, "contentType:", resp.contentType);

      // build message for discord
      let textPreview = resp.json ? preview(resp.json) : (resp.text || preview(resp.raw || resp.error));
      const embed = {
        title: `Funding update — ${SYMBOL}`,
        description: `Upstream: \`${path}\`\nURL: ${url}\n\`\`\`json\n${textPreview}\n\`\`\``,
        timestamp: new Date().toISOString()
      };

      // deliver to Discord
      await postDiscord(null, embed);
      logInfo("Wrote update to Discord");

      // wait normal poll interval
      await wait(POLL_INTERVAL_MS);
    } catch (err) {
      consecutiveErrors++;
      logError("Unhandled error in loop:", err);
      if (consecutiveErrors >= 5) {
        await postDiscord(`:x: Monitor encountered repeated errors for ${SYMBOL}. last error: ${String(err)}`);
      }
      backoffMs = Math.min(60000, (consecutiveErrors ** 2) * 1000);
      await wait(backoffMs);
    }
  }
}

// start
mainLoop().catch(err => {
  logError("Fatal monitor error:", err);
  process.exit(1);
});
