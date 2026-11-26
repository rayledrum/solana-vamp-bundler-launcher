const DEFAULT_WINDOW_MIN = 10;

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function emptyMigration(mint) {
  return {
    mint: mint || null,
    flagged: null,
    dumpedSupplyPct: null,
    firstDumpMs: null,
    windowMinutes: null
  };
}

function analyzeMigrationDump(input = {}) {
  if (input.graduated == null || finite(input.graduatedAt) == null || !Array.isArray(input.trades)) return emptyMigration(input.mint);
  const windowMinutes = finite(input.windowMinutes) || DEFAULT_WINDOW_MIN;
  if (input.graduated !== true) {
    return { mint: input.mint || null, flagged: false, dumpedSupplyPct: 0, firstDumpMs: null, windowMinutes };
  }
  if (!Array.isArray(input.earlyWallets) && !Array.isArray(input.coordinatedWallets)) return emptyMigration(input.mint);
  const watch = new Set([...(input.earlyWallets || []), ...(input.coordinatedWallets || [])]);
  const windowMs = windowMinutes * 60 * 1000;
  const sells = input.trades.filter(row => {
    const at = finite(row && row.time);
    return row && row.side === 'sell' && row.wallet && watch.has(row.wallet) && at != null && at >= input.graduatedAt && at - input.graduatedAt <= windowMs;
  });
  const watchedSells = input.trades.filter(row => row && row.side === 'sell' && row.wallet && watch.has(row.wallet));
  if (watchedSells.some(row => finite(row.time) == null)) return emptyMigration(input.mint);
  if (!sells.length) {
    return { mint: input.mint || null, flagged: false, dumpedSupplyPct: 0, firstDumpMs: null, windowMinutes };
  }
  const supply = finite(input.supply);
  const tokensKnown = sells.every(row => finite(row.tokens) != null);
  const dumpedSupplyPct = supply != null && supply > 0 && tokensKnown
    ? (sells.reduce((sum, row) => sum + row.tokens, 0) / supply) * 100
    : null;
  const firstDumpMs = Math.min(...sells.map(row => row.time - input.graduatedAt));
  return { mint: input.mint || null, flagged: true, dumpedSupplyPct, firstDumpMs, windowMinutes };
}

module.exports = { analyzeMigrationDump, DEFAULT_WINDOW_MIN };
