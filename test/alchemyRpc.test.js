const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { providersFromConfig, createRpcPool, liveTradingPaused, describeRpcAccount } = require('../src/rpc');

test('providers are Helius, QuickNode, Alchemy, then Public', () => {
  const names = providersFromConfig({
    HELIUS_CONFIGURED: true,
    HELIUS_RPC_URL: 'https://helius.example/unused',
    HELIUS_WS_URL: 'wss://helius.example/unused',
    QUICKNODE_CONFIGURED: true,
    QUICKNODE_RPC_URL: 'https://qn.example/unused',
    QUICKNODE_WS_URL: 'wss://qn.example/unused',
    ALCHEMY_CONFIGURED: true,
    ALCHEMY_RPC_URL: 'https://alchemy.example/unused',
    ALCHEMY_WS_URL: 'wss://alchemy.example/unused',
    SOLANA_PUBLIC_RPC_URL: 'https://api.mainnet.solana.com'
  }).map(row => row.name);
  assert.deepEqual(names, ['Helius', 'QuickNode', 'Alchemy', 'Public']);
});

test('Alchemy is skipped when it is not configured', () => {
  const names = providersFromConfig({
    HELIUS_CONFIGURED: false,
    QUICKNODE_CONFIGURED: true,
    QUICKNODE_RPC_URL: 'https://qn.example/unused',
    QUICKNODE_WS_URL: '',
    ALCHEMY_CONFIGURED: false,
    ALCHEMY_RPC_URL: '',
    SOLANA_PUBLIC_RPC_URL: 'https://api.mainnet.solana.com'
  }).map(row => row.name);
  assert.deepEqual(names, ['QuickNode', 'Public']);
});

test('an https Alchemy URL derives the websocket URL', () => {
  const fromUrl = config.alchemyEndpoints({
    ALCHEMY_RPC_URL: 'https://solana-mainnet.g.alchemy.com/v2/replace-me'
  });
  assert.equal(fromUrl.configured, true);
  assert.equal(fromUrl.wsUrl, 'wss://solana-mainnet.g.alchemy.com/v2/replace-me');
  const fromKey = config.alchemyEndpoints({ ALCHEMY_API_KEY: 'replace-me' });
  assert.equal(fromKey.httpUrl, 'https://solana-mainnet.g.alchemy.com/v2/replace-me');
  assert.equal(fromKey.wsUrl, 'wss://solana-mainnet.g.alchemy.com/v2/replace-me');
  const explicit = config.alchemyEndpoints({
    ALCHEMY_RPC_URL: 'https://solana-mainnet.g.alchemy.com/v2/replace-me',
    ALCHEMY_WS_URL: 'wss://solana-mainnet.g.alchemy.com/v2/other'
  });
  assert.equal(explicit.wsUrl, 'wss://solana-mainnet.g.alchemy.com/v2/other');
  assert.equal(config.alchemyEndpoints({}).configured, false);
});

test('failover walks QuickNode, then Alchemy, then Public', async () => {
  let clock = 0;
  let alchemyCredits = false;
  const lines = [];
  const api = createRpcPool({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: (line) => lines.push(line),
    providers: [
      { name: 'QuickNode', httpUrl: 'https://qn.example/unused', wsUrl: '', configured: true, rps: 12 },
      { name: 'Alchemy', httpUrl: 'https://alchemy.example/unused', wsUrl: 'wss://alchemy.example/unused', configured: true, rps: 12 },
      { name: 'Public', httpUrl: 'https://public.example/unused', wsUrl: '', configured: true, rps: 4 }
    ],
    connect: (provider) => ({
      async getBalance() {
        if (provider.name === 'QuickNode') {
          const err = new Error('socket hang up');
          err.code = 'ECONNRESET';
          throw err;
        }
        if (provider.name === 'Alchemy' && alchemyCredits) {
          const err = new Error('402 payment required');
          err.code = 402;
          throw err;
        }
        return 5;
      }
    })
  });
  assert.equal(await api.connection.getBalance('addr'), 5);
  assert.equal(api.status().active, 'Alchemy');
  assert.equal(lines[0], 'RPC failover: QuickNode -> Alchemy (unreachable)');
  assert.equal(liveTradingPaused(api.status()), false);
  const account = describeRpcAccount(api.status(), { alchemyConfigured: true });
  assert.equal(account.account, 'Alchemy');
  assert.equal(JSON.stringify(account).includes('alchemy.example'), false);
  alchemyCredits = true;
  assert.equal(await api.connection.getBalance('addr'), 5);
  assert.equal(api.status().active, 'Public');
  assert.equal(lines[1], 'RPC failover: Alchemy -> Public (credit exhausted)');
  assert.equal(liveTradingPaused(api.status()), true);
  const cooled = api.status().providers.find(row => row.name === 'Alchemy');
  assert.equal(cooled.healthy, false);
  assert.equal(cooled.cooldownMs, 30 * 60 * 1000);
});
