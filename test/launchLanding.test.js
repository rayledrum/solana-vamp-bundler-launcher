const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `launch-landing-${process.pid}.json`);
const bundler = require('../src/bundler');
const { createLaunchLock, confirmLaunchOnChain, signaturesOfEncoded } = require('../src/launchLanding');
const { tipLamports } = require('../src/portalTx');

function versionedTransfer(payer, blockhash) {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 1
    })]
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return Buffer.from(tx.serialize()).toString('base64');
}

test('an Invalid Jito status still counts as success when the mint is on-chain, with one send', async () => {
  const mint = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const payer = require('../src/walletManager').masterWallet;
  const user = versionedTransfer(payer, blockhash);
  let sends = 0;
  const calls = [];
  const original = {
    build: bundler.buildChunkTransactions,
    send: bundler.sendBundle,
    poll: bundler.pollBundle,
    connection: bundler.connection,
    sleep: bundler.sleep,
    now: bundler.now
  };
  bundler.buildChunkTransactions = async () => [user];
  bundler.sendBundle = async () => { sends += 1; return 'bundle-id'; };
  bundler.pollBundle = async () => ({ landed: false, status: 'Invalid', details: { err: 'Invalid' } });
  bundler.connection = {
    rpcPool: {
      async call(method) {
        calls.push(method);
        if (method === 'getAccountInfo') return { lamports: 1, data: Buffer.alloc(0) };
        return { value: [{ confirmationStatus: 'confirmed', err: null }] };
      }
    }
  };
  let slept = 0;
  bundler.sleep = async () => { slept += 1; };
  try {
    const landed = await bundler.submitChunk([{
      action: 'create',
      body: { mint: mint.toBase58() },
      publicKey: payer.publicKey.toBase58(),
      walletIndex: 0,
      sol: 0.05
    }], 0.003, 'chunk-1');
    assert.equal(sends, 1);
    assert.equal(slept, 0);
    assert.equal(landed.status, 'Landed');
    assert.equal(calls.includes('getSignatureStatuses'), true);
    assert.equal(calls.includes('getAccountInfo'), true);
    assert.equal(signaturesOfEncoded([user]).length, 1);
    assert.equal(tipLamports(0.003) > 1000, true);
  } finally {
    Object.assign(bundler, original);
  }
});

test('a bundle that is not on-chain fails once and is not sent again', async () => {
  const mint = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const payer = require('../src/walletManager').masterWallet;
  const user = versionedTransfer(payer, blockhash);
  let sends = 0;
  let clock = 0;
  const original = {
    build: bundler.buildChunkTransactions,
    send: bundler.sendBundle,
    poll: bundler.pollBundle,
    connection: bundler.connection,
    sleep: bundler.sleep,
    now: bundler.now
  };
  bundler.buildChunkTransactions = async () => [user];
  bundler.sendBundle = async () => { sends += 1; return 'bundle-id'; };
  bundler.pollBundle = async () => ({ landed: false, status: 'Invalid', details: null });
  bundler.connection = {
    rpcPool: {
      async call(method) {
        if (method === 'getAccountInfo') return null;
        return { value: [null] };
      }
    }
  };
  bundler.now = () => clock;
  bundler.sleep = async (ms) => { clock += ms; };
  try {
    await assert.rejects(
      () => bundler.submitChunk([{
        action: 'create',
        body: { mint: mint.toBase58() },
        publicKey: payer.publicKey.toBase58(),
        walletIndex: 0,
        sol: 0.05
      }], 0.003, 'chunk-1'),
      /did not land: Invalid/
    );
    assert.equal(sends, 1);
  } finally {
    Object.assign(bundler, original);
  }
});

test('a second launch is refused while the first landing is unresolved', () => {
  const lock = createLaunchLock();
  lock.begin();
  lock.setMint('MintAlreadySent');
  assert.throws(() => lock.begin(), (err) => err.statusCode === 409 && err.mint === 'MintAlreadySent');
  lock.finish();
  assert.doesNotThrow(() => lock.begin());
  lock.finish();
});

test('confirmLaunchOnChain stops polling once the create signature is confirmed', async () => {
  let clock = 0;
  let reads = 0;
  const result = await confirmLaunchOnChain({
    connection: {
      rpcPool: {
        async call(method, args, priority) {
          assert.equal(priority, true);
          reads += 1;
          if (method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: null }] };
          return null;
        }
      }
    },
    mint: Keypair.generate().publicKey.toBase58(),
    signatures: ['sig'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  });
  assert.equal(result.landed, true);
  assert.equal(result.signatureConfirmed, true);
  assert.equal(reads, 2);
});
