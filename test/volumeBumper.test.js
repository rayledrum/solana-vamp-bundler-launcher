const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `bump-wallets-${process.pid}.json`);
const walletManager = require('../src/walletManager');
const tradingEngine = require('../src/tradingEngine');
const { chooseBumpSide, createRandomStrategy } = require('../src/volumeStrategy');
const realSell = tradingEngine.executeSell.bind(tradingEngine);

function addresses() {
  return walletManager.subWallets.map(wallet => wallet.publicKey.toBase58());
}

function manualClock() {
  const queue = [];
  const delays = [];
  const schedule = (fn, ms) => {
    delays.push(ms);
    queue.push(fn);
    return queue.length;
  };
  return {
    delays,
    schedule,
    async fire() {
      const fn = queue.shift();
      if (!fn) throw new Error('no bumper step was scheduled');
      await fn();
    }
  };
}

function mockTrades() {
  const calls = { buys: [], sells: [] };
  tradingEngine.executeBuy = async ({ solAmount, walletAddresses }) => {
    calls.buys.push({ solAmount, address: walletAddresses[0] });
    const position = tradingEngine.positions.get(walletAddresses[0]) || { tokens: 0, solInvested: 0, costKnown: true };
    position.tokens += 1000;
    position.solInvested += solAmount;
    tradingEngine.positions.set(walletAddresses[0], position);
    return {
      success: true,
      totalSpentSol: solAmount,
      results: [{ address: walletAddresses[0], tokensBought: 1000, txSignature: `buy-${calls.buys.length}`, status: 'Success' }]
    };
  };
  tradingEngine.executeSell = async ({ pct, walletAddresses }) => {
    calls.sells.push({ pct, address: walletAddresses[0] });
    const position = tradingEngine.positions.get(walletAddresses[0]);
    if (position) position.tokens = 0;
    return {
      success: true,
      totalReceivedSol: 0.008,
      results: [{ address: walletAddresses[0], tokensSold: 1000, txSignature: `sell-${calls.sells.length}`, status: 'Success' }]
    };
  };
  return calls;
}

function quiet() {
  walletManager.setSimulationMode(true);
  tradingEngine.connectPumpPortal = () => {};
  tradingEngine.onMintChange = () => {};
  tradingEngine.stopVolumeBumper();
  tradingEngine.setActiveToken('BumpMint', []);
  tradingEngine.setBroadcaster(() => {});
}

test('the SOL reserve skips a sub-wallet that would be drained', async () => {
  quiet();
  const subs = addresses();
  subs.forEach(address => walletManager.simulatedBalances.set(address, 0.025));
  const rich = subs[1];
  walletManager.simulatedBalances.set(rich, 0.2);
  const calls = mockTrades();
  const clock = manualClock();
  tradingEngine.startVolumeBumper(0.01, { reserveSol: 0.02, minDelaySeconds: 3, maxDelaySeconds: 10, maxCycles: 1, sessionBudget: 0.05, schedule: clock.schedule, rng: () => 0 });
  assert.equal(calls.buys.length, 0);
  await clock.fire();
  assert.deepEqual(calls.buys.map(row => row.address), [rich]);
  await tradingEngine.stopVolumeBumper();
});

test('session budget and max cycles stop new buys and sell the open lot', async () => {
  quiet();
  const calls = mockTrades();
  const clock = manualClock();
  tradingEngine.startVolumeBumper(0.01, { reserveSol: 0, minDelaySeconds: 1, maxDelaySeconds: 1, maxCycles: 5, sessionBudget: 0.01, schedule: clock.schedule });
  await clock.fire();
  assert.equal(calls.buys.length, 1);
  assert.equal(tradingEngine.isBumping, false);
  assert.equal(calls.sells.length, 1);
  assert.equal(calls.sells[0].pct, 100);
  assert.match(tradingEngine.bumpLastError, /budget/i);
  assert.equal(Number(tradingEngine.bumpNetSol.toFixed(4)), 0.002);
});

test('stop sells open cycle positions and does not buy again', async () => {
  quiet();
  const calls = mockTrades();
  const clock = manualClock();
  tradingEngine.startVolumeBumper(0.01, { reserveSol: 0, minDelaySeconds: 3, maxDelaySeconds: 10, maxCycles: 10, sessionBudget: 0.2, schedule: clock.schedule, rng: () => 0 });
  await clock.fire();
  assert.equal(calls.buys.length, 1);
  assert.equal(calls.sells.length, 0);
  await tradingEngine.stopVolumeBumper();
  assert.equal(tradingEngine.isBumping, false);
  assert.equal(calls.buys.length, 1);
  assert.equal(calls.sells.length, 1);
  assert.equal(calls.sells[0].address, calls.buys[0].address);
});

