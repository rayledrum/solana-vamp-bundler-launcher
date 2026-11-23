// Per-mint chart series. The visible coin is the active slot only.
// History loading and timeframe regrouping stay in app.js; this book
// just keeps each mint's samples and trade markers from mixing.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ChartBook = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_SAMPLES = 5000;
  const MAX_TRADES = 30;

  function emptySeries() {
    return {
      samples: [],
      sampleMs: null,
      lastPrice: 0,
      source: '',
      symbol: null,
      trades: []
    };
  }

  function createBook() {
    const byMint = new Map();
    let activeMint = null;
    let epoch = 0;

    function ensure(mint) {
      let series = byMint.get(mint);
      if (!series) {
        series = emptySeries();
        byMint.set(mint, series);
      }
      return series;
    }

    return {
      activate(mint) {
        if (!mint || mint === activeMint) {
          return { changed: false, epoch, series: mint ? ensure(mint) : emptySeries() };
        }
        activeMint = mint;
        epoch += 1;
        return { changed: true, epoch, series: ensure(mint) };
      },

      getActiveMint() {
        return activeMint;
      },

      getEpoch() {
        return epoch;
      },

      peek(mint) {
        if (!mint) return null;
        return byMint.get(mint) || null;
      },

      replaceSeries(mint, next) {
        if (!mint) return null;
        const series = ensure(mint);
        const incoming = next || {};
        series.samples = Array.isArray(incoming.samples) ? incoming.samples : [];
        series.sampleMs = incoming.sampleMs == null ? series.sampleMs : incoming.sampleMs;
        series.lastPrice = Number(incoming.lastPrice) || 0;
        series.source = incoming.source || '';
        if (incoming.symbol) series.symbol = incoming.symbol;
        return series;
      },

      appendSample(mint, sample) {
        if (!mint || !sample) return false;
        const series = ensure(mint);
        series.samples.push(sample);
        if (series.samples.length > MAX_SAMPLES) {
          series.samples.splice(0, series.samples.length - MAX_SAMPLES);
        }
        if (Number.isFinite(sample.close)) series.lastPrice = sample.close;
        return mint === activeMint;
      },

      pushTrade(mint, trade) {
        if (!mint || !trade) return false;
        const series = ensure(mint);
        series.trades.push(trade);
        if (series.trades.length > MAX_TRADES) {
          series.trades.splice(0, series.trades.length - MAX_TRADES);
        }
        return mint === activeMint;
      }
    };
  }

  return { createBook, MAX_SAMPLES, MAX_TRADES };
});
