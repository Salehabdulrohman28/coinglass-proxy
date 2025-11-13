import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// Funding Rate
app.get("/funding", async (req, res) => {
  const symbol = req.query.symbol || "BTC";

  try {
    const resp = await fetch(
      `https://open-api.coinglass.com/api/pro/v1/futures/funding?symbol=${symbol}`,
      { headers: { coinglassSecret: API_KEY } }
    );

    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Proxy Error" });
  }
});

// Open Interest
app.get("/oi", async (req, res) => {
  const symbol = req.query.symbol || "BTC";

  try {
    const resp = await fetch(
      `https://open-api.coinglass.com/api/pro/v1/futures/openInterest?symbol=${symbol}`,
      { headers: { coinglassSecret: API_KEY } }
    );

    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Proxy Error" });
  }
});

app.listen(PORT, () => console.log("Coinglass Proxy Running on Port " + PORT));
