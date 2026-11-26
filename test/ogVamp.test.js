const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const { classifyOrigin, createOriginLookup, imageKey } = require('../src/research/origin');
const { createSafetyChecks } = require('../src/safetyChecks');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/og-vamp.json'), 'utf8'));

test('the earliest matching coin is the OG and later copies are numbered vamps', () => {
  const { subject, og, later } = fixture;
  const asVamp = classifyOrigin(subject, [og, later, subject]);
  assert.equal(asVamp.status, 'vamp');
  assert.equal(asVamp.label, 'VAMP of elonmas (#1 of 2)');
  assert.equal(asVamp.og.mint, og.mint);
  assert.equal(asVamp.og.graduated, true);
  assert.equal(asVamp.og.peakMcapUsd, 358620);
  assert.equal(asVamp.delta, '0m later');
  assert.equal(asVamp.ogDevBuying, true);
  assert.match(asVamp.reason, /OgMint/);
  assert.match(asVamp.reason, /OG graduated/);
  assert.match(asVamp.reason, /OG peak \$358620/);

  const asOg = classifyOrigin(og, [subject, later]);
  assert.equal(asOg.status, 'og');
  assert.equal(asOg.label, 'OG (2 vamps)');

  const alone = classifyOrigin(og, []);
  assert.equal(alone.status, 'og');
  assert.equal(alone.label, 'OG');
  assert.equal(alone.vamps, 0);
});

test('image CIDs and socials match across gateways, and a missing clock stays unknown', () => {
  assert.equal(
    imageKey('https://ipfs.io/ipfs/Qm11111111111111111111111111111111111111111111'),
    imageKey('https://gateway.ipfs.io/ipfs/Qm11111111111111111111111111111111111111111111')
  );
  const { subject, og } = fixture;
  const imageOnly = classifyOrigin(
    { mint: subject.mint, image: subject.image, createdAt: 5000 },
    [{ mint: og.mint, image: og.image, createdAt: 1000, name: 'Different', symbol: 'DIFF' }]
  );
  const hashed = classifyOrigin(
    { mint: 'HashVamp', imageHash: 'abc', createdAt: 4000 },
    [{ mint: 'HashOg', imageHash: 'abc', name: 'Hashed', createdAt: 1000 }]
  );
  assert.equal(hashed.status, 'vamp');
  assert.equal(imageOnly.status, 'vamp');
  assert.match(imageOnly.label, /VAMP of Different/);

  const socialOnly = classifyOrigin(
    { mint: 'SocialVamp', twitter: '@elonmas', createdAt: 9000 },
    [{ mint: og.mint, twitter: 'https://twitter.com/elonmas', createdAt: 1000, name: 'elonmas' }]
  );
  assert.equal(socialOnly.status, 'vamp');

  const noClock = classifyOrigin(
    { mint: subject.mint, name: subject.name },
    [{ mint: og.mint, name: og.name }]
  );
  assert.equal(noClock.status, 'unknown');
  assert.match(noClock.reason, /creation time/);

  const unrelated = classifyOrigin(
    { mint: 'Other', name: 'Coin', symbol: 'SOL', createdAt: 1 },
    [{ mint: og.mint, name: 'elonmas', symbol: 'ELON', createdAt: 2 }]
  );
  assert.equal(unrelated.status, 'og');
});

