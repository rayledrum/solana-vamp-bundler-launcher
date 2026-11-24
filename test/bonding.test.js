const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_GLOBAL,
  GLOBAL_DISCRIMINATOR,
  decodeGlobal,
  bondingProgress,
  curveState
} = require('../src/bondingCurve');

test('bonding progress uses real token reserves and the complete flag', () => {
  const initial = DEFAULT_GLOBAL.initialRealTokenReserves;
  assert.equal(initial, 793_100_000_000_000n);
  assert.equal(bondingProgress(initial, initial, false), 0);
  assert.equal(bondingProgress(initial / 2n, initial, false), 50);
  assert.equal(bondingProgress(0n, initial, false), 100);
  assert.equal(bondingProgress(initial, initial, true), 100);
});

test('the modeled curve does not graduate at 85 SOL', () => {
  const fresh = curveState(0);
  assert.equal(fresh.progressPct, 0);
  assert.equal(fresh.destination, 'PumpSwap');
  assert.equal(fresh.complete, false);
  const atOldTarget = curveState(85);
  assert.ok(atOldTarget.progressPct < 100);
  assert.equal(atOldTarget.complete, false);
  const graduated = curveState(500);
  assert.equal(graduated.complete, true);
  assert.equal(graduated.progressPct, 100);
});

test('the global account layout matches the live Pump global', () => {
  const buf = Buffer.alloc(113);
  GLOBAL_DISCRIMINATOR.copy(buf, 0);
  buf[8] = 1;
  let offset = 8 + 1 + 32 + 32;
  buf.writeBigUInt64LE(DEFAULT_GLOBAL.initialVirtualTokenReserves, offset); offset += 8;
  buf.writeBigUInt64LE(DEFAULT_GLOBAL.initialVirtualSolReserves, offset); offset += 8;
  buf.writeBigUInt64LE(DEFAULT_GLOBAL.initialRealTokenReserves, offset); offset += 8;
  buf.writeBigUInt64LE(DEFAULT_GLOBAL.tokenTotalSupply, offset);
  const decoded = decodeGlobal(buf);
  assert.equal(decoded.initialRealTokenReserves, 793_100_000_000_000n);
  assert.equal(decoded.initialVirtualSolReserves, 30_000_000_000n);
  assert.equal(decodeGlobal(Buffer.alloc(113)), null);
});
