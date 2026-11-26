const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { createSafetyChecks, overallFromChecks, classifyCreatedCoins, classifyRugHistory, classifyInstantBond, classifyMigration } = require('../src/safetyChecks');
const { assessMint } = require('../src/research/bleedExit');
const { observationFromSources } = require('../src/research/collector');
const config = require('../src/config');

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'panel-'));
}

function curveAccount() {
  const disc = crypto.createHash('sha256').update('account:BondingCurve').digest().subarray(0, 8);
  const buf = Buffer.alloc(49);
  disc.copy(buf, 0);
  buf.writeBigUInt64LE(1_000_000_000_000n, 8);
  buf.writeBigUInt64LE(30_000_000_000n, 16);
  buf.writeBigUInt64LE(700_000_000_000_000n, 24);
  buf.writeBigUInt64LE(5_000_000_000n, 32);
  buf.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  buf[48] = 0;
  return { data: buf, owner: new PublicKey('11111111111111111111111111111111') };
}

test('a stub connection fills authorities, holders, and the bonding curve', async () => {
  const mint = Keypair.generate().publicKey;
  const whale = Keypair.generate().publicKey.toBase58();
  const api = createSafetyChecks({
    blacklistFile: path.join(dir(), 'dev-blacklist.json'),
    launchedFile: path.join(dir(), 'launched-mints.json'),
    minIntervalMs: 0,
    connection: {
      async getAccountInfo(key) {
        if (key.equals(mint)) {
          const data = Buffer.alloc(82);
          data[45] = 1;
          data.writeBigUInt64LE(1000n, 36);
          return { data, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
        }
        return curveAccount();
      },
      async getTokenSupply() { return { value: { amount: '1000' } }; },
      async getTokenLargestAccounts() { return { value: [{ address: new PublicKey(whale), amount: '100' }] }; },
      async getTokenAccountsByOwner() { return { value: [] }; }
    },
    async fetchJson() { throw new Error('offline'); }
  });
  const report = await api.report(mint.toBase58());
  const byId = Object.fromEntries(report.checks.map(row => [row.id, row]));
  assert.notEqual(byId.authorities.status, 'unknown');
  assert.notEqual(byId.holders.status, 'unknown');
  assert.notEqual(byId.bonding.status, 'unknown');
  assert.match(byId.bonding.reason, /curve is filled/);
});

test('report with no stored tape reads the curve and classifies the tape', async () => {
  const mint = Keypair.generate().publicKey;
  let signatures = 0;
  let fetched = 0;
  const now = Math.floor(Date.now() / 1000);
  const api = createSafetyChecks({
    blacklistFile: path.join(dir(), 'dev-blacklist.json'),
    launchedFile: path.join(dir(), 'launched-mints.json'),
    minIntervalMs: 0,
    connection: {
      async getAccountInfo() { return null; },
      async getTokenSupply() { return { value: { amount: '1000' } }; },
      async getTokenLargestAccounts() { return { value: [] }; },
      async getTokenAccountsByOwner() { return { value: [] }; },
      async getSignaturesForAddress() {
        signatures += 1;
        return [
          { signature: 'recent', slot: 3, blockTime: now, err: null },
          { signature: 'failed', slot: 2, blockTime: now - 30, err: { InstructionError: [] } },
          { signature: 'create', slot: 1, blockTime: now - 60, err: null }
        ];
      },
      async getTransaction(signature) {
        fetched += 1;
        assert.notEqual(signature, 'failed');
        return { slot: 1, blockTime: now - 60, meta: { logMessages: [] } };
      }
    },
    async fetchJson() { throw new Error('offline'); }
  });
  const report = await api.report(mint.toBase58());
  assert.equal(signatures, 1);
  assert.equal(fetched, 2);
  const wash = report.checks.find(row => row.id === 'wash');
  assert.equal(wash.status, 'green');
  assert.match(wash.reason, /wash volume 0\.0%/);
  const flow = report.checks.find(row => row.id === 'devFlow');
  assert.equal(flow.status, 'unknown');
  assert.match(flow.reason, /Creator was not identified/);
});

test('an injected Elonmas market-cap series is two pumps', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/elonmas-1m.json'), 'utf8'));
  const snapshots = fixture.closes.map(row => ({ time: row.t, mcapUsd: row.mc }));
  const store = { readJsonl() { return []; } };
  const result = assessMint(fixture.mint, store, { snapshots, tape: { trades: [], createTime: fixture.createdMs, supply: 1e9 } });
  assert.equal(result.pumps.pumps.length, 2);
  assert.equal(result.pumps.armAfterPump, 2);
});

test('an empty creator index is not a clean zero and a weak lookalike is not a vamp', () => {
  assert.equal(classifyCreatedCoins({ emptyIndex: true }).status, 'unknown');
  assert.match(classifyCreatedCoins({ emptyIndex: true }).reason, /no coins/);
  assert.equal(classifyRugHistory({ emptyIndex: true }, null).status, 'unknown');
  assert.match(classifyRugHistory({ emptyIndex: true }, null).reason, /not measured/);
  assert.equal(classifyInstantBond({ na: true }).status, 'na');
  assert.match(classifyInstantBond({ na: true }).reason, /has not graduated/);
  assert.equal(classifyMigration({ na: true }).status, 'na');
  const many = overallFromChecks([
    ...Array.from({ length: 8 }, () => ({ status: 'unknown' })),
    { status: 'green' }
  ]);
  assert.equal(many.overall, 'incomplete');
  assert.equal(many.unknown, 8);
  assert.equal(overallFromChecks([{ status: 'na' }, { status: 'green' }]).overall, 'green');
  const observed = observationFromSources({
    coin: null,
    candles: [{ close: 0.000002 }],
    supplyUi: 1_000_000_000,
    solUsd: 150,
    curve: { complete: false, realTokenReserves: 0 },
    dex: { dexId: 'pumpfun', marketCap: 999 }
  });
  assert.equal(observed.mcapUsd, 0.000002 * 1_000_000_000 * 150);
  assert.equal(observed.graduated, false);
  assert.equal(observed.curveProgress, 100);
  assert.equal(config.HELIUS_CONFIGURED, Boolean(process.env.HELIUS_RPC_URL));
});
