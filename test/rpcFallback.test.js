const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  Keypair,
  SystemProgram,
  Transaction
} = require('@solana/web3.js');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;
process.env.WALLETS_FILE = path.join(os.tmpdir(), `rpc-wallets-${process.pid}.json`);
const {
  createRpcPool,
  classifyRpcError,
  redactUrl,
  signatureOf,
  liveTradingPaused,
  assertLiveTrading,
  bindLiveTradingPool,
  LIVE_TRADING_PAUSED
} = require('../src/rpc');
const walletManager = require('../src/walletManager');
const tradingEngine = require('../src/tradingEngine');

function fail(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

function providerStub(name, behavior) {
  const ws = new EventEmitter();
  const stub = {
    name,
    ws,
    _rpcWebSocket: ws,
    calls: [],
    subs: 0,
    async getBalance() {
      stub.calls.push('getBalance');
      if (behavior.getBalance) return behavior.getBalance();
      return 5;
    },
    async sendRawTransaction() {
      stub.calls.push('sendRawTransaction');
      if (behavior.sendRawTransaction) return behavior.sendRawTransaction();
      return 'sent';
    },
    async getSignatureStatuses() {
      stub.calls.push('getSignatureStatuses');
      if (behavior.getSignatureStatuses) return behavior.getSignatureStatuses();
      return { value: [null] };
    },
    onAccountChange() {
      stub.subs += 1;
      stub.calls.push('onAccountChange');
      return stub.subs;
    },
    removeAccountChangeListener() {
      stub.calls.push('removeAccountChangeListener');
    }
  };
  return stub;
}

function signedTransaction() {
  const payer = Keypair.generate();
  const tx = new Transaction();
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.feePayer = payer.publicKey;
  tx.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey,
    lamports: 1
  }));
  tx.sign(payer);
  return { raw: tx.serialize(), signature: bs58.encode(tx.signature) };
}

function pool(behaviors, now) {
  const stubs = {
    Helius: providerStub('Helius', behaviors.Helius || {}),
    QuickNode: providerStub('QuickNode', behaviors.QuickNode || {}),
    Public: providerStub('Public', behaviors.Public || {})
  };
  let clock = now || 1_000_000;
  const api = createRpcPool({
    now: () => clock,
    cooldownMs: 5 * 60 * 1000,
    creditCooldownMs: 60 * 60 * 1000,
    providers: [
      { name: 'Helius', httpUrl: 'https://helius.example/secret', wsUrl: 'wss://helius.example/secret', configured: true },
      { name: 'QuickNode', httpUrl: 'https://example.quiknode.pro/secret-key', wsUrl: 'wss://example.quiknode.pro/secret-key', configured: true },
      { name: 'Public', httpUrl: 'https://api.mainnet.solana.com', wsUrl: '', configured: true }
    ],
    connect: (provider) => stubs[provider.name]
  });
  return { api, stubs, advance: (ms) => { clock += ms; } };
}

test('reads fail over from Helius to QuickNode and honor the cooldown', async () => {
  const { api, stubs, advance } = pool({
    Helius: {
      getBalance() { throw fail('429 Too Many Requests', 429); }
    }
  });
  assert.equal(classifyRpcError(fail('429 Too Many Requests', 429)), 'rate');
  assert.equal(classifyRpcError(fail('max usage reached')), 'credit');
  const balance = await api.connection.getBalance('addr');
  assert.equal(balance, 5);
  assert.equal(stubs.Helius.calls.filter(row => row === 'getBalance').length, 1);
  assert.equal(stubs.QuickNode.calls.filter(row => row === 'getBalance').length, 1);
  assert.equal(api.status().active, 'QuickNode');
  assert.equal(api.status().providers.find(row => row.name === 'Helius').healthy, false);
  await api.connection.getBalance('addr');
  assert.equal(stubs.Helius.calls.filter(row => row === 'getBalance').length, 1);
  advance(5 * 60 * 1000);
  assert.equal(api.status().providers.find(row => row.name === 'Helius').healthy, true);
  assert.equal(await api.connection.getBalance('addr'), 5);
  assert.equal(stubs.Helius.calls.filter(row => row === 'getBalance').length, 2);
});

test('a credit error cools down longer than a rate limit', () => {
  const { api } = pool({
    Helius: { getBalance() { throw fail('max usage reached'); } }
  });
  api.markUnhealthy('Helius', 'credit');
  const row = api.status().providers.find(item => item.name === 'Helius');
  assert.equal(row.healthy, false);
  assert.ok(row.cooldownMs > 5 * 60 * 1000);
  assert.equal(row.cooldownMs, 60 * 60 * 1000);
});

test('URLs are redacted after the host', () => {
  const hidden = redactUrl('https://example.quiknode.pro/secret-key?api-key=abc');
  assert.equal(hidden, 'https://example.quiknode.pro/…');
  assert.equal(hidden.includes('secret-key'), false);
  assert.equal(hidden.includes('abc'), false);
  assert.equal(redactUrl('wss://mainnet.helius-rpc.com/?api-key=super'), 'wss://mainnet.helius-rpc.com/…');
});

