const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair } = require('@solana/web3.js');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `top-traders-wallets-${process.pid}.json`);

const { analyzeTopTraders } = require('../src/research/topTraders');
const { passesFilters } = require('../src/research/backtest');
const { createSafetyChecks } = require('../src/safetyChecks');

test('top traders rank closed profit and leave transfer cost unknown', () => {
  const row = analyzeTopTraders({
    mint: 'MintA',
    createTime: 1000,
    topN: 2,
    kolWallets: ['Kol'],
    clusterWallets: [],
    shadowWallets: [],
    serialWallets: [],
    registry: { wallets: {} },
    trades: [
      { side: 'buy', wallet: 'Organic', sol: 1, tokens: 100, time: 1500 },
      { side: 'sell', wallet: 'Organic', sol: 2, tokens: 100, time: 2500 },
      { side: 'buy', wallet: 'Kol', sol: 1, tokens: 100, time: 1600 },
      { side: 'sell', wallet: 'Kol', sol: 3, tokens: 100, time: 2600 },
      { side: 'transfer', to: 'Shadow', tokens: 50, time: 1800 }
    ]
  });
  assert.equal(row.wallets[0].wallet, 'Kol');
  assert.equal(row.wallets[0].pnl, 2);
  assert.equal(row.wallets[0].kol, true);
  assert.equal(row.wallets[0].linked, true);
  assert.equal(row.wallets[1].wallet, 'Organic');
  assert.equal(row.wallets[1].pnl, 1);
  assert.equal(row.wallets[1].linked, false);
  assert.equal(row.wallets[1].firstSeenOffsetMs, 500);
  assert.equal(row.wallets[1].tokensBought, 100);
  assert.equal(row.wallets[1].tokensReceived, 0);
  assert.ok(Math.abs(row.linkedProfitPct - (200 / 3)) < 1e-9);
  assert.ok(Math.abs(row.organicProfitPct - (100 / 3)) < 1e-9);

  const held = analyzeTopTraders({
    mint: 'MintB',
    trades: [{ side: 'transfer', to: 'Shadow', tokens: 50, time: 1800 }],
    kolWallets: [],
    clusterWallets: [],
    shadowWallets: ['Shadow'],
    serialWallets: [],
    registry: { wallets: {} }
  });
  assert.equal(held.wallets[0].tokensReceived, 50);
  assert.equal(held.wallets[0].tokensBought, 0);
  assert.equal(held.wallets[0].pnl, null);
  assert.equal(held.linkedProfitPct, null);
  assert.equal(analyzeTopTraders({ mint: 'Missing' }).wallets, null);
  assert.equal(passesFilters({ topTraders: { linkedProfitPct: null } }, { maxLinkedTraderPct: 20 }), false);
  assert.equal(passesFilters({ topTraders: { linkedProfitPct: 10 } }, { maxLinkedTraderPct: 20 }), true);
});

test('the safety panel can show the top-trader profit split', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top-safety-'));
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const api = createSafetyChecks({
    blacklistFile: path.join(dir, 'dev-blacklist.json'),
    launchedFile: path.join(dir, 'launched-mints.json'),
    minIntervalMs: 0,
    topTraderLookup: () => ({
      wallets: [{ wallet: 'KolWallet', pnl: 2, solIn: 1, solOut: 3, tokensBought: 100, tokensReceived: 0, kol: true }],
      linkedProfitPct: 100,
      organicProfitPct: 0
    }),
    connection: {
      async getAccountInfo() { return null; },
      async getTokenSupply() { return { value: { amount: '1000000' } }; },
      async getTokenLargestAccounts() { return { value: [] }; },
      async getTokenAccountsByOwner() { return { value: [] }; }
    },
    async fetchJson() { return { creator, created_timestamp: Date.now() - 3_600_000 }; }
  });
  const report = await api.report(mint);
  const row = report.checks.find(item => item.id === 'topTraders');
  assert.equal(row.label, 'Top traders');
  assert.match(row.reason, /100\.0% of profit to linked wallets/);
  assert.equal(report.topTraders.wallets[0].wallet, 'KolWallet');
});
