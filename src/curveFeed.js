const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');
const { backoffMs } = require('./subscriptionBook');
const { DEFAULT_GLOBAL, bondingProgress, MIGRATION_DESTINATION } = require('./bondingCurve');

function anchorDiscriminator(label) {
  return crypto.createHash('sha256').update(label).digest().subarray(0, 8);
}

const BONDING_CURVE_DISCRIMINATOR = anchorDiscriminator('account:BondingCurve');
const TRADE_EVENT_DISCRIMINATOR = anchorDiscriminator('event:TradeEvent');

function bondingCurvePda(mint, programId) {
  const mintKey = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const program = programId instanceof PublicKey ? programId : new PublicKey(programId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mintKey.toBuffer()],
    program
  );
  return pda;
}

// Layout after the 8-byte Anchor discriminator, from the published pump IDL:
// virtualToken, virtualSol, realToken, realSol, totalSupply, complete.
function decodeBondingCurve(data) {
  const buf = Buffer.from(data || []);
  if (buf.length < 49) return null;
  if (!buf.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) return null;
  let offset = 8;
  const virtualTokenReserves = buf.readBigUInt64LE(offset); offset += 8;
  const virtualSolReserves = buf.readBigUInt64LE(offset); offset += 8;
  const realTokenReserves = buf.readBigUInt64LE(offset); offset += 8;
  const realSolReserves = buf.readBigUInt64LE(offset); offset += 8;
  const tokenTotalSupply = buf.readBigUInt64LE(offset); offset += 8;
  const complete = buf[offset] === 1;
  const creator = buf.length >= offset + 33 ? new PublicKey(buf.subarray(offset + 1, offset + 33)).toBase58() : null;
  const tokenUi = Number(virtualTokenReserves) / 1e6;
  const solUi = Number(virtualSolReserves) / 1e9;
  const reserves = {
    creator,
    virtualTokenReserves: Number(virtualTokenReserves),
    virtualSolReserves: Number(virtualSolReserves),
    realTokenReserves: Number(realTokenReserves),
    realSolReserves: Number(realSolReserves),
    tokenTotalSupply: Number(tokenTotalSupply),
    complete
  };
  // A graduated curve is left in place with every reserve zeroed. That is still
  // the signal to switch to the PumpSwap pool, not a failed decode.
  if (complete) {
    return { ...reserves, priceSol: null, marketCapSol: null };
  }
  if (!(tokenUi > 0)) return null;
  const priceSol = solUi / tokenUi;
  const supplyUi = Number(tokenTotalSupply) / 1e6;
  return { ...reserves, priceSol, marketCapSol: priceSol * supplyUi };
}

function decodeTradeEvent(encoded) {
  const buf = Buffer.isBuffer(encoded) ? encoded : Buffer.from(String(encoded || ''), 'base64');
  if (buf.length < 8 + 32 + 8 + 8 + 1 + 32 + 8) return null;
  if (!buf.subarray(0, 8).equals(TRADE_EVENT_DISCRIMINATOR)) return null;
  let offset = 8;
  const mint = new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const solAmount = Number(buf.readBigUInt64LE(offset)) / 1e9;
  offset += 8;
  const tokenAmount = Number(buf.readBigUInt64LE(offset)) / 1e6;
  offset += 8;
  const isBuy = buf[offset] === 1;
  offset += 1;
  const user = new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const timestamp = Number(buf.readBigInt64LE(offset));
  offset += 8;
  let virtualSolReserves = null;
  let virtualTokenReserves = null;
  if (buf.length >= offset + 16) {
    virtualSolReserves = Number(buf.readBigUInt64LE(offset));
    offset += 8;
    virtualTokenReserves = Number(buf.readBigUInt64LE(offset));
  }
  let priceSol = null;
  if (virtualSolReserves > 0 && virtualTokenReserves > 0) {
    priceSol = (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6);
  } else if (solAmount > 0 && tokenAmount > 0) {
    priceSol = solAmount / tokenAmount;
  }
  return {
    mint,
    solAmount,
    tokenAmount,
    isBuy,
    user,
    timestamp,
    virtualSolReserves,
    virtualTokenReserves,
    priceSol,
    txType: isBuy ? 'buy' : 'sell'
  };
}

