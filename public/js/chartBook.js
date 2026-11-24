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
      trades: [],
      supplyUi: null,
      supplySource: null,
      solUsd: null
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
        if (Number(incoming.supplyUi) > 0 && (incoming.supplySource === 'mint' || series.supplySource !== 'mint')) {
          series.supplyUi = Number(incoming.supplyUi);
          series.supplySource = incoming.supplySource || 'mint';
        }
        if (Number(incoming.solUsd) > 0) series.solUsd = Number(incoming.solUsd);
        return series;
      },

      noteScale(mint, patch) {
        if (!mint || !patch) return null;
        const series = ensure(mint);
        const supply = Number(patch.supplyUi);
        if (supply > 0 && (patch.source === 'mint' || series.supplySource !== 'mint')) {
          series.supplyUi = supply;
          series.supplySource = patch.source || series.supplySource || 'curve';
        }
        if (Number(patch.solUsd) > 0) series.solUsd = Number(patch.solUsd);
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
