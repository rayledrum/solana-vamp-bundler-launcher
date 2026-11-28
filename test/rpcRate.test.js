const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenBucket, createRpcPool, liveTradingPaused } = require('../src/rpc');

test('the limiter stays inside the requests-per-second cap', async () => {
  let clock = 0;
  const bucket = createTokenBucket({
    rps: 2,
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  });
  const granted = [];
  for (let i = 0; i < 5; i += 1) {
    await bucket.acquire(false);
    granted.push(clock);
  }
  for (const at of granted) {
    const inWindow = granted.filter(time => at - time < 1000 && time <= at);
    assert.ok(inWindow.length <= 2);
  }
  assert.ok(granted[granted.length - 1] >= 1000);
});

test('a priority call is served before a background call waiting on the cap', async () => {
  let clock = 0;
  const bucket = createTokenBucket({
    rps: 1,
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  });
  await bucket.acquire(false);
  const order = [];
  const background = bucket.acquire(false).then(() => order.push('background'));
  const launch = bucket.acquire(true).then(() => order.push('launch'));
  await Promise.all([background, launch]);
  assert.deepEqual(order, ['launch', 'background']);
});

test('a live-switch burst against a 15 rps cap does not fail over', async () => {
  let clock = 0;
  const lines = [];
  const calls = [];
  let forced = false;
  const stub = {
    async getAccountInfo() {
      calls.push(clock);
      return { owner: { toBase58() { return 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'; } }, data: Buffer.alloc(0) };
    },
    async getMultipleAccountsInfo(keys) {
      calls.push(clock);
      return keys.map(() => null);
    },
    async getBalance() {
      calls.push(clock);
      if (!forced) {
        forced = true;
        const err = new Error('429 Too Many Requests: {"code":-32007,"message":"15/second request limit reached"}');
        err.code = -32007;
        throw err;
      }
      return 1;
    },
    async getSlot() {
      calls.push(clock);
      const err = new Error('429 Too Many Requests');
      err.code = 429;
      throw err;
    },
    onAccountChange() { return 1; },
    onLogs() { return 2; },
    removeAccountChangeListener() {},
    removeOnLogsListener() {}
  };
  const api = createRpcPool({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: (line) => lines.push(line),
    providers: [
      { name: 'QuickNode', httpUrl: 'https://qn.example/secret', wsUrl: '', configured: true, rps: 15 },
      { name: 'Public', httpUrl: 'https://public.example/unused', wsUrl: '', configured: true, rps: 4 }
    ],
    connect: () => stub
  });
  const reads = [
    api.connection.getAccountInfo('mint'),
    api.connection.getMultipleAccountsInfo(['a', 'b', 'c', 'd', 'e', 'f']),
    ...Array.from({ length: 12 }, () => api.connection.getBalance('wallet'))
  ];
  await Promise.all(reads);
  for (let i = 0; i < 8; i += 1) api.connection.onAccountChange(`wallet-${i}`, () => {}, 'processed');
  api.connection.onLogs('curve', () => {}, 'processed');
  api.connection.onLogs('curve', () => {}, 'processed');
  const probed = await api.probe({ timeoutMs: 20, method: 'getSlot' });
  assert.equal(probed.name, 'QuickNode');
  assert.equal(api.status().active, 'QuickNode');
  assert.equal(api.status().providers.find(row => row.name === 'QuickNode').healthy, true);
  assert.equal(api.status().providers.find(row => row.name === 'QuickNode').cooldownMs, 0);
  assert.equal(liveTradingPaused(api.status()), false);
  assert.deepEqual(lines, []);
  for (const at of calls) {
    assert.ok(calls.filter(time => at - time >= 0 && at - time < 1000).length <= 15);
  }
});

test('repeated transport errors still fail over', async () => {
  let clock = 0;
  const lines = [];
  const api = createRpcPool({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: (line) => lines.push(line),
    providers: [
      { name: 'QuickNode', httpUrl: 'https://qn.example/secret', wsUrl: '', configured: true, rps: 12 },
      { name: 'Public', httpUrl: 'https://public.example/unused', wsUrl: '', configured: true, rps: 4 }
    ],
    connect: (provider) => ({
      async getBalance() {
        if (provider.name === 'QuickNode') {
          const err = new Error('socket hang up');
          err.code = 'ECONNRESET';
          throw err;
        }
        return 5;
      }
    })
  });
  assert.equal(await api.connection.getBalance('addr'), 5);
  assert.equal(api.status().active, 'Public');
  assert.equal(lines[0], 'RPC failover: QuickNode -> Public (unreachable)');
  assert.equal(liveTradingPaused(api.status()), true);
});
