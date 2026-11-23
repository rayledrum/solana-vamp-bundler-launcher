const test = require('node:test');
const assert = require('node:assert/strict');
const { createBook } = require('../public/js/chartBook');

test('activating a mint does not keep the previous mint samples or markers', () => {
  const book = createBook();
  book.activate('MintA');
  book.appendSample('MintA', { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 2 });
  book.pushTrade('MintA', { mint: 'MintA', txType: 'buy', solAmount: 0.2 });

  const viewB = book.activate('MintB');
  assert.equal(viewB.changed, true);
  assert.equal(viewB.series.samples.length, 0);
  assert.equal(viewB.series.trades.length, 0);
  assert.equal(viewB.series.lastPrice, 0);
  assert.notEqual(book.peek('MintA').samples, viewB.series.samples);
});

test('a late sample or marker for the previous mint is stored there and is not visible', () => {
  const book = createBook();
  book.activate('MintA');
  book.appendSample('MintA', { time: 1, open: 0.1, high: 0.1, low: 0.1, close: 0.1, volume: 1 });
  book.activate('MintB');
  book.appendSample('MintB', { time: 2, open: 0.4, high: 0.4, low: 0.4, close: 0.4, volume: 1 });

  const lateSample = book.appendSample('MintA', { time: 9, open: 0.77, high: 0.77, low: 0.77, close: 0.77, volume: 3 });
  const lateTrade = book.pushTrade('MintA', { mint: 'MintA', txType: 'sell', solAmount: 1 });
  assert.equal(lateSample, false);
  assert.equal(lateTrade, false);
  assert.deepEqual(book.peek('MintB').samples.map((sample) => sample.close), [0.4]);
  assert.equal(book.peek('MintB').trades.length, 0);
  assert.deepEqual(book.peek('MintA').samples.map((sample) => sample.close), [0.1, 0.77]);
  assert.equal(book.peek('MintA').trades[0].txType, 'sell');
});

test('replacing one mint history does not replace the other mint', () => {
  const book = createBook();
  book.activate('MintA');
  book.appendSample('MintA', { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  book.activate('MintB');
  book.replaceSeries('MintB', {
    samples: [{ time: 5, open: 2, high: 3, low: 2, close: 3, volume: 4 }],
    sampleMs: 60000,
    lastPrice: 3,
    source: 'pump.fun',
    symbol: 'BBB'
  });

  assert.equal(book.peek('MintB').source, 'pump.fun');
  assert.equal(book.peek('MintB').symbol, 'BBB');
  assert.equal(book.peek('MintB').sampleMs, 60000);
  assert.deepEqual(book.peek('MintA').samples.map((sample) => sample.close), [1]);
  assert.equal(book.peek('MintA').source, '');

  const again = book.activate('MintA');
  assert.equal(again.changed, true);
  assert.deepEqual(again.series.samples.map((sample) => sample.close), [1]);
  assert.equal(book.getEpoch() > 1, true);
});

test('reactivating the same mint does not bump the epoch or clear samples', () => {
  const book = createBook();
  book.activate('MintA');
  book.appendSample('MintA', { time: 1, open: 4, high: 4, low: 4, close: 4, volume: 1 });
  const epoch = book.getEpoch();
  const again = book.activate('MintA');
  assert.equal(again.changed, false);
  assert.equal(book.getEpoch(), epoch);
  assert.equal(again.series.samples.length, 1);
});

