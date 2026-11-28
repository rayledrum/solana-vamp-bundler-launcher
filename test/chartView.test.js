const test = require('node:test');
const assert = require('node:assert/strict');
const ChartView = require('../public/js/chartView');
const ChartOverlays = require('../public/js/chartOverlays');
const ChartFeed = require('../public/js/chartFeed');
const {
  formatCompactUsd,
  formatAxisMarketCap,
  formatOhlcDisplay,
  toDisplayCandle,
  marketCapFromReserves,
  PUMP_SUPPLY_UI
} = require('../public/js/chartScale');

test('axis labels are compact USD market cap, including the reserves formula', () => {
  assert.equal(formatCompactUsd(2000), '$2K');
  assert.equal(formatCompactUsd(3500), '$3.5K');
  assert.equal(formatCompactUsd(1_200_000), '$1.2M');
  const fromReserves = marketCapFromReserves({
    virtualSolRaw: 30_000_000_000,
    virtualTokenRaw: 1_073_000_000_000_000,
    supplyUi: PUMP_SUPPLY_UI,
    solUsd: 100
  });
  assert.equal(fromReserves.unit, 'usd');
  assert.ok(Math.abs(fromReserves.value - (30 / 1.073) * 100) < 1);
  const price = 0.000002;
  assert.equal(formatAxisMarketCap(price, PUMP_SUPPLY_UI, 1), '$2K');
  assert.equal(formatAxisMarketCap(price, PUMP_SUPPLY_UI, null), '2.0K SOL');
  const candle = { time: 1, open: price, high: price * 1.75, low: price, close: price, volume: 1 };
  const display = toDisplayCandle(candle, PUMP_SUPPLY_UI, 1);
  assert.equal(display.high, 3500);
  assert.equal(formatOhlcDisplay(candle, PUMP_SUPPLY_UI, 1), 'O:$2K H:$3.5K L:$2K C:$2K');
});

test('a view on the right edge follows new bars, and a panned view stays put', () => {
  const view = ChartView.create();
  let count = 100;
  ChartView.zoomTime(view, count, 2, 1);
  let win = ChartView.windowOf(view, count);
  assert.equal(win.end, 100);
  assert.equal(win.following, true);
  count = 101;
  ChartView.noteBarsAppended(view, 1);
  win = ChartView.windowOf(view, count);
  assert.equal(win.end, 101);
  assert.equal(win.following, true);
  ChartView.panTime(view, count, -10);
  win = ChartView.windowOf(view, count);
  const parked = win.start;
  assert.equal(win.following, false);
  count = 102;
  ChartView.noteBarsAppended(view, 1);
  win = ChartView.windowOf(view, count);
  assert.equal(win.start, parked);
  ChartView.reset(view);
  assert.equal(ChartView.windowOf(view, count).following, true);
});

test('overlay choices survive a chart reset', () => {
  const memory = {
    data: {},
    getItem(key) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null; },
    setItem(key, value) { this.data[key] = String(value); }
  };
  const hidden = ChartOverlays.toggle(ChartOverlays.load(memory), 'markers');
  ChartOverlays.save(memory, hidden);
  ChartView.reset(ChartView.create());
  const restored = ChartOverlays.load(memory);
  assert.equal(restored.markers, false);
  assert.equal(restored.volume, true);
  memory.setItem(ChartOverlays.STORAGE_KEY, '{');
  assert.equal(ChartOverlays.load(memory).ma, true);
});

test('a gap or a single outlier keeps the last good price', () => {
  const feed = ChartFeed.create();
  ChartFeed.seed(feed, 0.000025, 1000);
  const bad = ChartFeed.consider(feed, { price: 0, reservePrice: 0.000025, now: 1000 });
  assert.equal(bad.plot, false);
  assert.equal(bad.reason, 'empty');
  assert.equal(bad.price, 0.000025);
  const outlier = ChartFeed.consider(feed, { price: 0.00001, reservePrice: 0.000025, now: 2000 });
  assert.equal(outlier.plot, false);
  assert.equal(outlier.reason, 'outlier');
  const stale = ChartFeed.consider(feed, { price: 0.000024, at: 500, now: 3000 });
  assert.equal(stale.reason, 'stale');
  const ok = ChartFeed.consider(feed, { price: 0.000026, reservePrice: 0.000025, now: 4000, at: 4000 });
  assert.equal(ok.plot, true);
  assert.equal(ChartFeed.isReconnecting(feed, 4000 + ChartFeed.GAP_MS), true);
  assert.equal(ChartFeed.isReconnecting(feed, 4000 + 1000), false);
});
