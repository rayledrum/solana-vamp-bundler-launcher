const test = require('node:test');
const assert = require('node:assert/strict');
const { collectVampMetadata, mergeVampParts, fromPumpCoin, fromDexPair, fromUriJson, fromGeckoToken } = require('../src/vampMetadata');
const { describeRpcAccount } = require('../src/rpc');

test('vamp metadata prefers Pump, then the metadata URI, then Dex, then Gecko', async () => {
  const calls = [];
  const token = await collectVampMetadata('Mint111', {
    readMetadata: async () => ({ name: 'ChainName', symbol: 'CH', uri: 'https://cdn.example/metadata.json' }),
    get: async (url) => {
      calls.push(url);
      if (url.includes('frontend-api-v3.pump.fun/coins/')) {
        return { data: { name: 'PumpName', symbol: 'PUMP', description: 'from pump', twitter: 'pumpcoin', image_uri: '' } };
      }
      if (url.includes('metadata.json')) {
        return { data: { image: 'https://cdn.example/chain.png', extensions: { telegram: 'https://t.me/coin' }, description: 'from chain' } };
      }
      if (url.includes('dexscreener')) {
        return { data: { pairs: [{ baseToken: { name: 'DexName', symbol: 'DEX' }, info: { imageUrl: 'https://cdn.example/dex.png', websites: ['https://dex.example'] } }] } };
      }
      if (url.includes('geckoterminal')) {
        return { data: { data: { attributes: { image_url: 'https://cdn.example/gecko.png', twitter_handle: 'gecko' } } } };
      }
      throw new Error('unexpected ' + url);
    }
  });
  assert.equal(token.name, 'PumpName');
  assert.equal(token.symbol, 'PUMP');
  assert.equal(token.description, 'from pump');
  assert.equal(token.twitter, 'https://x.com/pumpcoin');
  assert.equal(token.telegram, 'https://t.me/coin');
  assert.equal(token.icon, 'https://cdn.example/chain.png');
  assert.equal(token.website, 'https://dex.example');
  assert.equal(token.missing.includes('logo'), false);
  assert.equal(calls[0].includes('frontend-api-v3.pump.fun'), true);
  assert.ok(calls.indexOf('https://cdn.example/metadata.json') < calls.findIndex(url => url.includes('dexscreener')));
});

test('a failed Pump lookup still uses the later sources and notes a missing logo', async () => {
  const token = await collectVampMetadata('Mint222', {
    readMetadata: async () => null,
    get: async (url) => {
      if (url.includes('pump.fun')) throw new Error('pump down');
      if (url.includes('dexscreener.com/latest/dex/tokens/')) return { data: { pairs: [] } };
      if (url.includes('dexscreener')) {
        return { data: { pairs: [{ baseToken: { name: 'OnlyDex', symbol: 'OD' }, info: { socials: [{ type: 'twitter', url: 'https://x.com/od' }] } }] } };
      }
      if (url.includes('geckoterminal')) {
        return { data: { data: { attributes: { telegram_handle: 'odchat' } } } };
      }
      throw new Error('unexpected ' + url);
    }
  });
  assert.equal(token.name, 'OnlyDex');
  assert.equal(token.symbol, 'OD');
  assert.equal(token.twitter, 'https://x.com/od');
  assert.equal(token.telegram, 'https://t.me/odchat');
  assert.equal(token.icon, '');
  assert.deepEqual(token.missing.includes('logo'), true);
  const merged = mergeVampParts([
    fromPumpCoin({ name: 'P', image_uri: 'https://cdn.example/p.png' }),
    fromUriJson({ image: 'https://cdn.example/other.png' }),
    fromDexPair({ info: { imageUrl: 'https://cdn.example/dex.png' } }),
    fromGeckoToken({ data: { attributes: { image_url: 'https://cdn.example/g.png' } } })
  ]);
  assert.equal(merged.icon, 'https://cdn.example/p.png');
});

test('the RPC status payload names the active provider and hides URLs', () => {
  const quick = describeRpcAccount({
    active: 'QuickNode',
    providers: [
      { name: 'QuickNode', configured: true, healthy: true, cooldownMs: 0, httpUrl: 'https://secret.example/key' },
      { name: 'Public', configured: true, healthy: true, cooldownMs: 0 }
    ]
  }, { heliusConfigured: false, quicknodeConfigured: true });
  assert.equal(quick.active, 'QuickNode');
  assert.equal(quick.account, 'QuickNode');
  assert.equal(quick.paused, false);
  assert.equal(JSON.stringify(quick).includes('secret'), false);
  assert.equal(JSON.stringify(quick).includes('http'), false);

  const pub = describeRpcAccount({ active: 'Public', providers: [{ name: 'Public', healthy: true }] }, {});
  assert.equal(pub.account, 'live paused');
  assert.equal(pub.paused, true);

  const helius = describeRpcAccount({ active: 'Helius', providers: [{ name: 'Helius', healthy: true }] }, { heliusConfigured: true });
  assert.equal(helius.account, 'Helius configured');
  const idle = describeRpcAccount({ active: 'QuickNode', providers: [{ name: 'QuickNode' }] }, { heliusConfigured: true });
  assert.equal(idle.account, 'QuickNode');
});
