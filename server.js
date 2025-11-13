import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());

// ========= ENV =========
const API_KEY = process.env.COINGLASS_API_KEY;       // <— API KEY Coinglass
const PORT = process.env.PORT || 10000;

// LOG bwt cek
console.log("COINGLASS_API_KEY:", API_KEY ? "Loaded" : "NOT FOUND");

// ========= FUNDING ENDPOINT =========
app.get("/funding", async (req, res) => {
  const symbol = req.query.symbol || "BTC";

  const url = `https://open-api.coinglass.com/api/pro/v1/futures/funding?symbol=${symbol}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "coinglassSecret": API_KEY   // <— WAJIB ADA
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Funding fetch error:", data);
      return res.status(response.status).json({
        error: true,
        status: response.status,
        data
      });
    }

    res.json(data);

  } catch (err) {
    console.error("Funding fetch FAILED:", err);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});

// ========= OI ENDPOINT =========
app.get("/oi", async (req, res) => {
  const symbol = req.query.symbol || "BTC";

  const url = `https://open-api.coinglass.com/api/pro/v1/futures/openInterest?symbol=${symbol}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "coinglassSecret": API_KEY   // <— WAJIB ADA
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OI fetch error:", data);
      return res.status(response.status).json({
        error: true,
        status: response.status,
        data
      });
    }

    res.json(data);

  } catch (err) {
    console.error("OI fetch FAILED:", err);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});

// ========= HEALTH =========
app.get("/healthz", (req, res) => res.send("OK"));

// ========= START =========
app.listen(PORT, () =>
  console.log(`Coinglass Proxy Running on Port ${PORT}`)
);
