// server.js (VERSI MINIMAL TEST)
// tujuan: pastikan /health dan /coinglass/latest/:symbol berfungsi dulu

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// route cek kesehatan server
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    message: 'server ok',
    now: Date.now()
  });
});

// route dummy untuk coinglass (belum ambil API beneran, hanya test koneksi)
app.get('/coinglass/latest/:symbol', (req, res) => {
  const symbol = req.params.symbol;
  res.json({
    ok: true,
    payload: {
      symbol,
      timestamp: Date.now(),
      funding_rate: 0.0005,
      open_interest: 1234567,
      volume: 89000,
      liquidation: 1234
    }
  });
});

// jalankan server
app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
});
