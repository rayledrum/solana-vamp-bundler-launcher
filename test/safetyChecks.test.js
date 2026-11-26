const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { ACCOUNT_SIZE, AccountType, ExtensionType, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `safety-wallets-${process.pid}.json`);
const walletManager = require('../src/walletManager');
const tradingEngine = require('../src/tradingEngine');
const {
  createSafetyChecks,
  classifyRugcheck,
  classifyHolders,
  classifyRugHistory,
  classifyAuthorities
} = require('../src/safetyChecks');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'safety-'));
}

function token2022Mint(mint, { mintAuthority = false, permanentDelegate = false } = {}) {
  const tlvParts = [];
  if (permanentDelegate) {
    const body = Keypair.generate().publicKey.toBuffer();
    const tlv = Buffer.alloc(4 + body.length);
    tlv.writeUInt16LE(ExtensionType.PermanentDelegate, 0);
    tlv.writeUInt16LE(body.length, 2);
    body.copy(tlv, 4);
    tlvParts.push(tlv);
  }
  const tlv = Buffer.concat(tlvParts);
  const data = Buffer.alloc(ACCOUNT_SIZE + (tlv.length ? 1 + tlv.length : 0));
  if (mintAuthority) {
    data.writeUInt32LE(1, 0);
    Keypair.generate().publicKey.toBuffer().copy(data, 4);
  }
  data.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  data[44] = 6;
  data[45] = 1;
  if (tlv.length) {
    data[ACCOUNT_SIZE] = AccountType.Mint;
    tlv.copy(data, ACCOUNT_SIZE + 1);
  }
  return { owner: TOKEN_2022_PROGRAM_ID, data, lamports: 1 };
}

test('failed sources stay unknown and holder math skips the pool', () => {
  assert.equal(classifyRugcheck(null).status, 'unknown');
  const danger = classifyRugcheck({
    score_normalised: 80,
    risks: [{ name: 'Mutable mint', level: 'danger' }]
  });
  assert.equal(danger.status, 'red');
  assert.match(danger.reason, /80/);
  const pool = Keypair.generate().publicKey.toBase58();
  const whale = Keypair.generate().publicKey.toBase58();
  const holders = classifyHolders({
    supplyRaw: '100',
    exclude: [pool],
    accounts: [
      { address: pool, amount: '90' },
      { address: whale, amount: '40' },
      { address: Keypair.generate().publicKey.toBase58(), amount: '10' }
    ]
  });
  assert.equal(holders.status, 'red');
  assert.match(holders.reason, /largest non-pool 40\.0%/);
  assert.equal(classifyRugHistory(null, null).status, 'unknown');
  assert.equal(classifyRugHistory([{ usd_market_cap: 10, peak_market_cap: 1000 }], null).status, 'red');
  assert.equal(classifyAuthorities({
    mintAuthority: 'MintAuth',
    freezeAuthority: null,
    extensions: ['permanentDelegate', 'transferFee', 'transferHook']
  }).status, 'red');
});

