const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRpcError, createRpcPool } = require('../src/rpc');

function dailyQuotaError() {
  const err = new Error('429 Too Many Requests: {"code":-32003,"message":"daily request limit reached"}');
  err.code = 429;
  err.error = { code: -32003, message: 'daily request limit reached' };
  return err;
}

test('a daily request cap is a quota error, and a per-second cap stays a rate error', () => {
  assert.equal(classifyRpcError(dailyQuotaError()), 'quota');
  assert.equal(classifyRpcError(Object.assign(new Error('failed'), { code: -32003 })), 'quota');
  assert.equal(classifyRpcError(Object.assign(new Error('daily request limit reached'), { code: 429 })), 'quota');
  const burst = new Error('429 Too Many Requests: {"code":-32007,"message":"15/second request limit reached"}');
  burst.code = -32007;
  assert.equal(classifyRpcError(burst), 'rate');
});

test('QuickNode daily quota fails over to Alchemy immediately and moves the websocket', async () => {
  const at = Date.UTC(2026, 10, 28, 2, 0, 0);
  let clock = at;
  const lines = [];
  const opened = [];
  const sockets = [];
  const probed = [];
  let watchProbe = false;
  const api = createRpcPool({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: (line) => lines.push(line),
    providers: [
      { name: 'Helius', httpUrl: 'https://helius.example/unused', wsUrl: 'wss://helius.example/unused', configured: true, rps: Infinity },
      { name: 'QuickNode', httpUrl: 'https://qn.example/unused', wsUrl: 'wss://qn.example/unused', configured: true, rps: 12 },
      { name: 'Alchemy', httpUrl: 'https://solana-mainnet.g.alchemy.com/v2/replace-me', wsUrl: 'wss://solana-mainnet.g.alchemy.com/v2/replace-me', configured: true, rps: 12 },
      { name: 'Public', httpUrl: 'https://api.mainnet.solana.com', wsUrl: '', configured: true, rps: 4 }
    ],
    connect: (provider) => {
      sockets.push({ name: provider.name, wsUrl: provider.wsUrl });
      return {
        async getSlot() {
          if (watchProbe) probed.push(provider.name);
          if (provider.name === 'Helius' || provider.name === 'QuickNode') throw dailyQuotaError();
          return 9;
        },
        onAccountChange() {
          opened.push(provider.name);
          return opened.length;
        },
        removeAccountChangeListener() {}
      };
    }
  });
  api.connection.onAccountChange('curve', () => {}, 'processed');
  assert.equal(await api.connection.getSlot('processed'), 9);
  assert.equal(clock, at);
  assert.equal(api.status().active, 'Alchemy');
  assert.equal(lines[0], 'RPC failover: Helius -> QuickNode (daily quota exhausted)');
  assert.equal(lines[1], 'RPC failover: QuickNode -> Alchemy (daily quota exhausted)');
  assert.equal(lines.includes('RPC failover: Alchemy -> Public (daily quota exhausted)'), false);
  assert.equal(opened.includes('Alchemy'), true);
  assert.equal(sockets.some(row => row.name === 'Alchemy' && row.wsUrl === 'wss://solana-mainnet.g.alchemy.com/v2/replace-me'), true);
  const cooled = api.status().providers.find(row => row.name === 'QuickNode');
  assert.equal(cooled.healthy, false);
  assert.equal(cooled.cooldownMs, Date.UTC(2026, 10, 29) - at);
  watchProbe = true;
  await api.reprobe();
  assert.deepEqual(probed, []);
});

test('a recovered higher provider is probed and the pool fails back onto it', async () => {
  let clock = 0;
  let quickNodeDown = true;
  const lines = [];
  const opened = [];
  const api = createRpcPool({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: (line) => lines.push(line),
    providers: [
      { name: 'QuickNode', httpUrl: 'https://qn.example/unused', wsUrl: 'wss://qn.example/unused', configured: true, rps: 12 },
      { name: 'Alchemy', httpUrl: 'https://alchemy.example/unused', wsUrl: 'wss://alchemy.example/unused', configured: true, rps: 12 },
      { name: 'Public', httpUrl: 'https://public.example/unused', wsUrl: '', configured: true, rps: 4 }
    ],
    connect: (provider) => ({
      async getBalance() {
        if (provider.name === 'QuickNode' && quickNodeDown) {
          const err = new Error('socket hang up');
          err.code = 'ECONNRESET';
          throw err;
        }
        return 4;
      },
      async getSlot() {
        return 3;
      },
      onAccountChange() {
        opened.push(provider.name);
        return 1;
      },
      removeAccountChangeListener() {}
    })
  });
  api.connection.onAccountChange('curve', () => {}, 'processed');
  assert.equal(await api.connection.getBalance('addr'), 4);
  assert.equal(api.status().active, 'Alchemy');
  quickNodeDown = false;
  const next = await api.reprobe();
  assert.equal(next.name, 'QuickNode');
  assert.equal(api.status().active, 'QuickNode');
  assert.equal(lines.includes('RPC failback: Alchemy -> QuickNode'), true);
  assert.equal(opened.filter(name => name === 'QuickNode').length >= 2, true);
});