function parseProgramDataLogs(logs) {
  const events = [];
  for (const line of logs || []) {
    if (typeof line !== 'string' || !line.startsWith('Program data: ')) continue;
    const event = decodeTradeEvent(line.slice('Program data: '.length).trim());
    if (event) events.push(event);
  }
  return events;
}

function classifyPumpPortalMessage(payload) {
  if (!payload || typeof payload !== 'object') return { kind: 'ignore' };
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return { kind: 'error', message: payload.message.trim() };
  }
  if (payload.error) return { kind: 'error', message: String(payload.error) };
  if (payload.txType || payload.solAmount) return { kind: 'trade' };
  return { kind: 'ignore' };
}

function pumpPortalFeedEvent(payload) {
  const parsed = classifyPumpPortalMessage(payload);
  if (parsed.kind === 'error') {
    return {
      type: 'FEED_STATUS',
      payload: { channel: 'pumpportal', connected: false, message: parsed.message, label: 'PumpPortal' }
    };
  }
  if (parsed.kind === 'trade') return { type: 'PUBLIC_TRADE', payload };
  return null;
}

class CurveFeed {
  constructor(options = {}) {
    this.connection = options.connection;
    this.programId = options.programId;
    this.isLive = options.isLive || (() => true);
    this.onPrice = options.onPrice || (() => {});
    this.onTrade = options.onTrade || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.fetchMigratedPrice = options.fetchMigratedPrice || (async () => null);
    this.pumpSwap = options.pumpSwap || null;
    this.readGlobal = options.readGlobal || (async () => null);
    this.initialRealTokenRaw = null;
    this.schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.mint = null;
    this.accountSub = null;
    this.logsSub = null;
    this.mintLogsSub = null;
    this.lastEventLog = 0;
    this.stopped = true;
    this.retry = 0;
    this.timer = null;
    this.migratedTimer = null;
    this.seen = new Set();
    this.source = 'Helius bonding curve';
  }

  start() {
    this.stopped = false;
    if (this.accountSub != null) {
      this.emit(true);
      return;
    }
    this.open();
  }

  stop() {
    this.stopped = true;
    this.clearTimer();
    this.stopMigratedPoll();
    this.stopPumpSwap();
    this.dropSubs();
    this.emit(false);
  }

  setMint(mint) {
    const next = mint || null;
    if (next === this.mint && (this.accountSub != null || !next)) return;
    this.dropSubs();
    this.stopMigratedPoll();
    this.stopPumpSwap();
    this.mint = next;
    this.seen.clear();
    if (!this.stopped) this.open();
  }

  open() {
    this.dropSubs();
    if (this.stopped || !this.isLive() || !this.mint || !this.connection) {
      this.emit(false);
      return;
    }
    let pda;
    try {
      pda = bondingCurvePda(this.mint, this.programId);
    } catch (err) {
      this.emit(false, err.message);
      return;
    }
    this.pda = pda;
    this.ensureGlobal();
    this.accountSub = this.connection.onAccountChange(
      pda,
      (info) => this.onAccount(info),
      'processed'
    );
    this.logsSub = this.connection.onLogs(
      pda,
      (logs) => this.onLogs(logs),
      'processed'
    );
    this.mintLogsSub = this.connection.onLogs(
      new PublicKey(this.mint),
      (logs) => this.onLogs(logs),
      'processed'
    );
    this.source = 'Helius bonding curve';
    this.emit(true);
    if (typeof this.connection.getAccountInfo === 'function') {
      this.connection.getAccountInfo(pda, 'confirmed').then((info) => {
        if (info && this.mint) this.onAccount(info);
      }).catch(() => {});
    }
  }

