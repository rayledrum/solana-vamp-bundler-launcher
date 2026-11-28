const test = require('node:test');
const assert = require('node:assert/strict');
const vampScanner = require('../src/vampScanner');

function coin(address, mcap, extra = {}) {
  return { tokenAddress: address, metrics: { mcap, ...extra } };
}

test('a market-cap range keeps coins between min and max', () => {
  const filtered = vampScanner.filterCandidates([
    coin('Tiny', 1000),
    coin('Low', 120000),
    coin('High', 900000),
    coin('Giant', 20000000),
    coin('Unknown', null)
  ], { minMcap: 100000, maxMcap: 1000000, showUnknown: false });
  assert.deepEqual(filtered.tokens.map(row => row.tokenAddress), ['Low', 'High']);
  assert.equal(filtered.hidden, 3);
  const shown = vampScanner.filterCandidates([
    coin('Unknown', null),
    coin('Low', 120000)
  ], { minMcap: 100000, maxMcap: 1000000, showUnknown: true });
  assert.equal(shown.tokens.length, 2);
  assert.equal(shown.tokens[0].mcapUnknown, true);
});

test('closest, newest, and biggest sorts order the pool differently', () => {
  const tokens = [
    coin('Mid', 400000, { createdAt: 300 }),
    coin('Low', 150000, { createdAt: 100 }),
    coin('High', 800000, { createdAt: 200 }),
    coin('Undated', 500000, { createdAt: null })
  ];
  assert.deepEqual(vampScanner.sortCandidates(tokens, 'closest').map(row => row.tokenAddress), ['Low', 'Mid', 'Undated', 'High']);
  assert.deepEqual(vampScanner.sortCandidates(tokens, 'biggest').map(row => row.tokenAddress), ['High', 'Undated', 'Mid', 'Low']);
  assert.deepEqual(vampScanner.sortCandidates(tokens, 'newest').map(row => row.tokenAddress), ['Mid', 'High', 'Low', 'Undated']);
});

test('the range is applied before the display slice', () => {
  const tokens = [];
  for (let i = 0; i < 40; i += 1) tokens.push(coin(`Giant${i}`, 20000000 + i));
  tokens.push(coin('Near', 150000));
  tokens.push(coin('Nearer', 120000));
  const filtered = vampScanner.filterCandidates(tokens, { minMcap: 100000, maxMcap: 1000000 });
  const shown = vampScanner.sortCandidates(filtered.tokens, 'closest').slice(0, 2);
  assert.equal(filtered.tokens.length, 2);
  assert.deepEqual(shown.map(row => row.tokenAddress), ['Nearer', 'Near']);
  const many = Array.from({ length: 60 }, (_, index) => coin(`C${index}`, 100000 + index * 1000));
  const sorted = vampScanner.sortCandidates(vampScanner.filterCandidates(many, { minMcap: 100000 }).tokens, 'closest');
  assert.equal(sorted[0].tokenAddress, 'C0');
  assert.equal(vampScanner.sortCandidates(sorted, 'biggest')[0].tokenAddress, 'C59');
});

test('age, volume, and liquidity limits hide coins outside the range', () => {
  const now = 1_000_000_000_000;
  const tokens = [
    coin('Fit', 200000, { createdAt: now - 2 * 60 * 60 * 1000, volume24h: 5000, liquidityUsd: 8000 }),
    coin('TooNew', 200000, { createdAt: now - 10 * 60 * 1000, volume24h: 5000, liquidityUsd: 8000 }),
    coin('TooOld', 200000, { createdAt: now - 30 * 60 * 60 * 1000, volume24h: 5000, liquidityUsd: 8000 }),
    coin('Thin', 200000, { createdAt: now - 2 * 60 * 60 * 1000, volume24h: 10, liquidityUsd: 8000 }),
    coin('Dry', 200000, { createdAt: now - 2 * 60 * 60 * 1000, volume24h: 5000, liquidityUsd: 50 }),
    coin('NoVolume', 200000, { createdAt: now - 2 * 60 * 60 * 1000, volume24h: null, liquidityUsd: 8000 })
  ];
  const filtered = vampScanner.filterCandidates(tokens, {
    minAgeMs: 60 * 60 * 1000,
    maxAgeMs: 24 * 60 * 60 * 1000,
    minVolume: 1000,
    minLiquidity: 1000,
    showUnknown: false,
    now
  });
  assert.deepEqual(filtered.tokens.map(row => row.tokenAddress), ['Fit']);
  const unknown = vampScanner.filterCandidates(tokens, {
    minVolume: 1000,
    showUnknown: true,
    now
  });
  assert.equal(unknown.tokens.some(row => row.tokenAddress === 'NoVolume'), true);
});

test('descending Pump pages are skipped when the max is below them', () => {
  const narrow = vampScanner.pumpDescOffsets({ minMcap: 100000, maxMcap: 1000000 });
  assert.equal(narrow.includes(0), false);
  assert.equal(narrow.includes(50), false);
  assert.equal(narrow.includes(150), true);
  assert.equal(narrow.includes(500), true);
  const open = vampScanner.pumpDescOffsets({ minMcap: 100000, maxMcap: 0 });
  assert.equal(open.includes(0), true);
});
