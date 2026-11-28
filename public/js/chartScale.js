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

  function formatCompactUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const scaled = (div, suffix) => `${sign}$${(abs / div).toFixed(1).replace(/\.0$/, '')}${suffix}`;
    if (abs >= 1e9) return scaled(1e9, 'B');
    if (abs >= 1e6) return scaled(1e6, 'M');
    if (abs >= 1e3) return scaled(1e3, 'K');
    if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
    if (abs > 0) return `${sign}$${abs.toFixed(4)}`;
    return '$0';
  }

  function marketCapDisplay(priceSol, supplyUi, solUsd) {
    const sol = marketCapSol(priceSol, supplyUi);
    if (sol == null) return null;
    const rate = Number(solUsd);
    if (rate > 0) return { value: sol * rate, unit: 'usd' };
    return { value: sol, unit: 'sol' };
  }

  // Spot market cap from bonding-curve reserves: (vSol / vToken) × supply × SOL/USD.
  function marketCapFromReserves({ virtualSolRaw, virtualTokenRaw, supplyUi, solUsd }) {
    const vSol = Number(virtualSolRaw);
    const vTok = Number(virtualTokenRaw);
    if (!(vSol > 0) || !(vTok > 0)) return null;
    const priceSol = (vSol / 1e9) / (vTok / 1e6);
    return marketCapDisplay(priceSol, supplyUi, solUsd);
  }

  function formatAxisMarketCap(priceSol, supplyUi, solUsd) {
    const display = marketCapDisplay(priceSol, supplyUi, solUsd);
    if (!display) return '—';
    if (display.unit === 'usd') return formatCompactUsd(display.value);
    return formatMarketCapSol(display.value);
  }

  function formatDisplayNumber(value, unit) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    if (unit === 'usd') return formatCompactUsd(value);
    return compactNumber(value);
  }

  function toDisplayCandle(candle, supplyUi, solUsd) {
    const map = (price) => {
      const display = marketCapDisplay(price, supplyUi, solUsd);
      return display ? display.value : null;
    };
    return {
      time: candle && candle.time,
      open: map(candle && candle.open),
      high: map(candle && candle.high),
      low: map(candle && candle.low),
      close: map(candle && candle.close),
      volume: Number(candle && candle.volume) || 0
    };
  }

  function formatOhlcDisplay(candle, supplyUi, solUsd) {
    if (!candle) return '';
    const display = toDisplayCandle(candle, supplyUi, solUsd);
    const unit = Number(solUsd) > 0 ? 'usd' : 'sol';
    const part = (value) => formatDisplayNumber(value, unit);
    const suffix = unit === 'usd' ? '' : ' SOL';
    return `O:${part(display.open)} H:${part(display.high)} L:${part(display.low)} C:${part(display.close)}${suffix}`;
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
    marketCapFromFeed,
    formatCompactUsd,
    marketCapDisplay,
    marketCapFromReserves,
    formatAxisMarketCap,
    formatDisplayNumber,
    toDisplayCandle,
    formatOhlcDisplay
  };
});
