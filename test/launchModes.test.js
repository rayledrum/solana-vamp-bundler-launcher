const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `launch-modes-${process.pid}.json`);
const axios = require('axios');
const walletManager = require('../src/walletManager');
const bundler = require('../src/bundler');
const vampScanner = require('../src/vampScanner');
const { planBundleChunks } = require('../src/validation');
const { bindLiveTradingPool, createRpcPool, LIVE_TRADING_PAUSED } = require('../src/rpc');

function stubBalances() {
  walletManager.connection.getMultipleAccountsInfo = async (keys) => keys.map(() => ({ lamports: 2_000_000_000 }));
}

test('a minimum market cap hides cheap coins and unknown caps unless asked', () => {
  const tokens = [
    { tokenAddress: 'A', metrics: { mcap: 5000 } },
    { tokenAddress: 'B', metrics: { mcap: 50 } },
    { tokenAddress: 'C', metrics: { mcap: null } }
  ];
  const hidden = vampScanner.filterByMinMcap(tokens, { minMcap: 1000, showUnknown: false });
  assert.deepEqual(hidden.tokens.map(row => row.tokenAddress), ['A']);
  assert.equal(hidden.hidden, 2);
  const shown = vampScanner.filterByMinMcap(tokens, { minMcap: 1000, showUnknown: true });
  assert.equal(shown.tokens.length, 2);
  assert.equal(shown.tokens[1].mcapUnknown, true);
  assert.equal(shown.hidden, 1);
  assert.equal(vampScanner.filterByMinMcap(tokens, { minMcap: 0 }).hidden, 0);
});

test('a minimum market cap is applied before the display limit', async () => {
  const originalGet = axios.get;
  const originalPump = vampScanner.getPumpFunMovers.bind(vampScanner);
  let seenLimit = null;
  axios.get = async () => { throw new Error('offline'); };
  vampScanner.getPumpFunMovers = async (limit) => {
    seenLimit = limit;
    return Array.from({ length: 8 }, (_, index) => ({
      tokenAddress: `Mint${index}`,
      metrics: { mcap: index === 7 ? 9000 : 100 }
    }));
  };
  try {
    const list = await vampScanner.getTrendingSolanaTokens(2, { minMcap: 1000 });
    assert.equal(seenLimit, 50);
    assert.equal(list.length, 1);
    assert.equal(list[0].tokenAddress, 'Mint7');
    assert.equal(list.hidden, 7);
  } finally {
    axios.get = originalGet;
    vampScanner.getPumpFunMovers = originalPump;
  }
});

test('the server launch uses the passed Jito tip, including a 2-wallet bundle', async () => {
  walletManager.setSimulationMode(true);
  stubBalances();
  await walletManager.generateSubWallets(2, true);
  assert.equal(walletManager.subWallets.length, 2);
  const chunks = planBundleChunks(1 + 2);
  assert.deepEqual(chunks, [{ start: 0, userCount: 3, totalWithTip: 4 }]);
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const bundled = await bundler.launchBundle({
      tokenName: 'Two',
      tokenSymbol: 'TWO',
      devSolBuy: 0.05,
      subWalletBuys: [0.05, 0.04],
      jitoTipSol: 0.004
    });
    assert.equal(bundled.simulation, true);
    assert.equal(bundled.jitoTipSol, 0.004);
    assert.equal(bundled.subWallets.length, 2);
    assert.ok(lines.some(line => line === 'Jito tip: 0.004 SOL'));

    const standard = await bundler.launchStandard({
      tokenName: 'Plain',
      tokenSymbol: 'PLAIN',
      devSolBuy: 0.05,
      subWalletBuys: [0.02, 0.02],
      priorityFeeSol: 0.0001
    });
    assert.equal(standard.mode, 'standard');
    assert.equal(standard.atomic, false);
    assert.equal(standard.jitoTipSol, 0);
    assert.equal(standard.simulation, true);
    assert.match(standard.signature, /^sim_create_/);
    assert.equal(standard.subWallets.length, 2);
    assert.match(standard.note, /not atomic/i);
    assert.match(standard.subWallets[0].note, /snipeable/);

    bindLiveTradingPool(createRpcPool({
      providers: [{ name: 'Public', httpUrl: 'https://public.example/unused', wsUrl: '', configured: true }],
      connect() { return {}; }
    }));
    walletManager.setSimulationMode(false);
    await assert.rejects(
      () => bundler.launchBundle({ tokenName: 'Live', tokenSymbol: 'LIVE', devSolBuy: 0.05, subWalletBuys: [0.01, 0.01], jitoTipSol: 0.002 }),
      new RegExp(LIVE_TRADING_PAUSED)
    );
    await assert.rejects(
      () => bundler.launchStandard({ tokenName: 'Live', tokenSymbol: 'LIVE', devSolBuy: 0.05, subWalletBuys: [0.01], priorityFeeSol: 0.0001 }),
      new RegExp(LIVE_TRADING_PAUSED)
    );
  } finally {
    console.log = original;
    bindLiveTradingPool(null);
    walletManager.setSimulationMode(true);
  }
});
