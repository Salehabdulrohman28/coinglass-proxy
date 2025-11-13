// server.js (replace whole file)
// ES module style like your repo showed earlier
import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;

// Base (default) — use open-api-v4 as recommended
const COINGLASS_BASE = process.env.COINGLASS_BASE_URL || "https://open-api-v4.coinglass.com";
// API key (if provided in Render env)
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || "";

/**
 * mapping: short proxy path -> array of possible upstream API paths (try in order)
 * We'll try each candidate until one returns ok (2xx) or non-404 (and return body).
 */
const MAPPING_CANDIDATES = {
  "/funding": [
    "/api/pro/v1/futures/funding",           // older / possible path
    "/api/pro/v1/futures/funding-rate",      // alternate path
    "/api/pro/v1/futures/funding-rate/history"
  ],
  "/funding-history": [
    "/api/pro/v1/futures/funding-rate/history",
    "/api/pro/v1/futures/funding-history"
  ],
  "/oi": [
    "/api/pro/v1/futures/openInterest",
    "/api/pro/v1/futures/open-interest"
  ],
  "/healthz": ["/api/pro/v1/healthz", "/health"]
};

// Ensure base has no trailing slash
function baseNoSlash() {
  return COINGLASS_BASE.replace(/\/+$/, "");
}

function buildUpstreamUrl(candidatePath, qs = "") {
  const base = baseNoSlash();
  const path = candidatePath.startsWith("/") ? candidatePath : `/${candidatePath}`;
  return `${base}${path}${qs ? (qs.startsWith("?") ? qs : `?${qs}`) : ""}`;
}

async function fetchUpstream(shortPath, qs = "") {
  // pick candidate list
  const candidates = MAPPING_CANDIDATES[shortPath] || [shortPath];
  let lastError = null;

  for (const cand of candidates) {
    const url = buildUpstreamUrl(cand, qs);
    const headers = {
      "accept": "application/json",
      "user-agent": "coinglass-proxy/1.0"
    };
    if (COINGLASS_API_KEY) headers["CG-API-KEY"] = COINGLASS_API_KEY;

    console.log("DEBUG -> fetchUpstream trying url:", url);
    console.log("DEBUG -> fetchUpstream headers:", Object.keys(headers).join(","));

    let res;
    try {
      res = await fetch(url, { method: "GET", headers, redirect: "follow" });
    } catch (err) {
      lastError = { type: "network", message: String(err), url };
      console.warn("WARN -> fetchUpstream network error:", err);
      continue; // try next candidate
    }

    // read text (safe)
    const text = await res.text().catch(() => "");
    const contentType = res.headers.get("content-type") || "";

    console.log("DEBUG -> upstream status:", res.status, "contentType:", contentType);
    console.log("DEBUG -> upstream body preview:", text.slice(0, 400));

    if (!res.ok) {
      // if 404, try next candidate
      lastError = { status: res.status, body: text, url, contentType };
      console.warn("WARN -> upstream not ok:", res.status, "url:", url);
      // if it's 404 or 502 try next candidate; otherwise for 2xx we would have returned
      continue;
    }

    // if response ok, try parse JSON
    if (contentType.includes("application/json") || contentType.includes("text/plain")) {
      try {
        const json = JSON.parse(text);
        return { success: true, upstream_status: res.status, upstream_ok: true, body: json, url, contentType };
      } catch (err) {
        // sometimes server returns plain text but with json-like; return text
        return { success: true, upstream_status: res.status, upstream_ok: true, body: text, url, contentType };
      }
    } else {
      // not JSON (HTML etc) — return as text
      return { success: true, upstream_status: res.status, upstream_ok: true, body: text, url, contentType };
    }
  }

  // none succeeded
  return { success: false, upstream_status: lastError && lastError.status ? lastError.status : 500, upstream_ok: false, message: lastError ? lastError : "no-candidates", body: lastError && lastError.body ? lastError.body : "" };
}

// Proxy endpoint pattern: /<shortPath>?<qs>
// e.g. GET /funding?symbol=BTC
app.get("/:short", async (req, res) => {
  const short = `/${req.params.short}`;
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  try {
    const result = await fetchUpstream(short, qs);
    // propagate status codes clearly for debugging
    if (!result.success) {
      // return JSON with upstream info
      return res.status(502).json({
        success: false,
        upstream_status: result.upstream_status || 502,
        upstream_ok: false,
        message: result.message || "upstream failed",
        body_preview: (result.body && typeof result.body === "string") ? result.body.slice(0, 800) : result.body
      });
    }
    // success -> send upstream body directly if object, otherwise send wrapper
    if (typeof result.body === "object") {
      return res.status(200).json(result.body);
    } else {
      // text body
      return res.status(200).type(result.contentType || "text/plain").send(result.body);
    }
  } catch (err) {
    console.error("ERROR -> unexpected:", err);
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// simple health
app.get("/__health", (req, res) => {
  res.json({ ok: true, base: COINGLASS_BASE, hasKey: !!COINGLASS_API_KEY });
});

app.listen(PORT, () => {
  console.log("CoinGlass Proxy Running on Port", PORT);
  console.log("Available endpoints:", Object.keys(MAPPING_CANDIDATES).join(", "));
  console.log("COINGLASS_BASE=", COINGLASS_BASE);
  console.log("COINGLASS_API_KEY set:", !!COINGLASS_API_KEY);
});
