const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair } = require('@solana/web3.js');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `tape-flags-wallets-${process.pid}.json`);

const { loadKolList } = require('../src/research/distribution');
const { analyzeKolShadow, analyzeMcRun, analyzeScaleOut, analyzeInstantBond } = require('../src/research/tapeFlags');
const { scoreCoordination } = require('../src/research/coordination');
const { passesFilters } = require('../src/research/backtest');
const { createSafetyChecks } = require('../src/safetyChecks');

const kolFile = path.join(__dirname, '..', 'data', 'research', 'kol-wallets.json');

test('the seed KOL list loads wallet fields and ignores the rest', () => {
  const rows = JSON.parse(fs.readFileSync(kolFile, 'utf8'));
  const loaded = loadKolList(kolFile);
  assert.deepEqual(loaded, rows.map(row => row.wallet));
  assert.equal(loaded.length, 43);
  assert.equal(loaded[0], 'GM7Hrz2bDq33ezMtL6KGidSWZXMWgZ6qBuugkb5H8NvN');
  assert.equal(loaded.includes('JDd3hy3gQn2V982mi1zqhNqUw1GfV2UL6g76STojCJPN'), true);
  const extra = path.join(os.tmpdir(), `kol-extra-${process.pid}.json`);
  fs.writeFileSync(extra, JSON.stringify([{ wallet: 'WalletA', name: 'Ignored', notes: 'extra' }]));
  assert.deepEqual(loadKolList(extra), ['WalletA']);
});

test('a KOL buy flags a shadow transfer, a funder link, and a repeat', () => {
  const kol = 'GM7Hrz2bDq33ezMtL6KGidSWZXMWgZ6qBuugkb5H8NvN';
  const row = analyzeKolShadow({
    mint: 'MintA',
    supply: 100000,
    dev: 'Creator',
    kolWallets: [kol],
    fundings: [
      { wallet: 'Shadow', funder: 'Mid', ancestor: 'Treasury' },
      { wallet: kol, funder: 'Mid', ancestor: 'Treasury' }
    ],
    trades: [
      { side: 'buy', wallet: kol, sol: 1, time: 1_000_000 },
      { side: 'transfer', to: 'Shadow', tokens: 2000, time: 1_060_000 },
      { side: 'sell', wallet: 'Shadow', sol: 0.4, tokens: 2000, time: 1_120_000 }
    ],
    history: [{ mint: 'MintOld', wallet: 'Shadow', kol }]
  });
  assert.equal(row.shadowCount, 1);
  assert.equal(row.supplyPct, 2);
  assert.equal(row.repeat, true);
  assert.ok(row.reasons.includes('bare token transfer'));
  assert.ok(row.reasons.includes('shared funder'));
  assert.ok(row.reasons.includes('sold without an on-market buy'));
  assert.ok(row.reasons.includes('repeated after the same KOL'));
  const clustered = scoreCoordination({
    mint: 'MintA',
    buyers: [{ wallet: 'Buyer', supplyPct: 1 }],
    shadowWallets: row.wallets
  });
  assert.ok(clustered.clusters.some(item => item.kind === 'kol-shadow' && item.wallets.includes('Shadow')));
  assert.equal(clustered.coordinatedSupplyPct, 2);
  assert.equal(analyzeKolShadow({ mint: 'MintB' }).shadowCount, null);
});

test('same-slot buys across a wide market cap are a run', () => {
  const row = analyzeMcRun({
    mint: 'MintA',
    trades: [100000, 200000, 300000, 450000, 600000].map(mcapUsd => ({ side: 'buy', wallet: 'W', slot: 9, time: 5, mcapUsd }))
  });
  assert.equal(row.flagged, true);
  assert.equal(row.buyCount, 5);
  assert.equal(row.mcapLow, 100000);
  assert.equal(row.mcapHigh, 600000);
  const unknown = analyzeMcRun({
    mint: 'MintA',
    trades: Array.from({ length: 5 }, () => ({ side: 'buy', slot: 9, time: 5 }))
  });
  assert.equal(unknown.flagged, null);
  assert.equal(unknown.mcapLow, null);
});

