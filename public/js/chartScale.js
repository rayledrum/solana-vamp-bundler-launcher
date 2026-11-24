// Display scale for the candlestick chart. Samples stay SOL-per-token.
// The axis, last value, and OHLC readout show market cap on one scale:
// price × the mint supply (Pump.fun's 1e9 until getTokenSupply says otherwise).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ChartScale = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PUMP_SUPPLY_UI = 1000000000;

  function supplyOf(series) {
    const n = Number(series && series.supplyUi);
    return n > 0 ? n : PUMP_SUPPLY_UI;
  }

  function solUsdOf(series) {
    const n = Number(series && series.solUsd);
    return n > 0 ? n : null;
  }

  function marketCapSol(priceSol, supplyUi) {
    const price = Number(priceSol);
    const supply = Number(supplyUi) > 0 ? Number(supplyUi) : PUMP_SUPPLY_UI;
    if (!Number.isFinite(price) || price <= 0) return null;
    return price * supply;
  }

  function compactNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
    if (abs >= 1) return `${sign}${abs.toFixed(2)}`;
    return `${sign}${abs.toFixed(4)}`;
  }

  function formatMarketCapSol(mcap) {
    if (mcap == null || !Number.isFinite(Number(mcap))) return '—';
    return `${compactNumber(mcap)} SOL`;
  }

  function formatMarketCapLabel(mcap, solUsd) {
    const sol = formatMarketCapSol(mcap);
    const rate = Number(solUsd);
    if (!(rate > 0) || mcap == null || !Number.isFinite(Number(mcap))) return sol;
    return `${sol} ($${compactNumber(Number(mcap) * rate)})`;
  }

  function marketCapFromFeed({ priceSol, supplyUi, supplySource, solUsd, fdvUsd, marketCapUsd }) {
    const price = Number(priceSol);
    const supply = Number(supplyUi) > 0 ? Number(supplyUi) : PUMP_SUPPLY_UI;
    let mcap = price > 0 ? price * supply : null;
    if (supplySource !== 'mint' && Number(solUsd) > 0) {
      const usd = Number(fdvUsd) || Number(marketCapUsd);
      if (usd > 0) mcap = usd / Number(solUsd);
    }
    return mcap;
  }

  function formatOhlc(candle, supplyUi) {
    if (!candle) return '';
    const cap = (price) => compactNumber(marketCapSol(price, supplyUi));
    return `O:${cap(candle.open)} H:${cap(candle.high)} L:${cap(candle.low)} C:${cap(candle.close)} SOL`;
  }

  return {
    PUMP_SUPPLY_UI,
    supplyOf,
    solUsdOf,
    marketCapSol,
    compactNumber,
    formatMarketCapSol,
    formatMarketCapLabel,
    formatOhlc,
    marketCapFromFeed
  };
});
