const axios = require('axios');
const { Transaction, VersionedTransaction } = require('@solana/web3.js');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;
const config = require('./config');

function decodePortalTransaction(entry) {
  if (entry == null) throw new Error('PumpPortal returned an empty transaction');
  if (Buffer.isBuffer(entry) || entry instanceof Uint8Array) {
    return VersionedTransaction.deserialize(new Uint8Array(entry));
  }
  if (typeof entry !== 'string' || !entry.trim()) {
    throw new Error('PumpPortal returned an unexpected transaction encoding');
  }
  const trimmed = entry.trim();
  try {
    return VersionedTransaction.deserialize(Uint8Array.from(bs58.decode(trimmed)));
  } catch (err) {
    try {
      return VersionedTransaction.deserialize(new Uint8Array(Buffer.from(trimmed, 'base64')));
    } catch (inner) {
      throw new Error('PumpPortal response was not a serialized VersionedTransaction');
    }
  }
}

function portalErrorText(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data.slice(0, 500);
  if (Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return Buffer.from(data).toString('utf8').slice(0, 500);
  }
  try {
    return JSON.stringify(data).slice(0, 500);
  } catch (err) {
    return String(data).slice(0, 500);
  }
}

// trade-local returns raw VersionedTransaction bytes for one request.
async function fetchSingleVersionedTx(body) {
  const response = await axios.post(`${config.PUMPPORTAL_API}/trade-local`, body, {
    responseType: 'arraybuffer',
    timeout: config.HTTP_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json', Accept: '*/*' },
    maxContentLength: 2 * 1024 * 1024,
    maxBodyLength: 1024 * 1024,
    validateStatus: () => true
  });
  if (response.status !== 200) {
    throw new Error(`PumpPortal trade-local failed (${response.status}): ${portalErrorText(response.data)}`);
  }
  return decodePortalTransaction(Buffer.from(response.data));
}

// An array body asks PumpPortal for one VersionedTransaction per trade, returned
// as base58 strings (see the Jito bundle example on the local trading API).
async function fetchBundleVersionedTxs(bodies) {
  if (!Array.isArray(bodies) || bodies.length < 1 || bodies.length > 5) {
    throw new Error(`PumpPortal bundle requests must contain 1 to 5 trades (got ${bodies && bodies.length})`);
  }
  const response = await axios.post(`${config.PUMPPORTAL_API}/trade-local`, bodies, {
    timeout: config.HTTP_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    maxContentLength: 4 * 1024 * 1024,
    validateStatus: () => true
  });
  if (response.status !== 200) {
    throw new Error(`PumpPortal trade-local bundle failed (${response.status}): ${portalErrorText(response.data)}`);
  }
  const payload = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  const encoded = Array.isArray(payload) ? payload : payload && payload.transactions;
  if (!Array.isArray(encoded) || encoded.length !== bodies.length) {
    throw new Error('PumpPortal bundle response did not include one transaction per request');
  }
  return encoded.map(decodePortalTransaction);
}

async function sendAndConfirmVersioned(connection, tx) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3
  });
  let confirmation;
  try {
    confirmation = await Promise.race([
      connection.confirmTransaction({
        signature,
        blockhash: tx.message.recentBlockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight
      }, 'confirmed'),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Confirmation timed out for ${signature}`)), 60000);
      })
    ]);
  } catch (err) {
    throw new Error(`Transaction ${signature} was not confirmed: ${err.message}`);
  }
  if (confirmation && confirmation.value && confirmation.value.err) {
    throw new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

const JITO_MIN_TIP_LAMPORTS = 1000;

function jitoEndpoint(kind) {
  if (kind === 'send' || kind === 'inflight' || kind === 'status') return config.JITO_BLOCK_ENGINE_URL;
  throw new Error(`Unknown Jito endpoint ${kind}`);
}

function tipLamports(sol) {
  const lamports = Math.floor(Number(sol) * 1_000_000_000);
  if (!Number.isInteger(lamports) || lamports < JITO_MIN_TIP_LAMPORTS) {
    throw new Error(`Jito tip must be at least ${JITO_MIN_TIP_LAMPORTS} lamports`);
  }
  return lamports;
}

function transactionBlockhash(encoded) {
  const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
  try {
    return VersionedTransaction.deserialize(bytes).message.recentBlockhash;
  } catch (err) {
    return Transaction.from(bytes).recentBlockhash;
  }
}

function bundleBlockhash(encodedTxs) {
  if (!Array.isArray(encodedTxs) || encodedTxs.length < 1) {
    throw new Error('Bundle has no transactions');
  }
  if (encodedTxs.length > config.JITO_MAX_TXS) {
    throw new Error(`Refusing a Jito bundle of ${encodedTxs.length} transactions (max ${config.JITO_MAX_TXS})`);
  }
  const hashes = encodedTxs.map(transactionBlockhash);
  const first = hashes[0];
  if (!first || hashes.some(hash => hash !== first)) {
    throw new Error('Bundle transactions do not share one recent blockhash');
  }
  return first;
}

async function jitoRpc(kind, method, params) {
  const response = await axios.post(jitoEndpoint(kind), {
    jsonrpc: '2.0',
    id: 1,
    method,
    params
  }, {
    timeout: config.HTTP_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true
  });
  if (response.status !== 200) {
    throw new Error(`Jito ${method} HTTP ${response.status}: ${portalErrorText(response.data)}`);
  }
  if (response.data && response.data.error) {
    const body = JSON.stringify(response.data.error).slice(0, 800);
    console.error(`[Jito] ${method} error: ${body}`);
    throw new Error(`Jito ${method} error: ${body}`);
  }
  return response.data || {};
}

async function sendBundle(base64Transactions) {
  if (!Array.isArray(base64Transactions) || base64Transactions.length < 1 || base64Transactions.length > config.JITO_MAX_TXS) {
    throw new Error(`Jito accepts at most ${config.JITO_MAX_TXS} transactions per bundle`);
  }
  const data = await jitoRpc('send', 'sendBundle', [base64Transactions, { encoding: 'base64' }]);
  if (!data.result || typeof data.result !== 'string') {
    throw new Error('Jito sendBundle did not return a bundle id');
  }
  return data.result;
}

async function pollBundleUntilSettled(bundleId) {
  const deadline = Date.now() + config.BUNDLE_POLL_TIMEOUT_MS;
  let last = 'Pending';
  while (Date.now() < deadline) {
    const inflight = await jitoRpc('inflight', 'getInflightBundleStatuses', [[bundleId]]);
    const row = inflight.result && inflight.result.value ? inflight.result.value[0] : null;
    const status = row && row.status ? row.status : 'Pending';
    last = status;
    if (status === 'Failed' || status === 'Invalid') {
      let details = null;
      try {
        const landed = await jitoRpc('status', 'getBundleStatuses', [[bundleId]]);
        details = landed.result && landed.result.value ? landed.result.value[0] : null;
      } catch (err) {
        details = { lookupError: err.message };
      }
      console.error(`[Jito] bundle ${bundleId} ${status}: ${JSON.stringify({ inflight: row, details }).slice(0, 800)}`);
      return { landed: false, status, inflight: row, details };
    }
    if (status === 'Landed') {
      let details = null;
      try {
        const landed = await jitoRpc('status', 'getBundleStatuses', [[bundleId]]);
        details = landed.result && landed.result.value ? landed.result.value[0] : null;
      } catch (err) {
        details = { lookupError: err.message };
      }
      return { landed: true, status: 'Landed', inflight: row, details };
    }
    await new Promise(resolve => setTimeout(resolve, config.BUNDLE_POLL_INTERVAL_MS));
  }
  return { landed: false, status: 'Timeout', last };
}

module.exports = {
  decodePortalTransaction,
  fetchSingleVersionedTx,
  fetchBundleVersionedTxs,
  sendAndConfirmVersioned,
  sendBundle,
  pollBundleUntilSettled,
  jitoEndpoint,
  tipLamports,
  bundleBlockhash,
  JITO_MIN_TIP_LAMPORTS
};
