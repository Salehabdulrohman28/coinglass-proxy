// server.js
// Simple resilient proxy for Coinglass endpoints: /funding and /oi
// Requires env COINGLASS_API_KEY
import http from "http";
import url from "url";

const PORT = process.env.PORT || 10000;
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || "";
const BASE_UPSTREAM = "https://api.coinglass.com"; // upstream base used in code
// Optional: allow overriding upstream base (for dev)
const UPSTREAM_OVERRIDE = process.env.UPSTREAM_BASE || BASE_UPSTREAM;

// Simple in-memory cache (TTL ms)
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || "15000", 10);
const cache = new Map();

function log(...args){ console.log(new Date().toISOString(), ...args); }

async function fetchUpstream(path, upstreamUrl) {
  const full = upstreamUrl + path;
  const controller = new AbortController();
  const timeout = setTimeout(()=> controller.abort(), 7000); // 7s timeout
  try {
    const headers = { "Accept": "application/json" };
    if (COINGLASS_API_KEY) headers["X-API-KEY"] = COINGLASS_API_KEY; // try common header
    // some Coinglass examples use X-COINGLASS-APIKEY, include both:
    if (COINGLASS_API_KEY) headers["X-COINGLASS-APIKEY"] = COINGLASS_API_KEY;

    const res = await fetch(full, { method: "GET", headers, signal: controller.signal });
    const ct = res.headers.get("content-type") || "";

    const text = await res.text(); // get raw body
    let parsed = null;
    if (ct.includes("application/json")) {
      try { parsed = JSON.parse(text); }
      catch(e) { parsed = null; }
    } else {
      // try parse JSON even if content-type wrong
      try { parsed = JSON.parse(text); } catch(e){ parsed = null; }
    }

    clearTimeout(timeout);

    return {
      ok: res.ok,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      bodyText: text,
      bodyJson: parsed
    };
  } catch (err) {
    clearTimeout(timeout);
    return { ok:false, status:0, error: String(err) };
  }
}

function setCache(key, value) {
  cache.set(key, { value, t: Date.now() });
}
function getCache(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL) { cache.delete(key); return null; }
  return e.value;
}

async function handleRequest(req, res) {
  try {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || "/";
    // allow health check
    if (pathname === "/healthz" || pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, timestamp: Date.now() }));
      return;
    }

    // only handle two endpoints, else 404
    if (!["/funding", "/oi"].includes(pathname)) {
      res.writeHead(404, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ error: "not_found", message: "Endpoint not supported" }));
      return;
    }

    // build upstream path mapping (some endpoints differ by upstream path)
    // example mapping (adjust if your upstream endpoint differs)
    const q = parsedUrl.query || {};
    const symbol = q.symbol || q.coin || "BTC";
    // pick upstream path - many coinglass endpoints are like /api/pro/v1/futures/funding
    // adjust if your plan uses different path
    let upstreamPath = "";
    if (pathname === "/funding") {
      // try pro path first
      upstreamPath = `/api/pro/v1/futures/funding?symbol=${encodeURIComponent(symbol)}`;
    } else if (pathname === "/oi") {
      upstreamPath = `/api/pro/v1/futures/open_interest?symbol=${encodeURIComponent(symbol)}`;
    }

    const cacheKey = pathname + "?" + new URLSearchParams(q).toString();
    const cached = getCache(cacheKey);
    if (cached) {
      res.writeHead(200, { "Content-Type":"application/json" });
      res.end(JSON.stringify({ cached: true, data: cached, timestamp: Date.now() }));
      return;
    }

    const upstream = await fetchUpstream(upstreamPath, UPSTREAM_OVERRIDE);

    // upstream returned network/timeout error
    if (!upstream.ok && upstream.status === 0) {
      log("upstream network error:", upstream.error);
      res.writeHead(502, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ error: "upstream_network", msg: upstream.error }));
      return;
    }

    // upstream responded with some body
    // If bodyJson exists, return it. If not, return bodyText as error
    if (upstream.ok && upstream.bodyJson !== null) {
      // cache and return
      setCache(cacheKey, upstream.bodyJson);
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ cached: false, data: upstream.bodyJson, timestamp: Date.now() }));
      return;
    }

    // upstream might return non-JSON (HTML error page) OR returned json but parse failed
    // include raw text for debugging but always return JSON wrapper
    const responseWrapper = {
      upstream_status: upstream.status,
      error: upstream.ok ? null : "upstream_error",
      message: upstream.bodyText ? upstream.bodyText.slice(0, 2000) : "no body",
      headers: upstream.headers || {}
    };

    // if upstream returned 200 but non-json, still return 502? we'll return 502 to let monitor know.
    const statusToReturn = upstream.status >= 400 ? 502 : 502;

    res.writeHead(statusToReturn, {"Content-Type":"application/json"});
    res.end(JSON.stringify(responseWrapper));
  } catch (err) {
    log("internal server error:", err);
    res.writeHead(500, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ error: "internal", msg: String(err) }));
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, ()=> log("Coinglass Proxy Running on Port", PORT, "Upstream:", UPSTREAM_OVERRIDE, "CacheTTLms:", CACHE_TTL));
