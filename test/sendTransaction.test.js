const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;

process.env.WALLETS_FILE = path.join(os.tmpdir(), `send-tx-${process.pid}.json`);
const { createRpcPool, signatureOf } = require('../src/rpc');
const { WalletManager } = require('../src/walletManager');

function fail(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

function pool(behaviors = {}) {
  const stubs = {};
  for (const name of ['Helius', 'QuickNode', 'Public']) {
    const behavior = behaviors[name] || {};
    const stub = {
      calls: [],
      async getLatestBlockhash(...args) {
        stub.calls.push(['getLatestBlockhash', args]);
        if (behavior.getLatestBlockhash) return behavior.getLatestBlockhash(...args);
        throw new Error('no blockhash');
      },
      async sendRawTransaction(...args) {
        stub.calls.push(['sendRawTransaction', args]);
        if (behavior.sendRawTransaction) return behavior.sendRawTransaction(...args);
        return 'sent';
      },
      async sendTransaction() {
        throw new Error('raw connection sendTransaction must not run');
      },
      async getSignatureStatuses(...args) {
        stub.calls.push(['getSignatureStatuses', args]);
        if (behavior.getSignatureStatuses) return behavior.getSignatureStatuses(...args);
        return { value: [null] };
      },
      async confirmTransaction(...args) {
        stub.calls.push(['confirmTransaction', args]);
        if (behavior.confirmTransaction) return behavior.confirmTransaction(...args);
        return { value: { err: null } };
      },
      async getBalance() {
        stub.calls.push(['getBalance']);
        return behavior.balance == null ? 2 * LAMPORTS_PER_SOL : behavior.balance;
      },
      async getParsedTokenAccountsByOwner() {
        stub.calls.push(['getParsedTokenAccountsByOwner']);
        if (behavior.tokenAccounts) return behavior.tokenAccounts();
        return { value: [] };
      },
      async simulateTransaction(...args) {
        stub.calls.push(['simulateTransaction', args]);
        return { value: null };
      },
      async getFeeForMessage(...args) {
        stub.calls.push(['getFeeForMessage', args]);
        return { context: { slot: 1 }, value: 5000 };
      }
    };
    stubs[name] = stub;
  }
  const api = createRpcPool({
    log() {},
    providers: [
      { name: 'Helius', httpUrl: 'https://helius.example/secret', wsUrl: '', configured: true },
      { name: 'QuickNode', httpUrl: 'https://example.quiknode.pro/secret', wsUrl: '', configured: true },
      { name: 'Public', httpUrl: 'https://api.mainnet.solana.com', wsUrl: '', configured: true }
    ],
    connect: (provider) => stubs[provider.name]
  });
  return { api, stubs };
}

function unsignedTransfer(payer, to = Keypair.generate().publicKey) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: to,
    lamports: 1
  }));
  return tx;
}

test('signatureOf accepts bytes, base64, and transaction objects without throwing', () => {
  const payer = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const tx = unsignedTransfer(payer);
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const raw = tx.serialize();
  const signature = bs58.encode(tx.signature);
  assert.equal(signatureOf(raw), signature);
  assert.equal(signatureOf(new Uint8Array(raw)), signature);
  assert.equal(signatureOf(Array.from(raw)), signature);
  assert.equal(signatureOf(raw.toString('base64')), signature);
  assert.equal(signatureOf(tx), signature);

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: tx.instructions
  }).compileToV0Message();
  const versioned = new VersionedTransaction(message);
  versioned.sign([payer]);
  assert.equal(signatureOf(versioned), bs58.encode(versioned.signatures[0]));
  assert.equal(signatureOf(versioned.serialize()), bs58.encode(versioned.signatures[0]));

  assert.equal(signatureOf(new Transaction()), null);
  assert.equal(signatureOf({}), null);
  assert.equal(signatureOf(4), null);
  assert.equal(signatureOf(null), null);
  assert.equal(signatureOf('not-base64-tx'), null);
  assert.equal(signatureOf(['nope']), null);
});

test('a legacy sendTransaction is signed once and failover resends those bytes', async () => {
  const payer = Keypair.generate();
  const hashA = Keypair.generate().publicKey.toBase58();
  const hashB = Keypair.generate().publicKey.toBase58();
  let reads = 0;
  const sent = [];
  const { api, stubs } = pool({
    Helius: {
      getLatestBlockhash() {
        reads += 1;
        return {
          blockhash: reads === 1 ? hashA : hashB,
          lastValidBlockHeight: 100 + reads
        };
      },
      sendRawTransaction(raw) {
        sent.push(Buffer.from(raw));
        throw fail('socket hang up', 'ECONNRESET');
      }
    },
    QuickNode: {
      getLatestBlockhash() {
        reads += 1;
        return { blockhash: hashB, lastValidBlockHeight: 999 };
      },
      getSignatureStatuses() { return { value: [null] }; },
      sendRawTransaction(raw) {
        sent.push(Buffer.from(raw));
        return signatureOf(raw);
      }
    }
  });
  const tx = unsignedTransfer(payer);
  const result = await api.connection.sendTransaction(tx, [payer]);
  assert.equal(reads, 1);
  assert.equal(tx.recentBlockhash, hashA);
  assert.equal(tx.lastValidBlockHeight, 101);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(result, signatureOf(sent[0]));
  assert.equal(signatureOf(tx), result);
  assert.equal(stubs.QuickNode.calls.some(row => row[0] === 'getLatestBlockhash'), false);
  assert.equal(stubs.Helius.calls.filter(row => row[0] === 'sendRawTransaction').length, 1);
  assert.equal(stubs.QuickNode.calls.filter(row => row[0] === 'sendRawTransaction').length, 1);
});

