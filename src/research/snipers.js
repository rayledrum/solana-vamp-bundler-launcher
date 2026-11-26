function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function selectEarlyBuys(trades, { createTime, limit = 50, windowMs = 60_000 } = {}) {
  if (!Array.isArray(trades)) return null;
  const buys = trades.filter(row => row && row.wallet && (row.side == null || row.side === 'buy'));
  const ordered = buys.slice().sort((a, b) => {
    const at = finite(a.time);
    const bt = finite(b.time);
    if (at == null && bt == null) return 0;
    if (at == null) return 1;
    if (bt == null) return -1;
    return at - bt;
  });
  if (createTime == null) return ordered.slice(0, limit);
  const within = ordered.filter(row => {
    const at = finite(row.time);
    return at != null && at >= createTime && at - createTime <= windowMs;
  });
  return within.slice(0, limit);
}

function sharedFunders(buys) {
  const counts = new Map();
  buys.forEach(row => {
    if (!row.funder) return;
    counts.set(row.funder, (counts.get(row.funder) || 0) + 1);
  });
  return new Set([...counts.entries()].filter(([, count]) => count >= 2).map(([funder]) => funder));
}

function firstSell(wallet, trades, after) {
  const sells = (trades || []).filter(row => row && row.side === 'sell' && row.wallet === wallet);
  const ordered = sells.filter(row => finite(row.time) == null || after == null || finite(row.time) >= after);
  ordered.sort((a, b) => (finite(a.time) || 0) - (finite(b.time) || 0));
  return ordered[0] || null;
}

function analyzeEarlyBuys(input = {}) {
  const createTime = finite(input.createTime);
  const createSlot = finite(input.createSlot);
  const supply = finite(input.supply);
  const dev = input.dev || null;
  const observedUntil = finite(input.observedUntil);
  const selected = selectEarlyBuys(input.trades, { createTime });
  if (selected == null) {
    return {
      mint: input.mint || null,
      buys: null,
      sameBlockCount: null,
      sameBlockSupplyPct: null,
      sol10s: null,
      sol60s: null,
      holdingPct5: null,
      holdingPct15: null,
      holdingPct60: null,
      sellPressure: null,
      knownSniperReuse: null
    };
  }
  const shared = sharedFunders(selected.map(row => ({ funder: row.funder || null })));
  const buys = selected.map(row => {
    const slot = finite(row.slot);
    const time = finite(row.time);
    const tokens = finite(row.tokens);
    const sol = finite(row.sol);
    const funder = row.funder || null;
    const sell = firstSell(row.wallet, input.trades, time);
    const sellTime = sell ? finite(sell.time) : null;
    let sold = null;
    if (sell) sold = true;
    else if (observedUntil != null && time != null && observedUntil >= time) sold = false;
    const blockOffset = createSlot != null && slot != null ? slot - createSlot : null;
    const flipMs = sold === true && sellTime != null && time != null ? sellTime - time : null;
    const sniper = blockOffset === 0 || (flipMs != null && flipMs <= 5 * 60_000);
    return {
      wallet: row.wallet,
      sol,
      supplyPct: supply != null && supply > 0 && tokens != null ? (tokens / supply) * 100 : null,
      blockOffset,
      funder,
      fundedByDev: funder ? funder === dev : null,
      bundleCluster: funder ? shared.has(funder) || funder === dev : null,
      sold,
      soldAt: sold === true ? sellTime : null,
      soldMcapUsd: sold === true && sell ? finite(sell.mcapUsd) : null,
      soldSol: sold === true && sell ? finite(sell.sol) : null,
      sniper: sniper === true
    };
  });

  const withOffset = buys.filter(row => row.blockOffset != null);
  const sameBlock = withOffset.filter(row => row.blockOffset === 0);
  const sameBlockSupply = !sameBlock.length
    ? 0
    : (sameBlock.every(row => row.supplyPct != null) ? sameBlock.reduce((sum, row) => sum + row.supplyPct, 0) : null);

  function solWithin(ms) {
    if (createTime == null) return null;
    if (selected.some(row => finite(row.time) == null)) return null;
    const timed = selected.filter(row => {
      const at = finite(row.time);
      return at >= createTime && at - createTime <= ms;
    });
    if (timed.some(row => finite(row.sol) == null)) return null;
    return timed.reduce((sum, row) => sum + Number(row.sol), 0);
  }

  function holdingPct(minutes) {
    if (createTime == null || observedUntil == null) return null;
    const horizon = createTime + minutes * 60_000;
    if (observedUntil < horizon) return null;
    const snipers = buys.filter(row => row.sniper);
    if (!snipers.length) return null;
    if (snipers.some(row => row.sold == null)) return null;
    const still = snipers.filter(row => row.sold === false || (row.soldAt != null && row.soldAt > horizon)).length;
    return (still / snipers.length) * 100;
  }

  const sniperSells = buys.filter(row => row.sniper && row.sold === true);
  const organic = (input.trades || []).filter(row => {
    if (!row || row.side === 'sell' || !row.wallet) return false;
    return !buys.some(buy => buy.wallet === row.wallet);
  });
  let sellPressure = null;
  const soldKnown = sniperSells.length > 0 && sniperSells.every(row => row.soldSol != null);
  const organicKnown = organic.length > 0 && organic.every(row => finite(row.sol) != null);
  if (soldKnown && organicKnown) {
    const soldSol = sniperSells.reduce((sum, row) => sum + row.soldSol, 0);
    const organicSol = organic.reduce((sum, row) => sum + Number(row.sol), 0);
    sellPressure = organicSol > 0 ? soldSol / organicSol : null;
  }

  return {
    mint: input.mint || null,
    buys,
    sameBlockCount: withOffset.length ? sameBlock.length : null,
    sameBlockSupplyPct: withOffset.length ? sameBlockSupply : null,
    sol10s: solWithin(10_000),
    sol60s: solWithin(60_000),
    holdingPct5: holdingPct(5),
    holdingPct15: holdingPct(15),
    holdingPct60: holdingPct(60),
    sellPressure,
    knownSniperReuse: null
  };
}

