const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair } = require('@solana/web3.js');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `research-wallets-${process.pid}.json`);
const walletManager = require('../src/walletManager');
const tradingEngine = require('../src/tradingEngine');
const { safetyChecks } = require('../src/safetyChecks');
const { createStore } = require('../src/research/store');
const { ingestLaunches, takeDueSnapshots, staticRecord, snapshotRecord } = require('../src/research/collector');
const { trendingThemes } = require('../src/research/meta');
const { planExit, freshState } = require('../src/research/exitLadder');
const { runBacktest } = require('../src/research/backtest');
const { analyzeEarlyBuys, updateRegistry, ownLaunchSnipers } = require('../src/research/snipers');
const { analyzeDevExit, compareDevExit } = require('../src/research/devExit');
const { compareLadders } = require('../src/research/backtest');
const { createSafetyChecks } = require('../src/safetyChecks');
const { runCollect } = require('../src/research/collect');

function tempStore() {
  return createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'research-')));
}

test('collector keeps unknown fields null and resumes', async () => {
  const store = tempStore();
  const coin = { mint: 'MintA', name: 'Cat Coin', symbol: 'CAT', created_timestamp: Date.parse('2026-11-26T15:00:00Z'), creator: 'DevA' };
  const added = await ingestLaunches({ coins: [coin, coin], store, now: Date.parse('2026-11-26T15:00:30Z') });
  assert.equal(added.length, 1);
  assert.equal(added[0].initialDevBuySol, null);
  assert.equal(added[0].safetyScore, null);
  assert.equal(added[0].hourUtc, 15);
  const early = await takeDueSnapshots({
    store,
    now: Date.parse('2026-11-26T15:02:00Z'),
    observe: async () => ({ mcapUsd: 4200, graduated: false })
  });
  assert.deepEqual(early.map(row => row.atMin), [1]);
  assert.equal(early[0].buys, null);
  assert.equal(early[0].holderCount, null);
  const again = await takeDueSnapshots({
    store,
    now: Date.parse('2026-11-26T15:03:00Z'),
    observe: async () => ({})
  });
  assert.equal(again.length, 0);
  assert.equal(staticRecord({}).mint, null);
  assert.equal(snapshotRecord('MintA', 5, {}).top10Pct, null);
});

test('themes rank climbing words and ignore the stop list', () => {
  const now = Date.parse('2026-11-26T16:00:00Z');
  const report = trendingThemes([
    { name: 'Cat Rocket', description: 'the cat coin', at: now - 10 * 60_000, mcapUsd: 9000, prevMcapUsd: 3000, graduated: false },
    { name: 'Cat Again', description: 'cat', at: now - 20 * 60_000, mcapUsd: 2000, prevMcapUsd: 1000, graduated: true },
    { name: 'Quiet Dog', description: 'dog', at: now - 30 * 60_000, mcapUsd: 1100, prevMcapUsd: 1000, graduated: false }
  ], now);
  assert.equal(report.windows['1h'][0].theme, 'cat');
  assert.equal(report.windows['1h'].some(row => row.theme === 'the'), false);
  assert.equal(report.external.length, 0);
});

test('early buys record block offset, bundle funders, and nulls', () => {
  const t0 = 1_700_000_000_000;
  const analysis = analyzeEarlyBuys({
    mint: 'MintA',
    createSlot: 100,
    createTime: t0,
    supply: 1_000_000,
    dev: 'Dev',
    observedUntil: t0 + 20 * 60_000,
    trades: [
      { side: 'buy', wallet: 'Same', slot: 100, time: t0 + 1000, sol: 2, tokens: 100_000, funder: 'Funder' },
      { side: 'buy', wallet: 'Also', slot: 100, time: t0 + 2000, sol: 1, tokens: 50_000, funder: 'Funder' },
      { side: 'buy', wallet: 'Later', slot: 103, time: t0 + 30_000, sol: 0.5, tokens: 10_000, funder: null },
      { side: 'sell', wallet: 'Same', time: t0 + 4 * 60_000, sol: 1.5, mcapUsd: 8000 },
      { side: 'buy', wallet: 'Organic', time: t0 + 3 * 60_000, sol: 3, tokens: 20_000 }
    ]
  });
  assert.equal(analysis.sameBlockCount, 2);
  assert.equal(analysis.sameBlockSupplyPct, 15);
  assert.equal(analysis.sol10s, 3);
  assert.equal(analysis.buys[0].blockOffset, 0);
  assert.equal(analysis.buys[0].bundleCluster, true);
  assert.equal(analysis.buys[0].sold, true);
  assert.equal(analysis.buys[0].soldMcapUsd, 8000);
  assert.equal(analysis.buys[2].fundedByDev, null);
  assert.equal(analysis.holdingPct5 < 100, true);
  const empty = analyzeEarlyBuys({ mint: 'MintB', trades: null });
  assert.equal(empty.buys, null);
  assert.equal(empty.sameBlockCount, null);
  const book = updateRegistry({ wallets: {} }, [analysis, {
    mint: 'MintC',
    buys: [{ wallet: 'Same', sniper: true }]
  }]);
  assert.equal(book.wallets.Same.mints.length, 2);
  assert.equal(analysis.knownSniperReuse, 1);
  const own = ownLaunchSnipers(['MintA', 'Missing'], [analysis]);
  assert.equal(own[0].known, true);
  assert.equal(own[1].sameBlockSupplyPct, null);
});

