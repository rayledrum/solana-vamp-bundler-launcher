const config = require('../config');
const { bondingCurvePda, parseProgramDataLogs, decodeBondingCurve } = require('../curveFeed');

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function tradesFromLogs(tx, meta) {
  const logs = tx && tx.meta && tx.meta.logMessages;
  if (!Array.isArray(logs)) return [];
  const slot = meta && meta.slot != null ? meta.slot : (tx && tx.slot != null ? tx.slot : null);
  const blockTime = meta && meta.blockTime != null ? meta.blockTime : (tx && tx.blockTime != null ? tx.blockTime : null);
  return parseProgramDataLogs(logs).map(event => ({
    side: event.isBuy ? 'buy' : 'sell',
    wallet: event.user,
    sol: event.solAmount,
    tokens: event.tokenAmount,
    slot,
    time: blockTime == null ? null : blockTime * 1000,
    mint: event.mint,
    mcapUsd: null,
    signature: meta && meta.signature || null
  }));
}

function tradesFromHelius(tx) {
  if (!tx || typeof tx !== 'object') return [];
  const transfers = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
  const native = Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : [];
  if (!transfers.length || !native.length) return [];
  const token = transfers[0];
  const sol = native[0];
  if (!token || !sol || !token.toUserAccount || !token.fromUserAccount) return [];
  const solAmount = finite(sol.amount);
  const tokens = finite(token.tokenAmount);
  if (solAmount == null || tokens == null) return [];
  const userReceivedTokens = token.toUserAccount !== token.fromUserAccount && sol.fromUserAccount === token.toUserAccount;
  const userPaidTokens = sol.toUserAccount === token.fromUserAccount;
  if (!userReceivedTokens && !userPaidTokens) return [];
  return [{
    side: userReceivedTokens ? 'buy' : 'sell',
    wallet: userReceivedTokens ? token.toUserAccount : token.fromUserAccount,
    sol: solAmount / 1e9,
    tokens,
    slot: finite(tx.slot),
    time: finite(tx.timestamp) == null ? null : tx.timestamp * 1000,
    mint: token.mint || null,
    mcapUsd: null,
    signature: tx.signature || null
  }];
}

function tradesFromTransaction(tx, meta) {
  const fromLogs = tradesFromLogs(tx, meta);
  if (fromLogs.length) return fromLogs;
  return tradesFromHelius(tx);
}

async function listCurveSignatures(connection, curve, pace, maxPages) {
  const signatures = [];
  let before;
  for (let page = 0; page < maxPages; page += 1) {
    if (pace) await pace();
    const batch = await connection.getSignaturesForAddress(curve, { limit: 1000, before });
    if (!batch || !batch.length) break;
    signatures.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < 1000) break;
  }
  return signatures;
}

function selectTapeSignatures(signatures, { maxFetches = 400, focusFrom, focusTo } = {}) {
  const listed = signatures.filter(row => row && row.signature);
  const failed = listed.filter(row => row.err).length;
  const ok = listed.filter(row => !row.err);
  const timed = ok.filter(row => row.blockTime != null);
  const create = timed.length ? Math.min(...timed.map(row => row.blockTime)) : null;
  const first = create == null ? ok.slice(-120) : timed.filter(row => row.blockTime <= create + 180);
  const focus = timed.filter(row => {
    if (focusFrom == null) return false;
    const at = row.blockTime * 1000;
    return at >= focusFrom && (focusTo == null || at <= focusTo);
  });
  const chosen = [];
  const seen = new Set();
  [...first, ...focus].forEach(row => {
    if (chosen.length >= maxFetches || seen.has(row.signature)) return;
    seen.add(row.signature);
    chosen.push(row);
  });
  return { chosen, failed, listed: listed.length, createTime: create == null ? null : create * 1000 };
}