test('a signed send is not repeated when the signature already landed', async () => {
  const { raw, signature } = signedTransaction();
  assert.equal(signatureOf(raw), signature);
  let quickSends = 0;
  const { api, stubs } = pool({
    Helius: {
      sendRawTransaction() { throw fail('socket hang up', 'ECONNRESET'); }
    },
    QuickNode: {
      getSignatureStatuses() { return { value: [{ confirmationStatus: 'confirmed' }] }; },
      sendRawTransaction() { quickSends += 1; return 'again'; }
    }
  });
  const result = await api.connection.sendRawTransaction(raw);
  assert.equal(result, signature);
  assert.equal(quickSends, 0);
  assert.equal(stubs.QuickNode.calls.includes('sendRawTransaction'), false);
  assert.equal(stubs.Helius.calls.filter(row => row === 'sendRawTransaction').length, 1);
});

test('a signed send is retried once only when the provider never saw it', async () => {
  const { raw } = signedTransaction();
  let quickSends = 0;
  const { api, stubs } = pool({
    Helius: {
      sendRawTransaction() { throw fail('connect ECONNRESET', 'ECONNRESET'); }
    },
    QuickNode: {
      getSignatureStatuses() { return { value: [null] }; },
      sendRawTransaction() {
        quickSends += 1;
        if (quickSends > 1) throw fail('429 Too Many Requests', 429);
        return 'landed-on-quicknode';
      }
    }
  });
  const result = await api.connection.sendRawTransaction(raw);
  assert.equal(result, 'landed-on-quicknode');
  assert.equal(quickSends, 1);
  await assert.rejects(() => api.connection.sendRawTransaction(raw), /429/);
  assert.equal(quickSends, 2);
  assert.equal(stubs.Public.calls.includes('sendRawTransaction'), false);
});

test('live trading pauses on the public RPC and resumes when Helius or QuickNode is healthy', () => {
  const { api, advance } = pool({
    Helius: { getBalance() { throw fail('max usage reached'); } }
  });
  assert.equal(liveTradingPaused(api.status()), false);
  api.markUnhealthy('Helius', 'credit');
  assert.equal(api.status().active, 'QuickNode');
  assert.equal(liveTradingPaused(api.status()), false);
  api.markUnhealthy('QuickNode', 'credit');
  assert.equal(api.status().active, 'Public');
  assert.equal(liveTradingPaused(api.status()), true);
  advance(60 * 60 * 1000);
  assert.equal(api.status().active, 'Helius');
  assert.equal(liveTradingPaused(api.status()), false);
});

function publicOnlyPool() {
  return createRpcPool({
    providers: [{ name: 'Public', httpUrl: 'https://public.example/unused', wsUrl: '', configured: true }],
    connect() { return {}; }
  });
}

test('a live buy and volume start are refused while only the public RPC is active', async () => {
  const dedicated = createRpcPool({
    providers: [
      { name: 'QuickNode', httpUrl: 'https://qn.example/unused', wsUrl: '', configured: true },
      { name: 'Public', httpUrl: 'https://public.example/unused', wsUrl: '', configured: true }
    ],
    connect() { return {}; }
  });
  bindLiveTradingPool(dedicated);
  assert.equal(liveTradingPaused(), false);
  assert.doesNotThrow(() => assertLiveTrading());

  bindLiveTradingPool(publicOnlyPool());
  assert.equal(liveTradingPaused(), true);
  assert.throws(() => assertLiveTrading(), (err) => err && err.message === LIVE_TRADING_PAUSED);
  walletManager.setSimulationMode(false);
  tradingEngine.connectPumpPortal = () => {};
  tradingEngine.onMintChange = () => {};
  const mint = Keypair.generate().publicKey.toBase58();
  tradingEngine.setActiveToken(mint, []);
  try {
    let buyResolved;
    try {
      buyResolved = await tradingEngine.executeBuy({
        solAmount: 0.01,
        walletAddresses: [walletManager.masterWallet.publicKey.toBase58()]
      });
    } catch (err) {
      assert.equal(err && err.message, LIVE_TRADING_PAUSED);
      buyResolved = err;
    }
    assert.ok(buyResolved instanceof Error, 'live buy must reject instead of resolving');
    let bumperError;
    try {
      tradingEngine.startVolumeBumper(0.01);
    } catch (err) {
      bumperError = err;
    }
    assert.equal(bumperError && bumperError.message, LIVE_TRADING_PAUSED);
    walletManager.setSimulationMode(true);
    const started = tradingEngine.startVolumeBumper(0.01, {
      reserveSol: 0,
      minDelaySeconds: 3,
      maxDelaySeconds: 10,
      maxCycles: 1,
      sessionBudget: 0.05,
      schedule: () => 0,
      rng: () => 0
    });
    assert.equal(started.simulated, true);
  } finally {
    bindLiveTradingPool(null);
    await tradingEngine.stopVolumeBumper();
    walletManager.setSimulationMode(true);
  }
});

test('a websocket that closes twice resubscribes on the next provider', () => {
  const { api, stubs } = pool({});
  const id = api.connection.onAccountChange('pda', () => {}, 'processed');
  assert.equal(stubs.Helius.subs, 1);
  assert.equal(stubs.QuickNode.subs, 0);
  stubs.Helius.ws.emit('close');
  assert.equal(stubs.QuickNode.subs, 0);
  stubs.Helius.ws.emit('close');
  assert.equal(stubs.QuickNode.subs, 1);
  assert.equal(stubs.Helius.calls.includes('removeAccountChangeListener'), true);
  api.connection.removeAccountChangeListener(id);
  assert.equal(stubs.QuickNode.calls.includes('removeAccountChangeListener'), true);
});
