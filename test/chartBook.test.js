const test = require('node:test');
const assert = require('node:assert/strict');
const { createBook } = require('../public/js/chartBook');

function closes(book) {
  return book.view().candles.map(candle => candle.close);
}

test('switching mints shows only that mint’s candles and markers', () => {
  const book = createBook();
  book.activate('MintA');
  book.pushTick(0.1, 1, { mint: 'MintA', time: 0, side: 'buy' });
  book.pushTick(0.2, 1, { mint: 'MintA', time: 5000, side: 'sell' });

  book.activate('MintB');
  const viewB = book.view();
  assert.equal(viewB.mint, 'MintB');
  assert.equal(viewB.candles.length, 0);
  assert.equal(viewB.markers.length, 0);
  assert.equal(viewB.lastPrice, 0);

  book.pushTick(0.9, 2, { mint: 'MintB', time: 0, side: 'buy' });
  assert.deepEqual(closes(book), [0.9]);
  assert.equal(book.view().markers.length, 1);
  assert.equal(book.view().markers[0].side, 'buy');

  book.activate('MintA');
  assert.deepEqual(closes(book), [0.1, 0.2]);
  assert.deepEqual(book.view().markers.map(marker => marker.side), ['buy', 'sell']);
  assert.ok(book.view().candles.every(candle => candle.close !== 0.9));
});

test('late ticks for a previous mint are stored there and not drawn on the active mint', () => {
  const book = createBook();
  book.activate('MintA');
  book.pushTick(0.3, 1, { mint: 'MintA', time: 0, side: 'buy' });

  book.activate('MintB');
  book.pushTick(0.4, 1, { mint: 'MintB', time: 0 });
  const before = closes(book).slice();
  const markerCount = book.view().markers.length;

  const late = book.pushTick(0.77, 3, { mint: 'MintA', time: 8000, side: 'sell' });
  assert.equal(late.applied, true);
  assert.equal(late.visible, false);
  assert.deepEqual(closes(book), before);
  assert.equal(book.view().markers.length, markerCount);
  assert.equal(book.view().mint, 'MintB');

  book.activate('MintA');
  assert.ok(closes(book).includes(0.77));
  assert.ok(book.view().markers.some(marker => marker.side === 'sell' && marker.price === 0.77));
  assert.ok(closes(book).every(price => price !== 0.4));
});

test('unscoped ticks and stale epochs do not paint the active coin', () => {
  const book = createBook();
  book.activate('MintA');
  book.pushTick(0.5, 1, { mint: 'MintA', time: 0 });
  const epoch = book.getEpoch();

  const unscoped = book.pushTick(9, 1, { time: 1000, side: 'sell' });
  assert.equal(unscoped.applied, false);
  assert.equal(unscoped.reason, 'unscoped');
  assert.deepEqual(closes(book), [0.5]);
  assert.equal(book.view().markers.length, 0);

  book.activate('MintB');
  const stale = book.pushTick(8, 1, { mint: 'MintA', time: 2000, side: 'buy', epoch });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'stale-epoch');
  assert.equal(book.peek('MintA').ticks.length, 1);

  book.activate('MintA');
  assert.deepEqual(closes(book), [0.5]);
  assert.equal(book.view().markers.length, 0);
});

test('reactivating the same mint does not clear its series', () => {
  const book = createBook();
  book.activate('MintA');
  book.pushTick(0.42, 1, { mint: 'MintA', time: 0, side: 'buy' });
  const epoch = book.getEpoch();
  book.activate('MintA');
  assert.equal(book.getEpoch(), epoch);
  assert.deepEqual(closes(book), [0.42]);
  assert.equal(book.view().markers.length, 1);
});

test('timeframe changes rebucket only the active mint', () => {
  const book = createBook();
  book.activate('MintA');
  book.pushTick(1, 1, { mint: 'MintA', time: 0 });
  book.pushTick(2, 1, { mint: 'MintA', time: 10000 });
  book.activate('MintB');
  book.pushTick(9, 1, { mint: 'MintB', time: 0, side: 'buy' });
  book.pushTick(9.5, 1, { mint: 'MintB', time: 1000 });

  book.setTimeframe('1m');
  const view = book.view();
  assert.equal(view.mint, 'MintB');
  assert.equal(view.candles.length, 1);
  assert.equal(view.candles[0].open, 9);
  assert.equal(view.candles[0].close, 9.5);
  assert.equal(view.markers.length, 1);
  assert.ok(view.candles.every(candle => candle.close !== 1 && candle.close !== 2));

  book.activate('MintA');
  const merged = book.view().candles;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].open, 1);
  assert.equal(merged[0].close, 2);

  book.setTimeframe('5s');
  assert.deepEqual(closes(book), [1, 2]);
});
