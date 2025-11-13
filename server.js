import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

// ==========================================================
const API_KEY = process.env.COINGLASS_API_KEY;
if (!API_KEY) {
  console.error("❌ Missing COINGLASS_API_KEY in environment!");
}

const HEADERS = {
  "accept": "application/json",
  "CoinglassSecret": API_KEY
};
// ==========================================================

// FUNDING RATE
app.get("/funding", async (req, res) => {
  try {
    const symbol = req.query.symbol || "BTC";

    const url = `https://open-api.coinglass.com/api/pro/v1/futures/funding?symbol=${symbol}`;

    const response = await fetch(url, { headers: HEADERS });
    const data = await response.json();

    if (!response.ok) return res.status(response.status).json(data);

    // Ambil hanya Binance data
    const binance = data.data.find(ex => ex.exchangeName === "Binance");

    res.json({
      exchange: "Binance",
      funding_rate: binance?.fundingRate || null
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// OPEN INTEREST
app.get("/oi", async (req, res) => {
  try {
    const symbol = req.query.symbol || "BTC";

    const url = `https://open-api.coinglass.com/api/pro/v1/futures/openInterest?symbol=${symbol}`;

    const response = await fetch(url, { headers: HEADERS });
    const data = await response.json();

    if (!response.ok) return res.status(response.status).json(data);

    const binance = data.data.find(ex => ex.exchangeName === "Binance");

    res.json({
      exchange: "Binance",
      open_interest_usd: binance?.openInterest || null
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HEALTH CHECK
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// START SERVER
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Coinglass Proxy Running on Port ${PORT}`));