  // One account read, no websocket. Simulation uses this so a pasted mint shows
  // the real curve or pool instead of an empty modeled curve.
  async snapshot(mint) {
    if (!mint || !this.connection || typeof this.connection.getAccountInfo !== 'function') return null;
    let pda;
    try {
      pda = bondingCurvePda(mint, this.programId);
    } catch (err) {
      return null;
    }
    let info = null;
    try {
      info = await this.connection.getAccountInfo(pda, 'confirmed');
    } catch (err) {
      return null;
    }
    const decoded = decodeBondingCurve(info && info.data);
    if (!decoded) return null;
    const tick = { ...this.curveTick(decoded, 'Helius bonding curve'), mint };
    if (decoded.complete && this.pumpSwap && typeof this.pumpSwap.readPrice === 'function') {
      try {
        const pool = await this.pumpSwap.readPrice(mint);
        if (pool && Number(pool.priceSol) > 0) {
          tick.priceSol = pool.priceSol;
          tick.marketCapSol = pool.marketCapSol;
          tick.realSol = Number(pool.realSol) || tick.realSol;
          tick.poolBaseRaw = Number(pool.baseRaw) || 0;
          tick.poolQuoteRaw = Number(pool.quoteRaw) || 0;
          tick.progressPct = 100;
          tick.complete = true;
          tick.source = 'Helius PumpSwap pool';
        }
      } catch (err) { /* the completed curve tick still tells the desk it graduated */ }
    }
    this.onPrice(tick);
    return tick;
  }

  dropSubs() {
    if (this.accountSub != null && this.connection && this.connection.removeAccountChangeListener) {
      try { this.connection.removeAccountChangeListener(this.accountSub); } catch (err) { /* already removed */ }
    }
    if (this.logsSub != null && this.connection && this.connection.removeOnLogsListener) {
      try { this.connection.removeOnLogsListener(this.logsSub); } catch (err) { /* already removed */ }
    }
    if (this.mintLogsSub != null && this.connection && this.connection.removeOnLogsListener) {
      try { this.connection.removeOnLogsListener(this.mintLogsSub); } catch (err) { /* already removed */ }
    }
    this.accountSub = null;
    this.logsSub = null;
    this.mintLogsSub = null;
  }

  async ensureGlobal() {
    if (this.initialRealTokenRaw) return;
    try {
      const global = await this.readGlobal();
      if (global && global.initialRealTokenReserves) this.initialRealTokenRaw = global.initialRealTokenReserves;
    } catch (err) { /* default stays in place */ }
  }

  curveTick(decoded, source) {
    const initial = this.initialRealTokenRaw || DEFAULT_GLOBAL.initialRealTokenReserves;
    const complete = Boolean(decoded.complete);
    return {
      mint: this.mint,
      priceSol: decoded.priceSol,
      marketCapSol: decoded.marketCapSol,
      realSol: Number(decoded.realSolReserves) / 1e9,
      virtualSolReserves: Number(decoded.virtualSolReserves) || 0,
      virtualTokenReserves: Number(decoded.virtualTokenReserves) || 0,
      progressPct: bondingProgress(decoded.realTokenReserves, initial, complete),
      complete,
      destination: MIGRATION_DESTINATION,
      source,
      simulated: false
    };
  }

  onAccount(info) {
    const decoded = decodeBondingCurve(info && info.data);
    if (!decoded || !this.mint) return;
    if (decoded.complete) {
      if (this.pumpSwap && this.pumpSwap.running && this.pumpSwap.mint === this.mint) return;
      this.onPrice(this.curveTick(decoded, 'Helius bonding curve'));
      this.startPumpSwap();
      return;
    }
    this.stopMigratedPoll();
    this.stopPumpSwap();
    this.source = 'Helius bonding curve';
    this.emit(true);
    this.onPrice(this.curveTick(decoded, this.source));
  }

