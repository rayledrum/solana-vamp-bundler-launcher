function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function emptyCoordination(mint) {
  return {
    mint: mint || null,
    wallets: null,
    clusters: null,
    coordinatedSupplyPct: null,
    reasons: null
  };
}

function coefficientOfVariation(gaps) {
  if (!gaps.length) return null;
  const mean = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
  if (!(mean > 0)) return null;
  const variance = gaps.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gaps.length;
  return Math.sqrt(variance) / mean;
}

function cadenceReason(fundings) {
  const timed = (fundings || []).filter(row => row && finite(row.time) != null && row.funder && !row.cex);
  const byFunder = new Map();
  timed.forEach(row => {
    const list = byFunder.get(row.funder) || [];
    list.push(row);
    byFunder.set(row.funder, list);
  });
  for (const [funder, rows] of byFunder) {
    if (rows.length < 3) continue;
    const times = rows.map(row => row.time).sort((a, b) => a - b);
    const gaps = times.slice(1).map((time, index) => time - times[index]);
    const spread = coefficientOfVariation(gaps);
    if (spread != null && spread <= 0.15 && gaps.every(gap => gap >= 5_000)) {
      return { funder, wallets: rows.map(row => row.wallet), reason: 'regular funding cadence' };
    }
  }
  return null;
}

function delayReason(buyers, fundings) {
  const byWallet = new Map((fundings || []).filter(row => row && row.wallet).map(row => [row.wallet, row]));
  const delays = [];
  (buyers || []).forEach(buyer => {
    const fund = byWallet.get(buyer.wallet);
    const buyAt = finite(buyer.time);
    const fundedAt = fund ? finite(fund.time) : null;
    if (buyAt == null || fundedAt == null || buyAt < fundedAt) return;
    delays.push({ wallet: buyer.wallet, delay: buyAt - fundedAt });
  });
  if (delays.length < 3) return null;
  const mid = delays.map(row => row.delay).sort((a, b) => a - b)[Math.floor(delays.length / 2)];
  const close = delays.filter(row => Math.abs(row.delay - mid) <= Math.max(5_000, mid * 0.1));
  if (close.length < 3) return null;
  return { wallets: close.map(row => row.wallet), reason: 'same funding-to-buy delay' };
}

function offsetReason(buyers, fundings, createTime) {
  if (createTime == null) return null;
  const byWallet = new Map((fundings || []).filter(row => row && row.wallet && !row.cex).map(row => [row.wallet, row]));
  const offsets = [];
  (buyers || []).forEach(buyer => {
    const fund = byWallet.get(buyer.wallet);
    const fundedAt = fund ? finite(fund.time) : null;
    if (fundedAt == null || fundedAt > createTime) return;
    offsets.push({ wallet: buyer.wallet, offset: createTime - fundedAt });
  });
  if (offsets.length < 3) return null;
  const mid = offsets.map(row => row.offset).sort((a, b) => a - b)[Math.floor(offsets.length / 2)];
  const close = offsets.filter(row => Math.abs(row.offset - mid) <= 60_000);
  if (close.length < 3) return null;
  return { wallets: close.map(row => row.wallet), reason: 'funded at a fixed offset before launch' };
}

function fingerprintKey(buyer) {
  const fee = finite(buyer.priorityFee);
  const compute = finite(buyer.computeUnitPrice);
  const tip = finite(buyer.jitoTip);
  const order = Array.isArray(buyer.programOrder) ? buyer.programOrder.join('>') : null;
  const present = [fee, compute, tip, order].filter(value => value != null).length;
  if (present < 2) return null;
  return [fee, compute, tip, order].join('|');
}

function warmedReason(buyer, createTime) {
  const trades = Array.isArray(buyer.priorTrades) ? buyer.priorTrades : null;
  const count = finite(buyer.priorTxCount);
  if (!trades || createTime == null || count == null) return null;
  const recent = trades.filter(row => {
    const at = finite(row && row.time);
    const sol = finite(row && row.sol);
    return at != null && sol != null && sol <= 0.05 && createTime - at <= 24 * 60 * 60 * 1000 && createTime >= at;
  });
  const mints = new Set(recent.map(row => row.mint).filter(Boolean));
  if (count >= 3 && count <= 40 && mints.size >= 3) return 'warmed with tiny trades on other tokens';
  return null;
}

