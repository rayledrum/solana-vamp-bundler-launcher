const { PublicKey } = require('@solana/web3.js');
const config = require('./config');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

function parseStrictBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
}

function finiteNumber(value, name) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`${name} must be a finite number`);
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed)) throw new ValidationError(`${name} must be a finite number`);
    return parsed;
  }
  throw new ValidationError(`${name} must be a finite number`);
}

function requirePositive(value, name, max) {
  const parsed = finiteNumber(value, name);
  if (parsed <= 0) throw new ValidationError(`${name} must be greater than 0`);
  if (max !== undefined && parsed > max) {
    throw new ValidationError(`${name} exceeds the maximum of ${max}`);
  }
  return parsed;
}

function requireSolTradeAmount(value) {
  return requirePositive(value, 'SOL amount', config.MAX_SOL_PER_TRADE);
}

function requireJitoTip(value, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) {
    return config.DEFAULT_JITO_TIP;
  }
  return requirePositive(value, 'Jito tip', config.MAX_JITO_TIP_SOL);
}

function requireSellPct(value) {
  const parsed = finiteNumber(value, 'Sell percent');
  if (parsed <= 0 || parsed > 100) throw new ValidationError('Sell percent must be greater than 0 and at most 100');
  return parsed;
}

function requireBumperInterval(value) {
  const parsed = finiteNumber(value, 'Bumper interval');
  const minimum = config.MIN_BUMP_INTERVAL_SEC;
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new ValidationError(`Bumper interval must be an integer of at least ${minimum} seconds`);
  }
  return parsed;
}

function requirePublicKey(value, name = 'Address') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ValidationError(`${name} is required`);
  try {
    const key = new PublicKey(text);
    return key.toBase58();
  } catch (err) {
    throw new ValidationError(`${name} is not a valid Solana address`);
  }
}

function requireMint(value) {
  return requirePublicKey(value, 'Mint');
}

function optionalNonNegative(value, name, max) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = finiteNumber(value, name);
  if (parsed < 0) throw new ValidationError(`${name} cannot be negative`);
  if (parsed > 0 && parsed > max) throw new ValidationError(`${name} exceeds the maximum of ${max}`);
  return parsed;
}

function requireLaunchAmounts({ devSolBuy, subWalletBuys, jitoTipSol }) {
  const dev = requireSolTradeAmount(devSolBuy);
  if (!Array.isArray(subWalletBuys)) throw new ValidationError('subWalletBuys must be an array');
  if (subWalletBuys.length > 24) throw new ValidationError('At most 24 sub-wallet buys are allowed');
  const subs = subWalletBuys.map((amount, index) => optionalNonNegative(amount, `Sub-wallet buy #${index + 1}`, config.MAX_SOL_PER_TRADE));
  const tip = requireJitoTip(jitoTipSol, { optional: jitoTipSol === undefined });
  const traded = dev + subs.reduce((sum, amount) => sum + amount, 0);
  if (traded > config.MAX_SOL_PER_SESSION) {
    throw new ValidationError(`Launch spend ${traded} SOL exceeds the session cap of ${config.MAX_SOL_PER_SESSION} SOL`);
  }
  return { devSolBuy: dev, subWalletBuys: subs, jitoTipSol: tip, tradedSol: traded };
}

function requireSlippage(value) {
  const parsed = finiteNumber(value, 'Slippage');
  if (parsed <= 0 || parsed > config.MAX_SLIPPAGE_PCT) {
    throw new ValidationError(`Slippage must be greater than 0 and at most ${config.MAX_SLIPPAGE_PCT}`);
  }
  return parsed;
}

function requirePriorityFee(value) {
  const parsed = finiteNumber(value, 'Priority fee');
  if (parsed < 0 || parsed > config.MAX_PRIORITY_FEE_SOL) {
    throw new ValidationError(`Priority fee must be between 0 and ${config.MAX_PRIORITY_FEE_SOL} SOL`);
  }
  return parsed;
}

// Each Jito bundle holds at most 5 transactions. One slot in every bundle is
// the tip, so user transactions are packed 4 at a time.
function planBundleChunks(userCount) {
  const room = config.JITO_MAX_TXS - 1;
  if (!Number.isInteger(userCount) || userCount < 1) {
    throw new ValidationError('A bundle needs at least one transaction');
  }
  const chunks = [];
  for (let start = 0; start < userCount; start += room) {
    const count = Math.min(room, userCount - start);
    const totalWithTip = count + 1;
    if (totalWithTip > config.JITO_MAX_TXS) {
      throw new ValidationError('Bundle chunk exceeded the Jito limit of 5 transactions');
    }
    chunks.push({ start, userCount: count, totalWithTip });
  }
  return chunks;
}

module.exports = {
  ValidationError,
  parseStrictBoolean,
  requirePositive,
  requireSolTradeAmount,
  requireJitoTip,
  requireSellPct,
  requireBumperInterval,
  requirePublicKey,
  requireMint,
  requireLaunchAmounts,
  requireSlippage,
  requirePriorityFee,
  planBundleChunks
};
