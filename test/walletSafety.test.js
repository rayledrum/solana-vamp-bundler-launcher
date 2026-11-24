const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `wallet-singleton-${process.pid}.json`);
const { WalletManager } = require('../src/walletManager');

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-safety-'));
  return path.join(dir, name);
}

test('wallet saves are atomic, mode 0600, and backed up before overwrite', () => {
  const file = tempFile('wallets.json');
  const manager = new WalletManager({ dataFile: file, simulationMode: true });
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  const original = fs.readFileSync(file, 'utf8');
  const originalMaster = manager.masterWallet.publicKey.toBase58();

  manager.simulatedBalances.set(originalMaster, 1.25);
  manager.save();

  const backupDir = path.join(path.dirname(file), 'backups');
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  assert.equal((fs.statSync(path.join(backupDir, backups[0])).mode & 0o777), 0o600);
  assert.equal(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'), original);
  assert.notEqual(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
});

test('a corrupt wallet file refuses startup and is not overwritten', () => {
  const file = tempFile('wallets.json');
  fs.writeFileSync(file, '{ this is not json');
  assert.throws(() => new WalletManager({ dataFile: file, simulationMode: true }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json');
  assert.equal(fs.existsSync(path.join(path.dirname(file), 'backups')), false);

  const invalid = tempFile('invalid.json');
  fs.writeFileSync(invalid, JSON.stringify({ master: 'not-a-key', subWallets: [] }));
  const before = fs.readFileSync(invalid, 'utf8');
  assert.throws(() => new WalletManager({ dataFile: invalid, simulationMode: true }), /invalid wallet keys/);
  assert.equal(fs.readFileSync(invalid, 'utf8'), before);
});

test('funded wallets are not replaced unless force is explicitly true', async () => {
  const file = tempFile('wallets.json');
  const manager = new WalletManager({ dataFile: file, simulationMode: true });
  const previous = manager.masterWallet.publicKey.toBase58();
  await assert.rejects(() => manager.generateNewMaster(false), /nonzero SOL balance/);
  assert.equal(manager.masterWallet.publicKey.toBase58(), previous);

  const replaced = await manager.generateNewMaster(true);
  assert.notEqual(replaced, previous);

  await assert.rejects(() => manager.generateSubWallets(4, false), /nonzero SOL balance/);
  assert.equal(manager.subWallets.length, 6);
  const next = await manager.generateSubWallets(4, true);
  assert.equal(next.length, 4);

  await assert.rejects(() => manager.importMasterKey(manager.subWallets[0].secretKey, false), /nonzero SOL balance/);
});

test('wallet list responses do not include private keys', async () => {
  const file = tempFile('wallets.json');
  const manager = new WalletManager({ dataFile: file, simulationMode: true });
  const master = await manager.getMasterInfo();
  const subs = await manager.getSubWalletsInfo();
  assert.equal(Object.hasOwn(master, 'privateKey'), false);
  assert.equal(Object.hasOwn(master, 'secretKey'), false);
  assert.ok(subs.every(row => !Object.hasOwn(row, 'privateKey') && !Object.hasOwn(row, 'secretKey')));
  const exported = manager.exportAll();
  assert.equal(typeof exported.master.secretKey, 'string');
});

test('drain reports each wallet instead of hiding a failure', async () => {
  const file = tempFile('wallets.json');
  const manager = new WalletManager({ dataFile: file, simulationMode: true });
  manager.simulatedBalances.set(manager.subWallets[0].publicKey.toBase58(), 0.4);
  manager.simulatedBalances.set(manager.subWallets[1].publicKey.toBase58(), 0);
  const drained = await manager.drainSol();
  assert.equal(drained.success, true);
  assert.equal(drained.results.length, manager.subWallets.length);
  assert.match(drained.note, /SOL only/);
  assert.equal(manager.simulatedBalances.get(manager.subWallets[0].publicKey.toBase58()), 0);
});
