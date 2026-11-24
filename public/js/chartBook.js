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
  const MAX_TRADES = 240;
  const MIN_PUBLIC_SOL = 0.001;
  const PUBLIC_MARKER_CAP = 40;
  const OWN_MARKER_CAP = 40;

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
        if (!mint || !trade || trade.priceOnly) return false;
        const series = ensure(mint);
        const signature = String(trade.signature || '');
        if (signature) {
          const existing = series.trades.find(row => row.signature === signature);
          if (existing) {
            if (trade.own) {
              existing.own = true;
              if (trade.label) existing.label = trade.label;
            }
            return mint === activeMint;
          }
        }
        series.trades.push(trade);
        if (series.trades.length > MAX_TRADES) {
          const overflow = series.trades.length - MAX_TRADES;
          let dropped = 0;
          series.trades = series.trades.filter(row => {
            if (dropped >= overflow || row.own) return true;
            dropped += 1;
            return false;
          });
        }
        return mint === activeMint;
      }
    };
  }

  function markerTimeMs(trade) {
    const time = Number(trade && trade.timestamp);
    if (!Number.isFinite(time) || time <= 0) return null;
    return time < 1e12 ? time * 1000 : time;
  }

  function buildMarkers(trades, options) {
    const tfMs = Math.max(1, Number(options && options.tfMs) || 5000);
    const minSol = Number(options && options.minSol);
    const floor = Number.isFinite(minSol) ? minSol : MIN_PUBLIC_SOL;
    const publicCap = Number(options && options.publicCap) || PUBLIC_MARKER_CAP;
    const ownCap = Number(options && options.ownCap) || OWN_MARKER_CAP;
    const own = [];
    const pub = [];
    (trades || []).forEach(trade => {
      if (!trade || trade.priceOnly) return;
      const timeMs = markerTimeMs(trade);
      if (timeMs == null) return;
      const sol = Number(trade.solAmount) || 0;
      const row = {
        timeMs,
        bucket: Math.floor(timeMs / tfMs) * tfMs,
        txType: trade.txType === 'sell' ? 'sell' : 'buy',
        sol,
        own: Boolean(trade.own),
        label: trade.own ? String(trade.label || '') : '',
        signature: String(trade.signature || '')
      };
      if (row.own) own.push(row);
      else if (sol >= floor) pub.push(row);
    });
    return own.slice(-ownCap).concat(pub.slice(-publicCap)).sort((a, b) => a.timeMs - b.timeMs || a.signature.localeCompare(b.signature));
  }

  return {
    createBook,
    buildMarkers,
    markerTimeMs,
    MAX_SAMPLES,
    MAX_TRADES,
    MIN_PUBLIC_SOL,
    PUBLIC_MARKER_CAP,
    OWN_MARKER_CAP
  };
});
