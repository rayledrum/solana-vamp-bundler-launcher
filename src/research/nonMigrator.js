const { analyzeMigrationDump } = require('./migrationDump');

const DEFAULT_PROGRESS = 90;
const DEFAULT_WINDOW_MIN = 10;

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function analyzeNearMigration(input = {}) {
  if (input.graduated == null || !Array.isArray(input.trades) || !Array.isArray(input.linkedWallets)) {
    return { mint: input.mint || null, flagged: null, curveProgress: finite(input.curveProgress), sellCount: null };
  }
  if (input.graduated === true) {
    return { mint: input.mint || null, flagged: false, curveProgress: finite(input.curveProgress), sellCount: 0 };
  }
  const threshold = finite(input.progressThreshold) == null ? DEFAULT_PROGRESS : finite(input.progressThreshold);
  const series = Array.isArray(input.progress) ? input.progress : null;
  const linked = new Set(input.linkedWallets);
  const sells = input.trades.filter(row => row && row.side === 'sell' && linked.has(row.wallet) && finite(row.time) != null);
  let crossedAt = null;
  if (series) {
    const known = series.filter(row => finite(row && row.curveProgress) != null && finite(row.time) != null);
    if (!known.length) return { mint: input.mint || null, flagged: null, curveProgress: null, sellCount: null };
    const hit = known.find(row => row.curveProgress >= threshold && row.complete !== true);
    if (!hit) return { mint: input.mint || null, flagged: false, curveProgress: finite(input.curveProgress), sellCount: 0 };
    crossedAt = hit.time;
  } else if (finite(input.curveProgress) == null) {
    return { mint: input.mint || null, flagged: null, curveProgress: null, sellCount: null };
  } else if (input.curveProgress < threshold) {
    return { mint: input.mint || null, flagged: false, curveProgress: input.curveProgress, sellCount: 0 };
  }
  const started = sells.filter(row => crossedAt == null || row.time >= crossedAt);
  return {
    mint: input.mint || null,
    flagged: started.length > 0,
    curveProgress: finite(input.curveProgress),
    sellCount: started.length,
    startedAt: started.length ? started[0].time : null
  };
}

function analyzeForcedMigration(input = {}) {
  if (input.graduated == null || finite(input.graduatedAt) == null || !Array.isArray(input.trades) || !Array.isArray(input.linkedWallets)) {
    return { mint: input.mint || null, flagged: null, dumpedSupplyPct: null, firstDumpMs: null };
  }
  if (input.graduated !== true) {
    return { mint: input.mint || null, flagged: false, dumpedSupplyPct: 0, firstDumpMs: null };
  }
  const windowMin = finite(input.windowMinutes) == null ? DEFAULT_WINDOW_MIN : finite(input.windowMinutes);
  const before = input.trades.filter(row => {
    const at = finite(row && row.time);
    return row && row.side === 'buy' && at != null && at <= input.graduatedAt && input.graduatedAt - at <= 2 * 60 * 1000 && !input.linkedWallets.includes(row.wallet);
  });
  if (!before.length || before.some(row => finite(row.sol) == null)) {
    return { mint: input.mint || null, flagged: null, dumpedSupplyPct: null, firstDumpMs: null };
  }
  const largest = before.reduce((best, row) => row.sol > best.sol ? row : best, before[0]);
  const others = before.filter(row => row !== largest);
  const large = !others.length || largest.sol >= Math.max(...others.map(row => row.sol)) * 2;
  if (!large) return { mint: input.mint || null, flagged: false, dumpedSupplyPct: 0, firstDumpMs: null };
  const poolTrades = input.trades.filter(row => row && (row.venue === 'pump-swap' || row.pool === true || row.side !== 'sell'));
  const sells = input.trades.filter(row => row && row.side === 'sell');
  if (sells.length && sells.every(row => row.venue == null && row.pool == null)) {
    return { mint: input.mint || null, flagged: null, dumpedSupplyPct: null, firstDumpMs: null };
  }
  const dump = analyzeMigrationDump({
    mint: input.mint,
    graduated: true,
    graduatedAt: input.graduatedAt,
    trades: poolTrades,
    earlyWallets: input.linkedWallets,
    supply: input.supply,
    windowMinutes: windowMin
  });
  return {
    mint: input.mint || null,
    flagged: dump.flagged,
    dumpedSupplyPct: dump.dumpedSupplyPct,
    firstDumpMs: dump.firstDumpMs
  };
}

function labelNonMigrators(input = {}) {
  if (!Array.isArray(input.coins)) return { nonMigrator: null, history: null };
  const devs = new Set(input.linkedDevs || []);
  if (input.dev) devs.add(input.dev);
  if (!devs.size) return { nonMigrator: null, history: null };
  const priors = input.coins.filter(row => row && row.mint !== input.mint && devs.has(row.dev));
  if (!priors.length) return { nonMigrator: false, history: [] };
  const known = priors.filter(row => row.nearMigration != null || row.forcedDump != null);
  if (!known.length) return { nonMigrator: null, history: null };
  const hits = known.filter(row => row.nearMigration === true || row.forcedDump === true);
  return {
    nonMigrator: hits.length > 0,
    history: hits.map(row => ({
      mint: row.mint,
      dev: row.dev,
      nearMigration: row.nearMigration === true,
      forcedDump: row.forcedDump === true
    }))
  };
}

function summarizeNonMigrators(coins, options = {}) {
  const threshold = finite(options.progressThreshold) == null ? DEFAULT_PROGRESS : finite(options.progressThreshold);
  const rows = [];
  (coins || []).forEach(coin => {
    if (!coin) return;
    const label = labelNonMigrators({
      mint: coin.mint,
      dev: coin.dev,
      linkedDevs: coin.linkedDevs,
      coins: coin.history || coins
    });
    if (!label || label.nonMigrator == null) return;
    const progress = finite(coin.curveProgress);
    const nearLine = progress != null && coin.graduated === false && progress >= threshold;
    rows.push({
      mint: coin.mint,
      nonMigrator: label.nonMigrator,
      skipped: label.nonMigrator === true && nearLine,
      history: label.history
    });
  });
  const labeled = rows.filter(row => row.nonMigrator);
  return {
    progressThreshold: threshold,
    labeled: labeled.length,
    skippedNearLine: rows.filter(row => row.skipped).length,
    history: labeled.map(row => ({ mint: row.mint, history: row.history }))
  };
}

module.exports = {
  analyzeNearMigration,
  analyzeForcedMigration,
  labelNonMigrators,
  summarizeNonMigrators,
  DEFAULT_PROGRESS,
  DEFAULT_WINDOW_MIN
};
