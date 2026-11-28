const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRpcError, createRpcPool } = require('../src/rpc');

function dailyQuotaError() {
  const err = new Error('429 Too Many Requests: {"code":-32003,"message":"daily request limit reached"}');
  err.code = 429;
  err.error = { code: -32003, message: 'daily request limit reached' };
  return err;
}

test('a method the provider does not serve is not a provider outage', () => {
  const blocked = new Error('403 method not allowed: logsSubscribe');
  blocked.code = 403;
  assert.equal(classifyRpcError(blocked), null);
  const forbidden = new Error('403 forbidden');
  forbidden.code = 403;
  assert.equal(classifyRpcError(forbidden), 'credit');
});

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

test('an Alchemy websocket drop does not switch the sidebar to Public while getSlot works', async () => {
  const { EventEmitter } = require('events');
  const lines = [];
  const opened = [];
  let alchemyWs = null;
  const api = createRpcPool({
    log: (line) => lines.push(line),
    providers: [
      { name: 'Alchemy', httpUrl: 'https://solana-mainnet.g.alchemy.com/v2/replace-me', wsUrl: 'wss://solana-mainnet.g.alchemy.com/v2/replace-me', configured: true, rps: 12 },
      { name: 'Public', httpUrl: 'https://api.mainnet.solana.com', wsUrl: '', configured: true, rps: 4 }
    ],
    connect: (provider) => {
      const ws = new EventEmitter();
      if (provider.name === 'Alchemy') alchemyWs = ws;
      return {
        _rpcWebSocket: ws,
        async getSlot() {
          if (provider.name !== 'Alchemy') throw new Error('public getSlot');
          return 9;
        },
        async getProgramAccounts() {
          const err = new Error('403 method not allowed');
          err.code = 403;
          throw err;
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
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.status().active, 'Alchemy');
  await assert.rejects(() => api.connection.getProgramAccounts('pump'), /method not allowed/);
  assert.equal(api.status().active, 'Alchemy');
  alchemyWs.emit('error', new Error('Unexpected server response: 403'));
  assert.equal(api.status().active, 'Alchemy');
  assert.equal(api.status().providers.find(row => row.name === 'Alchemy').healthy, true);
  assert.equal(lines.filter(line => line.includes('websocket rejected')).length, 1);
  assert.equal(lines.some(line => line.includes('RPC failover: Alchemy -> Public')), false);
  alchemyWs.emit('error', new Error('Unexpected server response: 403'));
  assert.equal(lines.filter(line => line.includes('websocket rejected')).length, 1);
});

test('an Alchemy websocket 403 keeps HTTP on Alchemy and polls when no socket is left', async () => {
  const { EventEmitter } = require('events');
  const { describeRpcAccount } = require('../src/rpc');
  const lines = [];
  const opened = [];
  const sockets = {};
  let polls = 0;
  const api = createRpcPool({
    log: (line) => lines.push(line),
    providers: [
      { name: 'Alchemy', httpUrl: 'https://solana-mainnet.g.alchemy.com/v2/replace-me', wsUrl: 'wss://solana-mainnet.g.alchemy.com/v2/replace-me', configured: true, rps: 12 },
      { name: 'Public', httpUrl: 'https://api.mainnet.solana.com', wsUrl: 'wss://api.mainnet.solana.com', configured: true, rps: 4 }
    ],
    connect: (provider) => {
      const ws = new EventEmitter();
      sockets[provider.name] = ws;
      return {
        _rpcWebSocket: ws,
        async getSlot() { return provider.name === 'Alchemy' ? 9 : 1; },
        async getMultipleAccountsInfo(keys) {
          polls += 1;
          asked.push((keys || []).map(key => key.toBase58 ? key.toBase58() : String(key)));
          return (keys || []).map(() => ({ lamports: 5, data: Buffer.alloc(0) }));
        },
        onAccountChange() {
          opened.push(provider.name);
          return opened.length;
        },
        removeAccountChangeListener() {}
      };
    }
  });
  const { Keypair } = require('@solana/web3.js');
  const { bondingCurvePda } = require('../src/curveFeed');
  const { PUMP_PROGRAM_ID } = require('../src/config');
  const mint = Keypair.generate().publicKey;
  const curve = bondingCurvePda(mint, PUMP_PROGRAM_ID);
  const seen = [];
  const asked = [];
  api.setWatch({ clients: 1, visible: true, mint: mint.toBase58() });
  api.connection.onAccountChange(curve, (info) => seen.push(info && info.lamports), 'processed');
  api.connection.onAccountChange(mint, () => {}, 'processed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.status().active, 'Alchemy');
  assert.equal(opened[0], 'Alchemy');
  for (let i = 0; i < 4; i += 1) {
    sockets.Alchemy.emit('error', new Error('Unexpected server response: 403'));
    sockets.Alchemy.emit('close');
  }
  assert.equal(api.status().active, 'Alchemy');
  assert.equal(api.status().providers.find(row => row.name === 'Alchemy').healthy, true);
  assert.equal(lines.filter(line => line.startsWith('RPC Alchemy websocket rejected')).length, 1);
  assert.equal(lines.some(line => line.includes('Alchemy -> Public')), false);
  assert.equal(opened.includes('Public'), true);
  const moved = describeRpcAccount(api.status(), { alchemyConfigured: true });
  assert.equal(moved.active, 'Alchemy');
  assert.equal(moved.ws, 'Public');
  assert.equal(moved.paused, false);
  for (let i = 0; i < 3; i += 1) {
    sockets.Public.emit('error', new Error('Unexpected server response: 403'));
    sockets.Public.emit('close');
  }
  assert.equal(api.status().active, 'Alchemy');
  assert.equal(api.status().ws.mode, 'poll');
  await api.pollSubscriptions();
  assert.equal(polls, 1);
  assert.deepEqual(asked[0], [curve.toBase58()]);
  assert.deepEqual(seen, [5]);
  await api.pollSubscriptions();
  assert.equal(polls, 2);
  assert.equal(seen.length, 1);
  api.setWatch({ visible: false });
  await api.pollSubscriptions();
  assert.equal(polls, 2);
});

test('a daily call budget deprioritizes that provider and reports the count', async () => {
  const at = Date.UTC(2026, 10, 28, 3, 0, 0);
  let clock = at;
  const lines = [];
  const api = createRpcPool({
    now: () => clock,
    sleep: async () => {},
    log: (line) => lines.push(line),
    providers: [
      { name: 'Alchemy', httpUrl: 'https://alchemy.example/unused', wsUrl: 'wss://alchemy.example/unused', configured: true, rps: Infinity, dailyBudget: 2 },
      { name: 'Public', httpUrl: 'https://public.example/unused', wsUrl: '', configured: true, rps: Infinity }
    ],
    connect: (provider) => ({
      async getSlot() { return provider.name === 'Alchemy' ? 1 : 2; }
    })
  });
  assert.equal(await api.connection.getSlot('processed'), 1);
  assert.equal(await api.connection.getSlot('processed'), 1);
  assert.equal(api.status().active, 'Public');
  assert.equal(lines[0], 'RPC failover: Alchemy -> Public (daily budget reached)');
  const row = api.status().providers.find(item => item.name === 'Alchemy');
  assert.equal(row.callsToday, 2);
  assert.equal(row.dailyBudget, 2);
  assert.equal(row.healthy, false);
  const shown = require('../src/rpc').describeRpcAccount(api.status(), { alchemyConfigured: true });
  assert.equal(shown.providers.find(item => item.name === 'Alchemy').callsToday, 2);
});
