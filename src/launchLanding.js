const { PublicKey, Transaction, VersionedTransaction } = require('@solana/web3.js');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;

function createLaunchLock() {
  let pending = null;
  return {
    begin() {
      if (pending) {
        const err = new Error(`A launch for ${pending.mint || 'an unresolved mint'} is still in flight. Track that mint instead of creating another.`);
        err.statusCode = 409;
        err.mint = pending.mint;
        throw err;
      }
      pending = { mint: null };
    },
    setMint(mint) {
      if (pending) pending.mint = mint;
    },
    finish() {
      pending = null;
    },
    current() {
      return pending;
    }
  };
}

function signatureOfEncoded(encoded) {
  const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
  try {
    const sig = VersionedTransaction.deserialize(bytes).signatures[0];
    return sig ? bs58.encode(sig) : null;
  } catch (err) {
    const legacy = Transaction.from(bytes);
    return legacy.signature ? bs58.encode(legacy.signature) : null;
  }
}

function signaturesOfEncoded(encodedTxs) {
  return (encodedTxs || []).map(signatureOfEncoded).filter(Boolean);
}

async function priorityCall(connection, method, args) {
  const pool = connection && connection.rpcPool;
  if (pool && typeof pool.call === 'function') return pool.call(method, args, true);
  const fn = connection && connection[method];
  if (typeof fn !== 'function') throw new Error(`RPC has no ${method}`);
  return fn.apply(connection, args);
}

function signatureConfirmed(row) {
  if (!row || row.err) return false;
  return row.confirmationStatus === 'processed'
    || row.confirmationStatus === 'confirmed'
    || row.confirmationStatus === 'finalized';
}

async function confirmLaunchOnChain({
  connection,
  mint,
  signatures,
  windowMs = 25000,
  intervalMs = 2000,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now
}) {
  const deadline = now() + windowMs;
  const mintKey = mint ? new PublicKey(mint) : null;
  do {
    let statuses = null;
    let account = null;
    try {
      if (signatures && signatures.length) {
        statuses = await priorityCall(connection, 'getSignatureStatuses', [signatures]);
      }
    } catch (err) {
      statuses = null;
    }
    try {
      if (mintKey) account = await priorityCall(connection, 'getAccountInfo', [mintKey, 'confirmed']);
    } catch (err) {
      account = null;
    }
    const rows = statuses && statuses.value || [];
    const confirmed = rows.some(signatureConfirmed);
    if (confirmed || account) {
      return { landed: true, signatureConfirmed: confirmed, mintExists: Boolean(account) };
    }
    if (now() >= deadline) break;
    await sleep(intervalMs);
  } while (now() <= deadline);
  return { landed: false, signatureConfirmed: false, mintExists: false };
}

module.exports = {
  createLaunchLock,
  signaturesOfEncoded,
  confirmLaunchOnChain
};
