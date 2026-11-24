const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `chart-wallets-${process.pid}.json`);
const walletManager = require('../src/walletManager');
const tradingEngine = require('../src/tradingEngine');
const pumpfun = require('../src/pumpfun');

walletManager.setSimulationMode(true);
tradingEngine.connectPumpPortal = () => {};
const masterAddr = walletManager.masterWallet.publicKey.toBase58();
const subAddr = walletManager.subWallets[0].publicKey.toBase58();

function captureEvents() {
  const events = [];
  tradingEngine.setBroadcaster((event) => events.push(event));
  return events;
}

test('trade events stay on the mint they were opened for', async (t) => {
  await t.test('buy and sell broadcasts carry that mint', async () => {
    const events = captureEvents();
    tradingEngine.setActiveToken('MintA', [
      { address: masterAddr, tokens: 1000000, sol: 0.4 }
    ]);

    await tradingEngine.executeBuy({ solAmount: 0.05, walletAddresses: [masterAddr] });
    await tradingEngine.executeSell({ pct: 50, walletAddresses: [masterAddr] });

    const buy = events.find((event) => event.type === 'BUY_EXECUTED');
    const sell = events.find((event) => event.type === 'SELL_EXECUTED');
    const prints = events.filter((event) => event.type === 'PUBLIC_TRADE');
    assert.equal(buy.payload.mint, 'MintA');
    assert.equal(sell.payload.mint, 'MintA');
    assert.ok(prints.length >= 2);
    assert.ok(prints.every((event) => event.payload.mint === 'MintA'));
  });

  await t.test('a token switch during a cascade does not continue onto the new mint', async () => {
    const events = [];
    tradingEngine.setActiveToken('MintA', [
      { address: masterAddr, tokens: 1000000, sol: 0.4 },
      { address: subAddr, tokens: 1000000, sol: 0.4 }
    ]);
    tradingEngine.setBroadcaster((event) => {
      events.push(event);
      if (event.type === 'SELL_EXECUTED' && event.payload.mint === 'MintA') {
        tradingEngine.setActiveToken('MintB', []);
      }
    });

    await tradingEngine.executeCascadeSell(0, 100);

    const sells = events.filter((event) => event.type === 'SELL_EXECUTED');
    const steps = events.filter((event) => event.type === 'CASCADE_STEP');
    const completed = events.find((event) => event.type === 'CASCADE_COMPLETED');
    assert.equal(sells.length, 1);
    assert.ok(sells.every((event) => event.payload.mint === 'MintA'));
    assert.ok(steps.every((event) => event.payload.mint === 'MintA'));
    assert.equal(completed.payload.mint, 'MintA');
    assert.equal(tradingEngine.activeToken, 'MintB');
    assert.equal(tradingEngine.positions.get(subAddr), undefined);
  });

  await t.test('stats started for one mint are stale if the active mint changes', async () => {
    const original = pumpfun.getTokenDexInfo.bind(pumpfun);
    pumpfun.getTokenDexInfo = async () => {
      tradingEngine.setActiveToken('MintOther', []);
      return null;
    };

    try {
      tradingEngine.setActiveToken('MintSlow', [
        { address: 'walletA', tokens: 10, sol: 0.1 }
      ]);
      const stats = await tradingEngine.getLiveStats();
      assert.equal(stats.stale, true);
      assert.equal(stats.activeToken, 'MintSlow');
      assert.equal(stats.currentMint, 'MintOther');
      assert.deepEqual(stats.wallets, []);
    } finally {
      pumpfun.getTokenDexInfo = original;
    }
  });

  await t.test('bump ticks carry the mint active when they fire', async () => {
    const events = captureEvents();
    tradingEngine.setActiveToken('MintBump', []);
    tradingEngine.stopVolumeBumper();
    try {
      tradingEngine.startVolumeBumper(0.01, 5);
      const started = events.find((event) => event.type === 'BUMPER_STARTED');
      assert.equal(started.payload.mint, 'MintBump');
      assert.equal(started.payload.simulated, true);
      const tick = await waitFor(() => events.find((event) => event.type === 'BUMP_TICK'), 8000);
      assert.equal(tick.payload.mint, 'MintBump');
    } finally {
      tradingEngine.stopVolumeBumper();
    }
  });
});

function waitFor(read, timeoutMs = 500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const value = read();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for event'));
      }
    }, 10);
  });
}

