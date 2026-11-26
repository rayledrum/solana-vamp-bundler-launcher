const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');
const config = require('./config');

// On-chain PumpSwap program. Confirmed executable, and named in its IDL.
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const POOL_DISCRIMINATOR = crypto.createHash('sha256').update('account:Pool').digest().subarray(0, 8);
const BUY_EVENT_DISCRIMINATOR = crypto.createHash('sha256').update('event:BuyEvent').digest().subarray(0, 8);
const SELL_EVENT_DISCRIMINATOR = crypto.createHash('sha256').update('event:SellEvent').digest().subarray(0, 8);
const SOURCE = 'Helius PumpSwap pool';

function poolAuthorityPda(mint, programId = config.PUMP_PROGRAM_ID) {
  const mintKey = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool-authority'), mintKey.toBuffer()],
    programId
  );
  return pda;
}

// migrate / migrate_v2: ["pool", index u16 = 0, pool_authority, base_mint, quote_mint]
function canonicalPoolPda(mint, programId = PUMP_AMM_PROGRAM_ID) {
  const mintKey = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const index = Buffer.alloc(2);
  index.writeUInt16LE(0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), index, poolAuthorityPda(mintKey).toBuffer(), mintKey.toBuffer(), WSOL_MINT.toBuffer()],
    programId
  );
  return pda;
}

function readPubkey(buf, offset) {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
}

function decodePool(data) {
  const buf = Buffer.from(data || []);
  if (buf.length < 8 + 1 + 2 + 32 * 6 + 8) return null;
  if (!buf.subarray(0, 8).equals(POOL_DISCRIMINATOR)) return null;
  let offset = 8;
  const poolBump = buf[offset]; offset += 1;
  const index = buf.readUInt16LE(offset); offset += 2;
  const creator = readPubkey(buf, offset); offset += 32;
  const baseMint = readPubkey(buf, offset); offset += 32;
  const quoteMint = readPubkey(buf, offset); offset += 32;
  offset += 32; // lp mint
  const baseVault = readPubkey(buf, offset); offset += 32;
  const quoteVault = readPubkey(buf, offset);
  return { poolBump, index, creator, baseMint, quoteMint, baseVault, quoteVault };
}

function tokenAmount(data) {
  const buf = Buffer.from(data || []);
  if (buf.length < 72) return null;
  return buf.readBigUInt64LE(64);
}

function priceFromReserves({ baseRaw, quoteRaw, baseDecimals = 6, quoteDecimals = 9 }) {
  const base = Number(baseRaw) / (10 ** baseDecimals);
  const quote = Number(quoteRaw) / (10 ** quoteDecimals);
  if (!(base > 0) || !(quote >= 0)) return null;
  return quote / base;
}

// BuyEvent and SellEvent share the reserve prefix. The string field is later and is ignored.
function decodeSwapEvent(encoded) {
  const buf = Buffer.isBuffer(encoded) ? encoded : Buffer.from(String(encoded || ''), 'base64');
  if (buf.length < 184) return null;
  const disc = buf.subarray(0, 8);
  let txType = null;
  if (disc.equals(BUY_EVENT_DISCRIMINATOR)) txType = 'buy';
  else if (disc.equals(SELL_EVENT_DISCRIMINATOR)) txType = 'sell';
  else return null;
  const baseRaw = buf.readBigUInt64LE(16);
  const poolBaseRaw = buf.readBigUInt64LE(48);
  const poolQuoteRaw = buf.readBigUInt64LE(56);
  const quoteRaw = buf.readBigUInt64LE(64);
  const user = readPubkey(buf, 152);
  return { txType, baseRaw, quoteRaw, poolBaseRaw, poolQuoteRaw, user };
}

function swapToTrade(event, { mint, signature, supplyUi, baseDecimals = 6 }) {
  const tokenAmountUi = Number(event.baseRaw) / (10 ** baseDecimals);
  const solAmount = Number(event.quoteRaw) / 1e9;
  const priceSol = priceFromReserves({
    baseRaw: event.poolBaseRaw,
    quoteRaw: event.poolQuoteRaw,
    baseDecimals
  });
  const supply = Number(supplyUi) > 0 ? Number(supplyUi) : 1_000_000_000;
  return {
    txType: event.txType,
    solAmount,
    tokenAmount: tokenAmountUi,
    priceSol,
    marketCapSol: priceSol ? priceSol * supply : null,
    realSol: Number(event.poolQuoteRaw) / 1e9,
    user: event.user,
    traderPublicKey: event.user,
    signature: signature || '',
    mint,
    simulated: false,
    source: SOURCE,
    complete: true,
    progressPct: 100,
    timestamp: Date.now()
  };
}