test('three failed buys auto-stop', async () => {
  quiet();
  tradingEngine.executeBuy = async () => ({ success: false, error: 'no route', results: [] });
  tradingEngine.executeSell = async () => ({ success: true, totalReceivedSol: 0, results: [] });
  const clock = manualClock();
  tradingEngine.startVolumeBumper(0.01, { reserveSol: 0, minDelaySeconds: 1, maxDelaySeconds: 1, maxErrors: 3, maxCycles: 10, sessionBudget: 0.2, schedule: clock.schedule });
  await clock.fire();
  await clock.fire();
  await clock.fire();
  assert.equal(tradingEngine.isBumping, false);
  assert.match(tradingEngine.bumpLastError, /consecutive errors/i);
});

test('graduation stops the bumper and sells the open lot', async () => {
  quiet();
  const calls = mockTrades();
  const clock = manualClock();
  tradingEngine.startVolumeBumper(0.01, { reserveSol: 0, minDelaySeconds: 1, maxDelaySeconds: 1, maxCycles: 10, sessionBudget: 0.2, schedule: clock.schedule });
  await clock.fire();
  tradingEngine.curve = { mint: 'BumpMint', complete: true, progressPct: 100, realSol: 40 };
  tradingEngine.isBumping = true;
  tradingEngine.bumpBusy = false;
  await tradingEngine.runBumpCycle();
  assert.equal(tradingEngine.isBumping, false);
  assert.equal(calls.sells.length, 1);
  assert.match(tradingEngine.bumpLastError, /graduated/i);
});

test('live mode uses the same trade calls and the live balance reserve', async () => {
  quiet();
  walletManager.setSimulationMode(false);
  const [first] = addresses();
  walletManager.liveBalanceCache = { at: Date.now(), key: 'x', values: { [first]: 0.05 }, error: null };
  addresses().slice(1).forEach(address => {
    walletManager.liveBalanceCache.values[address] = 0.01;
  });
  const calls = mockTrades();
  try {
    const clock = manualClock();
    tradingEngine.startVolumeBumper(0.01, { reserveSol: 0.02, minDelaySeconds: 3, maxDelaySeconds: 10, maxCycles: 1, sessionBudget: 0.05, schedule: clock.schedule, rng: () => 0 });
    await clock.fire();
    assert.equal(calls.buys.length, 1);
    assert.equal(calls.buys[0].address, first);
    assert.equal(calls.buys[0].solAmount, 0.01);
    assert.equal(tradingEngine.bumpSnapshot().simulated, false);
    assert.match(tradingEngine.bumpLastTx, /^(buy|sell)-/);
  } finally {
    await tradingEngine.stopVolumeBumper();
    walletManager.setSimulationMode(true);
  }
});

test('delay bounds are random between min and max and rejected outside them', async () => {
  quiet();
  const calls = mockTrades();
  const clock = manualClock();
  let roll = 0;
  tradingEngine.startVolumeBumper(0.01, {
    reserveSol: 0,
    minDelaySeconds: 3,
    maxDelaySeconds: 10,
    maxCycles: 2,
    sessionBudget: 0.2,
    schedule: clock.schedule,
    strategy: 'round-trip',
    rng: () => roll++ === 0 ? 0 : 1
  });
  assert.equal(clock.delays[0], 3000);
  await clock.fire();
  assert.equal(calls.buys.length, 1);
  assert.equal(calls.sells.length, 0);
  assert.equal(clock.delays[1], 10000);
  await clock.fire();
  assert.equal(calls.sells.length, 1);
  assert.equal(calls.sells[0].pct, 100);
  await tradingEngine.stopVolumeBumper();
  assert.throws(() => tradingEngine.startVolumeBumper(0.01, { minDelaySeconds: 0, maxDelaySeconds: 10 }), /at least 1/);
  assert.throws(() => tradingEngine.startVolumeBumper(0.01, { minDelaySeconds: 8, maxDelaySeconds: 3 }), /greater than or equal/);
  assert.throws(() => tradingEngine.startVolumeBumper(0.01, { minDelaySeconds: 1, maxDelaySeconds: 301 }), /at most 300/);
});

test('a buy above the per-trade cap is refused before any trade', () => {
  quiet();
  mockTrades();
  assert.throws(
    () => tradingEngine.startVolumeBumper(0.05, { maxPerTrade: 0.01 }),
    /per-trade cap/
  );
  assert.equal(tradingEngine.isBumping, false);
});

