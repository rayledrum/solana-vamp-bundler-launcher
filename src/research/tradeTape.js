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

async function readCurveTape({ connection, mint, programId, pace, cache, maxPages = 20, supply } = {}) {
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
    return { trades: [], createSlot: null, createTime: null, supply: finite(supply), curve: curve.toBase58() };
  }
  const oldest = signatures[signatures.length - 1];
  const createSlot = oldest.slot == null ? null : oldest.slot;
  const createTime = oldest.blockTime == null ? null : oldest.blockTime * 1000;
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
  let failed = 0;
  for (const sig of signatures) {
    const key = sig && sig.signature;
    if (!key) continue;
    if (cache && cache.has(key)) {
      trades.push(...cache.get(key));
      fetched += 1;
      continue;
    }
    if (pace) await pace();
    let tx = null;
    try {
      if (typeof connection.getTransaction === 'function') {
        tx = await connection.getTransaction(key, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      }
    } catch (err) {
      tx = null;
    }
    if (!tx) {
      failed += 1;
      continue;
    }
    const parsed = tradesFromTransaction(tx, sig);
    if (cache) cache.set(key, parsed);
    trades.push(...parsed);
    fetched += 1;
  }
  if (fetched === 0 && failed > 0) return null;
  return {
    trades,
    createSlot,
    createTime,
    supply: curveSupply,
    observedUntil: signatures[0] && signatures[0].blockTime != null ? signatures[0].blockTime * 1000 : null,
    curve: curve.toBase58()
  };
}

function researchRpc() {
  const { Connection } = require('@solana/web3.js');
  if (config.HELIUS_CONFIGURED) {
    return { connection: new Connection(config.HELIUS_RPC_URL, 'confirmed'), helius: true, minIntervalMs: 400 };
  }
  return { connection: new Connection(config.SOLANA_PUBLIC_RPC_URL, 'confirmed'), helius: false, minIntervalMs: 2000 };
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
  researchRpc,
  fundingDefaultOn
};
