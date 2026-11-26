function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function emptyDevExit(mint) {
  return {
    mint: mint || null,
    sells: null,
    timeToFirstSellMs: null,
    fullyExited: null,
    fullyExitedAt: null,
    associated: null,
    associatedHoldPct: null,
    beforeFirstSell: null,
    afterFirstSell: null,
    afterFullExit: null,
    mcapAfterFirstSell: null
  };
}

function associatedWallets(trades, dev) {
  if (!Array.isArray(trades) || !dev) return null;
  const fundersKnown = trades.some(row => row && row.funder);
  if (!fundersKnown && !trades.some(row => row && row.bundleCluster === true)) return null;
  const devFunder = (trades.find(row => row && row.wallet === dev && row.funder) || {}).funder || null;
  const wallets = new Set();
  trades.forEach(row => {
    if (!row || !row.wallet || row.wallet === dev) return;
    const fundedByDev = row.funder && row.funder === dev;
    const sameFunder = devFunder && row.funder === devFunder;
    if (fundedByDev || sameFunder || row.bundleCluster === true) wallets.add(row.wallet);
  });
  return wallets;
}

function netTokens(wallet, trades) {
  let net = 0;
  let known = false;
  for (const row of trades || []) {
    if (!row || row.wallet !== wallet) continue;
    const tokens = finite(row.tokens);
    if (tokens == null) return null;
    known = true;
    net += row.side === 'sell' ? -tokens : tokens;
  }
  return known ? Math.max(0, net) : null;
}

function windowStats(trades, wallets, from, to) {
  if (from == null || to == null || !(to > from)) return null;
  const organic = (trades || []).filter(row => {
    if (!row || row.side === 'sell' || !row.wallet || wallets.has(row.wallet)) return false;
    const at = finite(row.time);
    return at != null && at >= from && at < to;
  });
  if (organic.some(row => finite(row.time) == null)) return null;
  const minutes = (to - from) / 60000;
  const unique = new Set(organic.map(row => row.wallet));
  return {
    buys: organic.length,
    uniqueBuyers: unique.size,
    buyRatePerMin: minutes > 0 ? organic.length / minutes : null
  };
}

function analyzeDevExit(input = {}) {
  if (!Array.isArray(input.trades) || !input.dev) return emptyDevExit(input.mint);
  const createTime = finite(input.createTime);
  const supply = finite(input.supply);
  const initialBag = finite(input.initialDevTokens);
  const observedUntil = finite(input.observedUntil);
  const sells = input.trades
    .filter(row => row && row.side === 'sell' && row.wallet === input.dev)
    .map(row => {
      const tokens = finite(row.tokens);
      return {
        time: finite(row.time),
        bagPct: initialBag != null && initialBag > 0 && tokens != null ? (tokens / initialBag) * 100 : null,
        mcapUsd: finite(row.mcapUsd),
        tokens
      };
    })
    .sort((a, b) => (a.time == null ? 1 : 0) - (b.time == null ? 1 : 0) || (a.time || 0) - (b.time || 0));

  const timed = sells.filter(row => row.time != null);
  const timeToFirstSellMs = timed.length && createTime != null ? timed[0].time - createTime : null;
  const soldTokens = sells.every(row => row.tokens != null) ? sells.reduce((sum, row) => sum + row.tokens, 0) : null;
  let fullyExited = null;
  let fullyExitedAt = null;
  if (initialBag != null && initialBag > 0 && soldTokens != null) {
    fullyExited = soldTokens >= initialBag * 0.99;
    if (fullyExited) {
      let running = 0;
      for (const row of sells) {
        running += row.tokens;
        if (running >= initialBag * 0.99) {
          fullyExitedAt = row.time;
          break;
        }
      }
    } else if (observedUntil == null) {
      fullyExited = null;
    }
  }

  const linked = associatedWallets(input.trades, input.dev);
  let associated = null;
  let associatedHoldPct = null;
  if (linked) {
    associated = [...linked].map(wallet => {
      const remaining = netTokens(wallet, input.trades);
      const sawSell = input.trades.some(row => row && row.side === 'sell' && row.wallet === wallet);
      return {
        wallet,
        holdPct: supply != null && supply > 0 && remaining != null ? (remaining / supply) * 100 : null,
        sold: sawSell ? true : (observedUntil != null ? false : null)
      };
    });
    if (supply != null && supply > 0 && associated.every(row => row.holdPct != null)) {
      associatedHoldPct = associated.reduce((sum, row) => sum + row.holdPct, 0);
    }
  }

  const excluded = new Set([input.dev, ...(linked || [])]);
  const firstAt = timed.length ? timed[0].time : null;
  const beforeFirstSell = firstAt != null ? windowStats(input.trades, excluded, createTime, firstAt) : null;
  const afterSpan = firstAt != null && timeToFirstSellMs != null ? firstAt + timeToFirstSellMs : null;
  const afterFirstSell = afterSpan != null ? windowStats(input.trades, excluded, firstAt, afterSpan) : null;
  const afterFullExit = fullyExitedAt != null && observedUntil != null
    ? windowStats(input.trades, excluded, fullyExitedAt, observedUntil)
    : null;
  const mcapAfterFirstSell = firstAt == null || !Array.isArray(input.snapshots)
    ? null
    : input.snapshots
      .filter(row => finite(row.time) != null && row.time >= firstAt)
      .map(row => ({ time: finite(row.time), mcapUsd: finite(row.mcapUsd) }));

  return {
    mint: input.mint || null,
    sells: sells.map(row => ({ time: row.time, bagPct: row.bagPct, mcapUsd: row.mcapUsd })),
    timeToFirstSellMs,
    fullyExited,
    fullyExitedAt,
    associated,
    associatedHoldPct,
    beforeFirstSell,
    afterFirstSell,
    afterFullExit,
    mcapAfterFirstSell
  };
}

function compareDevExit(paths, { earlyMs = 10 * 60 * 1000 } = {}) {
  const early = [];
  const held = [];
  for (const row of paths || []) {
    const exit = row && row.devExit;
    if (!exit || row.pnl == null) continue;
    if (exit.timeToFirstSellMs != null && exit.timeToFirstSellMs <= earlyMs) early.push(row.pnl);
    else if (exit.fullyExited === false) held.push(row.pnl);
  }
  const pack = (values) => ({
    n: values.length,
    hitRate: values.length ? values.filter(value => value > 0).length / values.length : null,
    avgPnl: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    medianPnl: median(values)
  });
  return { early: pack(early), held: pack(held) };
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

module.exports = { analyzeDevExit, compareDevExit };