test('own launches skip outside calls, cache repeats, and auto-blacklist is configurable', async () => {
  const dir = tempDir();
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  let calls = 0;
  const api = createSafetyChecks({
    blacklistFile: path.join(dir, 'dev-blacklist.json'),
    launchedFile: path.join(dir, 'launched-mints.json'),
    ttlMs: 60_000,
    minIntervalMs: 0,
    connection: {
      async getAccountInfo() { return null; },
      async getTokenSupply() { return { value: { amount: '1000000' } }; },
      async getTokenLargestAccounts() { return { value: [] }; },
      async getTokenAccountsByOwner() { return { value: [] }; }
    },
    async fetchJson(url) {
      calls += 1;
      if (String(url).includes('rugcheck')) {
        return { score_normalised: 90, rugged: true, risks: [{ name: 'Rugged', level: 'danger' }], creator };
      }
      if (String(url).includes('user-created-coins')) return [];
      if (String(url).includes('dex')) return { pairs: [] };
      return { creator, created_timestamp: Date.now() - 3_600_000 };
    }
  });
  api.noteOwnLaunch(mint);
  const own = await api.report(mint);
  assert.equal(own.label, 'Own launch');
  assert.equal(calls, 0);

  const tracked = Keypair.generate().publicKey.toBase58();
  const first = await api.report(tracked);
  const afterFirst = calls;
  assert.ok(afterFirst > 0);
  assert.equal(first.blacklisted, true);
  assert.equal(api.isMintFlagged(tracked), true);
  await api.report(tracked);
  assert.equal(calls, afterFirst);

  api.updateSettings({ enabled: false });
  api.cache.clear();
  const other = Keypair.generate().publicKey.toBase58();
  const creator2 = Keypair.generate().publicKey.toBase58();
  const quiet = createSafetyChecks({
    blacklistFile: path.join(dir, 'dev-blacklist.json'),
    launchedFile: path.join(dir, 'launched-mints.json'),
    ttlMs: 60_000,
    minIntervalMs: 0,
    connection: api && {
      async getAccountInfo() { return null; },
      async getTokenSupply() { return { value: { amount: '1000000' } }; },
      async getTokenLargestAccounts() { return { value: [] }; },
      async getTokenAccountsByOwner() { return { value: [] }; }
    },
    async fetchJson() {
      return { score_normalised: 90, rugged: true, risks: [{ name: 'Rugged', level: 'danger' }], creator: creator2 };
    }
  });
  const second = await quiet.report(other);
  assert.equal(second.checks.find(row => row.id === 'rugcheck').status, 'red');
  assert.equal(quiet.listBlacklist().devs.some(row => row.address === creator2), false);

  assert.throws(() => api.removeBlacklist(creator, false), /confirm: true/);
  api.removeBlacklist(creator, true);
  assert.equal(api.listBlacklist().devs.some(row => row.address === creator), false);
});

test('a blacklisted dev blocks buys and does not sell the position', async () => {
  walletManager.setSimulationMode(true);
  tradingEngine.connectPumpPortal = () => {};
  tradingEngine.onMintChange = () => {};
  const mint = Keypair.generate().publicKey.toBase58();
  const address = walletManager.masterWallet.publicKey.toBase58();
  tradingEngine.setActiveToken(mint, [{ address, tokens: 1000, sol: 0.02 }]);
  tradingEngine.safetyBlock = async () => 'Buys blocked: dev Dev111 is blacklisted (Rug history). Existing positions are not sold automatically.';
  await assert.rejects(
    () => tradingEngine.executeBuy({ solAmount: 0.01, walletAddresses: [address] }),
    /Buys blocked/
  );
  assert.equal(tradingEngine.positions.get(address).tokens, 1000);
  tradingEngine.safetyBlock = async () => null;
  const sold = await tradingEngine.executeSell({ pct: 100, walletAddresses: [address] });
  assert.equal(sold.success, true);
  assert.ok(!tradingEngine.positions.get(address) || tradingEngine.positions.get(address).tokens === 0);
});

test('a Token-2022 permanent delegate is reported from the mint account', async () => {
  const mintKey = Keypair.generate().publicKey;
  const dir = tempDir();
  const api = createSafetyChecks({
    blacklistFile: path.join(dir, 'dev-blacklist.json'),
    launchedFile: path.join(dir, 'launched-mints.json'),
    minIntervalMs: 0,
    connection: {
      async getAccountInfo(key) {
        if (key.equals(mintKey)) return token2022Mint(mintKey, { mintAuthority: true, permanentDelegate: true });
        return null;
      },
      async getTokenSupply() { return { value: { amount: '1000' } }; },
      async getTokenLargestAccounts() { return { value: [] }; },
      async getTokenAccountsByOwner() { return { value: [] }; }
    },
    async fetchJson() { throw new Error('offline'); }
  });
  const row = await api.report(mintKey.toBase58());
  const authorities = row.checks.find(item => item.id === 'authorities');
  assert.equal(authorities.status, 'red');
  assert.match(authorities.reason, /permanent delegate/);
  assert.equal(row.checks.find(item => item.id === 'rugcheck').status, 'unknown');
  assert.equal(row.blacklisted, false);
});
