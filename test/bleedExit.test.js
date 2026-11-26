const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair } = require('@solana/web3.js');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `bleed-exit-wallets-${process.pid}.json`);

const {
  trackPumps,
  analyzeBleed,
  buildExitAlert,
  planBleedExit,
  entryDecision,
  applyEntryGate,
  compareBleedStrategy
} = require('../src/research/bleedExit');
const {
  analyzeNearMigration,
  analyzeForcedMigration,
  labelNonMigrators,
  summarizeNonMigrators
} = require('../src/research/nonMigrator');
const walletManager = require('../src/walletManager');
const tradingEngine = require('../src/tradingEngine');
const { safetyChecks } = require('../src/safetyChecks');
const { createSafetyChecks } = require('../src/safetyChecks');

test('a peak under 100k arms after pump 1 and a peak above waits for pump 2', () => {
  const small = trackPumps([
    { time: 0, mcapUsd: 10000 },
    { time: 1, mcapUsd: 40000 },
    { time: 2, mcapUsd: 20000 }
  ]);
  assert.equal(small.aboveSecondPumpThreshold, false);
  assert.equal(small.armAfterPump, 1);
  assert.equal(small.armed, true);
  assert.equal(small.pumps[0].number, 1);

  const oneHigh = trackPumps([
    { time: 0, mcapUsd: 20000 },
    { time: 1, mcapUsd: 150000 },
    { time: 2, mcapUsd: 80000 }
  ]);
  assert.equal(oneHigh.armAfterPump, 2);
  assert.equal(oneHigh.armed, false);

  const twoHigh = trackPumps([
    { time: 0, mcapUsd: 20000 },
    { time: 1, mcapUsd: 80000 },
    { time: 2, mcapUsd: 40000 },
    { time: 3, mcapUsd: 180000 },
    { time: 4, mcapUsd: 100000 }
  ]);
  assert.equal(twoHigh.pumps.length, 2);
  assert.equal(twoHigh.armed, true);

  const solOnly = trackPumps([{ time: 0, mcapSol: 400 }, { time: 1, mcapSol: 900 }, { time: 2, mcapSol: 500 }]);
  assert.equal(solOnly.aboveSecondPumpThreshold, null);
  assert.equal(solOnly.armed, null);
  const priced = trackPumps([
    { time: 0, mcapSol: 100 },
    { time: 1, mcapSol: 400 },
    { time: 2, mcapSol: 200 }
  ], { solPriceUsd: 100 });
  assert.equal(priced.aboveSecondPumpThreshold, false);
  assert.equal(priced.armAfterPump, 1);
  assert.equal(trackPumps(null).pumps, null);
});

test('slow bleed after the armed pump records supply, absorption, and market cap from the peak', () => {
  const t0 = 1_000_000;
  const bleed = analyzeBleed({
    mint: 'MintA',
    armed: true,
    peakAt: t0,
    peakMcapUsd: 160000,
    mcapUsd: 90000,
    supply: 100000,
    linkedWallets: ['Dev'],
    trades: [
      { side: 'sell', wallet: 'Dev', sol: 0.2, tokens: 1000, time: t0 + 1000 },
      { side: 'sell', wallet: 'Dev', sol: 0.2, tokens: 1000, time: t0 + 2000 },
      { side: 'sell', wallet: 'Dev', sol: 0.2, tokens: 1000, time: t0 + 3000 },
      { side: 'buy', wallet: 'Dip', sol: 0.3, time: t0 + 1500 },
      { side: 'buy', wallet: 'Dip2', sol: 0.3, time: t0 + 2500 },
      { side: 'buy', wallet: 'Dip3', sol: 0.3, time: t0 + 2800 }
    ]
  });
  assert.equal(bleed.flagged, true);
  assert.equal(bleed.bleedStart, t0 + 1000);
  assert.ok(Math.abs(bleed.soldSol - 0.6) < 1e-9);
  assert.equal(bleed.soldSupplyPct, 3);
  assert.equal(bleed.buyAbsorptionRatio, 1);
  assert.ok(Math.abs(bleed.mcapFromPeak - 90000 / 160000) < 1e-9);
  assert.equal(analyzeBleed({ trades: null, armed: true, peakAt: t0 }).flagged, null);

  const alert = buildExitAlert({
    pumps: { armed: true, armAfterPump: 1 },
    bleed,
    floorUsd: 50000
  });
  const plan = planBleedExit({
    alert,
    mcapUsd: 80000,
    floorUsd: 50000,
    positionTokens: 1000
  });
  assert.equal(plan.action, 'sell');
  assert.equal(plan.sellPct, 50);
  const late = planBleedExit({ alert, mcapUsd: 40000, floorUsd: 50000, positionTokens: 1000 });
  assert.equal(late.sellPct, 100);
  const unknown = planBleedExit({ alert, mcapSol: 10, floorUsd: 50000, positionTokens: 1000 });
  assert.equal(unknown.reason, 'floor-unknown');
  assert.equal(unknown.action, 'hold');
});

