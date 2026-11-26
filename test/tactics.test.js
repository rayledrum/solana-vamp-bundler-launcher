const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair } = require('@solana/web3.js');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `tactics-wallets-${process.pid}.json`);

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tactics.json'), 'utf8'));
const { analyzeWash } = require('../src/research/wash');
const { analyzeHolderPadding } = require('../src/research/holderPadding');
const { analyzeLadderDump } = require('../src/research/ladderDump');
const { analyzeMigrationDump } = require('../src/research/migrationDump');
const { linkSerialDevs } = require('../src/research/serialDev');
const { passesFilters, compareMigrationDumps } = require('../src/research/backtest');
const { createSafetyChecks } = require('../src/safetyChecks');

test('wash volume counts linked round trips and a flood of tiny buys', () => {
  const row = analyzeWash(fixture.wash);
  assert.ok(row.washVolumePct > 0);
  assert.ok(row.reasons.includes('same-amount round trip between linked wallets'));
  assert.ok(row.reasons.includes('flood of tiny buys'));
  assert.ok(row.microBuyTxShare > 50);
  assert.equal(analyzeWash({ mint: 'Missing' }).washVolumePct, null);
  assert.equal(analyzeWash({ mint: 'Missing' }).microBuyTxShare, null);
});

test('dust transfers to wallets with no buy are padded holders', () => {
  const row = analyzeHolderPadding(fixture.holders);
  assert.equal(row.dustHolderCount, 2);
  assert.ok(Math.abs(row.noBuyHolderPct - (200 / 3)) < 0.01);
  assert.ok(Math.abs(row.paddedHolderPct - (200 / 3)) < 0.01);
  assert.equal(analyzeHolderPadding({ mint: 'Missing' }).paddedHolderPct, null);
});

test('even sells across dev-linked wallets are a ladder', () => {
  const row = analyzeLadderDump(fixture.ladder);
  assert.equal(row.flagged, true);
  assert.equal(row.soldSol, 3);
  assert.equal(row.soldSupplyPct, 3);
  assert.equal(row.cadence, 'every 60s');
  assert.equal(analyzeLadderDump({ trades: fixture.ladder.trades }).flagged, null);
});

test('coordinated sells just after graduation are a migration dump', () => {
  const row = analyzeMigrationDump(fixture.migration);
  assert.equal(row.flagged, true);
  assert.equal(row.dumpedSupplyPct, 5);
  assert.equal(row.firstDumpMs, 300000);
  const unknown = analyzeMigrationDump({ mint: 'Open', graduated: null, trades: [] });
  assert.equal(unknown.dumpedSupplyPct, null);
  const coins = [
    {
      mint: 'Dumped',
      snapshots: [{ atMin: 1, mcapUsd: 5000 }, { atMin: 20, mcapUsd: 1000 }],
      migration: row
    },
    {
      mint: 'Held',
      snapshots: [{ atMin: 1, mcapUsd: 5000 }, { atMin: 20, mcapUsd: 9000 }],
      migration: { flagged: false, dumpedSupplyPct: 0, firstDumpMs: null }
    },
    { mint: 'Unknown', snapshots: [{ atMin: 1, mcapUsd: 5000 }, { atMin: 20, mcapUsd: 7000 }], migration: { flagged: null, dumpedSupplyPct: null } }
  ];
  assert.equal(passesFilters(coins[0], { maxMigrationDumpPct: 1 }), false);
  assert.equal(passesFilters(coins[2], { maxMigrationDumpPct: 50 }), false);
  const compared = compareMigrationDumps(coins);
  assert.equal(compared.dumped.n, 1);
  assert.equal(compared.clean.n, 1);
  assert.ok(compared.dumped.avgPnl < compared.clean.avgPnl);
});

test('a shared treasury and reused metadata link a fresh dev to a prior coin', () => {
  const linked = linkSerialDevs(fixture.serial);
  const fresh = linked.find(row => row.mint === 'CoinNew');
  assert.equal(fresh.linkedDevs[0], 'DevOld');
  assert.equal(fresh.linkedPriorCoins[0].rugged, true);
  assert.equal(fresh.linkedPriorCoins[0].peakMcapUsd, 18000);
  const sameDev = linkSerialDevs([
    { mint: 'A', dev: 'Same', twitter: '@one' },
    { mint: 'B', dev: 'Same', twitter: '@one' }
  ]);
  assert.deepEqual(sameDev[0].linkedPriorCoins, []);
  assert.equal(linkSerialDevs(null), null);
});

test('a linked blacklisted dev blocks buys and can be auto-blacklisted without selling', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tactics-safety-'));
  let creator = Keypair.generate().publicKey.toBase58();
  const oldDev = Keypair.generate().publicKey.toBase58();
  const connection = {
    async getAccountInfo() { return null; },
    async getTokenSupply() { return { value: { amount: '1000000' } }; },
    async getTokenLargestAccounts() { return { value: [] }; },
    async getTokenAccountsByOwner() { return { value: [] }; }
  };
  const serialLookup = () => ({
    dev: creator,
    linkedDevs: [oldDev],
    linkedPriorCoins: [{ mint: 'CoinOld', dev: oldDev, rugged: true, peakMcapUsd: 18000, graduated: false }]
  });
  const api = createSafetyChecks({
    blacklistFile: path.join(dir, 'dev-blacklist.json'),
    launchedFile: path.join(dir, 'launched-mints.json'),
    minIntervalMs: 0,
    connection,
    serialLookup,
    async fetchJson() { return { creator, created_timestamp: Date.now() - 3_600_000 }; }
  });
  const mint = Keypair.generate().publicKey.toBase58();
  const nextMint = Keypair.generate().publicKey.toBase58();
  api.addBlacklist(oldDev, 'prior rug', 'manual');
  const blocked = api.buyBlockReason(mint);
  assert.match(blocked, new RegExp(`linked to blacklisted dev ${oldDev}`));
  assert.match(blocked, /Existing positions are not sold automatically/);

  const report = await api.report(mint);
  const serial = report.checks.find(row => row.id === 'serialDev');
  const wash = report.checks.find(row => row.id === 'wash');
  assert.equal(serial.status, 'red');
  assert.match(serial.reason, /CoinOld/);
  assert.match(serial.reason, /peak \$18000/);
  assert.equal(wash.status, 'unknown');
  assert.equal(report.blacklisted, true);

  api.updateSettings({ serialDev: false, enabled: true });
  api.cache.clear();
  creator = Keypair.generate().publicKey.toBase58();
  const second = await api.report(nextMint);
  assert.equal(second.blacklisted, false);
  assert.equal(api.listBlacklist().auto.serialDev, false);
});