function scoreCoordination(input = {}) {
  if (!Array.isArray(input.buyers)) return emptyCoordination(input.mint);
  const cadence = cadenceReason(input.fundings);
  const delay = delayReason(input.buyers, input.fundings);
  const aligned = offsetReason(input.buyers, input.fundings, finite(input.createTime));
  const groupReasons = [cadence, delay, aligned].filter(Boolean);
  const fingerprints = new Map();
  input.buyers.forEach(buyer => {
    const key = fingerprintKey(buyer);
    if (!key) return;
    const list = fingerprints.get(key) || [];
    list.push(buyer.wallet);
    fingerprints.set(key, list);
  });
  const fingerprintGroups = [...fingerprints.values()].filter(list => list.length >= 2);
  const ancestors = new Map();
  input.buyers.forEach(buyer => {
    if (!buyer.ancestor) return;
    const list = ancestors.get(buyer.ancestor) || [];
    list.push(buyer.wallet);
    ancestors.set(buyer.ancestor, list);
  });
  const ancestorGroups = [...ancestors.values()].filter(list => list.length >= 2);
  const registry = input.registry && input.registry.wallets ? input.registry.wallets : {};
  const walletReasons = new Map();
  const add = (wallet, reason) => {
    const list = walletReasons.get(wallet) || [];
    if (!list.includes(reason)) list.push(reason);
    walletReasons.set(wallet, list);
  };
  input.buyers.forEach(buyer => {
    const warmed = warmedReason(buyer, finite(input.createTime));
    if (warmed) add(buyer.wallet, warmed);
    const depth = finite(buyer.hopDepth);
    if (depth != null && depth >= 3) add(buyer.wallet, `funding hop depth ${depth}`);
    const seen = registry[buyer.wallet];
    if (seen && Array.isArray(seen.mints) && seen.mints.filter(mint => mint !== input.mint).length >= 1) {
      add(buyer.wallet, 'reused across launches');
    }
  });
  groupReasons.forEach(group => group.wallets.forEach(wallet => add(wallet, group.reason)));
  fingerprintGroups.forEach(list => list.forEach(wallet => add(wallet, 'shared fee and transaction shape')));
  ancestorGroups.forEach(list => list.forEach(wallet => add(wallet, 'shared funding ancestor')));
  const shadowRows = Array.isArray(input.shadowWallets) ? input.shadowWallets.filter(row => row && row.wallet) : [];
  shadowRows.forEach(row => {
    add(row.wallet, 'KOL shadow sell');
    if (row.repeat) add(row.wallet, 'repeated after the same KOL');
  });
  const clusters = [];
  ancestorGroups.forEach(list => clusters.push({ kind: 'ancestor', wallets: list }));
  fingerprintGroups.forEach(list => clusters.push({ kind: 'fingerprint', wallets: list }));
  groupReasons.forEach(group => clusters.push({ kind: 'cadence', wallets: group.wallets, reason: group.reason }));
  if (shadowRows.length) clusters.push({ kind: 'kol-shadow', wallets: shadowRows.map(row => row.wallet) });
  const scored = input.buyers.concat(shadowRows.filter(row => !input.buyers.some(buyer => buyer.wallet === row.wallet)).map(row => ({
    wallet: row.wallet,
    supplyPct: row.supplyPct
  })));
  const coordinated = scored.filter(row => walletReasons.has(row.wallet));
  const supplyKnown = coordinated.length > 0 && coordinated.every(row => finite(row.supplyPct) != null);
  return {
    mint: input.mint || null,
    wallets: scored.map(buyer => ({
      wallet: buyer.wallet,
      supplyPct: finite(buyer.supplyPct),
      likelyCoordinated: walletReasons.has(buyer.wallet),
      reasons: walletReasons.get(buyer.wallet) || []
    })),
    clusters,
    coordinatedSupplyPct: supplyKnown ? coordinated.reduce((sum, buyer) => sum + buyer.supplyPct, 0) : (coordinated.length ? null : 0),
    reasons: [...new Set([...walletReasons.values()].flat())]
  };
}

module.exports = { scoreCoordination };
