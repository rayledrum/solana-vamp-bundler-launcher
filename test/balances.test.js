const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `balance-singleton-${process.pid}.json`);
const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { WalletManager } = require('../src/walletManager');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balances-'));
  return path.join(dir, 'wallets.json');
}

function mockConnection(lamports) {
  const api = {
    calls: 0,
    fail: false,
    async getMultipleAccountsInfo(keys) {
      api.calls += 1;
      if (api.fail) throw new Error('rpc down');
      return keys.map(key => {
        const amount = lamports.get(key.toBase58());
        if (amount == null) return null;
        return { lamports: amount };
      });
    }
  };
  return api;
}

test('wallet payloads include sim and live balances and omit private keys', async () => {
  const lamports = new Map();
  const connection = mockConnection(lamports);
  const manager = new WalletManager({
    dataFile: tempFile(),
    simulationMode: true,
    connection,
    liveBalanceTtlMs: 5000
  });
  lamports.set(manager.masterWallet.publicKey.toBase58(), 0.5 * LAMPORTS_PER_SOL);

  const master = await manager.getMasterInfo();
  const subs = await manager.getSubWalletsInfo();
  assert.equal(master.simBalance, 15);
  assert.equal(master.liveBalance, 0.5);
  assert.equal(master.liveError, null);
  assert.equal(master.balance, 15);
  assert.equal(Number(master.totals.simBalance.toFixed(4)), Number((15 + (0.2 * subs.length)).toFixed(4)));
  assert.equal(master.totals.liveBalance, 0.5);
  assert.equal(Object.hasOwn(master, 'privateKey'), false);
  assert.ok(subs.every(row => row.simBalance === 0.2 && row.liveBalance === 0 && row.solBalance === 0.2));
  assert.ok(subs.every(row => !Object.hasOwn(row, 'privateKey') && !Object.hasOwn(row, 'secretKey')));
  assert.equal(connection.calls, 1);

  await manager.getMasterInfo();
  assert.equal(connection.calls, 1);
  manager.invalidateLiveBalances();
  await manager.getMasterInfo();
  assert.equal(connection.calls, 2);

  manager.setSimulationMode(false);
  manager.invalidateLiveBalances();
  const liveMaster = await manager.getMasterInfo();
  assert.equal(liveMaster.balance, 0.5);
  assert.equal(liveMaster.simBalance, 15);
});

test('a failed RPC leaves liveBalance null and does not invent a number', async () => {
  const connection = mockConnection(new Map());
  connection.fail = true;
  const manager = new WalletManager({
    dataFile: tempFile(),
    simulationMode: true,
    connection
  });
  const master = await manager.getMasterInfo();
  const subs = await manager.getSubWalletsInfo();
  assert.equal(master.liveBalance, null);
  assert.match(master.liveError, /rpc down/);
  assert.equal(master.simBalance, 15);
  assert.equal(master.balance, 15);
  assert.equal(master.totals.liveBalance, null);
  assert.ok(subs.every(row => row.liveBalance === null && row.simBalance === 0.2));
});

test('a simulated disperse changes the sim ledger and not the live balance', async () => {
  const lamports = new Map();
  const connection = mockConnection(lamports);
  const manager = new WalletManager({
    dataFile: tempFile(),
    simulationMode: true,
    connection
  });
  lamports.set(manager.masterWallet.publicKey.toBase58(), 0.5 * LAMPORTS_PER_SOL);
  const before = await manager.getMasterInfo();
  await manager.disperseSol(0.4, false, 0);
  manager.invalidateLiveBalances();
  const after = await manager.getMasterInfo();
  assert.equal(before.liveBalance, 0.5);
  assert.equal(after.liveBalance, 0.5);
  assert.equal(Number(after.simBalance.toFixed(4)), 14.6);
  assert.notEqual(after.simBalance, before.simBalance);
});