  onLogs(logs) {
    const signature = logs && logs.signature;
    if (signature && this.seen.has(signature)) return;
    const events = parseProgramDataLogs(logs && logs.logs);
    if (events.length && Date.now() - this.lastEventLog > 2000) {
      const sample = events[0];
      console.log(`[CurveFeed] ${sample.txType} ${sample.solAmount} SOL / ${sample.tokenAmount} tokens ${signature || ''} mint ${sample.mint}`);
      this.lastEventLog = Date.now();
    }
    for (const event of events) {
      if (this.mint && event.mint !== this.mint) continue;
      if (signature) this.seen.add(signature);
      this.onTrade({
        ...event,
        signature: signature || '',
        source: 'Helius bonding curve',
        simulated: false,
        traderPublicKey: event.user,
        timestamp: event.timestamp > 1e12 ? event.timestamp : event.timestamp * 1000
      });
    }
  }

  async startPumpSwap() {
    const mint = this.mint;
    if (!mint || this.stopped) return;
    if (!this.pumpSwap) {
      this.source = 'DexScreener fallback';
      this.emit(true, 'PumpSwap feed is not configured');
      this.startMigratedPoll();
      return;
    }
    this.stopMigratedPoll();
    this.pumpSwap.onFallback = () => {
      if (this.stopped || this.mint !== mint) return;
      this.source = 'DexScreener fallback';
      this.emit(false, 'PumpSwap websocket stalled');
      this.startMigratedPoll();
    };
    this.pumpSwap.onRecover = () => {
      if (this.stopped || this.mint !== mint || !this.pumpSwap.running) return;
      this.stopMigratedPoll();
      this.source = 'Helius PumpSwap pool';
      this.emit(true);
    };
    const ok = await this.pumpSwap.start(mint);
    if (this.stopped || this.mint !== mint) return;
    if (!ok) {
      this.source = 'DexScreener fallback';
      this.emit(true, 'PumpSwap pool not found');
      this.startMigratedPoll();
      return;
    }
    this.source = 'Helius PumpSwap pool';
    this.emit(true);
  }

  stopPumpSwap() {
    if (this.pumpSwap && this.pumpSwap.running) this.pumpSwap.stop();
  }

  startMigratedPoll() {
    if (this.migratedTimer || this.stopped) return;
    const tick = async () => {
      if (this.stopped || !this.mint) return;
      try {
        const price = await this.fetchMigratedPrice(this.mint);
        const row = price && typeof price === 'object' ? price : { priceSol: Number(price) };
        if (row && Number(row.priceSol) > 0) {
          this.onPrice({
            mint: this.mint,
            priceSol: Number(row.priceSol),
            marketCapSol: Number(row.marketCapSol) > 0 ? Number(row.marketCapSol) : null,
            solUsd: Number(row.solUsd) > 0 ? Number(row.solUsd) : null,
            source: 'DexScreener fallback',
            progressPct: 100,
            complete: true,
            destination: MIGRATION_DESTINATION,
            simulated: false,
            complete: true
          });
        }
      } catch (err) { /* next poll retries */ }
    };
    tick();
    this.migratedTimer = setInterval(tick, 2000);
  }

  stopMigratedPoll() {
    if (this.migratedTimer) {
      clearInterval(this.migratedTimer);
      this.migratedTimer = null;
    }
  }

  handleClose() {
    this.emit(false);
    if (this.stopped || !this.isLive()) return;
    this.clearTimer();
    const delay = backoffMs(this.retry);
    this.retry += 1;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.dropSubs();
      this.open();
    }, delay);
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  emit(connected, message) {
    this.onStatus({
      channel: 'chart',
      connected: Boolean(connected) && !this.stopped,
      label: this.source,
      mint: this.mint,
      message: message || null
    });
  }
}

module.exports = {
  BONDING_CURVE_DISCRIMINATOR,
  TRADE_EVENT_DISCRIMINATOR,
  bondingCurvePda,
  decodeBondingCurve,
  decodeTradeEvent,
  parseProgramDataLogs,
  classifyPumpPortalMessage,
  pumpPortalFeedEvent,
  CurveFeed
};
