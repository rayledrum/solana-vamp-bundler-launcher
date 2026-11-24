const BASE_SIGNATURE_FEE_SOL = 5000 / 1e9;

function knownTradeFeeSol(priorityFeeSol) {
  const priority = Number(priorityFeeSol);
  return (Number.isFinite(priority) && priority > 0 ? priority : 0) + BASE_SIGNATURE_FEE_SOL;
}

function emptyBook() {
  return { tokens: 0, costBasisSol: 0, realizedSol: 0 };
}

function applyBuy(book, { tokensBought, solSpent }) {
  const tokens = Math.max(0, Number(tokensBought) || 0);
  const spent = Math.max(0, Number(solSpent) || 0);
  return {
    tokens: book.tokens + tokens,
    costBasisSol: book.costBasisSol + spent,
    realizedSol: book.realizedSol
  };
}

function applySell(book, { tokensSold, solReceived }) {
  const requested = Math.max(0, Number(tokensSold) || 0);
  const sold = Math.min(requested, book.tokens);
  const fraction = book.tokens > 0 ? sold / book.tokens : 0;
  const costRemoved = book.costBasisSol * fraction;
  const received = Math.max(0, Number(solReceived) || 0);
  return {
    tokens: book.tokens - sold,
    costBasisSol: book.costBasisSol - costRemoved,
    realizedSol: book.realizedSol + (received - costRemoved)
  };
}

// Holdings come from the chain. Cost basis comes from confirmed fills.
// A missing price leaves unrealized PnL unknown instead of using a stand-in.
function quotePosition(book, onChainTokens, priceSolPerToken) {
  const tokens = onChainTokens == null ? book.tokens : Math.max(0, Number(onChainTokens) || 0);
  const price = Number(priceSolPerToken);
  const priced = Number.isFinite(price) && price > 0;
  const unrealizedSol = priced ? (tokens * price) - book.costBasisSol : null;
  const pnlSol = unrealizedSol == null ? null : book.realizedSol + unrealizedSol;
  const pnlPct = pnlSol == null || book.costBasisSol <= 0 ? null : (pnlSol / book.costBasisSol) * 100;
  return {
    tokens,
    costBasisSol: book.costBasisSol,
    realizedSol: book.realizedSol,
    unrealizedSol,
    pnlSol,
    pnlPct
  };
}

function priceFromTrade(trade) {
  if (!trade || trade.simulated) return null;
  const sol = Number(trade.solAmount);
  const tokens = Number(trade.tokenAmount);
  if (sol > 0 && tokens > 0) return sol / tokens;
  const mcap = Number(trade.marketCapSol);
  if (mcap > 0) return mcap / 1e9;
  return null;
}

module.exports = {
  BASE_SIGNATURE_FEE_SOL,
  knownTradeFeeSol,
  emptyBook,
  applyBuy,
  applySell,
  quotePosition,
  priceFromTrade
};
