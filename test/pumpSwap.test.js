const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, PublicKey } = require('@solana/web3.js');
const {
  PUMP_AMM_PROGRAM_ID,
  WSOL_MINT,
  POOL_DISCRIMINATOR,
  BUY_EVENT_DISCRIMINATOR,
  canonicalPoolPda,
  poolAuthorityPda,
  decodePool,
  priceFromReserves,
  decodeSwapEvent,
  swapToTrade,
  PumpSwapFeed
} = require('../src/pumpSwap');

function poolBytes(baseMint, quoteMint, baseVault, quoteVault) {
  const buf = Buffer.alloc(8 + 1 + 2 + 32 * 7 + 8);
  POOL_DISCRIMINATOR.copy(buf, 0);
  let offset = 8;
  buf[offset] = 1; offset += 1;
  buf.writeUInt16LE(0, offset); offset += 2;
  Keypair.generate().publicKey.toBuffer().copy(buf, offset); offset += 32;
  new PublicKey(baseMint).toBuffer().copy(buf, offset); offset += 32;
  new PublicKey(quoteMint).toBuffer().copy(buf, offset); offset += 32;
  Keypair.generate().publicKey.toBuffer().copy(buf, offset); offset += 32;
  new PublicKey(baseVault).toBuffer().copy(buf, offset); offset += 32;
  new PublicKey(quoteVault).toBuffer().copy(buf, offset);
  return buf;
}

function vault(amount) {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(BigInt(amount), 64);
  return { data };
}

test('canonical pool price is quote reserves over base reserves', () => {
  assert.equal(PUMP_AMM_PROGRAM_ID.toBase58(), 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  const mint = Keypair.generate().publicKey;
  const pool = canonicalPoolPda(mint);
  const authority = poolAuthorityPda(mint);
  assert.notEqual(pool.toBase58(), authority.toBase58());
  const price = priceFromReserves({ baseRaw: 500_000_000_000n, quoteRaw: 2_000_000_000n });
  assert.ok(Math.abs(price - 0.000004) < 1e-12);
  assert.ok(Math.abs(price * 1_000_000_000 - 4000) < 1e-6);
});

test('a PumpSwap buy log becomes a chart trade and a vault tick prices the pool', async () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const baseVault = Keypair.generate().publicKey.toBase58();
  const quoteVault = Keypair.generate().publicKey.toBase58();
  const user = Keypair.generate().publicKey;
  const prices = [];
  const trades = [];
  const statuses = [];
  let logsHandler = null;
  const connection = {
    async getAccountInfo() {
      return { data: poolBytes(mint, WSOL_MINT, baseVault, quoteVault) };
    },
    async getMultipleAccountsInfo() {
      return [vault(500_000_000_000), vault(2_000_000_000)];
    },
    onAccountChange() { return 1; },
    removeAccountChangeListener() {},
    onLogs(_key, handler) { logsHandler = handler; return 2; },
    removeOnLogsListener() {}
  };
  const feed = new PumpSwapFeed({
    connection,
    supplyUi: async () => 1_000_000_000,
    schedule: () => 1,
    onPrice: (tick) => prices.push(tick),
    onTrade: (trade) => trades.push(trade),
    onStatus: (status) => statuses.push(status)
  });
  const ok = await feed.start(mint);
  assert.equal(ok, true);
  assert.equal(prices.length, 1);
  assert.ok(Math.abs(prices[0].priceSol - 0.000004) < 1e-12);
  assert.ok(Math.abs(prices[0].marketCapSol - 4000) < 1e-6);
  assert.equal(prices[0].complete, true);
  assert.equal(prices[0].source, 'Helius PumpSwap pool');
  assert.equal(statuses.at(-1).label, 'Helius PumpSwap pool');
  assert.equal(statuses.at(-1).connected, true);

  const buf = Buffer.alloc(184);
  BUY_EVENT_DISCRIMINATOR.copy(buf, 0);
  buf.writeBigUInt64LE(1_000_000_000n, 16);
  buf.writeBigUInt64LE(500_000_000_000n, 48);
  buf.writeBigUInt64LE(2_000_000_000n, 56);
  buf.writeBigUInt64LE(20_000_000n, 64);
  user.toBuffer().copy(buf, 152);
  const event = decodeSwapEvent(buf);
  assert.equal(event.txType, 'buy');
  assert.equal(event.user, user.toBase58());
  logsHandler({ signature: 'sig1', logs: [`Program data: ${buf.toString('base64')}`] });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].txType, 'buy');
  assert.equal(trades[0].tokenAmount, 1000);
  assert.ok(Math.abs(trades[0].solAmount - 0.02) < 1e-12);
  assert.equal(trades[0].mint, mint);
  const shaped = swapToTrade(event, { mint, signature: 'sig1', supplyUi: 1_000_000_000 });
  assert.ok(Math.abs(shaped.marketCapSol - 4000) < 1e-4);
  feed.stop();
  assert.equal(feed.running, false);
});

test('a missing PumpSwap pool does not invent a price', async () => {
  const feed = new PumpSwapFeed({
    connection: { async getAccountInfo() { return null; } },
    schedule: () => 1
  });
  const ok = await feed.start(Keypair.generate().publicKey.toBase58());
  assert.equal(ok, false);
  assert.equal(decodePool(Buffer.alloc(80)), null);
});
