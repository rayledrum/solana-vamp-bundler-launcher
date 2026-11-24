const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');
const { backoffMs } = require('./subscriptionBook');

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
  const tokenUi = Number(virtualTokenReserves) / 1e6;
  const solUi = Number(virtualSolReserves) / 1e9;
  if (!(tokenUi > 0)) return null;
  const priceSol = solUi / tokenUi;
  const supplyUi = Number(tokenTotalSupply) / 1e6;
  return {
    virtualTokenReserves: Number(virtualTokenReserves),
    virtualSolReserves: Number(virtualSolReserves),
    realTokenReserves: Number(realTokenReserves),
    realSolReserves: Number(realSolReserves),
    tokenTotalSupply: Number(tokenTotalSupply),
    complete,
    priceSol,
    marketCapSol: priceSol * supplyUi
  };
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
    this.schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.mint = null;
    this.accountSub = null;
    this.logsSub = null;
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
    this.dropSubs();
    this.emit(false);
  }

  setMint(mint) {
    const next = mint || null;
    if (next === this.mint && (this.accountSub != null || !next)) return;
    this.dropSubs();
    this.stopMigratedPoll();
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
    this.source = 'Helius bonding curve';
    this.emit(true);
    if (typeof this.connection.getAccountInfo === 'function') {
      this.connection.getAccountInfo(pda, 'confirmed').then((info) => {
        if (info && this.mint) this.onAccount(info);
      }).catch(() => {});
    }
  }

  dropSubs() {
    if (this.accountSub != null && this.connection && this.connection.removeAccountChangeListener) {
      try { this.connection.removeAccountChangeListener(this.accountSub); } catch (err) { /* already removed */ }
    }
    if (this.logsSub != null && this.connection && this.connection.removeOnLogsListener) {
      try { this.connection.removeOnLogsListener(this.logsSub); } catch (err) { /* already removed */ }
    }
    this.accountSub = null;
    this.logsSub = null;
  }

  onAccount(info) {
    const decoded = decodeBondingCurve(info && info.data);
    if (!decoded || !this.mint) return;
    if (decoded.complete) {
      this.source = 'DexScreener migrated pool';
      this.startMigratedPoll();
      this.emit(true);
      return;
    }
    this.stopMigratedPoll();
    this.source = 'Helius bonding curve';
    this.emit(true);
    this.onPrice({
      mint: this.mint,
      priceSol: decoded.priceSol,
      marketCapSol: decoded.marketCapSol,
      source: this.source,
      simulated: false,
      complete: false
    });
  }

  onLogs(logs) {
    const signature = logs && logs.signature;
    if (signature && this.seen.has(signature)) return;
    const events = parseProgramDataLogs(logs && logs.logs);
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

  startMigratedPoll() {
    if (this.migratedTimer || this.stopped) return;
    const tick = async () => {
      if (this.stopped || !this.mint) return;
      try {
        const price = await this.fetchMigratedPrice(this.mint);
        if (price && Number(price) > 0) {
          this.onPrice({
            mint: this.mint,
            priceSol: Number(price),
            marketCapSol: null,
            source: 'DexScreener migrated pool',
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