function updateRegistry(registry, analyses) {
  const book = registry && registry.wallets ? registry : { wallets: {} };
  for (const analysis of analyses || []) {
    for (const buy of analysis.buys || []) {
      if (!buy.sniper || !buy.wallet) continue;
      const slot = book.wallets[buy.wallet] || { mints: [] };
      if (analysis.mint && !slot.mints.includes(analysis.mint)) slot.mints.push(analysis.mint);
      book.wallets[buy.wallet] = slot;
    }
  }
  for (const analysis of analyses || []) {
    if (!analysis.buys) {
      analysis.knownSniperReuse = null;
      continue;
    }
    const reused = analysis.buys.filter(buy => buy.sniper && book.wallets[buy.wallet] && book.wallets[buy.wallet].mints.length >= 2);
    analysis.knownSniperReuse = reused.length;
  }
  return book;
}

function ownLaunchSnipers(ownMints, analyses) {
  return (ownMints || []).map(mint => {
    const row = (analyses || []).find(item => item && item.mint === mint);
    if (!row || row.buys == null) {
      return {
        mint,
        known: false,
        sameBlockCount: null,
        sameBlockSupplyPct: null,
        sol60s: null,
        holdingPct5: null,
        sellPressure: null,
        knownSniperReuse: null
      };
    }
    return {
      mint,
      known: true,
      sameBlockCount: row.sameBlockCount,
      sameBlockSupplyPct: row.sameBlockSupplyPct,
      sol60s: row.sol60s,
      holdingPct5: row.holdingPct5,
      sellPressure: row.sellPressure,
      knownSniperReuse: row.knownSniperReuse
    };
  });
}

module.exports = {
  selectEarlyBuys,
  analyzeEarlyBuys,
  updateRegistry,
  ownLaunchSnipers
};