test('a failed lookalike search is unknown and a successful search is cached', async () => {
  let calls = 0;
  const failing = createOriginLookup({
    ttlMs: 60_000,
    async fetchJson() {
      calls += 1;
      throw new Error('HTTP 500 from api.dexscreener.com');
    }
  });
  const first = await failing.get('MintA');
  assert.equal(first.status, 'unknown');
  assert.match(first.reason, /not read|failed|no pair/i);
  const used = calls;
  const second = await failing.get('MintA');
  assert.equal(second.status, 'unknown');
  assert.equal(calls, used);

  const { subject, og } = fixture;
  const pair = (coin, dexId) => ({
    baseToken: { address: coin.mint, name: coin.name, symbol: coin.symbol },
    info: { imageUrl: coin.image, socials: [{ type: 'twitter', url: coin.twitter }] },
    pairCreatedAt: coin.createdAt,
    dexId,
    peakMcapUsd: coin.peakMcapUsd,
    creator: coin.creator || null
  });
  let searches = 0;
  const lookup = createOriginLookup({
    ttlMs: 60_000,
    readTrades: () => subject.trades,
    async fetchJson(url) {
      searches += 1;
      if (url.includes('/tokens/')) return { pairs: [pair(subject, 'pumpfun')] };
      if (url.includes('/search')) return { pairs: [pair(subject, 'pumpfun'), pair(og, 'pumpswap')] };
      if (url.includes('rugcheck')) return { creator: og.creator };
      throw new Error(`unexpected ${url}`);
    }
  });
  const found = await lookup.get(subject.mint);
  assert.equal(found.status, 'vamp');
  assert.equal(found.label, 'VAMP of elonmas (#1 of 1)');
  assert.equal(found.og.graduated, true);
  assert.equal(found.og.peakMcapUsd, 358620);
  assert.equal(found.ogDevBuying, true);
  const after = searches;
  await lookup.get(subject.mint);
  assert.equal(searches, after);
});

test('a Pump coin fallback supplies the identity when the token endpoint has no pair', async () => {
  const { subject, og } = fixture;
  const lookup = createOriginLookup({
    ttlMs: 0,
    readTrades: () => null,
    async fetchJson(url) {
      if (url.includes('/tokens/')) throw new Error('HTTP 404 from api.dexscreener.com');
      if (url.includes('/coins/')) {
        return {
          mint: subject.mint,
          name: subject.name,
          symbol: subject.symbol,
          image_uri: subject.image,
          twitter: subject.twitter,
          created_timestamp: subject.createdAt,
          complete: false,
          ath_market_cap: null
        };
      }
      if (url.includes('/search')) {
        return {
          pairs: [
            {
              baseToken: { address: og.mint, name: og.name, symbol: og.symbol },
              info: { imageUrl: og.image },
              pairCreatedAt: og.createdAt,
              dexId: 'pumpswap',
              athMarketCap: og.peakMcapUsd
            },
            {
              baseToken: { address: subject.mint, name: subject.name, symbol: subject.symbol },
              info: { imageUrl: subject.image },
              pairCreatedAt: subject.createdAt,
              dexId: 'pumpfun'
            }
          ]
        };
      }
      throw new Error(`unexpected ${url}`);
    }
  });
  const found = await lookup.get(subject.mint);
  assert.equal(found.status, 'vamp');
  assert.equal(found.og.mint, og.mint);
  assert.equal(found.og.peakMcapUsd, 358620);
  assert.equal(found.ogDevBuying, null);
});

test('the safety row stays unknown unless a lookup returns a real verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-safety-'));
  const mint = Keypair.generate().publicKey.toBase58();
  const connection = {
    async getAccountInfo() { return null; },
    async getTokenSupply() { return { value: { amount: '1' } }; },
    async getTokenLargestAccounts() { return { value: [] }; },
    async getTokenAccountsByOwner() { return { value: [] }; }
  };
  const quiet = createSafetyChecks({
    blacklistFile: path.join(dir, 'dev-blacklist.json'),
    launchedFile: path.join(dir, 'launched-mints.json'),
    minIntervalMs: 0,
    connection,
    async fetchJson() { throw new Error('offline'); }
  });
  const unknown = await quiet.report(mint);
  const unknownRow = unknown.checks.find(row => row.id === 'origin');
  assert.equal(unknownRow.status, 'unknown');

  const told = createSafetyChecks({
    blacklistFile: path.join(dir, 'dev-blacklist.json'),
    launchedFile: path.join(dir, 'launched-mints.json'),
    minIntervalMs: 0,
    connection,
    async fetchJson() { throw new Error('offline'); },
    originLookup: async () => classifyOrigin(fixture.subject, [fixture.og])
  });
  const report = await told.report(mint);
  const row = report.checks.find(item => item.id === 'origin');
  assert.equal(row.status, 'red');
  assert.match(row.reason, /VAMP of elonmas/);
  assert.match(row.reason, /OG dev is buying this vamp/);
});