test('manual trades ignore the bump delay and a sell-all preempts open lots', async () => {
  quiet();
  const calls = mockTrades();
  const clock = manualClock();
  const steps = [];
  const schedule = (fn, ms) => {
    steps.push(fn);
    return clock.schedule(fn, ms);
  };
  tradingEngine.executeBuy = async ({ walletAddresses }) => {
    calls.buys.push({ address: walletAddresses[0] });
    const position = tradingEngine.positions.get(walletAddresses[0]) || { tokens: 0, solInvested: 0, costKnown: true };
    position.tokens += 1000;
    tradingEngine.positions.set(walletAddresses[0], position);
    return { success: true, totalSpentSol: 0.01, results: [{ address: walletAddresses[0], tokensBought: 1000 }] };
  };
  tradingEngine.startVolumeBumper(0.01, {
    reserveSol: 0,
    strategy: 'round-trip',
    minDelaySeconds: 3,
    maxDelaySeconds: 10,
    maxCycles: 10,
    sessionBudget: 0.5,
    schedule,
    rng: () => 0
  });
  await clock.fire();
  const first = calls.buys[0].address;
  const scheduled = steps.length;
  tradingEngine.executeSell = realSell;
  const started = Date.now();
  await tradingEngine.executeSell({ pct: 40, walletAddresses: [first] });
  assert.ok(Date.now() - started < 500);
  assert.equal(tradingEngine.isBumping, true);
  assert.equal(steps.length, scheduled);
  const lot = tradingEngine.bumpStrategy.open.find(row => row.address === first);
  assert.ok(lot);
  assert.ok(lot.tokensBought < 1000);
  const other = addresses().find(address => address !== first);
  await tradingEngine.executeSell({ pct: 100, walletAddresses: [other] });
  assert.equal(tradingEngine.isBumping, false);
  assert.equal(tradingEngine.bumpLastError, 'Stopped: user sold out');
  assert.equal(tradingEngine.bumpStrategy.open.length, 0);
  assert.equal(steps.length, scheduled);
  await steps[steps.length - 1]();
  assert.equal(calls.buys.length, 1);
});

test('stopping while a cycle is in flight sells open lots without waiting on bumpBusy', async () => {
  quiet();
  mockTrades();
  const clock = manualClock();
  tradingEngine.startVolumeBumper(0.01, {
    reserveSol: 0,
    strategy: 'round-trip',
    minDelaySeconds: 9,
    maxDelaySeconds: 9,
    maxCycles: 10,
    sessionBudget: 0.5,
    schedule: clock.schedule,
    rng: () => 0
  });
  await clock.fire();
  assert.equal(tradingEngine.bumpStrategy.open.length, 1);
  tradingEngine.bumpBusy = true;
  try {
    const pending = tradingEngine.stopVolumeBumper();
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true);
    await pending;
    assert.equal(tradingEngine.isBumping, false);
    assert.equal(tradingEngine.bumpStrategy.open.length, 0);
    assert.equal(clock.delays.filter(ms => ms === 9000).length, 2);
  } finally {
    tradingEngine.bumpBusy = false;
  }
});

test('a buy that finishes after a stop does not arm another delay', async () => {
  quiet();
  mockTrades();
  const clock = manualClock();
  let release;
  tradingEngine.executeBuy = async ({ solAmount, walletAddresses }) => {
    await new Promise(resolve => { release = resolve; });
    const position = tradingEngine.positions.get(walletAddresses[0]) || { tokens: 0, solInvested: 0, costKnown: true };
    position.tokens += 1000;
    tradingEngine.positions.set(walletAddresses[0], position);
    return { success: true, totalSpentSol: solAmount, results: [{ address: walletAddresses[0], tokensBought: 1000 }] };
  };
  tradingEngine.startVolumeBumper(0.01, {
    reserveSol: 0,
    strategy: 'round-trip',
    minDelaySeconds: 8,
    maxDelaySeconds: 8,
    maxCycles: 10,
    sessionBudget: 0.5,
    schedule: clock.schedule,
    rng: () => 0
  });
  const running = clock.fire();
  await new Promise(resolve => setImmediate(resolve));
  const delaysBeforeStop = clock.delays.length;
  await tradingEngine.stopVolumeBumper();
  release();
  await running;
  assert.equal(clock.delays.length, delaysBeforeStop);
  assert.equal(tradingEngine.isBumping, false);
  assert.equal(tradingEngine.bumpStrategy.open.length, 0);
  const stillHeld = [...tradingEngine.positions.values()].some(position => position.tokens > 0);
  assert.equal(stillHeld, false);
});

test('random weighting must buy with no lots and must sell at the open cap', () => {
  assert.equal(chooseBumpSide(0, 4, () => 0.99), 'buy');
  assert.equal(chooseBumpSide(4, 4, () => 0), 'sell');
  assert.equal(chooseBumpSide(2, 4, () => 0.49), 'sell');
  assert.equal(chooseBumpSide(2, 4, () => 0.5), 'buy');
});

