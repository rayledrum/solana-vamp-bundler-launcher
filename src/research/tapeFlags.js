const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_BOND_MS = 10 * 60 * 1000;
const MC_RUN_MIN_BUYS = 5;
const MC_RUN_RATIO = 3;
const SCALE_MIN_SELLS = 4;
const SCALE_WINDOW_MS = 10 * 60 * 1000;

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function amountsClose(left, right) {
  const hi = Math.max(left, right);
  if (!(hi > 0)) return false;
  return Math.abs(left - right) / hi <= 0.03;
}

function shareOf(row, supply) {
  if (!row) return null;
  if (finite(row.supplyPct) != null) return finite(row.supplyPct);
  const tokens = finite(row.tokens);
  if (tokens != null && finite(supply) > 0) return (tokens / supply) * 100;
  return null;
}

function analyzeKolShadow(input = {}) {
  const mint = input.mint || null;
  if (!Array.isArray(input.trades) || !Array.isArray(input.kolWallets)) {
    return { mint, shadowCount: null, supplyPct: null, reasons: null, wallets: null, repeat: null };
  }
  const windowMs = finite(input.windowMs) == null ? DEFAULT_WINDOW_MS : finite(input.windowMs);
  const kols = new Set(input.kolWallets.filter(Boolean));
  const trades = input.trades;
  const transfers = (Array.isArray(input.transfers) ? input.transfers : trades)
    .filter(row => row && row.side === 'transfer');
  const kolBuys = trades.filter(row => row && row.side === 'buy' && kols.has(row.wallet) && finite(row.time) != null);
  if (!kolBuys.length) {
    return { mint, shadowCount: 0, supplyPct: 0, reasons: [], wallets: [], repeat: false };
  }
  const fundings = Array.isArray(input.fundings) ? input.fundings : null;
  const dev = input.dev || null;
  const shadows = new Map();
  const note = (wallet, reason, supplyPct, kol) => {
    if (!wallet || kols.has(wallet)) return;
    const current = shadows.get(wallet) || { wallet, reasons: [], supplyPct: null, kol };
    if (!current.reasons.includes(reason)) current.reasons.push(reason);
    if (current.supplyPct == null && supplyPct != null) current.supplyPct = supplyPct;
    if (!current.kol) current.kol = kol;
    shadows.set(wallet, current);
  };
  const inWindow = (at, buyAt) => at != null && Math.abs(at - buyAt) <= windowMs;
  kolBuys.forEach(buy => {
    transfers.forEach(row => {
      if (!inWindow(finite(row.time), buy.time) || !row.to) return;
      note(row.to, 'bare token transfer', shareOf(row, input.supply), buy.wallet);
    });
    trades.filter(row => row && row.side === 'sell' && row.wallet && !kols.has(row.wallet)).forEach(sell => {
      const at = finite(sell.time);
      const sol = finite(sell.sol);
      if (at == null || sol == null || at < buy.time || at - buy.time > windowMs) return;
      const ownBuys = trades.filter(row => row && row.side === 'buy' && row.wallet === sell.wallet && finite(row.time) != null && row.time <= at);
      if (ownBuys.some(row => finite(row.sol) == null)) return;
      if (ownBuys.some(row => amountsClose(row.sol, sol))) return;
      note(sell.wallet, 'sold without an on-market buy', shareOf(sell, input.supply), buy.wallet);
    });
    if (!fundings) return;
    const kolFunding = fundings.find(row => row && row.wallet === buy.wallet);
    const kolRoot = kolFunding ? (kolFunding.ancestor || kolFunding.funder) : null;
    fundings.forEach(row => {
      if (!row || !row.wallet || kols.has(row.wallet)) return;
      const root = row.ancestor || row.funder;
      const fundedByKol = row.funder === buy.wallet || root === buy.wallet;
      const fundedByDev = Boolean(dev) && (row.funder === dev || root === dev);
      const shared = Boolean(kolRoot) && root === kolRoot && root !== buy.wallet;
      if (!fundedByKol && !fundedByDev && !shared) return;
      const active = transfers.some(item => item.to === row.wallet && inWindow(finite(item.time), buy.time))
        || trades.some(item => item && item.wallet === row.wallet && item.side !== 'transfer' && inWindow(finite(item.time), buy.time));
      if (!active) return;
      const reason = fundedByKol ? 'funded by the KOL' : fundedByDev ? 'funded by the creator' : 'shared funder';
      note(row.wallet, reason, null, buy.wallet);
    });
  });
  const history = Array.isArray(input.history) ? input.history : [];
  const wallets = [...shadows.values()].map(row => ({
    ...row,
    repeat: history.some(item => item && item.wallet === row.wallet && item.kol === row.kol && item.mint !== mint)
  }));
  const reasons = [...new Set(wallets.flatMap(row => row.reasons.concat(row.repeat ? ['repeated after the same KOL'] : [])))];
  const supplyPct = wallets.every(row => row.supplyPct != null)
    ? wallets.reduce((sum, row) => sum + row.supplyPct, 0)
    : null;
  return { mint, shadowCount: wallets.length, supplyPct, reasons, wallets, repeat: wallets.some(row => row.repeat) };
}

