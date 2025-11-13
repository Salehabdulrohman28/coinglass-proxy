// server.js - Resilient proxy (no direct response.json() calls)
import http from "http";
import url from "url";

const PORT = process.env.PORT || 10000;
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || "";
const UPSTREAM_BASE = process.env.UPSTREAM_BASE || "https://api.coinglass.com";
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || "15000", 10);

const cache = new Map();
function setCache(k, v){ cache.set(k, {v, t:Date.now()}); }
function getCache(k){ const e = cache.get(k); if(!e) return null; if(Date.now()-e.t>CACHE_TTL_MS){ cache.delete(k); return null;} return e.v; }
function log(...a){ console.log(new Date().toISOString(), ...a); }

async function fetchRaw(upstreamPath){
  const full = UPSTREAM_BASE + upstreamPath;
  const headers = { "Accept": "application/json" };
  if (COINGLASS_API_KEY){
    headers["X-API-KEY"] = COINGLASS_API_KEY;
    headers["X-COINGLASS-APIKEY"] = COINGLASS_API_KEY;
  }
  try{
    const controller = new AbortController();
    const t = setTimeout(()=> controller.abort(), 8000);
    const res = await fetch(full, { method: "GET", headers, signal: controller.signal });
    const bodyText = await res.text();
    clearTimeout(t);
    // try parse JSON safely
    let json = null;
    try{ json = JSON.parse(bodyText); } catch(e){ json = null; }
    return { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers.entries()), bodyText, bodyJson: json };
  }catch(err){
    return { ok:false, status:0, error: String(err) };
  }
}

async function handle(req, res){
  try{
    const p = url.parse(req.url, true);
    const path = p.pathname || "/";
    if (path === "/health" || path === "/healthz"){
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ ok:true, ts: Date.now() }));
      return;
    }
    if (!["/funding","/oi"].includes(path)){
      res.writeHead(404, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ error:"not_supported", message:"Use /funding or /oi" }));
      return;
    }

    const q = p.query || {};
    const symbol = q.symbol || "BTC";
    const upstreamPath = path === "/funding"
      ? `/api/pro/v1/futures/funding?symbol=${encodeURIComponent(symbol)}`
      : `/api/pro/v1/futures/open_interest?symbol=${encodeURIComponent(symbol)}`;

    const cacheKey = path + ":" + symbol;
    const cached = getCache(cacheKey);
    if (cached){
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ cached:true, data: cached }));
      return;
    }

    const upstream = await fetchRaw(upstreamPath);

    if (!upstream.ok && upstream.status === 0){
      // network/timeout
      res.writeHead(502, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ error:"upstream_network", msg: upstream.error }));
      return;
    }

    // if upstream returned JSON parsed ok -> return it
    if (upstream.ok && upstream.bodyJson !== null){
      setCache(cacheKey, upstream.bodyJson);
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ cached:false, data: upstream.bodyJson }));
      return;
    }

    // upstream returned non-json body or error page
    const wrapper = {
      upstream_status: upstream.status,
      upstream_ok: upstream.ok,
      message_snippet: upstream.bodyText ? upstream.bodyText.slice(0,1600) : "no body",
      headers: upstream.headers || {}
    };

    // return 502 so monitor knows something upstream wrong
    res.writeHead(502, {"Content-Type":"application/json"});
    res.end(JSON.stringify(wrapper));
  }catch(e){
    log("internal error", e);
    res.writeHead(500, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ error:"internal", msg: String(e) }));
  }
}

const server = http.createServer(handle);
server.listen(PORT, ()=> log("Coinglass Proxy Running on Port", PORT, "Upstream:", UPSTREAM_BASE, "CacheTTLms:", CACHE_TTL_MS));