test('a dense sell trail while market cap rises is a scale-out', () => {
  const t0 = 5_000_000;
  const row = analyzeScaleOut({
    mint: 'MintA',
    supply: 100000,
    trades: [0, 1, 2, 3].map(step => ({
      side: 'sell',
      wallet: 'Seller',
      sol: 0.2,
      tokens: 1000,
      time: t0 + step * 30_000,
      mcapUsd: 100000 + step * 50000
    }))
  });
  assert.equal(row.flagged, true);
  assert.equal(row.sellCount, 4);
  assert.equal(row.soldSol, 0.8);
  assert.equal(row.soldSupplyPct, 4);
  assert.equal(row.mcapChange, 150000);
  assert.equal(analyzeScaleOut({ mint: 'MintB' }).sellCount, null);
});

test('graduation under the threshold is near-instant bonding', () => {
  const fast = analyzeInstantBond({ mint: 'MintA', createTime: 0, graduatedAt: 12_000, graduated: true });
  assert.equal(fast.flagged, true);
  assert.equal(fast.durationMs, 12_000);
  const normal = analyzeInstantBond({ mint: 'MintB', createTime: 0, graduatedAt: 90_000, graduated: true, thresholdMs: 60_000 });
  assert.equal(normal.flagged, false);
  assert.equal(analyzeInstantBond({ mint: 'MintC', graduated: true }).flagged, null);
  assert.equal(passesFilters({ bonding: { graduated: true, durationMs: 12_000 } }, { minBondingSec: 60 }), false);
  assert.equal(passesFilters({ bonding: { graduated: null, durationMs: null } }, { minBondingSec: 60 }), false);
  assert.equal(passesFilters({ kolShadow: { supplyPct: null } }, { maxKolShadowPct: 5 }), false);
  assert.equal(passesFilters({ kolShadow: { supplyPct: 1 } }, { maxKolShadowPct: 5 }), true);
});

test('the safety panel labels KOL shadow sells', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-safety-'));
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const api = createSafetyChecks({
    blacklistFile: path.join(dir, 'dev-blacklist.json'),
    launchedFile: path.join(dir, 'launched-mints.json'),
    minIntervalMs: 0,
    connection: {
      async getAccountInfo() { return null; },
      async getTokenSupply() { return { value: { amount: '1000000' } }; },
      async getTokenLargestAccounts() { return { value: [] }; },
      async getTokenAccountsByOwner() { return { value: [] }; }
    },
    kolShadowLookup: () => ({ shadowCount: 2, supplyPct: 4, reasons: ['bare token transfer'], repeat: false, wallets: [] }),
    mcRunLookup: () => ({ flagged: true, buyCount: 5, mcapLow: 100000, mcapHigh: 600000 }),
    scaleOutLookup: () => ({ flagged: true, sellCount: 4, soldSol: 0.8, soldSupplyPct: 4, mcapChange: 150000 }),
    bondingLookup: () => ({ flagged: true, durationMs: 12000, thresholdMs: 60000 }),
    async fetchJson() { return { creator, created_timestamp: Date.now() - 3_600_000 }; }
  });
  const report = await api.report(mint);
  const byId = Object.fromEntries(report.checks.map(row => [row.id, row]));
  assert.equal(byId.kolShadow.label, 'KOL shadow sells');
  assert.match(byId.kolShadow.reason, /2 shadow wallets/);
  assert.match(byId.kolShadow.reason, /4\.0%/);
  assert.match(byId.mcRun.reason, /5 buys from \$100000 to \$600000/);
  assert.match(byId.scaleOut.reason, /4 sells/);
  assert.match(byId.instantBond.reason, /Graduated in 12s/);
});
