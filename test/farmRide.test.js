const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { Keypair } = require('@solana/web3.js');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `farm-ride-wallets-${process.pid}.json`);

const { scoreFarmEntry, planFarmExit, compareFarmStrategies } = require('../src/research/farmRide');
const walletManager = require('../src/walletManager');
const tradingEngine = require('../src/tradingEngine');

function openFarm(extra = {}) {
  return {
    series: [{ time: 0, mcapUsd: 10000 }, { time: 1000, mcapUsd: 20000 }],
    now: 1000,
    trades: [],
    clusterWallets: ['Bundle'],
    kolWallets: [],
    shadowWallets: [],
    bleed: { flagged: false },
    nonMigrator: { nonMigrator: false },
    curveProgress: 20,
    graduated: false,
    devExit: { fullyExited: false },
    serial: { linkedPriorCoins: [] },
    bonding: { flagged: false },
    sessionRemaining: 0.5,
    maxSol: 0.02,
    ...extra
  };
}

test('a farm ride is eligible while the bundle is still holding and pump 1 is rising', () => {
  const row = scoreFarmEntry(openFarm());
  assert.equal(row.eligible, true);
  assert.equal(row.sizeSol, 0.02);
  assert.ok(row.reasons.includes('bundle cluster has not started selling'));
  assert.ok(row.reasons.includes('pump 1 is still rising'));
  assert.equal(row.checks.early, true);

  const capped = scoreFarmEntry(openFarm({ sessionRemaining: 0.01 }));
  assert.equal(capped.sizeSol, 0.01);
  const blocked = scoreFarmEntry(openFarm({ sessionRemaining: 0 }));
  assert.equal(blocked.eligible, false);

  const selling = scoreFarmEntry(openFarm({
    trades: [{ side: 'sell', wallet: 'Bundle', time: 500 }]
  }));
  assert.equal(selling.eligible, false);
  assert.equal(scoreFarmEntry(openFarm({ series: null })).eligible, null);
});

test('pump 2 is the early entry only after the coin clears the second-pump threshold', () => {
  const second = scoreFarmEntry(openFarm({
    series: [
      { time: 0, mcapUsd: 10000 },
      { time: 1, mcapUsd: 40000 },
      { time: 2, mcapUsd: 20000 },
      { time: 3, mcapUsd: 150000 }
    ],
    now: 3
  }));
  assert.equal(second.checks.early, true);
  assert.ok(second.reasons.includes('pump 2 is still rising'));

  const tooSoon = scoreFarmEntry(openFarm({
    series: [{ time: 0, mcapUsd: 20000 }, { time: 1, mcapUsd: 150000 }],
    now: 1
  }));
  assert.equal(tooSoon.checks.early, false);
  assert.equal(tooSoon.eligible, false);
});

test('a fresh KOL buy qualifies until a shadow wallet sells', () => {
  const fresh = scoreFarmEntry(openFarm({
    clusterWallets: [],
    kolWallets: ['Kol'],
    shadowWallets: ['Shadow'],
    trades: [{ side: 'buy', wallet: 'Kol', time: 900 }],
    kolWindowMs: 600000
  }));
  assert.equal(fresh.checks.kol, true);
  assert.equal(fresh.eligible, true);
  const dumped = scoreFarmEntry(openFarm({
    clusterWallets: [],
    kolWallets: ['Kol'],
    shadowWallets: ['Shadow'],
    trades: [
      { side: 'buy', wallet: 'Kol', time: 900 },
      { side: 'sell', wallet: 'Shadow', time: 950 }
    ]
  }));
  assert.equal(dumped.checks.kol, false);
  assert.equal(dumped.eligible, false);
});

test('hard vetoes block the ride and a cleared instant-bond veto does not', () => {
  assert.equal(scoreFarmEntry(openFarm({ devExit: { timeToFirstSellMs: 1000 } })).eligible, false);
  assert.ok(scoreFarmEntry(openFarm({
    serial: { linkedPriorCoins: [{ mint: 'Old', rugged: true }] }
  })).reasons.includes('early-rug serial dev'));
  assert.equal(scoreFarmEntry(openFarm({ bonding: { flagged: true } })).eligible, false);
  assert.equal(scoreFarmEntry(openFarm({ bonding: { flagged: true }, vetoInstantBond: false })).eligible, true);
  assert.equal(scoreFarmEntry(openFarm({
    nonMigrator: { nonMigrator: true },
    curveProgress: 92,
    graduated: false
  })).eligible, false);
});

