function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function emptyLadder(mint) {
  return {
    mint: mint || null,
    flagged: null,
    soldSol: null,
    soldSupplyPct: null,
    cadence: null
  };
}

function variation(values) {
  if (!values || values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (!(mean > 0)) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function walletSet(input) {
  if (input.dev == null && !Array.isArray(input.linked) && !Array.isArray(input.clusterWallets)) return null;
  const wallets = new Set();
  if (input.dev) wallets.add(input.dev);
  (input.linked || []).forEach(wallet => wallet && wallets.add(wallet));
  (input.clusterWallets || []).forEach(wallet => wallet && wallets.add(wallet));
  return wallets;
}

function analyzeLadderDump(input = {}) {
  if (!Array.isArray(input.trades)) return emptyLadder(input.mint);
  const wallets = walletSet(input);
  if (!wallets) return emptyLadder(input.mint);
  const sells = input.trades.filter(row => row && row.side === 'sell' && wallets.has(row.wallet));
  const supply = finite(input.supply);
  const solKnown = sells.every(row => finite(row.sol) != null);
  const tokenKnown = supply != null && supply > 0 && sells.every(row => finite(row.tokens) != null);
  const soldSol = solKnown ? sells.reduce((sum, row) => sum + row.sol, 0) : null;
  const soldSupplyPct = tokenKnown ? (sells.reduce((sum, row) => sum + row.tokens, 0) / supply) * 100 : null;
  const distinct = new Set(sells.map(row => row.wallet));
  if (sells.length < 3 || distinct.size < 3) {
    return { mint: input.mint || null, flagged: false, soldSol, soldSupplyPct, cadence: null };
  }
  const timed = sells.every(row => finite(row.time) != null)
    ? sells.slice().sort((a, b) => a.time - b.time)
    : null;
  const gaps = timed ? timed.slice(1).map((row, index) => row.time - timed[index].time) : null;
  const gapCv = gaps ? variation(gaps) : null;
  const sizeCv = solKnown ? variation(sells.map(row => row.sol)) : null;
  const evenTime = gapCv != null && gapCv <= 0.15 && gaps.every(gap => gap >= 5_000);
  const evenSize = sizeCv != null && sizeCv <= 0.15;
  const flagged = evenTime || evenSize;
  let cadence = null;
  if (evenTime) {
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    cadence = `every ${Math.round(mean / 1000)}s`;
  } else if (evenSize) {
    cadence = 'even slice size';
  }
  return { mint: input.mint || null, flagged, soldSol, soldSupplyPct, cadence };
}

module.exports = { analyzeLadderDump };