function analyzeMcRun(input = {}) {
  const mint = input.mint || null;
  if (!Array.isArray(input.trades)) return { mint, flagged: null, buyCount: null, mcapLow: null, mcapHigh: null };
  const groups = new Map();
  input.trades.forEach(row => {
    if (!row || row.side !== 'buy') return;
    const slot = finite(row.slot);
    const time = finite(row.time);
    const key = slot != null ? `slot:${slot}` : (time != null ? `time:${time}` : null);
    if (!key) return;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  });
  let best = null;
  for (const list of groups.values()) {
    if (list.length < MC_RUN_MIN_BUYS) continue;
    if (!best || list.length > best.length) best = list;
  }
  if (!best) return { mint, flagged: false, buyCount: 0, mcapLow: null, mcapHigh: null };
  if (best.some(row => finite(row.mcapUsd) == null)) return { mint, flagged: null, buyCount: best.length, mcapLow: null, mcapHigh: null };
  const mcapLow = Math.min(...best.map(row => row.mcapUsd));
  const mcapHigh = Math.max(...best.map(row => row.mcapUsd));
  return { mint, flagged: mcapLow > 0 && mcapHigh / mcapLow >= MC_RUN_RATIO, buyCount: best.length, mcapLow, mcapHigh };
}

function risingTrail(rows) {
  const ordered = rows.filter(row => finite(row.time) != null).sort((a, b) => a.time - b.time);
  if (ordered.length < SCALE_MIN_SELLS) return null;
  if (ordered[ordered.length - 1].time - ordered[0].time > SCALE_WINDOW_MS) return null;
  if (ordered.some(row => finite(row.mcapUsd) == null)) return { unknown: true, list: ordered };
  const rising = ordered.every((row, index) => index === 0 || row.mcapUsd >= ordered[index - 1].mcapUsd)
    && ordered[ordered.length - 1].mcapUsd > ordered[0].mcapUsd;
  if (!rising) return null;
  return { unknown: false, list: ordered, mcapChange: ordered[ordered.length - 1].mcapUsd - ordered[0].mcapUsd };
}

function analyzeScaleOut(input = {}) {
  const mint = input.mint || null;
  if (!Array.isArray(input.trades)) {
    return { mint, flagged: null, sellCount: null, soldSol: null, soldSupplyPct: null, mcapChange: null };
  }
  const sells = input.trades.filter(row => row && row.side === 'sell' && row.wallet);
  const groups = new Map();
  sells.forEach(row => {
    const list = groups.get(row.wallet) || [];
    list.push(row);
    groups.set(row.wallet, list);
  });
  (input.clusters || []).forEach(cluster => {
    const members = new Set(cluster || []);
    if (members.size < 2) return;
    const list = sells.filter(row => members.has(row.wallet));
    if (list.length) groups.set(`cluster:${[...members].sort().join(',')}`, list);
  });
  let chosen = null;
  for (const list of groups.values()) {
    const trail = risingTrail(list);
    if (!trail) continue;
    if (!chosen || (trail.unknown && !chosen.unknown) || (!trail.unknown && chosen.unknown) || (trail.list.length > chosen.list.length)) {
      if (chosen && chosen.unknown === false && trail.unknown) continue;
      chosen = trail;
    }
  }
  if (!chosen) {
    return { mint, flagged: false, sellCount: 0, soldSol: 0, soldSupplyPct: finite(input.supply) == null ? null : 0, mcapChange: null };
  }
  if (chosen.unknown) {
    return { mint, flagged: null, sellCount: chosen.list.length, soldSol: null, soldSupplyPct: null, mcapChange: null };
  }
  const solKnown = chosen.list.every(row => finite(row.sol) != null);
  const supply = finite(input.supply);
  const tokenKnown = supply != null && supply > 0 && chosen.list.every(row => finite(row.tokens) != null);
  return {
    mint,
    flagged: true,
    sellCount: chosen.list.length,
    soldSol: solKnown ? chosen.list.reduce((sum, row) => sum + row.sol, 0) : null,
    soldSupplyPct: tokenKnown ? (chosen.list.reduce((sum, row) => sum + row.tokens, 0) / supply) * 100 : null,
    mcapChange: chosen.mcapChange
  };
}

function analyzeInstantBond(input = {}) {
  const thresholdMs = finite(input.thresholdMs) == null
    ? (finite(process.env.INSTANT_BOND_MS) == null ? DEFAULT_BOND_MS : finite(process.env.INSTANT_BOND_MS))
    : finite(input.thresholdMs);
  const create = finite(input.createTime);
  const done = finite(input.graduatedAt);
  if (input.graduated === false && done == null) {
    return { mint: input.mint || null, flagged: false, durationMs: null, thresholdMs, graduated: false, na: true };
  }
  if (create == null || done == null || done < create) {
    return { mint: input.mint || null, flagged: null, durationMs: null, thresholdMs };
  }
  const durationMs = done - create;
  if (!(durationMs < thresholdMs)) {
    return { mint: input.mint || null, flagged: false, durationMs, thresholdMs, rushed: false };
  }
  const burst = input.snipeBurst;
  if (!burst || finite(burst.signatures) == null || finite(burst.failedRatio) == null) {
    return { mint: input.mint || null, flagged: null, durationMs, thresholdMs, rushed: null };
  }
  const rushed = burst.signatures >= 100 && burst.failedRatio >= 0.5;
  return { mint: input.mint || null, flagged: rushed, durationMs, thresholdMs, rushed };
}

module.exports = {
  analyzeKolShadow,
  analyzeMcRun,
  analyzeScaleOut,
  analyzeInstantBond,
  DEFAULT_WINDOW_MS,
  DEFAULT_BOND_MS
};