async function readCurveTape({ connection, mint, programId, pace, cache, maxPages = 15, supply, maxFetches = 400, focusFrom, focusTo } = {}) {
  if (!connection || typeof connection.getSignaturesForAddress !== 'function' || !mint) return null;
  let curve;
  try {
    curve = bondingCurvePda(mint, programId || config.PUMP_PROGRAM_ID);
  } catch (err) {
    return null;
  }
  let signatures;
  try {
    signatures = await listCurveSignatures(connection, curve, pace, maxPages);
  } catch (err) {
    return null;
  }
  if (!signatures.length) {
    return { trades: [], createSlot: null, createTime: null, supply: finite(supply), curve: curve.toBase58(), signatures: { listed: 0, failed: 0, fetched: 0 } };
  }
  const picked = selectTapeSignatures(signatures, { maxFetches, focusFrom, focusTo });
  const oldest = signatures[signatures.length - 1];
  const createSlot = oldest.slot == null ? null : oldest.slot;
  const createTime = picked.createTime != null ? picked.createTime : (oldest.blockTime == null ? null : oldest.blockTime * 1000);
  let curveSupply = finite(supply);
  if (curveSupply == null && typeof connection.getAccountInfo === 'function') {
    try {
      if (pace) await pace();
      const info = await connection.getAccountInfo(curve, 'confirmed');
      const decoded = decodeBondingCurve(info && info.data);
      if (decoded && decoded.tokenTotalSupply > 0) curveSupply = decoded.tokenTotalSupply / 1e6;
    } catch (err) {
      curveSupply = null;
    }
  }
  const trades = [];
  let fetched = 0;
  let failedFetches = 0;
  let heliusBySig = null;
  const { rpc } = require('../rpc');
  const heliusProvider = rpc.status().providers.find(row => row.name === 'Helius');
  if (process.env.HELIUS_API_KEY && heliusProvider && heliusProvider.healthy && picked.chosen.length) {
    try {
      const response = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${encodeURIComponent(process.env.HELIUS_API_KEY)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transactions: picked.chosen.slice(0, 100).map(row => row.signature) })
      });
      const body = await response.json().catch(() => null);
      if (response.ok && Array.isArray(body)) {
        heliusBySig = new Map();
        body.forEach(tx => {
          if (tx && tx.signature) heliusBySig.set(tx.signature, tradesFromHelius(tx));
        });
      } else {
        const text = `${response.status} ${JSON.stringify(body || '')}`;
        const kind = /max usage|credit|exhausted/.test(text.toLowerCase()) || response.status === 401 || response.status === 403
          ? 'credit'
          : (response.status === 429 || /-32429/.test(text) ? 'rate' : null);
        if (kind) rpc.markUnhealthy('Helius', kind);
      }
    } catch (err) {
      heliusBySig = null;
      rpc.markUnhealthy('Helius', 'transport');
    }
  }
  for (const sig of picked.chosen) {
    const key = sig.signature;
    if (heliusBySig && heliusBySig.has(key)) {
      const parsed = heliusBySig.get(key);
      if (cache) cache.set(key, parsed);
      trades.push(...parsed);
      fetched += 1;
      continue;
    }
    if (cache && cache.has(key)) {
      trades.push(...cache.get(key));
      fetched += 1;
      continue;
    }
    if (pace) await pace();
    let tx = null;
    try {
      if (typeof connection.getTransaction === 'function') {
        tx = await connection.getTransaction(key, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
      }
    } catch (err) {
      tx = null;
    }
    if (!tx) {
      failedFetches += 1;
      continue;
    }
    const parsed = tradesFromTransaction(tx, sig);
    if (cache) cache.set(key, parsed);
    trades.push(...parsed);
    fetched += 1;
  }
  if (fetched === 0 && failedFetches > 0 && picked.chosen.length) return null;
  const failedRatio = picked.listed ? picked.failed / picked.listed : null;
  return {
    trades,
    createSlot,
    createTime,
    supply: curveSupply,
    observedUntil: signatures[0] && signatures[0].blockTime != null ? signatures[0].blockTime * 1000 : null,
    curve: curve.toBase58(),
    signatures: { listed: picked.listed, failed: picked.failed, fetched, failedRatio }
  };
}

function researchRpc() {
  const { rpc } = require('../rpc');
  const active = rpc.status().active;
  return {
    connection: rpc.connection,
    helius: active === 'Helius',
    minIntervalMs: active === 'Public' ? 2000 : 400
  };
}

function fundingDefaultOn() {
  if (process.env.COLLECT_FUNDING === '0') return false;
  if (process.env.COLLECT_FUNDING === '1') return true;
  return config.HELIUS_CONFIGURED;
}

module.exports = {
  tradesFromTransaction,
  tradesFromHelius,
  readCurveTape,
  selectTapeSignatures,
  researchRpc,
  fundingDefaultOn
};
