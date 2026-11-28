// Decide whether a live tick may move the chart.
// A gap, a zero, or one print far from the reserves price keeps the last good price.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ChartFeed = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const GAP_MS = 5000;
  const OUTLIER_RATIO = 2;

  function positive(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function far(price, reference) {
    if (!(price > 0) || !(reference > 0)) return false;
    const ratio = price / reference;
    return ratio >= OUTLIER_RATIO || ratio <= 1 / OUTLIER_RATIO;
  }

  function create() {
    return { lastPrice: null, reserve: null, suspect: null, lastGoodAt: null, watchedAt: null, lastTickAt: null };
  }

  function watch(state, now) {
    state.lastPrice = null;
    state.reserve = null;
    state.suspect = null;
    state.lastGoodAt = null;
    state.lastTickAt = null;
    state.watchedAt = now;
    return state;
  }

  function seed(state, price, now) {
    const good = positive(price);
    if (!good) return state;
    state.lastPrice = good;
    state.reserve = good;
    state.suspect = null;
    state.lastGoodAt = now;
    state.lastTickAt = now;
    return state;
  }

  function isReconnecting(state, now, gapMs) {
    const gap = gapMs == null ? GAP_MS : gapMs;
    const since = state && (state.lastGoodAt != null ? state.lastGoodAt : state.watchedAt);
    if (since == null) return false;
    return now - since >= gap;
  }

  function reservesPrice(trade) {
    const vSol = Number(trade && trade.virtualSolReserves);
    const vTok = Number(trade && trade.virtualTokenReserves);
    if (vSol > 0 && vTok > 0) return (vSol / 1e9) / (vTok / 1e6);
    if (trade && trade.priceOnly) return positive(trade.priceSol);
    return null;
  }

  function consider(state, tick) {
    const now = Number(tick && tick.now) || 0;
    const reconnecting = isReconnecting(state, now);
    const reserve = positive(tick && tick.reservePrice);
    if (reserve) {
      if (!state.reserve || !far(reserve, state.reserve)) {
        state.reserve = reserve;
        state.suspect = null;
      } else if (state.suspect && !far(reserve, state.suspect)) {
        state.reserve = reserve;
        state.suspect = null;
      } else {
        state.suspect = reserve;
      }
    }
    const price = positive(tick && tick.price);
    const at = tick && tick.at != null ? Number(tick.at) : now;
    if (!price) {
      return { plot: false, price: state.lastPrice, reason: 'empty', reconnecting };
    }
    if (state.lastTickAt != null && at < state.lastTickAt) {
      return { plot: false, price: state.lastPrice, reason: 'stale', reconnecting };
    }
    const reference = state.reserve || state.lastPrice;
    if (reference && far(price, reference)) {
      return { plot: false, price: state.lastPrice, reason: 'outlier', reconnecting };
    }
    state.lastPrice = price;
    state.lastGoodAt = now;
    state.lastTickAt = at;
    if (!state.reserve) state.reserve = price;
    return { plot: true, price, reason: 'ok', reconnecting: false };
  }

  return { GAP_MS, OUTLIER_RATIO, create, watch, seed, consider, isReconnecting, reservesPrice, positive };
});