class PumpSwapFeed {
  constructor(options = {}) {
    this.connection = options.connection;
    this.isLive = options.isLive || (() => true);
    this.onPrice = options.onPrice || (() => {});
    this.onTrade = options.onTrade || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.onFallback = options.onFallback || (() => {});
    this.onRecover = options.onRecover || (() => {});
    this.supplyUi = options.supplyUi || (async () => 1_000_000_000);
    this.schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.stallMs = options.stallMs || 20000;
    this.baseDecimals = 6;
    this.mint = null;
    this.pool = null;
    this.baseRaw = null;
    this.quoteRaw = null;
    this.subs = [];
    this.running = false;
    this.seen = new Set();
    this.watchdog = null;
    this.lastEventAt = 0;
    this.supply = 1_000_000_000;
  }

  async readPrice(mint) {
    if (!this.connection || !mint || typeof this.connection.getAccountInfo !== 'function') return null;
    const poolKey = canonicalPoolPda(mint);
    const poolInfo = await this.connection.getAccountInfo(poolKey, 'confirmed');
    const decoded = decodePool(poolInfo && poolInfo.data);
    if (!decoded || decoded.baseMint !== String(mint) || decoded.quoteMint !== WSOL_MINT.toBase58()) return null;
    let supply = this.supply || 1_000_000_000;
    try {
      const value = await this.supplyUi(mint);
      if (Number(value) > 0) supply = Number(value);
    } catch (err) { /* default supply */ }
    if (typeof this.connection.getMultipleAccountsInfo !== 'function') return null;
    const infos = await this.connection.getMultipleAccountsInfo([
      new PublicKey(decoded.baseVault),
      new PublicKey(decoded.quoteVault)
    ], 'confirmed');
    const baseRaw = tokenAmount(infos && infos[0] && infos[0].data);
    const quoteRaw = tokenAmount(infos && infos[1] && infos[1].data);
    const priceSol = priceFromReserves({ baseRaw, quoteRaw, baseDecimals: this.baseDecimals });
    if (!(priceSol > 0)) return null;
    return {
      priceSol,
      marketCapSol: priceSol * supply,
      realSol: Number(quoteRaw) / 1e9,
      baseRaw: Number(baseRaw),
      quoteRaw: Number(quoteRaw),
      complete: true,
      progressPct: 100
    };
  }

  async start(mint) {
    this.stop();
    this.mint = mint;
    this.running = true;
    if (!this.connection || !mint) return false;
    let poolInfo = null;
    try {
      const poolKey = canonicalPoolPda(mint);
      poolInfo = await this.connection.getAccountInfo(poolKey, 'confirmed');
      this.poolAddress = poolKey;
    } catch (err) {
      this.fail('PumpSwap pool lookup failed');
      return false;
    }
    const decoded = decodePool(poolInfo && poolInfo.data);
    if (!decoded || decoded.baseMint !== String(mint) || decoded.quoteMint !== WSOL_MINT.toBase58()) {
      this.fail('PumpSwap pool not found');
      return false;
    }
    this.pool = decoded;
    try {
      const supply = await this.supplyUi(mint);
      if (Number(supply) > 0) this.supply = Number(supply);
    } catch (err) { /* default supply */ }
    this.subscribe();
    await this.snapshot();
    this.armWatchdog();
    this.emitStatus(true);
    return this.running;
  }

  stop() {
    this.running = false;
    this.clearWatchdog();
    this.subs.forEach(row => {
      try {
        if (row.kind === 'logs' && this.connection.removeOnLogsListener) this.connection.removeOnLogsListener(row.id);
        if (row.kind === 'account' && this.connection.removeAccountChangeListener) this.connection.removeAccountChangeListener(row.id);
      } catch (err) { /* already removed */ }
    });
    this.subs = [];
    this.pool = null;
    this.baseRaw = null;
    this.quoteRaw = null;
    this.seen.clear();
  }