test('a landed sendTransaction is not sent again', async () => {
  const payer = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  let quickSends = 0;
  const { api } = pool({
    Helius: {
      getLatestBlockhash() { return { blockhash, lastValidBlockHeight: 50 }; },
      sendRawTransaction() { throw fail('socket hang up', 'ECONNRESET'); }
    },
    QuickNode: {
      getSignatureStatuses() { return { value: [{ confirmationStatus: 'confirmed' }] }; },
      sendRawTransaction() { quickSends += 1; return 'again'; }
    }
  });
  const tx = unsignedTransfer(payer);
  const result = await api.connection.sendTransaction(tx, [payer]);
  assert.equal(result, signatureOf(tx));
  assert.equal(quickSends, 0);
  assert.equal(tx.recentBlockhash, blockhash);
});

test('a rate limit does not resend or fetch a second blockhash', async () => {
  const payer = Keypair.generate();
  let reads = 0;
  let sends = 0;
  const { api } = pool({
    Helius: {
      getLatestBlockhash() {
        reads += 1;
        return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 7 };
      },
      sendRawTransaction() {
        sends += 1;
        throw fail('429 Too Many Requests', 429);
      }
    }
  });
  await assert.rejects(() => api.connection.sendTransaction(unsignedTransfer(payer), [payer]), /429/);
  assert.equal(reads, 1);
  assert.equal(sends, 1);
});

test('a versioned transaction is serialized once and simulation objects pass through', async () => {
  const payer = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 1
    })]
  }).compileToV0Message();
  const vtx = new VersionedTransaction(message);
  vtx.sign([payer]);
  const seen = [];
  const { api, stubs } = pool({
    Helius: {
      sendRawTransaction(raw, options) {
        seen.push({ raw: Buffer.from(raw), options });
        return signatureOf(vtx);
      }
    }
  });
  const sent = await api.connection.sendTransaction(vtx, { skipPreflight: true });
  assert.equal(sent, bs58.encode(vtx.signatures[0]));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].raw, Buffer.from(vtx.serialize()));
  assert.deepEqual(seen[0].options, { skipPreflight: true });

  const legacy = unsignedTransfer(payer);
  const signers = [payer];
  await api.connection.simulateTransaction(legacy, signers);
  const sim = stubs.Helius.calls.find(row => row[0] === 'simulateTransaction');
  assert.equal(sim[1][0], legacy);
  assert.equal(sim[1][1], signers);

  const feeMessage = message;
  const fee = await api.connection.getFeeForMessage(feeMessage, 'confirmed');
  assert.equal(fee.value, 5000);
  const feeCall = stubs.Helius.calls.find(row => row[0] === 'getFeeForMessage');
  assert.equal(feeCall[1][0], feeMessage);
  assert.equal(feeCall[1][1], 'confirmed');
});

test('live disperse, drain, and rent reclaim confirm the signed transaction', async () => {
  const blockhash = Keypair.generate().publicKey.toBase58();
  const confirmed = [];
  const file = path.join(os.tmpdir(), `send-tx-wallets-${process.pid}.json`);
  const { api } = pool({
    Helius: {
      getLatestBlockhash() { return { blockhash, lastValidBlockHeight: 80 }; },
      sendRawTransaction(raw) { return signatureOf(raw); },
      confirmTransaction(strategy) {
        confirmed.push(strategy);
        return { value: { err: null } };
      },
      tokenAccounts() {
        return {
          value: [{
            pubkey: Keypair.generate().publicKey,
            account: {
              data: {
                parsed: {
                  info: {
                    tokenAmount: { uiAmount: 0 },
                    mint: new PublicKey('So11111111111111111111111111111111111111112').toBase58()
                  }
                }
              }
            }
          }]
        };
      }
    }
  });
  const manager = new WalletManager({ dataFile: file, connection: api.connection, simulationMode: false });
  try {
    const dispersed = await manager.disperseSol(0.06, false);
    assert.equal(dispersed.simulation, false);
    assert.equal(dispersed.success, true);
    assert.equal(typeof dispersed.txSignature, 'string');
    assert.equal(confirmed[0].signature, dispersed.txSignature);
    assert.equal(confirmed[0].blockhash, blockhash);
    assert.equal(confirmed[0].lastValidBlockHeight, 80);

    const drained = await manager.drainSol();
    assert.equal(drained.simulation, false);
    assert.equal(drained.success, true);
    assert.ok(drained.signatures.length >= 1);
    assert.equal(confirmed.some(row => row.signature === drained.signatures[0]), true);

    const reclaimed = await manager.reclaimRentAndRewards();
    assert.equal(reclaimed.simulation, false);
    assert.equal(reclaimed.success, true);
    assert.ok(reclaimed.accountsClosed >= 1);
    assert.equal(confirmed.some(row => row.signature === reclaimed.signatures[0]), true);

    const direct = new Transaction().add(SystemProgram.transfer({
      fromPubkey: manager.masterWallet.publicKey,
      toPubkey: manager.subWallets[0].publicKey,
      lamports: 1
    }));
    const sig = await sendAndConfirmTransaction(api.connection, direct, [manager.masterWallet]);
    assert.equal(direct.recentBlockhash, blockhash);
    assert.equal(direct.lastValidBlockHeight, 80);
    assert.equal(sig, bs58.encode(direct.signature));
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.bak`, { force: true });
  }
});
