const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');
const {
  parseStrictBoolean,
  requireSolTradeAmount,
  requireSellPct,
  requireBumperInterval,
  requireMint,
  requireLaunchAmounts,
  requireJitoTip,
  planBundleChunks,
  ValidationError
} = require('../src/validation');
const { isPrivateIp } = require('../src/safeImage');

test('strict booleans do not treat the string false as true', () => {
  assert.equal(parseStrictBoolean(false), false);
  assert.equal(parseStrictBoolean('false'), false);
  assert.equal(parseStrictBoolean('0'), false);
  assert.equal(parseStrictBoolean(true), true);
  assert.equal(parseStrictBoolean('true'), true);
  assert.equal(parseStrictBoolean('FALSE'), false);
  assert.equal(parseStrictBoolean('no'), null);
  assert.equal(parseStrictBoolean(''), null);
  assert.equal(Boolean('false'), true);
});

test('trade amounts reject non-numeric, non-positive, and over-cap values', () => {
  assert.equal(requireSolTradeAmount('0.05'), 0.05);
  assert.equal(requireSolTradeAmount(0.1), 0.1);
  assert.throws(() => requireSolTradeAmount('nope'), ValidationError);
  assert.throws(() => requireSolTradeAmount(''), ValidationError);
  assert.throws(() => requireSolTradeAmount(0), ValidationError);
  assert.throws(() => requireSolTradeAmount(-1), ValidationError);
  assert.throws(() => requireSolTradeAmount(0.11), /maximum/);
  assert.throws(() => requireSellPct(0), ValidationError);
  assert.throws(() => requireSellPct(101), ValidationError);
  assert.throws(() => requireSellPct('abc'), ValidationError);
  assert.equal(requireSellPct('100'), 100);
});

test('bumper interval cannot be zero and jito tips are capped', () => {
  assert.throws(() => requireBumperInterval(0), /at least 5/);
  assert.throws(() => requireBumperInterval(4), /at least 5/);
  assert.throws(() => requireBumperInterval(5.5), /integer/);
  assert.equal(requireBumperInterval(5), 5);
  assert.equal(requireBumperInterval('20'), 20);
  assert.throws(() => requireJitoTip(0.02), /maximum/);
  assert.throws(() => requireJitoTip(-0.001), ValidationError);
  assert.equal(requireJitoTip(0.01), 0.01);
});

test('mints and launch bundles are validated before they can be tracked', () => {
  assert.throws(() => requireMint('notamint'), /not a valid Solana address/);
  assert.throws(() => requireMint(''), /required/);
  const mint = Keypair.generate().publicKey.toBase58();
  assert.equal(requireMint(mint), mint);

  const launch = requireLaunchAmounts({
    devSolBuy: 0.05,
    subWalletBuys: [0.05, 0, '0.02'],
    jitoTipSol: 0.005
  });
  assert.equal(launch.devSolBuy, 0.05);
  assert.deepEqual(launch.subWalletBuys, [0.05, 0, 0.02]);
  assert.throws(() => requireLaunchAmounts({
    devSolBuy: 0.05,
    subWalletBuys: [-0.1],
    jitoTipSol: 0.001
  }), /negative/);
  assert.throws(() => requireLaunchAmounts({
    devSolBuy: 'lots',
    subWalletBuys: [],
    jitoTipSol: 0.001
  }), ValidationError);
});

test('bundle chunks stay within the Jito limit of 5 and each reserves a tip', () => {
  const chunks = planBundleChunks(7);
  assert.deepEqual(chunks.map(chunk => chunk.totalWithTip), [5, 4]);
  assert.ok(chunks.every(chunk => chunk.totalWithTip <= 5 && chunk.totalWithTip === chunk.userCount + 1));
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.userCount, 0), 7);
  assert.throws(() => planBundleChunks(0), ValidationError);
});

test('private and loopback addresses are rejected for remote images', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.1.2.3'), true);
  assert.equal(isPrivateIp('192.168.1.9'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('1.1.1.1'), false);
});