  subscribe() {
    if (!this.connection || typeof this.connection.onAccountChange !== 'function') return;
    const watch = (address, side) => {
      const id = this.connection.onAccountChange(new PublicKey(address), (info) => {
        const raw = tokenAmount(info && info.data);
        if (raw == null) return;
        if (side === 'base') this.baseRaw = raw;
        else this.quoteRaw = raw;
        this.touch();
        this.publishPrice();
      }, 'processed');
      this.subs.push({ kind: 'account', id });
    };
    watch(this.pool.baseVault, 'base');
    watch(this.pool.quoteVault, 'quote');
    if (typeof this.connection.onLogs === 'function' && this.poolAddress) {
      const id = this.connection.onLogs(this.poolAddress, (logs) => this.onLogs(logs), 'processed');
      this.subs.push({ kind: 'logs', id });
    }
  }

  async snapshot() {
    if (!this.connection || typeof this.connection.getMultipleAccountsInfo !== 'function' || !this.pool) return;
    const infos = await this.connection.getMultipleAccountsInfo([
      new PublicKey(this.pool.baseVault),
      new PublicKey(this.pool.quoteVault)
    ], 'confirmed');
    this.baseRaw = tokenAmount(infos && infos[0] && infos[0].data);
    this.quoteRaw = tokenAmount(infos && infos[1] && infos[1].data);
    this.touch();
    this.publishPrice();
  }

  publishPrice() {
    if (!this.running || this.baseRaw == null || this.quoteRaw == null) return;
    const priceSol = priceFromReserves({ baseRaw: this.baseRaw, quoteRaw: this.quoteRaw, baseDecimals: this.baseDecimals });
    if (!(priceSol > 0)) return;
    this.onPrice({
      mint: this.mint,
      priceSol,
      marketCapSol: priceSol * this.supply,
      realSol: Number(this.quoteRaw) / 1e9,
      poolBaseRaw: Number(this.baseRaw),
      poolQuoteRaw: Number(this.quoteRaw),
      progressPct: 100,
      complete: true,
      source: SOURCE,
      simulated: false
    });
  }

  onLogs(logs) {
    if (!this.running) return;
    const signature = logs && logs.signature;
    if (signature && this.seen.has(signature)) return;
    let emitted = false;
    for (const line of (logs && logs.logs) || []) {
      if (typeof line !== 'string' || !line.startsWith('Program data: ')) continue;
      const event = decodeSwapEvent(line.slice('Program data: '.length).trim());
      if (!event) continue;
      if (signature) this.seen.add(signature);
      const trade = swapToTrade(event, { mint: this.mint, signature, supplyUi: this.supply, baseDecimals: this.baseDecimals });
      this.onTrade(trade);
      if (trade.priceSol > 0) {
        this.onPrice({
          mint: this.mint,
          priceSol: trade.priceSol,
          marketCapSol: trade.marketCapSol,
          realSol: trade.realSol,
          progressPct: 100,
          complete: true,
          source: SOURCE,
          simulated: false
        });
      }
      emitted = true;
    }
    if (emitted) this.touch();
  }

  touch() {
    this.lastEventAt = Date.now();
    this.onRecover();
    this.armWatchdog();
  }

  armWatchdog() {
    this.clearWatchdog();
    if (!this.running) return;
    this.watchdog = this.schedule(() => {
      this.watchdog = null;
      if (!this.running) return;
      this.emitStatus(false, 'PumpSwap websocket stalled');
      this.onFallback();
    }, this.stallMs);
  }

  clearWatchdog() {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  fail(message) {
    this.running = false;
    this.emitStatus(false, message);
  }

  emitStatus(connected, message) {
    this.onStatus({
      channel: 'chart',
      connected: Boolean(connected) && this.running,
      label: SOURCE,
      mint: this.mint,
      message: message || null
    });
  }
}

module.exports = {
  PUMP_AMM_PROGRAM_ID,
  WSOL_MINT,
  POOL_DISCRIMINATOR,
  BUY_EVENT_DISCRIMINATOR,
  SELL_EVENT_DISCRIMINATOR,
  SOURCE,
  poolAuthorityPda,
  canonicalPoolPda,
  decodePool,
  tokenAmount,
  priceFromReserves,
  decodeSwapEvent,
  swapToTrade,
  PumpSwapFeed
};
