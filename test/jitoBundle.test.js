const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction
} = require('@solana/web3.js');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `jito-bundle-${process.pid}.json`);
const config = require('../src/config');
const bundler = require('../src/bundler');
const { bundleBlockhash, tipLamports, jitoEndpoint, JITO_MIN_TIP_LAMPORTS } = require('../src/portalTx');

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

test('a bundle is refused when its transactions do not share a blockhash', () => {
  const payer = Keypair.generate();
  const first = versionedTransfer(payer, Keypair.generate().publicKey.toBase58());
  const second = versionedTransfer(payer, Keypair.generate().publicKey.toBase58());
  assert.throws(() => bundleBlockhash([first, second]), /do not share one recent blockhash/);
  assert.throws(() => tipLamports(0.0000001), /1000 lamports/);
  assert.equal(tipLamports(0.003) >= JITO_MIN_TIP_LAMPORTS, true);
});

test('the tip transaction reuses the user transaction blockhash and an official tip account', async () => {
  const payer = bundler.connection ? require('../src/walletManager').masterWallet : null;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const user = versionedTransfer(payer, blockhash);
  const tip = await bundler.buildTipTransaction(tipLamports(0.003), blockhash);
  assert.equal(bundleBlockhash([user, tip.encoded]), blockhash);
  assert.equal(config.JITO_TIP_ACCOUNTS.includes(tip.tipAccount), true);
  assert.equal(jitoEndpoint('send'), jitoEndpoint('inflight'));
  assert.equal(jitoEndpoint('send'), jitoEndpoint('status'));
  assert.match(jitoEndpoint('send'), /\/bundles$/);
});
