// contoh bagian yang memanggil proxy
const BASE_URL = process.env.BASE_URL || "https://coinglass-proxy-9con.onrender.com";
const SYMBOL = process.env.SYMBOL || "BTC";

async function checkFunding() {
  const url = `${BASE_URL}/funding?symbol=${encodeURIComponent(SYMBOL)}`;
  const r = await fetch(url);
  const data = await r.json();
  // handle data...
}
