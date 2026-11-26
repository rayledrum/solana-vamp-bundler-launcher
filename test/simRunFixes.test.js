const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const axios = require('axios');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `sim-run-${process.pid}.json`);
const walletManager = require('../src/walletManager');
const tradingEngine = require('../src/tradingEngine');
const pumpfun = require('../src/pumpfun');
const vampScanner = require('../src/vampScanner');
const { ammOut } = require('../src/bondingCurve');
const { publicTradePrice, reportedFillPrice } = require('../public/js/chartBook');

const MINT = 'F9CwhBgSsEJuCigbodtUH257EqQpRSzKLKwHPPKNpump';

function quiet() {
  walletManager.setSimulationMode(true);
  tradingEngine.connectPumpPortal = () => {};
  tradingEngine.onMintChange = () => {};
  tradingEngine.onChainSnapshot = null;
  tradingEngine.stopVolumeBumper();
}

test('simulated public trades do not move the chart and the fake ticker is gone', () => {
  quiet();
  tradingEngine.setActiveToken(MINT);
  tradingEngine.openPumpSocket = () => {};
  delete tradingEngine.connectPumpPortal;
  tradingEngine.connectPumpPortal(MINT);
  assert.equal(tradingEngine.simTicker, null);
  assert.equal(publicTradePrice({ simulated: true, priceSol: 0.002, solAmount: 1, tokenAmount: 100 }), null);
  assert.equal(publicTradePrice({ signature: 'sim_abc', priceSol: 0.002 }), null);
  assert.equal(publicTradePrice({ priceSol: 0.002, solAmount: 1, tokenAmount: 500 }), 0.002);
  assert.equal(reportedFillPrice({ solAmount: 1 }), null);
  assert.equal(reportedFillPrice({ priceSol: 0.01 }), 0.01);
});

test('sim buys and sells use the snapshot reserves, not a 15 SOL curve', async () => {
  quiet();
  const originalDex = pumpfun.getTokenDexInfo;
  pumpfun.getTokenDexInfo = async () => null;
  const master = walletManager.masterWallet.publicKey.toBase58();
  tradingEngine.setActiveToken(MINT);
  tradingEngine.curve = {
    mint: MINT,
    complete: false,
    virtualSolReserves: 30_000_000_000,
    virtualTokenReserves: 1_073_000_000_000_000,
    priceSol: 30 / 1_073_000_000
  };
  try {
    const bought = await tradingEngine.executeBuy({ solAmount: 0.01, walletAddresses: [master] });
    const expected = Math.floor(Number(ammOut(10_000_000n, 30_000_000_000n, 1_073_000_000_000_000n)) / 1e6);
    assert.equal(bought.success, true);
    assert.equal(bought.results[0].tokensBought, expected);
    assert.notEqual(expected, Math.floor(pumpfun.calculateBuyOutput(0.01, 15)));
    const stats = await tradingEngine.getLiveStats();
    const row = stats.wallets.find(wallet => wallet.address === master);
    const quoted = tradingEngine.simSolOut(expected);
    assert.equal(row.currentValue, Number(quoted.toFixed(4)));
    assert.notEqual(Number(quoted.toFixed(4)), Number(pumpfun.calculateSellOutput(expected, 15).toFixed(4)));
    const events = [];
    tradingEngine.setBroadcaster(event => events.push(event));
    const sold = await tradingEngine.executeSell({ pct: 100, walletAddresses: [master] });
    assert.equal(sold.success, true);
    assert.ok(sold.totalReceivedSol > 0);
    const broadcast = events.find(event => event.type === 'SELL_EXECUTED');
    assert.ok(broadcast.payload.priceSol > 0);
  } finally {
    pumpfun.getTokenDexInfo = originalDex;
    tradingEngine.setBroadcaster(null);
  }
});

test('a 100% sell skips empty wallets and an empty book is a no-op', async () => {
  quiet();
  const master = walletManager.masterWallet.publicKey.toBase58();
  const sub = walletManager.subWallets[0].publicKey.toBase58();
  tradingEngine.setActiveToken(MINT, [{ address: master, tokens: 1000, sol: 0.01 }]);
  const sold = await tradingEngine.executeSell({ pct: 100, walletAddresses: [master, sub] });
  assert.equal(sold.success, true);
  assert.equal(sold.noop, undefined);
  assert.equal(sold.results.length, 1);
  assert.equal(sold.results[0].address, master);
  const empty = await tradingEngine.executeSell({ pct: 100, walletAddresses: [master, sub] });
  assert.equal(empty.success, true);
  assert.equal(empty.noop, true);
  assert.equal(empty.message, 'No tokens to sell.');
});

