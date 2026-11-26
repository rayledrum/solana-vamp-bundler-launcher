const { createStore } = require('./store');
const { backfill, pollNewCoins, createPacer } = require('./collector');

const CANDLE_URL = 'https://frontend-api-v3.pump.fun/candles/solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/';

async function defaultCandles(fetchJson, mint) {
  const body = await fetchJson(`${CANDLE_URL}${encodeURIComponent(mint)}?res=1m&count=120&measure=price_quote`);
  const rows = body && Array.isArray(body.candles) ? body.candles : null;
  if (!rows || !rows.length) return null;
  return rows.map(row => ({
    time: Number.isFinite(Number(row.openTimeMs)) ? Number(row.openTimeMs) : null,
    open: Number.isFinite(Number(row.open)) ? Number(row.open) : null,
    high: Number.isFinite(Number(row.high)) ? Number(row.high) : null,
    low: Number.isFinite(Number(row.low)) ? Number(row.low) : null,
    close: Number.isFinite(Number(row.close)) ? Number(row.close) : null,
    volumeUsd: Number.isFinite(Number(row.volumeUsd)) ? Number(row.volumeUsd) : null
  }));
}

async function runBackfill(options = {}) {
  const store = options.store || createStore(options.dir);
  const pace = createPacer(options.minIntervalMs == null ? 400 : options.minIntervalMs);
  const coins = options.coins || await pollNewCoins(options.fetchJson);
  const limit = options.limit == null ? coins.length : options.limit;
  return backfill({
    coins: coins.slice(0, limit),
    store,
    pace,
    candlesFor: (mint) => (options.candlesFor || (id => defaultCandles(options.fetchJson, id)))(mint)
  });
}

async function main() {
  const fetchJson = async (url) => {
    const response = await fetch(url, { headers: { accept: 'application/json', origin: 'https://pump.fun' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const limit = Number(process.env.BACKFILL_LIMIT || 20);
  const saved = await runBackfill({ fetchJson, limit });
  console.log(JSON.stringify({ coins: saved.length, withCandles: saved.filter(row => row.candles).length }));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runBackfill, defaultCandles };