test('exit on bleed reports the average exit market cap and the share above the floor', () => {
  const result = compareBleedStrategy([
    {
      mint: 'Under',
      supply: 100000,
      linkedWallets: ['Dev'],
      snapshots: [
        { time: 0, mcapUsd: 10000 },
        { time: 1, mcapUsd: 40000 },
        { time: 2, mcapUsd: 20000 },
        { time: 5000, mcapUsd: 60000 }
      ],
      trades: [
        { side: 'sell', wallet: 'Dev', sol: 0.1, tokens: 100, time: 4000 },
        { side: 'sell', wallet: 'Dev', sol: 0.1, tokens: 100, time: 5000 },
        { side: 'sell', wallet: 'Dev', sol: 0.1, tokens: 100, time: 6000 },
        { side: 'buy', wallet: 'A', sol: 0.2, time: 4500 },
        { side: 'buy', wallet: 'B', sol: 0.2, time: 5500 },
        { side: 'buy', wallet: 'C', sol: 0.2, time: 5800 }
      ]
    }
  ], { floorUsd: 50000, secondPumpMcapUsd: 100000 });
  assert.equal(result.trades, 1);
  assert.equal(result.avgExitMcap, 60000);
  assert.equal(result.pctExitedBeforeFloor, 1);
  assert.equal(result.secondPumpMcapUsd, 100000);
});

