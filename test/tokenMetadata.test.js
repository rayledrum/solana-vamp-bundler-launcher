const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ExtensionType, ACCOUNT_SIZE, AccountType } = require('@solana/spl-token');
const { pack } = require('@solana/spl-token-metadata');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `metadata-wallets-${process.pid}.json`);
const walletManager = require('../src/walletManager');
const tradingEngine = require('../src/tradingEngine');
const pumpfun = require('../src/pumpfun');
const {
  decodeToken2022Metadata,
  decodeMetaplexMetadata,
  readMintMetadata
} = require('../src/tokenMetadata');

const MINT = 'F9CwhBgSsEJuCigbodtUH257EqQpRSzKLKwHPPKNpump';

function token2022Mint(mint, meta) {
  const packed = Buffer.from(pack({
    mint: new PublicKey(mint),
    name: meta.name,
    symbol: meta.symbol,
    uri: meta.uri || 'https://example.com/meta.json',
    additionalMetadata: []
  }));
  const tlv = Buffer.alloc(4 + packed.length);
  tlv.writeUInt16LE(ExtensionType.TokenMetadata, 0);
  tlv.writeUInt16LE(packed.length, 2);
  packed.copy(tlv, 4);
  const data = Buffer.alloc(ACCOUNT_SIZE + 1 + tlv.length);
  data.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  data[44] = 6;
  data[45] = 1;
  data[ACCOUNT_SIZE] = AccountType.Mint;
  tlv.copy(data, ACCOUNT_SIZE + 1);
  return { owner: TOKEN_2022_PROGRAM_ID, data };
}

function metaplexAccount(name, symbol) {
  const nameBuf = Buffer.from(name);
  const symbolBuf = Buffer.from(symbol);
  const uriBuf = Buffer.from('https://example.com/m.json');
  const data = Buffer.alloc(1 + 64 + 4 + nameBuf.length + 4 + symbolBuf.length + 4 + uriBuf.length);
  data[0] = 4;
  let offset = 1 + 64;
  data.writeUInt32LE(nameBuf.length, offset); offset += 4;
  nameBuf.copy(data, offset); offset += nameBuf.length;
  data.writeUInt32LE(symbolBuf.length, offset); offset += 4;
  symbolBuf.copy(data, offset); offset += symbolBuf.length;
  data.writeUInt32LE(uriBuf.length, offset); offset += 4;
  uriBuf.copy(data, offset);
  return { data };
}

test('Token-2022 metadata is read from the mint, with Metaplex as the fallback', async () => {
  const mint = Keypair.generate().publicKey;
  const embedded = decodeToken2022Metadata(token2022Mint(mint, { name: 'Grad Coin', symbol: 'GRAD' }), mint);
  assert.equal(embedded.symbol, 'GRAD');
  assert.equal(embedded.name, 'Grad Coin');
  assert.equal(embedded.source, 'token-2022');

  const classic = Keypair.generate().publicKey;
  const meta = metaplexAccount('Classic Coin', 'CLAS');
  const read = await readMintMetadata({
    async getAccountInfo(key) {
      if (key.equals(classic)) return { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82) };
      return meta;
    }
  }, classic);
  assert.equal(read.symbol, 'CLAS');
  assert.equal(read.name, 'Classic Coin');
  assert.equal(read.source, 'metaplex');
  assert.equal(decodeMetaplexMetadata(Buffer.alloc(10)), null);
});

test('pump candles keep the on-chain name instead of leaving the header blank', async () => {
  const originalPump = pumpfun.getPumpChartCandles;
  const originalDex = pumpfun.getTokenDexInfo;
  const originalLookup = pumpfun.lookupMintMetadata;
  pumpfun.getTokenDexInfo = async () => null;
  pumpfun.getPumpChartCandles = async () => ({
    candles: [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 }],
    priceNative: 0.00001,
    source: 'pump',
    servedRes: '1m'
  });
  pumpfun.lookupMintMetadata = async () => ({ name: 'Graduated Coin', symbol: 'GRAD' });
  try {
    const data = await pumpfun.getChartCandles(MINT, '1m');
    assert.equal(data.source, 'pump');
    assert.equal(data.symbol, 'GRAD');
    assert.equal(data.name, 'Graduated Coin');
    assert.ok(data.candles.length > 0);
  } finally {
    pumpfun.getPumpChartCandles = originalPump;
    pumpfun.getTokenDexInfo = originalDex;
    pumpfun.lookupMintMetadata = originalLookup;
  }
});

test('simulation stats use one chain snapshot instead of an empty modeled curve', async () => {
  walletManager.setSimulationMode(true);
  tradingEngine.connectPumpPortal = () => {};
  tradingEngine.onMintChange = () => {};
  const originalDex = pumpfun.getTokenDexInfo;
  pumpfun.getTokenDexInfo = async () => null;
  let calls = 0;
  tradingEngine.onChainSnapshot = async (mint) => {
    calls += 1;
    tradingEngine.noteCurve({
      mint,
      simulated: false,
      complete: true,
      progressPct: 100,
      realSol: 12.5,
      priceSol: 0.00002,
      marketCapSol: 20000,
      destination: 'PumpSwap',
      source: 'Helius PumpSwap pool'
    });
  };
  try {
    tradingEngine.setActiveToken(MINT);
    tradingEngine.simRealSol = 0;
    const stats = await tradingEngine.getLiveStats();
    assert.equal(calls, 1);
    assert.equal(stats.curveComplete, true);
    assert.equal(stats.curveProgressPct, 100);
    assert.equal(stats.curveRealSol, 12.5);
    assert.equal(stats.curveMarketCapSol, 20000);
    assert.equal(stats.curvePriceSol, 0.00002);
    const again = await tradingEngine.getLiveStats();
    assert.equal(calls, 1);
    assert.equal(again.curveProgressPct, 100);
    tradingEngine.snapshotAt = Date.now() - tradingEngine.snapshotTtlMs - 1;
    const refreshed = await tradingEngine.getLiveStats();
    assert.equal(calls, 2);
    assert.equal(refreshed.curveProgressPct, 100);
  } finally {
    pumpfun.getTokenDexInfo = originalDex;
    tradingEngine.onChainSnapshot = null;
    tradingEngine.snapshotMint = null;
    tradingEngine.snapshotPromise = null;
  }
});
