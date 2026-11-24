const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { createBook, buildMarkers } = require('../public/js/chartBook');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `marker-wallets-${process.pid}.json`);
const walletManager = require('../src/walletManager');
const tradingEngine = require('../src/tradingEngine');

test('markers bucket millisecond and second timestamps onto candle times', () => {
  const tfMs = 5000;
  const second = 1_700_000_000;
  const markers = buildMarkers([
    { txType: 'sell', solAmount: 0.2, timestamp: second, signature: 'a' },
    { txType: 'buy', solAmount: 0.0001, timestamp: second * 1000 + 1200, signature: 'dust' },
    { txType: 'buy', solAmount: 0.01, timestamp: second * 1000 + 6000, signature: 'b' },
    { txType: 'sell', solAmount: 0.010316, timestamp: second * 1000 + 800, signature: 'own', own: true, label: 'DEV SELL 0.0103' }
  ], { tfMs });
  assert.deepEqual(markers.map(row => row.signature), ['a', 'own', 'b']);
  assert.equal(markers[0].bucket, Math.floor(second * 1000 / tfMs) * tfMs);
  assert.equal(markers[1].bucket, markers[0].bucket);
  assert.equal(markers[1].own, true);
  assert.equal(markers[1].label, 'DEV SELL 0.0103');
  assert.ok(markers[2].bucket > markers[0].bucket);
  assert.deepEqual(markers.map(row => row.timeMs), [...markers.map(row => row.timeMs)].sort((a, b) => a - b));
});

test('public markers are capped and own fills stay', () => {
  const trades = [];
  for (let i = 0; i < 50; i += 1) {
    trades.push({ txType: 'buy', solAmount: 0.05, timestamp: 1_700_000_000_000 + i * 1000, signature: `p${i}` });
  }
  trades.push({ txType: 'sell', solAmount: 0.010316, timestamp: 1_700_000_100_000, signature: 'dev', own: true, label: 'DEV SELL 0.0103' });
  const markers = buildMarkers(trades, { tfMs: 1000, publicCap: 40, ownCap: 10 });
  assert.equal(markers.filter(row => !row.own).length, 40);
  assert.equal(markers.filter(row => row.signature === 'dev').length, 1);
  assert.equal(markers.at(-1).signature, 'dev');
});

test('a later own fill upgrades the public trade and survives a candle reset', () => {
  const book = createBook();
  const at = 1_700_000_005_200;
  book.activate('MintA');
  book.appendSample('MintA', { time: at, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  book.pushTrade('MintA', { mint: 'MintA', txType: 'sell', solAmount: 0.010316, timestamp: at, signature: 'sig', own: false });
  book.pushTrade('MintA', { mint: 'MintA', txType: 'sell', solAmount: 0.010316, timestamp: at, signature: 'sig', own: true, label: 'DEV SELL 0.0103' });
  book.replaceSeries('MintA', {
    samples: [{ time: Math.floor(at / 5000) * 5000, open: 2, high: 2, low: 2, close: 2, volume: 0 }],
    sampleMs: 5000,
    lastPrice: 2
  });
  const [marker] = buildMarkers(book.peek('MintA').trades, { tfMs: 5000, minSol: 0.001 });
  assert.equal(book.peek('MintA').trades.length, 1);
  assert.equal(marker.own, true);
  assert.equal(marker.label, 'DEV SELL 0.0103');
  assert.equal(marker.bucket, Math.floor(at / 5000) * 5000);
});

test('the confirmed own sell is broadcast with a DEV label even after the public log', () => {
  walletManager.setSimulationMode(true);
  tradingEngine.connectPumpPortal = () => {};
  const master = walletManager.masterWallet.publicKey.toBase58();
  const events = [];
  tradingEngine.setBroadcaster(event => events.push(event));
  tradingEngine.seenTradeSigs = new Set();
  tradingEngine.ownTrades = new Map();
  const signature = '3jVesNbfjm7cgyxYZueC5T84kEuwWADztnM8REfH4NYoW2UGD6zidBDyyahbZBVfQiqffnGJzsGT6Zqcw5hWnvWm';
  tradingEngine.ingestExternalTrade({
    txType: 'sell',
    solAmount: 0.010316,
    tokenAmount: 63724.256335,
    traderPublicKey: master,
    signature,
    mint: 'FUNuAFQJyzBXqk8pSXEtdH42odnti7hQFFraJtd2pump',
    timestamp: 1_700_000_000
  });
  tradingEngine.ingestExternalTrade({
    txType: 'sell',
    solAmount: 0.010316,
    tokenAmount: 63724.256335,
    traderPublicKey: master,
    signature,
    mint: 'FUNuAFQJyzBXqk8pSXEtdH42odnti7hQFFraJtd2pump',
    own: true,
    timestamp: Date.now()
  });
  const prints = events.filter(event => event.type === 'PUBLIC_TRADE');
  assert.equal(prints.length, 2);
  assert.equal(prints[0].payload.own, false);
  assert.equal(prints[1].payload.own, true);
  assert.equal(prints[1].payload.label, 'DEV SELL 0.0103');
  assert.equal(prints[1].payload.signature, signature);
});