test('safety uses a derived sniper share and leaves the rest unknown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-sniper-'));
  const api = createSafetyChecks({
    blacklistFile: path.join(dir, 'blacklist.json'),
    launchedFile: path.join(dir, 'launched.json'),
    minIntervalMs: 0,
    sniperLookup: () => ({ pct: 22, buyers: 4 }),
    connection: {
      async getAccountInfo() { return null; },
      async getTokenSupply() { return { value: { amount: '1000' } }; },
      async getTokenLargestAccounts() { return { value: [] }; },
      async getTokenAccountsByOwner() { return { value: [] }; }
    },
    async fetchJson() { throw new Error('offline'); }
  });
  const row = await api.report(Keypair.generate().publicKey.toBase58());
  const snipers = row.checks.find(item => item.id === 'snipers');
  assert.equal(snipers.status, 'yellow');
  assert.match(snipers.reason, /22\.0%/);
  assert.equal(row.checks.find(item => item.id === 'rugcheck').status, 'unknown');
  assert.equal(row.checks.find(item => item.id === 'devAssociated').status, 'unknown');
});

test('backtest skips unknown sniper rows and reports pnl after fees', () => {
  const input = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'research-sample.json'), 'utf8'));
  const result = runBacktest(input);
  assert.equal(result.trades, 1);
  assert.equal(result.skipped, 3);
  assert.equal(result.hitRate, 1);
  assert.ok(result.medianPnl > 0);
  assert.ok(result.avgPnl < 7);
});

test('the exit ladder scales out in simulation and stays off for live', async () => {
  const state = freshState();
  state.originalTokens = 1000;
  state.entryMcapUsd = 4000;
  state.highMcapUsd = 4000;
  state.highAt = 0;
  const plan = planExit({
    ladder: { enabled: true, milestones: [{ mcapUsd: 10000, sellPct: 25 }], moonbagPct: 25, maxCurvePct: 5, minSellGapMs: 0, stallMinutes: 99 },
    state,
    mcapUsd: 12000,
    liquiditySol: 10,
    priceSol: 0.00001,
    positionTokens: 1000,
    now: 1000
  });
  assert.equal(plan.action, 'sell');
  assert.ok(plan.sellPct <= 25);
  walletManager.setSimulationMode(false);
  assert.throws(() => tradingEngine.configureExitLadder({ enabled: true }), /simulation-only/);
  walletManager.setSimulationMode(true);
  tradingEngine.connectPumpPortal = () => {};
  tradingEngine.onMintChange = () => {};
  const mint = Keypair.generate().publicKey.toBase58();
  const master = walletManager.masterWallet.publicKey.toBase58();
  safetyChecks.noteOwnLaunch(mint);
  tradingEngine.setActiveToken(mint, [{ address: master, tokens: 1000, sol: 0.05 }]);
  tradingEngine.configureExitLadder({ enabled: true, milestones: [{ mcapUsd: 10000, sellPct: 25 }], moonbagPct: 25, maxCurvePct: 100, minSellGapMs: 0, stallMinutes: 99 });
  const calls = [];
  tradingEngine.executeSell = async (args) => {
    calls.push(args);
    return { success: true, totalReceivedSol: 0.01, results: [] };
  };
  const held = await tradingEngine.reviewExitLadder(mint, { mcapUsd: 5000, liquiditySol: 20, priceSol: 0.00002 }, 1000);
  assert.equal(held.action, 'hold');
  const sold = await tradingEngine.reviewExitLadder(mint, { mcapUsd: 15000, liquiditySol: 20, priceSol: 0.00002 }, 2000);
  assert.equal(sold.action, 'sell');
  assert.equal(calls[0].fromLadder, true);
  assert.equal(calls[0].walletAddresses[0], master);
  tradingEngine.configureExitLadder({ enabled: false });
});

