const MICRO_SOL = 0.002;
const WINDOW_MS = 5 * 60 * 1000;
const AMOUNT_BAND = 0.03;
const MICRO_FLOOD = 8;

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function amountsClose(left, right) {
  const hi = Math.max(left, right);
  if (!(hi > 0)) return false;
  return Math.abs(left - right) / hi <= AMOUNT_BAND;
}

function emptyWash(mint) {
  return {
    mint: mint || null,
    washVolumePct: null,
    microBuyTxShare: null,
    washSol: null,
    totalVolumeSol: null,
    reasons: null
  };
}

function linkRoots(fundings) {
  if (!Array.isArray(fundings)) return null;
  const roots = new Map();
  fundings.forEach(row => {
    if (!row || !row.wallet || !row.funder || row.cex) return;
    roots.set(row.wallet, row.ancestor || row.funder);
  });
  return roots;
}

function analyzeWash(input = {}) {
  if (!Array.isArray(input.trades)) return emptyWash(input.mint);
  const trades = input.trades.filter(row => row && (row.side === 'buy' || row.side === 'sell'));
  const incomplete = trades.some(row => finite(row.sol) == null || finite(row.time) == null || !row.wallet);
  const buys = trades.filter(row => row.side === 'buy');
  const sells = trades.filter(row => row.side === 'sell');
  const buysKnown = buys.every(row => finite(row.sol) != null);
  const micro = buysKnown ? buys.filter(row => row.sol <= MICRO_SOL && row.sol > 0).length : null;
  const microBuyTxShare = buys.length === 0 ? 0 : (buysKnown ? (micro / buys.length) * 100 : null);
  const roots = linkRoots(input.fundings);
  const usedSells = new Set();
  let washSol = 0;
  let sawSelf = false;
  let sawLinked = false;
  buys.forEach(buy => {
    const buySol = finite(buy.sol);
    const buyTime = finite(buy.time);
    if (buySol == null || buyTime == null || !buy.wallet) return;
    sells.forEach(sell => {
      if (usedSells.has(sell)) return;
      const sellSol = finite(sell.sol);
      const sellTime = finite(sell.time);
      if (sellSol == null || sellTime == null || !sell.wallet) return;
      if (Math.abs(sellTime - buyTime) > WINDOW_MS) return;
      if (!amountsClose(buySol, sellSol)) return;
      const same = buy.wallet === sell.wallet;
      const linked = !same && roots && roots.get(buy.wallet) && roots.get(buy.wallet) === roots.get(sell.wallet);
      if (!same && !linked) return;
      usedSells.add(sell);
      washSol += Math.min(buySol, sellSol);
      if (same) sawSelf = true;
      if (linked) sawLinked = true;
    });
  });
  trades.forEach(row => {
    if (row.counterparty && row.counterparty === row.wallet) sawSelf = true;
  });
  const totalKnown = trades.every(row => finite(row.sol) != null);
  const totalVolumeSol = trades.length === 0 ? 0 : (totalKnown ? trades.reduce((sum, row) => sum + row.sol, 0) : null);
  const washVolumePct = incomplete || totalVolumeSol == null
    ? null
    : (totalVolumeSol > 0 ? (washSol / totalVolumeSol) * 100 : 0);
  const reasons = [];
  if (sawSelf) reasons.push('self-trade');
  if (sawLinked) reasons.push('same-amount round trip between linked wallets');
  if (!sawSelf && !sawLinked && washSol > 0) reasons.push('same-amount round trip');
  if (micro != null && micro >= MICRO_FLOOD) reasons.push('flood of tiny buys');
  return {
    mint: input.mint || null,
    washVolumePct,
    microBuyTxShare,
    washSol: incomplete ? null : washSol,
    totalVolumeSol,
    reasons: trades.length === 0 ? [] : (incomplete && !reasons.length ? null : reasons)
  };
}

module.exports = { analyzeWash, MICRO_SOL };
