// Per-mint candlestick book. The visible chart is only the active mint's
// series; ticks for any other mint are stored on that mint and never drawn
// on the coin currently on screen.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ChartBook = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TIMEFRAME_MS = {
    '1s': 1000,
    '5s': 5000,
    '15s': 15000,
    '30s': 30000,
    '1m': 60000,
    '5m': 300000
  };
  const MAX_CANDLES = 60;
  const MAX_TICKS = 4000;
  const MAX_MARKERS = 200;
  const BASE_PRICE = 0.00003;

  function createBook() {
    let timeframe = '5s';
    let activeMint = null;
    let epoch = 0;
    const seriesByMint = new Map();
    let demo = null;

    function tfMs() {
      return TIMEFRAME_MS[timeframe] || 5000;
    }

    function emptySeries() {
      return {
        candles: [],
        currentCandle: null,
        lastPrice: 0,
        markers: [],
        ticks: []
      };
    }

    function ensure(mint) {
      let series = seriesByMint.get(mint);
      if (!series) {
        series = emptySeries();
        seriesByMint.set(mint, series);
      }
      return series;
    }

    function append(series, price, volume, meta) {
      const now = meta.time != null ? meta.time : Date.now();
      const vol = volume || 0;
      series.ticks.push({ time: now, price, volume: vol, side: meta.side || null });
      if (series.ticks.length > MAX_TICKS) series.ticks.shift();
      series.lastPrice = price;

      if (!series.currentCandle || now - series.currentCandle.time >= tfMs()) {
        const candle = {
          time: now,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: vol
        };
        series.currentCandle = candle;
        series.candles.push(candle);
        if (series.candles.length > MAX_CANDLES) series.candles.shift();
      } else {
        const candle = series.currentCandle;
        candle.high = Math.max(candle.high, price);
        candle.low = Math.min(candle.low, price);
        candle.close = price;
        candle.volume += vol;
      }

      if (meta.side) {
        series.markers.push({ time: now, price, side: meta.side, volume: vol });
        if (series.markers.length > MAX_MARKERS) series.markers.shift();
      }
    }

    function rebucket(series) {
      const ticks = series.ticks;
      const windowMs = tfMs();
      const candles = [];
      let current = null;
      for (let i = 0; i < ticks.length; i++) {
        const tick = ticks[i];
        if (!current || tick.time - current.time >= windowMs) {
          current = {
            time: tick.time,
            open: tick.price,
            high: tick.price,
            low: tick.price,
            close: tick.price,
            volume: tick.volume || 0
          };
          candles.push(current);
          if (candles.length > MAX_CANDLES) candles.shift();
        } else {
          current.high = Math.max(current.high, tick.price);
          current.low = Math.min(current.low, tick.price);
          current.close = tick.price;
          current.volume += tick.volume || 0;
        }
      }
      series.candles = candles;
      series.currentCandle = current;
      series.lastPrice = current ? current.close : 0;
    }

    function viewOf(series, mint) {
      const src = series || emptySeries();
      return {
        mint: mint || null,
        epoch,
        candles: src.candles,
        markers: src.markers,
        lastPrice: src.lastPrice || 0,
        currentCandle: src.currentCandle
      };
    }

    return {
      activate(mint) {
        if (!mint || mint === activeMint) return this.view();
        activeMint = mint;
        epoch += 1;
        rebucket(ensure(mint));
        return this.view();
      },

      deactivate() {
        if (!activeMint) return this.view();
        activeMint = null;
        epoch += 1;
        return this.view();
      },

      // meta.mint routes the tick. meta.epoch drops a callback that was
      // captured before the visible coin changed. Unscoped ticks are ignored
      // once a mint is active so they cannot paint the new coin.
      pushTick(price, volume, meta) {
        const info = meta || {};
        if (info.epoch != null && info.epoch !== epoch) {
          return { applied: false, visible: false, reason: 'stale-epoch' };
        }
        const mint = info.mint || null;
        if (!mint) {
          if (activeMint) return { applied: false, visible: false, reason: 'unscoped' };
          if (!demo) demo = emptySeries();
          append(demo, price, volume || 0, info);
          return { applied: true, visible: true };
        }
        append(ensure(mint), price, volume || 0, info);
        return { applied: true, visible: mint === activeMint };
      },

      loadDemo(candles, lastPrice) {
        if (activeMint) return this.view();
        const built = candles || [];
        demo = {
          candles: built,
          currentCandle: built.length ? built[built.length - 1] : null,
          lastPrice: lastPrice || (built.length ? built[built.length - 1].close : 0),
          markers: [],
          ticks: built.map(candle => ({
            time: candle.time,
            price: candle.close,
            volume: candle.volume || 0,
            side: null
          }))
        };
        return this.view();
      },

      resetDemo() {
        demo = null;
      },

      setTimeframe(tf) {
        if (!TIMEFRAME_MS[tf]) return this.view();
        timeframe = tf;
        if (activeMint) rebucket(ensure(activeMint));
        return this.view();
      },

      view() {
        if (activeMint) return viewOf(seriesByMint.get(activeMint), activeMint);
        return viewOf(demo, null);
      },

      peek(mint) {
        if (!mint) return demo;
        return seriesByMint.get(mint) || null;
      },

      getActiveMint() {
        return activeMint;
      },

      getEpoch() {
        return epoch;
      }
    };
  }

  return { createBook, TIMEFRAME_MS, BASE_PRICE, MAX_CANDLES };
});
