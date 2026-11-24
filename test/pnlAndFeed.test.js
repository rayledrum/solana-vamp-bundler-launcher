const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');
const {
  emptyBook,
  applyBuy,
  applySell,
  quotePosition,
  knownTradeFeeSol,
  priceFromTrade
} = require('../src/pnl');
const { planAccounts, diffSubscriptions, backoffMs, decodeTokenAmount } = require('../src/subscriptionBook');
const { LiveAccountFeed } = require('../src/liveFeed');

function address() {
  return Keypair.generate().publicKey.toBase58();
}

function fakeConnection() {
  let nextId = 1;
  return {
    subs: new Map(),
    removed: [],
    resyncs: 0,
    onAccountChange(pubkey, callback, commitment) {
      const id = nextId;
      nextId += 1;
      this.subs.set(id, { address: pubkey.toBase58(), callback, commitment });
      return id;
    },
    removeAccountChangeListener(id) {
      this.removed.push(id);
      this.subs.delete(id);
    },
    async getMultipleAccountsInfo(keys) {
      this.resyncs += 1;
      return keys.map(() => ({ lamports: 42_000, data: Buffer.alloc(72) }));
    }
  };
}

test('cost basis, unrealized PnL, and realized PnL follow confirmed fills', () => {
  const fee = knownTradeFeeSol(0.0001);
  let book = applyBuy(emptyBook(), { tokensBought: 1000, solSpent: 0.1 + fee });
  assert.equal(book.tokens, 1000);
  assert.ok(Math.abs(book.costBasisSol - (0.1 + fee)) < 1e-12);
  assert.equal(book.realizedSol, 0);

  const marked = quotePosition(book, 1000, 0.0002);
  assert.ok(Math.abs(marked.unrealizedSol - (0.2 - book.costBasisSol)) < 1e-12);
  assert.ok(Math.abs(marked.pnlSol - marked.unrealizedSol) < 1e-12);

  const cost = book.costBasisSol;
  book = applySell(book, { tokensSold: 400, solReceived: 0.09 });
  assert.equal(book.tokens, 600);
  const costRemoved = cost * 0.4;
  assert.ok(Math.abs(book.costBasisSol - (cost - costRemoved)) < 1e-12);
  assert.ok(Math.abs(book.realizedSol - (0.09 - costRemoved)) < 1e-12);

  const drifted = quotePosition(book, 500, 0.0002);
  assert.equal(drifted.tokens, 500);
  assert.ok(Math.abs(drifted.unrealizedSol - (500 * 0.0002 - book.costBasisSol)) < 1e-12);
  assert.ok(Math.abs(drifted.pnlSol - (drifted.realizedSol + drifted.unrealizedSol)) < 1e-12);
  assert.equal(quotePosition(book, 500, null).unrealizedSol, null);
  const unknown = quotePosition({ ...emptyBook(), costKnown: false }, 63724.256335, 0.0000001465);
  assert.equal(unknown.costKnown, false);
  assert.equal(unknown.pnlSol, null);
  assert.equal(unknown.costBasisSol, null);
  assert.ok(Math.abs(unknown.valueSol - (63724.256335 * 0.0000001465)) < 1e-8);
});

test('a simulated ticker trade is not a live price', () => {
  assert.equal(priceFromTrade({ simulated: true, solAmount: 1, tokenAmount: 10 }), null);
  assert.equal(priceFromTrade({ solAmount: 0.2, tokenAmount: 1000 }), 0.0002);
});

test('subscriptions follow wallet and mint changes and reconnect resyncs once', async () => {
  const first = address();
  const second = address();
  const mintA = address();
  const mintB = address();
  const connection = fakeConnection();
  let live = true;
  const solEvents = [];
  const delays = [];
  const feed = new LiveAccountFeed({
    connection,
    isLive: () => live,
    onSol: (row) => solEvents.push(row),
    schedule: (fn, ms) => {
      delays.push(ms);
      return 0;
    }
  });

  feed.start();
  feed.setWallets([first, second]);
  feed.setMint(mintA);
  const ataA = planAccounts({ wallets: [first], mint: mintA }).find(row => row.kind === 'token').address;
  assert.equal(feed.keys().filter(key => key.startsWith('sol:')).length, 2);
  assert.equal(feed.keys().filter(key => key.startsWith('token:')).length, 2);
  assert.ok(feed.keys().includes(`token:${first}:${mintA}`));
  assert.equal(connection.subs.size, 4);

  feed.setMint(mintB);
  assert.ok(!feed.keys().includes(`token:${first}:${mintA}`));
  assert.ok(feed.keys().includes(`token:${second}:${mintB}`));
  assert.equal(feed.keys().filter(key => key.startsWith('sol:')).length, 2);
  assert.ok(connection.removed.length >= 2);

  feed.setWallets([first]);
  assert.deepEqual(feed.keys().sort(), [`sol:${first}`, `token:${first}:${mintB}`].sort());
  assert.equal(planAccounts({ wallets: [first], mint: mintB }).find(row => row.kind === 'token').address === ataA, false);

  const before = [...connection.subs.keys()];
  feed.handleClose();
  assert.equal(delays[0], backoffMs(0));
  assert.equal(backoffMs(5), 30000);
  await feed.resubscribe();
  assert.equal(connection.resyncs, 1);
  assert.equal(feed.keys().length, 2);
  assert.ok(before.every(id => connection.removed.includes(id)));
  assert.ok(solEvents.length >= 1);

  const raw = Buffer.alloc(72);
  raw.writeBigUInt64LE(1_500_000n, 64);
  assert.equal(decodeTokenAmount(raw), 1_500_000);
  const diff = diffSubscriptions(new Set(['sol:a']), planAccounts({ wallets: ['a', 'b'], mint: null }));
  assert.deepEqual(diff.unsubscribe, []);
  assert.equal(diff.subscribe.length, 1);

  feed.stop();
  assert.equal(feed.keys().length, 0);
  live = false;
  feed.start();
  feed.setWallets([first, second]);
  feed.setMint(mintA);
  assert.equal(feed.keys().length, 0);
});
