const DEFAULT_TOP_N = 20;

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function emptyTopTraders(mint) {
  return {
    mint: mint || null,
    wallets: null,
    linkedProfitPct: null,
    organicProfitPct: null,
    topN: null
  };
}

function blank(wallet) {
  return {
    wallet,
    solIn: 0,
    solOut: 0,
    solKnown: true,
    tokensBought: 0,
    tokensReceived: 0,
    tokensSold: 0,
    tokensKnown: true,
    firstSeen: null
  };
}

function markTime(row, time) {
  const at = finite(time);
  if (at != null && (row.firstSeen == null || at < row.firstSeen)) row.firstSeen = at;
}

function membership(wallet, input) {
  const cluster = Array.isArray(input.clusterWallets) ? new Set(input.clusterWallets) : null;
  const kol = Array.isArray(input.kolWallets) ? new Set(input.kolWallets) : null;
  const shadow = Array.isArray(input.shadowWallets)
    ? new Set(input.shadowWallets.map(row => typeof row === 'string' ? row : row && row.wallet).filter(Boolean))
    : null;
  const serial = Array.isArray(input.serialWallets) ? new Set(input.serialWallets) : null;
  const registry = input.registry && input.registry.wallets ? input.registry.wallets : null;
  const flags = {
    coordinated: cluster ? cluster.has(wallet) : null,
    kol: kol ? kol.has(wallet) : null,
    kolShadow: shadow ? shadow.has(wallet) : null,
    serialDev: serial ? serial.has(wallet) : null,
    sniper: registry ? Boolean(registry[wallet] && Array.isArray(registry[wallet].mints) && registry[wallet].mints.length) : null
  };
  const known = Object.values(flags).filter(value => value != null);
  return { ...flags, linked: known.length ? known.some(Boolean) : null };
}

function pnlFor(row, priceSol) {
  if (!row.tokensKnown || !row.solKnown) {
    return { realizedPnl: null, unrealizedPnl: null, pnl: null };
  }
  const remaining = row.tokensBought + row.tokensReceived - row.tokensSold;
  if (remaining < -1e-9) return { realizedPnl: null, unrealizedPnl: null, pnl: null };
  const soldFromBuys = Math.min(row.tokensSold, row.tokensBought);
  const soldFromTransfer = row.tokensSold - soldFromBuys;
  let realized = null;
  if (soldFromTransfer > 0) realized = null;
  else if (row.tokensBought > 0) realized = row.solOut - row.solIn * (soldFromBuys / row.tokensBought);
  else realized = row.tokensSold === 0 ? 0 : null;
  let unrealized = null;
  if (remaining <= 1e-9) unrealized = 0;
  else if (row.tokensReceived > 0 || soldFromTransfer > 0 || finite(priceSol) == null) unrealized = null;
  else {
    const unsoldBuys = row.tokensBought - soldFromBuys;
    const costLeft = row.tokensBought > 0 ? row.solIn * (unsoldBuys / row.tokensBought) : 0;
    unrealized = remaining * priceSol - costLeft;
  }
  return {
    realizedPnl: realized,
    unrealizedPnl: unrealized,
    pnl: realized != null && unrealized != null ? realized + unrealized : null
  };
}

function analyzeTopTraders(input = {}) {
  if (!Array.isArray(input.trades)) return emptyTopTraders(input.mint);
  const books = new Map();
  const book = (wallet) => {
    if (!books.has(wallet)) books.set(wallet, blank(wallet));
    return books.get(wallet);
  };
  input.trades.forEach(row => {
    if (!row || !row.wallet || (row.side !== 'buy' && row.side !== 'sell')) return;
    const entry = book(row.wallet);
    markTime(entry, row.time);
    const sol = finite(row.sol);
    const tokens = finite(row.tokens);
    if (sol == null) entry.solKnown = false;
    if (tokens == null) entry.tokensKnown = false;
    if (row.side === 'buy') {
      if (sol != null) entry.solIn += sol;
      if (tokens != null) entry.tokensBought += tokens;
    } else {
      if (sol != null) entry.solOut += sol;
      if (tokens != null) entry.tokensSold += tokens;
    }
  });
  const transfers = Array.isArray(input.transfers) ? input.transfers : input.trades.filter(row => row && row.side === 'transfer');
  transfers.forEach(row => {
    if (!row || row.side === 'buy' || row.side === 'sell' || !row.to) return;
    const entry = book(row.to);
    markTime(entry, row.time);
    const tokens = finite(row.tokens);
    if (tokens == null) entry.tokensKnown = false;
    else entry.tokensReceived += tokens;
  });
  const createTime = finite(input.createTime);
  const priceSol = finite(input.priceSol);
  const topN = finite(input.topN) == null ? DEFAULT_TOP_N : finite(input.topN);
  const ranked = [...books.values()].map(row => {
    const flags = membership(row.wallet, input);
    const profit = pnlFor(row, priceSol);
    return {
      wallet: row.wallet,
      pnl: profit.pnl,
      realizedPnl: profit.realizedPnl,
      unrealizedPnl: profit.unrealizedPnl,
      solIn: row.solKnown ? row.solIn : null,
      solOut: row.solKnown ? row.solOut : null,
      tokensBought: row.tokensKnown ? row.tokensBought : null,
      tokensReceived: row.tokensKnown ? row.tokensReceived : null,
      firstSeen: row.firstSeen,
      firstSeenOffsetMs: row.firstSeen != null && createTime != null ? row.firstSeen - createTime : null,
      ...flags
    };
  }).sort((a, b) => {
    if (a.pnl != null && b.pnl != null && a.pnl !== b.pnl) return b.pnl - a.pnl;
    if (a.pnl != null && b.pnl == null) return -1;
    if (a.pnl == null && b.pnl != null) return 1;
    const aNet = a.solIn != null && a.solOut != null ? a.solOut - a.solIn : null;
    const bNet = b.solIn != null && b.solOut != null ? b.solOut - b.solIn : null;
    if (aNet != null && bNet != null && aNet !== bNet) return bNet - aNet;
    return String(a.wallet).localeCompare(String(b.wallet));
  });
  const wallets = ranked.slice(0, Math.max(0, topN));
  const priced = wallets.length > 0 && wallets.every(row => row.pnl != null && row.linked != null);
  const profit = priced ? wallets.reduce((sum, row) => sum + Math.max(0, row.pnl), 0) : null;
  const linkedProfit = priced ? wallets.filter(row => row.linked).reduce((sum, row) => sum + Math.max(0, row.pnl), 0) : null;
  return {
    mint: input.mint || null,
    wallets,
    linkedProfitPct: profit == null ? null : (profit > 0 ? (linkedProfit / profit) * 100 : 0),
    organicProfitPct: profit == null ? null : (profit > 0 ? ((profit - linkedProfit) / profit) * 100 : 0),
    topN
  };
}

module.exports = { analyzeTopTraders, DEFAULT_TOP_N };
