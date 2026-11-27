const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const vampScanner = require('../src/vampScanner');

const SOL = 'So11111111111111111111111111111111111111112';

function geckoBody(address, mcap) {
  return {
    data: [{
      relationships: {
        base_token: { data: { id: `solana_${address}` } },
        quote_token: { data: { id: 'solana_SOL' } }
      },
      attributes: {
        name: 'Good',
        market_cap_usd: mcap,
        volume_usd: { h24: 10 },
        price_change_percentage: { h24: 1 }
      }
    }],
    included: [
      { id: `solana_${address}`, attributes: { address, name: 'Good', symbol: 'GOOD' } },
      { id: 'solana_SOL', attributes: { address: SOL, symbol: 'SOL' } }
    ]
  };
}

test('dedupe keeps one mint and prefers a known market cap', () => {
  const merged = vampScanner.dedupeTokens([
    { tokenAddress: 'MintA', name: 'Bare', metrics: { mcap: null } },
    { tokenAddress: 'MintA', name: 'Priced', symbol: 'PA', metrics: { mcap: 120000 } },
    { tokenAddress: 'MintB', name: 'Small', metrics: { mcap: 40 } },
    { tokenAddress: '', name: 'Skip' }
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].tokenAddress, 'MintA');
  assert.equal(merged[0].metrics.mcap, 120000);
  assert.equal(merged[0].name, 'Priced');
  assert.equal(merged[0].symbol, 'PA');
});

test('a market-cap floor drops cheaper coins and sorts the rest descending', () => {
  const filtered = vampScanner.filterByMinMcap([
    { tokenAddress: 'Low', metrics: { mcap: 1000 } },
    { tokenAddress: 'High', metrics: { mcap: 250000 } },
    { tokenAddress: 'Mid', metrics: { mcap: 150000 } },
    { tokenAddress: 'Unknown', metrics: { mcap: null } }
  ], { minMcap: 100000, showUnknown: false });
  assert.deepEqual(filtered.tokens.map(row => row.tokenAddress), ['High', 'Mid']);
  assert.equal(filtered.hidden, 2);
  const sorted = filtered.tokens.slice().sort((a, b) => b.metrics.mcap - a.metrics.mcap);
  assert.deepEqual(sorted.map(row => row.tokenAddress), ['High', 'Mid']);
});

test('one failing source still leaves coins from the sources that answered', async () => {
  const originalGet = axios.get;
  vampScanner.clearSourceCache();
  const calls = [];
  axios.get = async (url) => {
    calls.push(String(url));
    if (String(url).includes('frontend-api-v3.pump.fun')) throw new Error('pump down');
    if (String(url).includes('trending_pools')) return { data: geckoBody('MintGood', 250000) };
    if (String(url).includes('geckoterminal')) return { data: { data: [], included: [] } };
    if (String(url).includes('token-boosts/top')) {
      return { data: [{ chainId: 'solana', tokenAddress: 'MintDex', symbol: 'DEX', links: [] }] };
    }
    if (String(url).includes('dexscreener.com/latest/dex/tokens/')) {
      return { data: { pairs: [{ baseToken: { address: 'MintDex', name: 'Dex', symbol: 'DEX' }, marketCap: 180000, volume: { h24: 1 }, priceChange: { h24: 0 } }] } };
    }
    if (String(url).includes('dexscreener.com')) return { data: [] };
    throw new Error(`unexpected ${url}`);
  };
  try {
    const list = await vampScanner.getTrendingSolanaTokens(15, { minMcap: 100000 });
    assert.equal(list.some(row => row.tokenAddress === 'MintGood'), true);
    assert.equal(list.some(row => row.tokenAddress === 'MintDex'), true);
    assert.equal(list[0].metrics.mcap >= list[list.length - 1].metrics.mcap, true);
    assert.equal(list.matched, 2);
    assert.ok(list.scanned >= 2);
    assert.ok(list.sources >= 2);
    assert.ok(calls.some(url => url.includes('frontend-api-v3.pump.fun')));
    const again = await vampScanner.getTrendingSolanaTokens(15, { minMcap: 100000 });
    assert.equal(again.length, list.length);
    const geckoCalls = calls.filter(url => url.includes('trending_pools'));
    assert.equal(geckoCalls.length, 1);
  } finally {
    axios.get = originalGet;
    vampScanner.clearSourceCache();
  }
});