test('random strategy stops opening lots at the cap and can close one partially', async () => {
  const a = 'WalletA';
  const b = 'WalletB';
  const sells = [];
  const rolls = [0, 0.9, 0, 0, 0];
  let cursor = 0;
  const rng = () => rolls[Math.min(cursor++, rolls.length - 1)];
  const engine = {
    isBumping: true,
    activeToken: 'Mint',
    positions: new Map(),
    canBumpBuy: () => true,
    bumpSubWallets: () => [a, b],
    async executeBuy({ walletAddresses }) {
      const address = walletAddresses[0];
      const position = engine.positions.get(address) || { tokens: 0 };
      position.tokens += 1000;
      engine.positions.set(address, position);
      return { success: true, results: [{ tokensBought: 1000, address }] };
    },
    async executeSell({ pct, walletAddresses }) {
      sells.push({ pct, address: walletAddresses[0] });
      const position = engine.positions.get(walletAddresses[0]);
      if (position) position.tokens = Math.max(0, position.tokens * (1 - pct / 100));
      return { success: true, totalReceivedSol: 0.002, results: [] };
    }
  };
  const strategy = createRandomStrategy({ maxOpen: 2, rng });
  await strategy.onCycle({ engine, solAmount: 0.01, mint: 'Mint' });
  await strategy.onCycle({ engine, solAmount: 0.01, mint: 'Mint' });
  assert.equal(strategy.open.length, 2);
  const third = await strategy.onCycle({ engine, solAmount: 0.01, mint: 'Mint' });
  assert.equal(third.actions[0].side, 'sell');
  assert.equal(strategy.open.length, 2);
  assert.ok(strategy.open.some(row => row.tokensBought > 0 && row.tokensBought < 1000));
  assert.ok(sells[0].pct >= 25 && sells[0].pct < 100);
  const full = createRandomStrategy({ maxOpen: 1, rng: () => 1 });
  full.open.push({ address: a, tokensBought: 1000, mint: 'Mint' });
  engine.positions.set(a, { tokens: 1000 });
  await full.onCycle({ engine, solAmount: 0.01, mint: 'Mint' });
  assert.equal(full.open.length, 0);
});

test('a 100% manual sell, cascade, panic, and mint change stop the bumper', async () => {
  async function openLot() {
    quiet();
    const calls = mockTrades();
    const clock = manualClock();
    tradingEngine.connectPumpPortal = () => {};
    tradingEngine.startVolumeBumper(0.01, {
      reserveSol: 0,
      strategy: 'round-trip',
      minDelaySeconds: 1,
      maxDelaySeconds: 1,
      maxCycles: 10,
      sessionBudget: 0.5,
      schedule: clock.schedule,
      rng: () => 0
    });
    await clock.fire();
    return { calls, bought: calls.buys[0].address };
  }

  const manual = await openLot();
  tradingEngine.executeSell = realSell;
  const other = addresses().find(address => address !== manual.bought);
  await tradingEngine.executeSell({ pct: 50, walletAddresses: [other] });
  assert.equal(tradingEngine.isBumping, true);
  await tradingEngine.executeSell({ pct: 100, walletAddresses: [other] });
  assert.equal(tradingEngine.isBumping, false);
  assert.equal(tradingEngine.bumpLastError, 'Stopped: user sold out');
  assert.equal(tradingEngine.bumpLastError, 'Stopped: user sold out');
  const left = tradingEngine.positions.get(manual.bought);
  assert.ok(!left || left.tokens === 0);

  const cascade = await openLot();
  tradingEngine.executeSell = realSell;
  await tradingEngine.executeCascadeSell(0, 100);
  assert.equal(tradingEngine.isBumping, false);
  assert.equal(tradingEngine.bumpLastError, 'Stopped: user sold out');
  const cascadeLeft = tradingEngine.positions.get(cascade.bought);
  assert.ok(!cascadeLeft || cascadeLeft.tokens === 0);

  const panic = await openLot();
  tradingEngine.executeSell = realSell;
  await tradingEngine.executeSell({ pct: 100 });
  assert.equal(tradingEngine.isBumping, false);
  assert.equal(tradingEngine.bumpLastError, 'Stopped: user sold out');

  const switched = await openLot();
  tradingEngine.setActiveToken('OtherMint', []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tradingEngine.isBumping, false);
  assert.equal(tradingEngine.bumpLastError, 'Stopped: token changed');
  assert.equal(tradingEngine.activeToken, 'OtherMint');
  assert.ok(switched.calls.sells.some(row => row.address === switched.bought));
});