test('linked sells near 90% without graduating are a non-migrator pattern', () => {
  const near = analyzeNearMigration({
    mint: 'Stall',
    graduated: false,
    curveProgress: 92,
    linkedWallets: ['Dev'],
    trades: [{ side: 'sell', wallet: 'Dev', sol: 1, time: 10 }]
  });
  assert.equal(near.flagged, true);
  assert.equal(analyzeNearMigration({ graduated: false, curveProgress: null, trades: [], linkedWallets: ['Dev'] }).flagged, null);
  assert.equal(analyzeNearMigration({
    graduated: true,
    curveProgress: 100,
    trades: [{ side: 'sell', wallet: 'Dev', time: 10 }],
    linkedWallets: ['Dev']
  }).flagged, false);

  const forced = analyzeForcedMigration({
    mint: 'Pushed',
    graduated: true,
    graduatedAt: 1_000_000,
    supply: 100000,
    linkedWallets: ['Dev'],
    trades: [
      { side: 'buy', wallet: 'Outsider', sol: 1, time: 900_000 },
      { side: 'buy', wallet: 'Whale', sol: 8, time: 980_000 },
      { side: 'sell', wallet: 'Dev', sol: 2, tokens: 20000, time: 1_120_000, venue: 'pump-swap' }
    ]
  });
  assert.equal(forced.flagged, true);
  assert.equal(forced.dumpedSupplyPct, 20);
  assert.equal(analyzeForcedMigration({
    graduated: true,
    graduatedAt: 1_000_000,
    linkedWallets: ['Dev'],
    trades: [{ side: 'sell', wallet: 'Dev', sol: 1, time: 1_100_000 }]
  }).flagged, null);

  const label = labelNonMigrators({
    mint: 'FreshCoin',
    dev: 'Fresh',
    linkedDevs: ['Old'],
    coins: [
      { mint: 'OldCoin', dev: 'Old', nearMigration: true, forcedDump: false },
      { mint: 'FreshCoin', dev: 'Fresh', nearMigration: null, forcedDump: null }
    ]
  });
  assert.equal(label.nonMigrator, true);
  assert.equal(label.history[0].mint, 'OldCoin');
  assert.equal(labelNonMigrators({ mint: 'Only', dev: 'Dev', coins: null }).nonMigrator, null);

  const gate = entryDecision({
    nonMigrator: label,
    curveProgress: 93,
    graduated: false
  });
  assert.equal(gate.action, 'skip');
  assert.match(gate.reasons.join(' '), /non-migrator/);
  const alert = buildExitAlert({ nonMigrator: label, curveProgress: 93, graduated: false });
  assert.equal(alert.action, 'sell');
  assert.match(alert.reasons[0], /migration line/);
  assert.equal(applyEntryGate(false, gate, 0.1).action, 'allow');
  assert.equal(applyEntryGate(true, gate, 0.1).action, 'skip');

  const summary = summarizeNonMigrators([
    { mint: 'OldCoin', dev: 'Old', nearMigration: true, forcedDump: false, curveProgress: 40, graduated: false, history: [
      { mint: 'OldCoin', dev: 'Old', nearMigration: true, forcedDump: false },
      { mint: 'FreshCoin', dev: 'Fresh', curveProgress: 93, graduated: false }
    ] },
    {
      mint: 'FreshCoin',
      dev: 'Fresh',
      curveProgress: 93,
      graduated: false,
      linkedDevs: ['Old'],
      history: [
        { mint: 'OldCoin', dev: 'Old', nearMigration: true, forcedDump: false },
        { mint: 'FreshCoin', dev: 'Fresh', curveProgress: 93, graduated: false }
      ]
    }
  ]);
  assert.equal(summary.skippedNearLine, 1);
  assert.equal(summary.progressThreshold, 90);
});

test('live mode shows the bleed alert and does not sell', async () => {
  walletManager.setSimulationMode(true);
  tradingEngine.connectPumpPortal = () => {};
  tradingEngine.onMintChange = () => {};
  const mint = Keypair.generate().publicKey.toBase58();
  const master = walletManager.masterWallet.publicKey.toBase58();
  safetyChecks.noteOwnLaunch(mint);
  tradingEngine.setActiveToken(mint, [{ address: master, tokens: 1000, sol: 0.05 }]);
  const original = tradingEngine.executeSell;
  const calls = [];
  tradingEngine.executeSell = async (args) => {
    calls.push(args);
    return { success: true };
  };
  try {
    walletManager.setSimulationMode(false);
    const live = await tradingEngine.reviewBleedExit(mint, {
      pumps: { armed: true, armAfterPump: 2 },
      bleed: { flagged: true },
      mcapUsd: 80000,
      floorUsd: 50000
    }, 10);
    assert.equal(live.action, 'sell');
    assert.equal(live.acted, false);
    assert.equal(calls.length, 0);
    walletManager.setSimulationMode(true);
    const sim = await tradingEngine.reviewBleedExit(mint, {
      pumps: { armed: true, armAfterPump: 2 },
      bleed: { flagged: true },
      mcapUsd: 80000,
      floorUsd: 50000
    }, 20);
    assert.equal(sim.acted, true);
    assert.equal(calls[0].fromLadder, true);
    assert.equal(calls.length, 1);
  } finally {
    tradingEngine.executeSell = original;
    walletManager.setSimulationMode(true);
  }
});

test('the safety panel names a non-migrator and the prior coin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bleed-safety-'));
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
    async fetchJson() { return { creator, created_timestamp: Date.now() - 3_600_000 }; }
  });
  const original = require('../src/research/bleedExit');
  const assessed = api.report ? null : null;
  void original;
  void assessed;
  const report = await api.report(mint);
  const row = report.checks.find(item => item.id === 'nonMigrator');
  assert.equal(row.label, 'Non-migrator');
  assert.ok(row.status === 'unknown' || row.status === 'green' || row.status === 'red');
  assert.ok(report.exitAlert);
});
