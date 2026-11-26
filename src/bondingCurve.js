const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');
const config = require('./config');

// Read from the live Pump global account 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf.
// These are the fallback if that account cannot be read. They are not an 85 SOL target.
const DEFAULT_GLOBAL = {
  initialVirtualTokenReserves: 1_073_000_000_000_000n,
  initialVirtualSolReserves: 30_000_000_000n,
  initialRealTokenReserves: 793_100_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n
};

const GLOBAL_DISCRIMINATOR = crypto.createHash('sha256').update('account:Global').digest().subarray(0, 8);
const MIGRATION_DESTINATION = 'PumpSwap';

let globalCache = null;

function decodeGlobal(data) {
  const buf = Buffer.from(data || []);
  if (buf.length < 113) return null;
  if (!buf.subarray(0, 8).equals(GLOBAL_DISCRIMINATOR)) return null;
  let offset = 8;
  offset += 1; // initialized
  offset += 32; // authority
  offset += 32; // fee recipient
  const initialVirtualTokenReserves = buf.readBigUInt64LE(offset); offset += 8;
  const initialVirtualSolReserves = buf.readBigUInt64LE(offset); offset += 8;
  const initialRealTokenReserves = buf.readBigUInt64LE(offset); offset += 8;
  const tokenTotalSupply = buf.readBigUInt64LE(offset);
  if (initialRealTokenReserves <= 0n) return null;
  return {
    initialVirtualTokenReserves,
    initialVirtualSolReserves,
    initialRealTokenReserves,
    tokenTotalSupply
  };
}

async function readPumpGlobal(connection) {
  if (globalCache) return globalCache;
  if (!connection || typeof connection.getAccountInfo !== 'function') return { ...DEFAULT_GLOBAL, source: 'default' };
  try {
    const info = await connection.getAccountInfo(config.PUMP_GLOBAL, 'confirmed');
    const decoded = decodeGlobal(info && info.data);
    if (decoded) {
      globalCache = { ...decoded, source: 'global' };
      return globalCache;
    }
  } catch (err) { /* keep the verified default */ }
  return { ...DEFAULT_GLOBAL, source: 'default' };
}

function resetGlobalCache() {
  globalCache = null;
}

// progress = 1 - realTokenReserves / initialRealTokenReserves. complete is 100%.
function bondingProgress(realTokenReserves, initialRealTokenReserves, complete) {
  if (complete) return 100;
  const initial = BigInt(initialRealTokenReserves || DEFAULT_GLOBAL.initialRealTokenReserves);
  const real = BigInt(realTokenReserves || 0);
  if (initial <= 0n) return 0;
  if (real <= 0n) return 100;
  if (real >= initial) return 0;
  const pct = Number((initial - real) * 10000n / initial) / 100;
  return Math.min(100, Math.max(0, pct));
}

function curveState(realSolUi, globals = DEFAULT_GLOBAL) {
  const realLamports = BigInt(Math.max(0, Math.round(Number(realSolUi) * 1e9)));
  const virtualSol = globals.initialVirtualSolReserves + realLamports;
  const k = globals.initialVirtualSolReserves * globals.initialVirtualTokenReserves;
  const virtualTokens = virtualSol > 0n ? k / virtualSol : globals.initialVirtualTokenReserves;
  const sold = globals.initialVirtualTokenReserves > virtualTokens
    ? globals.initialVirtualTokenReserves - virtualTokens
    : 0n;
  const remaining = sold >= globals.initialRealTokenReserves ? 0n : globals.initialRealTokenReserves - sold;
  const complete = remaining === 0n;
  return {
    progressPct: bondingProgress(remaining, globals.initialRealTokenReserves, complete),
    realSol: Number(realLamports) / 1e9,
    complete,
    destination: MIGRATION_DESTINATION,
    realTokenReserves: remaining
  };
}

function tokensOutForSol(solAmount, currentRealSol = 0, globals = DEFAULT_GLOBAL) {
  const spend = BigInt(Math.max(0, Math.floor(Number(solAmount) * 1e9)));
  const already = BigInt(Math.max(0, Math.round(Number(currentRealSol) * 1e9)));
  const before = globals.initialVirtualSolReserves + already;
  const after = before + spend;
  const k = globals.initialVirtualSolReserves * globals.initialVirtualTokenReserves;
  const tokensBefore = k / before;
  const tokensAfter = k / after;
  const raw = tokensBefore > tokensAfter ? tokensBefore - tokensAfter : 0n;
  const capped = raw > globals.initialRealTokenReserves ? globals.initialRealTokenReserves : raw;
  return Number(capped) / 1e6;
}

// Constant product against raw reserves. amountInRaw and both reserves share their own units.
function ammOut(amountInRaw, reserveIn, reserveOut) {
  const amount = BigInt(amountInRaw || 0);
  const rin = BigInt(reserveIn || 0);
  const rout = BigInt(reserveOut || 0);
  if (amount <= 0n || rin <= 0n || rout <= 0n) return 0n;
  const nextOut = (rin * rout) / (rin + amount);
  return rout > nextOut ? rout - nextOut : 0n;
}

function solOutForTokens(tokenUi, currentRealSol = 0, globals = DEFAULT_GLOBAL) {
  const raw = BigInt(Math.max(0, Math.floor(Number(tokenUi) * 1e6)));
  const already = BigInt(Math.max(0, Math.round(Number(currentRealSol) * 1e9)));
  const virtualSol = globals.initialVirtualSolReserves + already;
  const k = globals.initialVirtualSolReserves * globals.initialVirtualTokenReserves;
  const virtualTokens = k / virtualSol;
  const nextTokens = virtualTokens + raw;
  if (nextTokens <= 0n) return 0;
  const nextSol = k / nextTokens;
  const lamports = virtualSol > nextSol ? virtualSol - nextSol : 0n;
  return Number(lamports) / 1e9;
}

module.exports = {
  DEFAULT_GLOBAL,
  GLOBAL_DISCRIMINATOR,
  MIGRATION_DESTINATION,
  decodeGlobal,
  readPumpGlobal,
  resetGlobalCache,
  bondingProgress,
  curveState,
  tokensOutForSol,
  solOutForTokens,
  ammOut
};