test('hard triggers exit in full and a linked scale-out uses the 50/25/25 ladder', () => {
  const stopped = planFarmExit({ entryMcapUsd: 20000, mcapUsd: 10000, positionTokens: 1000, clusterSold: false, bleed: { flagged: false } });
  assert.equal(stopped.sellPct, 100);
  assert.ok(stopped.reasons.includes('stop loss'));
  const cluster = planFarmExit({ entryMcapUsd: 20000, mcapUsd: 30000, positionTokens: 1000, clusterSold: true, bleed: { flagged: false } });
  assert.equal(cluster.sellPct, 100);
  assert.ok(cluster.reasons.includes('first cluster sell'));
  const scaled = planFarmExit({
    entryMcapUsd: 20000,
    mcapUsd: 80000,
    floorUsd: 50000,
    positionTokens: 1000,
    clusterSold: false,
    bleed: { flagged: false },
    scaleOut: { flagged: true }
  });
  assert.equal(scaled.hard, false);
  assert.equal(scaled.sellPct, 50);
});

test('ride-the-farm, avoid-farmed, and baseline report separate results', () => {
  const quiet = {
    mint: 'Quiet',
    snapshots: [{ time: 0, mcapUsd: 10000 }, { time: 1000, mcapUsd: 15000 }],
    clusterWallets: [],
    kolWallets: [],
    trades: []
  };
  const farmed = {
    mint: 'Farmed',
    snapshots: [
      { time: 0, mcapUsd: 10000, curveProgress: 10, graduated: false },
      { time: 1000, mcapUsd: 20000, curveProgress: 20, graduated: false },
      { time: 2000, mcapUsd: 12000, curveProgress: 15, graduated: false }
    ],
    trades: [{ side: 'sell', wallet: 'Bundle', time: 5000 }],
    clusterWallets: ['Bundle'],
    kolWallets: [],
    shadowWallets: [],
    bleed: { flagged: false },
    nonMigrator: { nonMigrator: false },
    devExit: { fullyExited: false },
    serial: { linkedPriorCoins: [] },
    bonding: { flagged: false },
    firstClusterSellAt: 5000
  };
  const report = compareFarmStrategies([farmed, quiet], { maxSol: 0.02, sessionRemaining: 0.5 });
  assert.equal(report.ride.trades, 1);
  assert.equal(report.ride.avgEntryMcap, 20000);
  assert.equal(report.ride.avgExitMcap, 12000);
  assert.equal(report.ride.pctExitsBeforeClusterSell, 1);
  assert.ok(report.ride.worstDrawdown < 0);
  assert.equal(report.avoid.trades, 1);
  assert.equal(report.avoid.avgExitMcap, 15000);
  assert.equal(report.baseline.trades, 2);
  assert.equal(report.avoid.pctExitsBeforeClusterSell, null);
});

test('live mode and a disabled flag do not place a farm trade', async () => {
  walletManager.setSimulationMode(true);
  tradingEngine.connectPumpPortal = () => {};
  tradingEngine.onMintChange = () => {};
  const mint = Keypair.generate().publicKey.toBase58();
  tradingEngine.setActiveToken(mint, []);
  const buys = [];
  const sells = [];
  const originalBuy = tradingEngine.executeBuy;
  const originalSell = tradingEngine.executeSell;
  tradingEngine.executeBuy = async (args) => {
    buys.push(args);
    return { success: true };
  };
  tradingEngine.executeSell = async (args) => {
    sells.push(args);
    return { success: true };
  };
  const context = { ...openFarm(), enabled: true };
  try {
    walletManager.setSimulationMode(false);
    const live = await tradingEngine.actOnFarmRide(mint, context, 1000);
    assert.equal(live.decision.eligible, true);
    assert.equal(live.acted, false);
    assert.equal(buys.length, 0);
    walletManager.setSimulationMode(true);
    tradingEngine.farmRideEnabled = false;
    const off = await tradingEngine.actOnFarmRide(mint, openFarm(), 1000);
    assert.equal(off.acted, false);
    assert.equal(buys.length, 0);
    const on = await tradingEngine.actOnFarmRide(mint, context, 1000);
    assert.equal(on.acted, true);
    assert.equal(buys[0].solAmount, 0.02);
    assert.equal(sells.length, 0);
  } finally {
    tradingEngine.executeBuy = originalBuy;
    tradingEngine.executeSell = originalSell;
    tradingEngine.farmRideEnabled = false;
    walletManager.setSimulationMode(true);
  }
});