test('a sim buy with no wallet list uses wallets that hold sim SOL', async () => {
  quiet();
  const master = walletManager.masterWallet.publicKey.toBase58();
  const skipped = walletManager.subWallets[0].publicKey.toBase58();
  const funded = walletManager.subWallets[1].publicKey.toBase58();
  walletManager.setSimSol(skipped, 0);
  tradingEngine.setActiveToken(MINT);
  tradingEngine.curve = {
    mint: MINT,
    complete: false,
    virtualSolReserves: 30_000_000_000,
    virtualTokenReserves: 1_073_000_000_000_000
  };
  const bought = await tradingEngine.executeBuy({ solAmount: 0.01 });
  const addresses = bought.results.map(row => row.address);
  assert.ok(addresses.includes(master));
  assert.ok(addresses.includes(funded));
  assert.equal(addresses.includes(skipped), false);
  tradingEngine.setActiveToken('NextMint');
  assert.equal(tradingEngine.sessionSpentSol, 0);
});

test('sim token positions reload with the mint and SOL dust rounds to lamports', () => {
  quiet();
  const master = walletManager.masterWallet.publicKey.toBase58();
  walletManager.setSimSol(master, 0.1 + 0.2);
  assert.equal(walletManager.simBalanceOf(master), 0.3);
  tradingEngine.setActiveToken(MINT);
  tradingEngine.positions.set(master, { tokens: 42, solInvested: 0.01, costKnown: true });
  tradingEngine.costBooks.set(`${MINT}:${master}`, { costBasisSol: 0.01, tokens: 42, costKnown: true });
  tradingEngine.persistSimMint(MINT);
  walletManager.save();
  tradingEngine.positions.clear();
  tradingEngine.costBooks.clear();
  tradingEngine.setActiveToken(MINT);
  assert.equal(tradingEngine.positions.get(master).tokens, 42);
  assert.equal(tradingEngine.costBooks.get(`${MINT}:${master}`).costBasisSol, 0.01);
});

test('a second bumper start does not reset the running cycle', async () => {
  quiet();
  tradingEngine.setActiveToken('BumpMint');
  const queue = [];
  const schedule = (fn) => {
    queue.push(fn);
    return queue.length;
  };
  tradingEngine.startVolumeBumper(0.01, {
    reserveSol: 0,
    minDelaySeconds: 1,
    maxDelaySeconds: 1,
    maxCycles: 10,
    sessionBudget: 0.5,
    schedule,
    rng: () => 0,
    strategy: 'round-trip'
  });
  tradingEngine.executeBuy = async ({ walletAddresses }) => {
    const position = tradingEngine.positions.get(walletAddresses[0]) || { tokens: 0, solInvested: 0 };
    position.tokens += 1000;
    tradingEngine.positions.set(walletAddresses[0], position);
    return { success: true, totalSpentSol: 0.01, results: [{ address: walletAddresses[0], tokensBought: 1000 }] };
  };
  tradingEngine.executeSell = async () => ({ success: true, totalReceivedSol: 0, results: [] });
  await queue.shift()();
  const cycles = tradingEngine.bumpCycles;
  tradingEngine.curve = {
    mint: 'BumpMint',
    complete: true,
    priceSol: 0.00002,
    poolBaseRaw: 1_000_000_000_000,
    poolQuoteRaw: 2_000_000_000
  };
  await tradingEngine.runBumpCycle();
  assert.equal(tradingEngine.isBumping, true);
  assert.doesNotMatch(tradingEngine.bumpLastError || '', /pool/i);
  const again = tradingEngine.startVolumeBumper(0.05);
  assert.equal(again.cycles, cycles);
  assert.equal(tradingEngine.bumpSol, 0.01);
  await tradingEngine.stopVolumeBumper();
});

test('trending does not invent coins or pad the limit to 24', async () => {
  const originalGet = axios.get;
  const originalPump = vampScanner.getPumpFunMovers.bind(vampScanner);
  let seenLimit = null;
  axios.get = async () => { throw new Error('offline'); };
  vampScanner.getPumpFunMovers = async (limit) => {
    seenLimit = limit;
    return [{ tokenAddress: 'MintA', metrics: null }, { tokenAddress: 'MintB', metrics: null }];
  };
  try {
    const empty = await vampScanner.getTrendingSolanaTokens(3);
    assert.equal(seenLimit, 3);
    assert.equal(empty.length, 2);
    assert.equal(empty[0].metrics, null);
    const merged = vampScanner.mergeTrendingTokens(
      [{ tokenAddress: 'a' }, { tokenAddress: 'b' }, { tokenAddress: 'c' }],
      [],
      2
    );
    assert.equal(merged.length, 2);
  } finally {
    axios.get = originalGet;
    vampScanner.getPumpFunMovers = originalPump;
  }
});
