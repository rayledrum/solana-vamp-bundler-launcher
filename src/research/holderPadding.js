const DUST_SUPPLY_PCT = 0.01;

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function emptyPadding(mint) {
  return {
    mint: mint || null,
    noBuyHolderPct: null,
    dustHolderCount: null,
    paddedHolderPct: null
  };
}

function buyerSet(buys) {
  if (!Array.isArray(buys)) return null;
  return new Set(buys.map(row => (typeof row === 'string' ? row : row && row.wallet)).filter(Boolean));
}

function analyzeHolderPadding(input = {}) {
  const hasHolders = Array.isArray(input.holders);
  const hasTransfers = Array.isArray(input.transfers);
  if (!hasHolders && !hasTransfers) return emptyPadding(input.mint);
  const supply = finite(input.supply);
  const buyers = buyerSet(input.buys);
  const holders = hasHolders ? input.holders.filter(row => row && row.wallet) : null;
  let dustRecipients = null;
  if (hasTransfers && supply != null && supply > 0 && input.transfers.every(row => !row || row.side === 'buy' || row.side === 'sell' || finite(row.tokens) != null)) {
    dustRecipients = new Set();
    input.transfers.forEach(row => {
      if (!row || row.side === 'buy' || row.side === 'sell' || !row.to) return;
      const tokens = finite(row.tokens);
      if (tokens == null) return;
      if ((tokens / supply) * 100 <= DUST_SUPPLY_PCT) dustRecipients.add(row.to);
    });
  }
  const freshDust = dustRecipients && buyers
    ? [...dustRecipients].filter(wallet => !buyers.has(wallet))
    : null;
  let dustHolderCount = null;
  let noBuyHolderPct = null;
  let paddedHolderPct = null;
  if (holders && buyers) {
    const noBuy = holders.filter(row => !buyers.has(row.wallet));
    noBuyHolderPct = holders.length ? (noBuy.length / holders.length) * 100 : null;
    if (freshDust) {
      const padded = holders.filter(row => freshDust.includes(row.wallet));
      dustHolderCount = padded.length;
      paddedHolderPct = holders.length ? (padded.length / holders.length) * 100 : null;
    }
  } else if (freshDust && !holders) {
    dustHolderCount = freshDust.length;
  }
  return {
    mint: input.mint || null,
    noBuyHolderPct,
    dustHolderCount,
    paddedHolderPct
  };
}

module.exports = { analyzeHolderPadding, DUST_SUPPLY_PCT };
