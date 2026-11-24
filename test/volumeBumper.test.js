const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `bump-wallets-${process.pid}.json`);
const walletManager = require('../src/walletManager');
const tradingEngine = require('../src/tradingEngine');

function addresses() {
  return walletManager.subWallets.map(wallet => wallet.publicKey.toBase58());
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
  tradingEngine.startVolumeBumper(0.01, 30, { reserveSol: 0.02, holdSeconds: 60, maxCycles: 1, sessionBudget: 0.05 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.buys.map(row => row.address), [rich]);
  await tradingEngine.stopVolumeBumper();
});

test('session budget and max cycles stop new buys and sell the open lot', async () => {
  quiet();
  const calls = mockTrades();
  tradingEngine.startVolumeBumper(0.01, 30, { reserveSol: 0, holdSeconds: 60, maxCycles: 5, sessionBudget: 0.01, maxPerTrade: 0.02 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.buys.length, 1);
  assert.equal(tradingEngine.isBumping, false);
  assert.equal(calls.sells.length, 1);
  assert.equal(calls.sells[0].pct, 100);
  assert.match(tradingEngine.bumpLastError, /budget/i);
  assert.ok(tradingEngine.bumpNetSol > 0);
  assert.ok(tradingEngine.bumpNetSol < 0.01);
});

test('stop sells open cycle positions and does not buy again', async () => {
  quiet();
  const calls = mockTrades();
  tradingEngine.startVolumeBumper(0.01, 30, { reserveSol: 0, holdSeconds: 120, maxCycles: 10, sessionBudget: 0.2 });
  await new Promise(resolve => setImmediate(resolve));
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
  tradingEngine.startVolumeBumper(0.01, 30, { reserveSol: 0, holdSeconds: 30, maxErrors: 3, maxCycles: 10, sessionBudget: 0.2 });
  await new Promise(resolve => setImmediate(resolve));
  await tradingEngine.runBumpCycle();
  await tradingEngine.runBumpCycle();
  assert.equal(tradingEngine.isBumping, false);
  assert.match(tradingEngine.bumpLastError, /consecutive errors/i);
});

test('graduation stops the bumper and sells the open lot', async () => {
  quiet();
  const calls = mockTrades();
  tradingEngine.startVolumeBumper(0.01, 30, { reserveSol: 0, holdSeconds: 120, maxCycles: 10, sessionBudget: 0.2 });
  await new Promise(resolve => setImmediate(resolve));
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
    tradingEngine.startVolumeBumper(0.01, 30, { reserveSol: 0.02, holdSeconds: 60, maxCycles: 1, sessionBudget: 0.05 });
    await new Promise(resolve => setImmediate(resolve));
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

test('a buy above the per-trade cap is refused before any trade', () => {
  quiet();
  mockTrades();
  assert.throws(
    () => tradingEngine.startVolumeBumper(0.05, 30, { maxPerTrade: 0.02 }),
    /per-trade cap/
  );
  assert.equal(tradingEngine.isBumping, false);
});
