const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, PublicKey } = require('@solana/web3.js');
const {
  BONDING_CURVE_DISCRIMINATOR,
  TRADE_EVENT_DISCRIMINATOR,
  decodeBondingCurve,
  decodeTradeEvent,
  parseProgramDataLogs,
  pumpPortalFeedEvent,
  CurveFeed
} = require('../src/curveFeed');

function fakeConnection() {
  let next = 1;
  return {
    removedAccounts: [],
    removedLogs: [],
    onAccountChange() {
      const id = next;
      next += 1;
      return id;
    },
    removeAccountChangeListener(id) {
      this.removedAccounts.push(id);
    },
    onLogs() {
      const id = next;
      next += 1;
      return id;
    },
    removeOnLogsListener(id) {
      this.removedLogs.push(id);
    }
  };
}

test('bonding-curve bytes decode to a SOL price from virtual reserves', () => {
  assert.deepEqual([...BONDING_CURVE_DISCRIMINATOR], [23, 183, 248, 55, 96, 216, 172, 96]);
  const buf = Buffer.alloc(49);
  BONDING_CURVE_DISCRIMINATOR.copy(buf, 0);
  buf.writeBigUInt64LE(1_000_000_000_000n, 8);
  buf.writeBigUInt64LE(30_000_000_000n, 16);
  buf.writeBigUInt64LE(793_100_000_000_000n, 24);
  buf.writeBigUInt64LE(5_000_000_000n, 32);
  buf.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  buf[48] = 0;
  const decoded = decodeBondingCurve(buf);
  assert.equal(decoded.complete, false);
  assert.equal(decoded.realSolReserves, 5_000_000_000);
  assert.ok(Math.abs(decoded.priceSol - 0.00003) < 1e-12);
  assert.ok(Math.abs(decoded.marketCapSol - 30000) < 1e-6);
});

test('TradeEvent program-data logs become a buy or sell', () => {
  assert.deepEqual([...TRADE_EVENT_DISCRIMINATOR], [189, 219, 127, 211, 78, 230, 97, 238]);
  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const buf = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 32 + 8 + 16);
  TRADE_EVENT_DISCRIMINATOR.copy(buf, 0);
  Buffer.from(mint.toBytes()).copy(buf, 8);
  buf.writeBigUInt64LE(2_000_000_000n, 40);
  buf.writeBigUInt64LE(1_000_000_000_000n, 48);
  buf[56] = 1;
  Buffer.from(user.toBytes()).copy(buf, 57);
  buf.writeBigInt64LE(1_700_000_000n, 89);
  buf.writeBigUInt64LE(30_000_000_000n, 97);
  buf.writeBigUInt64LE(1_000_000_000_000n, 105);
  const line = `Program data: ${buf.toString('base64')}`;
  const [event] = parseProgramDataLogs(['Program log: Instruction: Buy', line, 'not an event']);
  assert.equal(event.mint, mint.toBase58());
  assert.equal(event.user, user.toBase58());
  assert.equal(event.isBuy, true);
  assert.equal(event.txType, 'buy');
  assert.ok(Math.abs(event.solAmount - 2) < 1e-9);
  assert.ok(Math.abs(event.tokenAmount - 1_000_000) < 1e-6);
  assert.ok(Math.abs(event.priceSol - 0.00003) < 1e-12);
  assert.equal(decodeTradeEvent(Buffer.alloc(4)), null);
});

test('a PumpPortal error message becomes FEED_STATUS instead of a silent drop', () => {
  const message = "'subscribeTokenTrade' and 'subscribeAccountTrade' methods are only available when connecting with an API key funded with at least 0.02 SOL.";
  const event = pumpPortalFeedEvent({ message });
  assert.equal(event.type, 'FEED_STATUS');
  assert.equal(event.payload.channel, 'pumpportal');
  assert.equal(event.payload.connected, false);
  assert.equal(event.payload.message, message);
  assert.equal(pumpPortalFeedEvent({ txType: 'buy', solAmount: 0.1 }).type, 'PUBLIC_TRADE');
  assert.equal(pumpPortalFeedEvent({}), null);
});

test('switching the tracked mint unsubscribes the previous bonding curve', () => {
  const connection = fakeConnection();
  const feed = new CurveFeed({
    connection,
    programId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    isLive: () => true
  });
  const mintA = Keypair.generate().publicKey.toBase58();
  const mintB = Keypair.generate().publicKey.toBase58();
  feed.start();
  feed.setMint(mintA);
  assert.equal(feed.accountSub, 1);
  assert.equal(feed.logsSub, 2);
  assert.equal(feed.mintLogsSub, 3);
  feed.setMint(mintB);
  assert.deepEqual(connection.removedAccounts, [1]);
  assert.deepEqual(connection.removedLogs, [2, 3]);
  assert.notEqual(feed.accountSub, 1);
  assert.equal(feed.mint, mintB);
  feed.stop();
  assert.equal(feed.accountSub, null);
  assert.equal(feed.logsSub, null);
});
