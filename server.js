import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const API_KEY = process.env.COINGLASS_API_KEY;
if (!API_KEY) {
  console.error("❌ COINGLASS_API_KEY is missing");
}

app.get("/funding", async (req, res) => {
  const symbol = req.query.symbol || "BTC";

  const url = `https://api.coinglass.com/api/pro/v1/futures/funding?symbol=${symbol}`;

  try {
    const response = await fetch(url, {
      headers: {
        "accept": "application/json",
        "X-COINGLASS-APIKEY": API_KEY
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Funding fetch error:", data);
      return res.status(response.status).json(data);
    }

    res.json(data);

  } catch (err) {
    console.error("❌ Exception:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(10000, () => {
  console.log("✔ Coinglass Proxy Running on Port 10000");
  console.log("✔ Endpoint available: /funding");
});