test('dev exit timing compares buyers before and after the first dev sell', () => {
  const t0 = 1_700_000_000_000;
  const row = analyzeDevExit({
    mint: 'MintA',
    dev: 'Dev',
    createTime: t0,
    supply: 1_000_000,
    initialDevTokens: 200_000,
    observedUntil: t0 + 30 * 60_000,
    trades: [
      { side: 'buy', wallet: 'Buddy', funder: 'Dev', time: t0 + 1000, tokens: 50_000, sol: 1 },
      { side: 'buy', wallet: 'Buyer', time: t0 + 2 * 60_000, tokens: 10_000, sol: 0.4 },
      { side: 'sell', wallet: 'Dev', time: t0 + 10 * 60_000, tokens: 200_000, mcapUsd: 12000 },
      { side: 'buy', wallet: 'After', time: t0 + 12 * 60_000, tokens: 8_000, sol: 0.5 },
      { side: 'buy', wallet: 'After2', time: t0 + 14 * 60_000, tokens: 8_000, sol: 0.5 },
      { side: 'sell', wallet: 'Buddy', time: t0 + 16 * 60_000, tokens: 50_000, mcapUsd: 9000 }
    ],
    snapshots: [
      { time: t0 + 11 * 60_000, mcapUsd: 13000 },
      { time: t0 + 20 * 60_000, mcapUsd: null }
    ]
  });
  assert.equal(row.sells[0].bagPct, 100);
  assert.equal(row.timeToFirstSellMs, 10 * 60_000);
  assert.equal(row.fullyExited, true);
  assert.equal(row.associated.length, 1);
  assert.equal(row.associated[0].sold, true);
  assert.equal(row.associatedHoldPct, 0);
  assert.equal(row.beforeFirstSell.uniqueBuyers, 1);
  assert.equal(row.afterFirstSell.uniqueBuyers, 2);
  assert.equal(row.mcapAfterFirstSell[1].mcapUsd, null);
  const unknown = analyzeDevExit({ mint: 'MintB', trades: null, dev: 'Dev' });
  assert.equal(unknown.fullyExited, null);
  assert.equal(unknown.associatedHoldPct, null);
  const compared = compareDevExit([
    { pnl: 0.4, devExit: { timeToFirstSellMs: 5 * 60_000, fullyExited: true } },
    { pnl: -0.2, devExit: { timeToFirstSellMs: 60 * 60_000, fullyExited: false } }
  ]);
  assert.equal(compared.early.n, 1);
  assert.equal(compared.held.n, 1);
  assert.equal(compared.early.hitRate, 1);
});

test('an early dev sale is a separate ladder from waiting for 30k', () => {
  const coins = [{
    mint: 'Own',
    snapshots: [
      { atMin: 1, mcapUsd: 4000 },
      { atMin: 5, mcapUsd: 4500 },
      { atMin: 40, mcapUsd: 2000 }
    ]
  }];
  const [early, later] = compareLadders(coins, [
    { name: 'early', earlyDevSell: { atMin: 5, sellPct: 50 }, moonbagPct: 0, milestones: [] },
    { name: 'later', milestones: [{ mcapUsd: 30000, sellPct: 50 }], moonbagPct: 0, stallMinutes: 999 }
  ]);
  assert.equal(early.name, 'early');
  assert.ok(early.medianPnl > later.medianPnl);
});

test('collection stores sniper rows only from supplied trades', async () => {
  const store = tempStore();
  const t0 = Date.parse('2026-11-26T15:00:00Z');
  const result = await runCollect({
    store,
    now: t0 + 30_000,
    listCoins: async () => [{ mint: 'MintZ', name: 'Zebra', created_timestamp: t0 }],
    enrich: async () => ({ safetyScore: null, devHistory: null }),
    earlyTrades: async () => ({
      createSlot: 10,
      createTime: t0,
      supply: 100,
      dev: 'Dev',
      observedUntil: t0 + 1000,
      trades: [{ side: 'buy', wallet: 'W', slot: 10, time: t0 + 500, sol: 1, tokens: 10 }]
    }),
    observe: async () => ({})
  });
  assert.equal(result.added, 1);
  const rows = store.readJsonl('snipers.jsonl');
  assert.equal(rows[0].sameBlockCount, 1);
  assert.equal(rows[0].holdingPct5, null);
  const exits = store.readJsonl('dev-exits.jsonl');
  assert.equal(exits[0].fullyExited, null);
  assert.equal(exits[0].associatedHoldPct, null);
});
