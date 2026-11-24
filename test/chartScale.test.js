const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');
const { createBook } = require('../public/js/chartBook');
const {
  PUMP_SUPPLY_UI,
  marketCapSol,
  formatMarketCapSol,
  formatMarketCapLabel,
  formatOhlc,
  marketCapFromFeed,
  supplyOf
} = require('../public/js/chartScale');
const { readMintSupply } = require('../src/tokenAccounts');

test('axis labels are market cap in SOL, with USD only when a SOL price exists', () => {
  const price = 0.0000276;
  const mcap = marketCapSol(price, PUMP_SUPPLY_UI);
  assert.equal(mcap, 27600);
  assert.equal(formatMarketCapSol(mcap), '27.6K SOL');
  assert.equal(formatMarketCapLabel(mcap, null), '27.6K SOL');
  assert.equal(formatMarketCapLabel(mcap, 150), '27.6K SOL ($4.14M)');
  const candle = { open: price, high: price * 1.1, low: price * 0.9, close: price };
  assert.equal(formatOhlc(candle, PUMP_SUPPLY_UI), 'O:27.6K H:30.4K L:24.8K C:27.6K SOL');
});

test('curve, DexScreener, and the Pump default supply share one market-cap scale', () => {
  const curvePrice = 0.00003;
  const curveSupply = 1_000_000_000;
  assert.equal(marketCapSol(curvePrice, curveSupply), 30000);
  assert.equal(formatMarketCapSol(30000), '30.0K SOL');
  const fromMint = marketCapFromFeed({
    priceSol: curvePrice,
    supplyUi: curveSupply,
    supplySource: 'mint'
  });
  const sim = marketCapSol(curvePrice, supplyOf(null));
  assert.equal(fromMint, sim);
  const fromDex = marketCapFromFeed({
    priceSol: 0.00001,
    supplyUi: PUMP_SUPPLY_UI,
    supplySource: 'default',
    solUsd: 150,
    fdvUsd: 4_500_000,
    marketCapUsd: 4_000_000
  });
  assert.equal(fromDex, 4_500_000 / 150);
});

test('each mint keeps its own supply when the chart resets', () => {
  const book = createBook();
  book.activate('MintA');
  book.noteScale('MintA', { supplyUi: 1_000_000_000, source: 'mint', solUsd: 150 });
  book.appendSample('MintA', { time: 1, open: 0.00002, high: 0.00002, low: 0.00002, close: 0.00002, volume: 0.4 });
  const viewB = book.activate('MintB');
  assert.equal(viewB.series.samples.length, 0);
  assert.equal(viewB.series.supplyUi, null);
  assert.equal(supplyOf(viewB.series), PUMP_SUPPLY_UI);
  assert.equal(book.peek('MintA').supplyUi, 1_000_000_000);
  book.noteScale('MintA', { supplyUi: 50, source: 'curve' });
  assert.equal(book.peek('MintA').supplyUi, 1_000_000_000);
  assert.equal(marketCapSol(book.peek('MintA').lastPrice, book.peek('MintA').supplyUi), 20000);
});

test('getTokenSupply is used when the mint answers, otherwise Pump supply', async () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const read = await readMintSupply({
    async getTokenSupply() {
      return { value: { uiAmountString: '1000000000', decimals: 6 } };
    }
  }, mint);
  assert.equal(read.source, 'mint');
  assert.equal(read.ui, PUMP_SUPPLY_UI);
  const missing = Keypair.generate().publicKey.toBase58();
  const fallback = await readMintSupply({
    async getTokenSupply() {
      throw new Error('mint missing');
    }
  }, missing);
  assert.equal(fallback.source, 'default');
  assert.equal(fallback.ui, PUMP_SUPPLY_UI);
});
