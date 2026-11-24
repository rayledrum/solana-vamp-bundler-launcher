const walletManager = require('./walletManager');
const pumpfun = require('./pumpfun');
const config = require('./config');
const {
  readOwnerTokenBalance,
  solSpentFromMeta,
  tokenChangeFromMeta,
  accountKeysFromTransaction,
  noTokensMessage
} = require('./tokenAccounts');
const WebSocket = require('ws');
const {
  requireSolTradeAmount,
  requireSellPct,
  requireBumperInterval,
  ValidationError
} = require('./validation');
const { fetchSingleVersionedTx, sendAndConfirmVersioned } = require('./portalTx');
const { emptyBook, applyBuy, applySell, quotePosition, priceFromTrade, knownTradeFeeSol } = require('./pnl');
const { pumpPortalFeedEvent } = require('./curveFeed');
const { curveState, MIGRATION_DESTINATION } = require('./bondingCurve');
const { createRoundTripStrategy, readBumpLimits } = require('./volumeStrategy');

class TradingEngine {
  constructor() {
    this.activeToken = null;
    this.positions = new Map();
    this.isBumping = false;
    this.bumpInterval = null;
    this.wsBroadcaster = null;
    this.pumpWs = null;
    this.simTicker = null;
    this.pumpRetry = 0;
    this.pumpRetryTimer = null;
    this.pumpMint = null;
    this.sessionSpentSol = 0;
    this.costBooks = new Map();
    this.priceSol = null;
    this.priceMint = null;
    this.curve = null;
    this.simRealSol = 0;
    this.onMintChange = null;
    this.seededMint = null;
    this.seedPromise = null;
    this.seedPromiseMint = null;
    this.portalFetch = fetchSingleVersionedTx;
    this.seenTradeSigs = new Set();
    this.pumpPortalNotice = '';
  }

  rememberTrade(signature) {
    if (!signature) return false;
    if (this.seenTradeSigs.has(signature)) return true;
    this.seenTradeSigs.add(signature);
    if (this.seenTradeSigs.size > 500) {
      this.seenTradeSigs.delete(this.seenTradeSigs.values().next().value);
    }
    return false;
  }

  notePumpPortalStatus(message, connected) {
    if (this.pumpPortalNotice === message) return;
    this.pumpPortalNotice = message;
    console.warn(`[TradingEngine] PumpPortal: ${message}`);
    this.broadcast('FEED_STATUS', {
      channel: 'pumpportal',
      connected: Boolean(connected),
      message,
      label: 'PumpPortal'
    });
  }

  fillLabel(side, sol, address) {
    const master = walletManager.masterWallet && walletManager.masterWallet.publicKey.toBase58();
    const who = address && address === master ? 'DEV' : 'BOT';
    const verb = side === 'sell' ? 'SELL' : 'BUY';
    const amount = Number(sol);
    return `${who} ${verb} ${Number.isFinite(amount) ? amount.toFixed(4) : '0.0000'}`;
  }

  tradePayload(trade, own) {
    const mint = trade.mint || this.activeToken;
    const solAmount = Number(trade.solAmount) || 0;
    const txType = trade.txType || 'buy';
    const address = trade.traderPublicKey || trade.user || '';
    return {
      txType,
      solAmount,
      tokenAmount: Number(trade.tokenAmount) || 0,
      traderPublicKey: address || 'Unknown',
      signature: trade.signature || '',
      marketCapSol: trade.marketCapSol || 0,
      priceSol: trade.priceSol || null,
      mint,
      simulated: false,
      source: trade.source || 'helius',
      own: Boolean(own),
      label: own ? (trade.label || this.fillLabel(txType, solAmount, address)) : '',
      timestamp: trade.timestamp || Date.now()
    };
  }

  ingestExternalTrade(trade) {
    if (!trade || trade.simulated) return;
    const signature = trade.signature || '';
    const own = Boolean(trade.own) || (signature && this.ownTrades && this.ownTrades.has(signature));
    if (signature && own) {
      if (!this.ownTrades) this.ownTrades = new Map();
      this.ownTrades.set(signature, trade.label || this.fillLabel(trade.txType, trade.solAmount, trade.traderPublicKey || trade.user));
      if (this.ownTrades.size > 200) this.ownTrades.delete(this.ownTrades.keys().next().value);
    }
    if (signature && this.rememberTrade(signature)) {
      if (own) this.broadcast('PUBLIC_TRADE', this.tradePayload(trade, true));
      return;
    }
    const payload = this.tradePayload(trade, own);
    this.broadcast('PUBLIC_TRADE', payload);
    const price = Number(trade.priceSol) > 0 ? Number(trade.priceSol) : priceFromTrade(trade);
    if (price) this.noteMarketPrice(payload.mint, price, { simulated: false });
  }

  noteCurve(tick) {
    if (!tick || tick.simulated || !tick.mint || tick.mint !== this.activeToken) return;
    const progressPct = tick.complete ? 100 : Number(tick.progressPct);
    if (!Number.isFinite(progressPct) && !tick.complete) return;
    this.curve = {
      mint: tick.mint,
      progressPct: Number.isFinite(progressPct) ? progressPct : 100,
      realSol: Number(tick.realSol) || 0,
      complete: Boolean(tick.complete),
      destination: tick.destination || MIGRATION_DESTINATION,
      source: tick.source || ''
    };
    this.broadcast('CURVE_PROGRESS', this.curve);
  }

  tradePool() {
    if (walletManager.simulationMode) return 'pump';
    if (this.curve && this.curve.mint === this.activeToken && this.curve.complete) return 'pump-amm';
    if (this.curve && this.curve.mint === this.activeToken && this.curve.complete === false) return 'pump';
    return 'auto';
  }

  noteChartFeed(status) {
    if (!status || (status.channel && status.channel !== 'chart')) return;
    this.chartFeedConnected = status.connected !== false;
    if (this.chartFeedConnected) this.chartFeedAt = Date.now();
  }

  ingestCurvePrice(tick) {
    if (!tick || tick.simulated) return;
    this.chartFeedAt = Date.now();
    this.chartFeedConnected = true;
    this.noteCurve(tick);
    if (!(Number(tick.priceSol) > 0)) return;
    this.broadcast('PUBLIC_TRADE', {
      mint: tick.mint,
      priceSol: tick.priceSol,
      marketCapSol: tick.marketCapSol || 0,
      solUsd: tick.solUsd || null,
      priceOnly: true,
      simulated: false,
      source: tick.source || 'Helius bonding curve',
      txType: 'buy',
      solAmount: 0,
      tokenAmount: 0,
      timestamp: Date.now()
    });
    this.noteMarketPrice(tick.mint, tick.priceSol, { simulated: false });
  }

  bookKey(mint, address) {
    return `${mint}:${address}`;
  }

  clearMintBooks(mint) {
    const prefix = `${mint}:`;
    for (const key of [...this.costBooks.keys()]) {
      if (key.startsWith(prefix)) this.costBooks.delete(key);
    }
  }

  noteFill(mint, address, fill) {
    if (!mint || !address) return;
    const key = this.bookKey(mint, address);
    const book = this.costBooks.get(key) || emptyBook();
    const position = this.positions.get(address);
    const unknown = Boolean(position && position.costKnown === false);
    const next = fill.side === 'sell' ? applySell(book, fill) : applyBuy(book, fill);
    next.costKnown = !unknown;
    this.costBooks.set(key, next);
    if (position && next.costKnown) {
      position.costKnown = true;
      position.solInvested = next.costBasisSol;
      this.positions.set(address, position);
    }
    if (!walletManager.simulationMode) this.publishPnl(mint);
  }

  noteOnChainTokens(address, mint, tokenAmount) {
    this.applyOnChainBalance(address, mint, tokenAmount);
    if (!walletManager.simulationMode && mint === this.activeToken) this.publishPnl(mint);
  }

  applyOnChainBalance(address, mint, tokenAmount) {
    if (!mint || mint !== this.activeToken || !address) return;
    const tokens = Math.max(0, Number(tokenAmount) || 0);
    const key = this.bookKey(mint, address);
    const book = this.costBooks.get(key);
    const existing = this.positions.get(address);
    const position = existing || { tokens: 0, solInvested: 0, costKnown: true };
    if (!existing) {
      if (book && book.costKnown === true) {
        position.costKnown = true;
        position.solInvested = book.costBasisSol;
      } else if (tokens > 0) {
        position.costKnown = false;
        position.solInvested = null;
      } else {
        position.costKnown = true;
        position.solInvested = 0;
      }
    }
    position.tokens = tokens;
    if (tokens <= 0 && position.costKnown === false) {
      position.costKnown = true;
      position.solInvested = 0;
      this.costBooks.delete(key);
    } else if (position.costKnown === false) {
      position.solInvested = null;
    } else {
      const book = this.costBooks.get(key);
      if (book && book.costKnown === true) position.solInvested = book.costBasisSol;
    }
    this.positions.set(address, position);
    walletManager.noteTokenBalance(address, mint, tokens);
  }

  seedOnChainHoldings(mint) {
    if (walletManager.simulationMode || !mint || mint !== this.activeToken) return Promise.resolve();
    if (this.seededMint === mint) return Promise.resolve();
    if (this.seedPromise && this.seedPromiseMint === mint) return this.seedPromise;
    this.seedPromiseMint = mint;
    const run = (async () => {
      const wallets = walletManager.walletList();
      let failed = false;
      await Promise.all(wallets.map(async (wallet) => {
        const address = wallet.publicKey.toBase58();
        try {
          const balance = await readOwnerTokenBalance(walletManager.connection, address, mint);
          if (this.activeToken !== mint) return;
          const existing = this.positions.get(address);
          if (existing && existing.costKnown === true) {
            existing.tokens = balance.ui;
            this.positions.set(address, existing);
          } else {
            const position = existing || { tokens: 0, solInvested: null, costKnown: false };
            position.tokens = balance.ui;
            if (balance.ui > 0) {
              position.costKnown = false;
              position.solInvested = null;
            } else {
              position.costKnown = true;
              position.solInvested = 0;
              position.tokens = 0;
            }
            this.positions.set(address, position);
          }
          walletManager.noteTokenBalance(address, mint, balance.ui);
        } catch (err) {
          failed = true;
          console.warn(`[Tokens] ${address} ${mint} balance read failed: ${err.message}`);
        }
      }));
      if (this.activeToken !== mint) return;
      if (!failed) this.seededMint = mint;
      this.publishPnl(mint);
      this.broadcast('HOLDINGS_SEEDED', { mint });
    })();
    this.seedPromise = run.finally(() => {
      if (this.seedPromiseMint === mint) this.seedPromise = null;
    });
    return this.seedPromise;
  }

  noteMarketPrice(mint, price, meta = {}) {
    if (meta.simulated || walletManager.simulationMode) return;
    if (!mint || mint !== this.activeToken) return;
    if (!Number.isFinite(price) || price <= 0) return;
    this.priceSol = price;
    this.priceMint = mint;
    this.publishPnl(mint);
  }

  publishPnl(mint) {
    if (walletManager.simulationMode || !mint || mint !== this.activeToken) return;
    const price = this.priceMint === mint ? this.priceSol : null;
    const addresses = new Set(walletManager.walletList().map(wallet => wallet.publicKey.toBase58()));
    for (const key of this.costBooks.keys()) {
      if (key.startsWith(`${mint}:`)) addresses.add(key.slice(mint.length + 1));
    }
    const wallets = [];
    let realizedSol = 0;
    let unrealizedSol = 0;
    let costBasisSol = 0;
    let tokens = 0;
    let valueSol = 0;
    let priced = price != null;
    let unknownCost = false;
    for (const address of addresses) {
      const book = { ...(this.costBooks.get(this.bookKey(mint, address)) || emptyBook()) };
      const position = this.positions.get(address);
      if (position && position.costKnown === false) book.costKnown = false;
      const onChain = position ? position.tokens : null;
      const quote = quotePosition(book, onChain, price);
      wallets.push({ address, ...quote });
      tokens += quote.tokens;
      if (quote.valueSol == null) priced = false;
      else valueSol += quote.valueSol;
      if (quote.costKnown === false && quote.tokens > 0) unknownCost = true;
      if (quote.unrealizedSol == null) priced = false;
      else unrealizedSol += quote.unrealizedSol;
      if (quote.costBasisSol != null) costBasisSol += quote.costBasisSol;
      if (quote.realizedSol != null) realizedSol += quote.realizedSol;
    }
    const pnlSol = !unknownCost && priced ? realizedSol + unrealizedSol : null;
    const pnlPct = pnlSol == null || costBasisSol <= 0 ? null : (pnlSol / costBasisSol) * 100;
    this.broadcast('PNL_UPDATE', {
      mint,
      priceSol: price,
      wallets,
      total: {
        tokens,
        costBasisSol: unknownCost ? null : costBasisSol,
        realizedSol: unknownCost ? null : realizedSol,
        unrealizedSol: !unknownCost && priced ? unrealizedSol : null,
        pnlSol,
        pnlPct,
        valueSol: price != null ? valueSol : null
      }
    });
  }

  setBroadcaster(fn) {
    this.wsBroadcaster = fn;
  }

  broadcast(type, payload) {
    if (this.wsBroadcaster) {
      this.wsBroadcaster({ type, payload, timestamp: Date.now() });
    }
  }

  stopPumpFeed() {
    if (this.pumpRetryTimer) {
      clearTimeout(this.pumpRetryTimer);
      this.pumpRetryTimer = null;
    }
    if (this.pumpWs) {
      const socket = this.pumpWs;
      this.pumpWs = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch (err) { /* already closed */ }
    }
    if (this.simTicker) {
      clearInterval(this.simTicker);
      this.simTicker = null;
    }
  }

  connectPumpPortal(mint) {
    this.stopPumpFeed();
    this.pumpMint = mint || null;
    this.pumpRetry = 0;
    if (!mint) return;
    this.openPumpSocket(mint);
    if (walletManager.simulationMode) {
      this.simTicker = setInterval(() => {
        if (!walletManager.simulationMode || !this.activeToken || this.activeToken !== mint) return;
        const isBuy = Math.random() > 0.45;
        const solAmount = Number((Math.random() * 0.45 + 0.05).toFixed(3));
        const tokenAmount = Math.floor(pumpfun.calculateBuyOutput(solAmount, 15) * (0.9 + Math.random() * 0.2));
        const randomAddress = Math.random().toString(36).substring(2, 6).toUpperCase() + '..' + Math.random().toString(36).substring(2, 6).toUpperCase();
        this.broadcast('PUBLIC_TRADE', {
          txType: isBuy ? 'buy' : 'sell',
          solAmount,
          tokenAmount,
          traderPublicKey: randomAddress,
          signature: 'sim_' + Date.now().toString(36),
          marketCapSol: Number((15 + Math.random() * 5).toFixed(2)),
          mint,
          simulated: true,
          timestamp: Date.now()
        });
      }, 3800);
    }
  }

  openPumpSocket(mint) {
    if (this.pumpMint !== mint) return;
    const apiKey = String(config.PUMPPORTAL_API_KEY || '').trim();
    if (!apiKey) {
      if (!walletManager.simulationMode) {
        this.notePumpPortalStatus('PumpPortal trade stream needs PUMPPORTAL_API_KEY. Chart prices come from the Helius bonding curve.', false);
      }
      return;
    }
    let socket;
    const url = `${config.PUMPPORTAL_WS}?api-key=${encodeURIComponent(apiKey)}`;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.schedulePumpReconnect(mint, err.message);
      return;
    }
    this.pumpWs = socket;
    socket.on('open', () => {
      if (this.pumpMint !== mint || this.pumpWs !== socket) return;
      this.pumpRetry = 0;
      console.log(`[TradingEngine] Subscribed to PumpPortal trades for ${mint}`);
      socket.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    });
    socket.on('message', (data) => {
      try {
        const trade = JSON.parse(data.toString());
        const event = pumpPortalFeedEvent(trade);
        if (event && event.type === 'FEED_STATUS') {
          this.notePumpPortalStatus(event.payload.message, false);
          return;
        }
        if (!event || event.type !== 'PUBLIC_TRADE') return;
        this.ingestExternalTrade({
          txType: (trade.txType || 'buy').toLowerCase(),
          solAmount: parseFloat(trade.solAmount || 0),
          tokenAmount: parseFloat(trade.tokenAmount || 0),
          traderPublicKey: trade.traderPublicKey || trade.user || 'Unknown',
          signature: trade.signature || '',
          marketCapSol: trade.marketCapSol || 0,
          mint,
          simulated: false,
          source: 'PumpPortal',
          timestamp: Date.now()
        });
      } catch (err) { /* ignore malformed feed messages */ }
    });
    socket.on('error', (err) => {
      console.warn('[TradingEngine] PumpPortal WS error:', err.message);
    });
    socket.on('close', () => {
      if (this.pumpWs === socket) this.pumpWs = null;
      this.schedulePumpReconnect(mint, 'closed');
    });
  }

  schedulePumpReconnect(mint, reason) {
    if (this.pumpMint !== mint) return;
    const delay = Math.min(30000, 1000 * (2 ** this.pumpRetry));
    this.pumpRetry += 1;
    console.warn(`[TradingEngine] PumpPortal WS ${reason}. Reconnecting in ${delay}ms.`);
    this.pumpRetryTimer = setTimeout(() => {
      this.pumpRetryTimer = null;
      this.openPumpSocket(mint);
    }, delay);
  }

  setActiveToken(mint, initialInvestments = []) {
    this.activeToken = mint;
    this.seededMint = null;
    this.seedPromise = null;
    this.seedPromiseMint = null;
    this.positions.clear();
    this.clearMintBooks(mint);
    this.priceSol = null;
    this.priceMint = null;
    this.curve = null;
    this.simRealSol = 0;
    initialInvestments.forEach(item => {
      this.positions.set(item.address, {
        tokens: item.tokens,
        solInvested: item.sol
      });
      if ((item.tokens || 0) > 0 || (item.sol || 0) > 0) {
        this.noteFill(mint, item.address, {
          side: 'buy',
          tokensBought: item.tokens || 0,
          solSpent: item.sol || 0
        });
      }
    });
    this.broadcast('TOKEN_TRACKED', { mint, positionsCount: initialInvestments.length });
    this.connectPumpPortal(mint);
    if (this.onMintChange) this.onMintChange(mint);
  }

  async getLiveStats() {
    const mint = this.activeToken;
    const subWallets = await walletManager.getSubWalletsInfo(mint);
    const master = await walletManager.getMasterInfo();
    if (this.activeToken !== mint) {
      return {
        activeToken: mint,
        stale: true,
        currentMint: this.activeToken,
        wallets: []
      };
    }

    if (!mint) {
      const walletRows = [];
      walletRows.push({
        role: 'Master Dev',
        address: master.address,
        solBalance: master.balance,
        simBalance: master.simBalance,
        liveBalance: master.liveBalance,
        liveError: master.liveError || null,
        tokens: 0,
        solInvested: 0,
        currentValue: 0,
        pnlSol: 0,
        pnlPct: 0
      });
      for (const wallet of subWallets) {
        walletRows.push({
          role: `Sub #${wallet.index}`,
          address: wallet.address,
          solBalance: wallet.solBalance,
          simBalance: wallet.simBalance,
          liveBalance: wallet.liveBalance,
          liveError: wallet.liveError || null,
          tokens: 0,
          solInvested: 0,
          currentValue: 0,
          pnlSol: 0,
          pnlPct: 0
        });
      }
      return {
        activeToken: null,
        stale: false,
        totalTokens: 0,
        totalSolInvested: 0,
        currentSolValue: 0,
        pnlSol: 0,
        pnlPct: 0,
        curveProgressPct: 0,
        wallets: walletRows
      };
    }

    if (!walletManager.simulationMode) {
      try {
        await this.seedOnChainHoldings(mint);
      } catch (err) {
        console.warn('[Tokens] Holding seed failed:', err.message);
      }
      if (this.activeToken !== mint) {
        return {
          activeToken: mint,
          stale: true,
          currentMint: this.activeToken,
          wallets: []
        };
      }
    }

    const dexInfo = await pumpfun.getTokenDexInfo(mint);
    if (this.activeToken !== mint) {
      return {
        activeToken: mint,
        stale: true,
        currentMint: this.activeToken,
        wallets: []
      };
    }

    let totalTokens = 0;
    let totalInvested = 0;
    const walletRows = [];

    const devPos = this.positions.get(master.address) || { tokens: 0, solInvested: 0, costKnown: true };
    const livePrice = !walletManager.simulationMode && this.priceMint === mint && this.priceSol > 0 ? this.priceSol : null;
    const valueOf = (tokens) => livePrice != null ? tokens * livePrice : (walletManager.simulationMode ? pumpfun.calculateSellOutput(tokens, 15) : 0);
    const present = (address, position) => {
      const tokens = Math.max(0, Number(position.tokens) || 0);
      const currentValue = valueOf(tokens);
      if (!walletManager.simulationMode) {
        const book = { ...(this.costBooks.get(this.bookKey(mint, address)) || emptyBook()) };
        if (position.costKnown === false) book.costKnown = false;
        const quote = quotePosition(book, tokens, livePrice);
        return {
          tokens,
          solInvested: quote.costKnown ? Number((quote.costBasisSol || 0).toFixed(4)) : null,
          currentValue: quote.valueSol == null ? 0 : Number(quote.valueSol.toFixed(4)),
          pnlSol: quote.pnlSol == null ? null : Number(quote.pnlSol.toFixed(4)),
          pnlPct: quote.pnlPct == null ? null : Number(quote.pnlPct.toFixed(2))
        };
      }
      const invested = Number(position.solInvested) || 0;
      const pnlSol = currentValue - invested;
      const pnlPct = invested > 0 ? (pnlSol / invested) * 100 : 0;
      return {
        tokens,
        solInvested: Number(invested.toFixed(4)),
        currentValue: Number(currentValue.toFixed(4)),
        pnlSol: Number(pnlSol.toFixed(4)),
        pnlPct: Number(pnlPct.toFixed(2))
      };
    };
    const devPresented = present(master.address, devPos);
    totalTokens += devPresented.tokens;
    if (devPresented.solInvested != null) totalInvested += devPresented.solInvested;

    walletRows.push({
      role: 'Master Dev',
      address: master.address,
      solBalance: master.balance,
      simBalance: master.simBalance,
      liveBalance: master.liveBalance,
      liveError: master.liveError || null,
      ...devPresented
    });

    for (const wallet of subWallets) {
      const position = this.positions.get(wallet.address) || { tokens: wallet.tokenBalance, solInvested: 0, costKnown: true };
      const presented = present(wallet.address, position);
      totalTokens += presented.tokens;
      if (presented.solInvested != null) totalInvested += presented.solInvested;

      walletRows.push({
        role: `Sub #${wallet.index}`,
        address: wallet.address,
        solBalance: wallet.solBalance,
        simBalance: wallet.simBalance,
        liveBalance: wallet.liveBalance,
        liveError: wallet.liveError || null,
        ...presented
      });
    }

    const unknownCost = walletRows.some(row => row.solInvested == null && row.tokens > 0);
    const currentSolValue = walletRows.reduce((sum, row) => sum + (Number(row.currentValue) || 0), 0);
    const pnlSol = unknownCost ? null : currentSolValue - totalInvested;
    const pnlPct = pnlSol == null || totalInvested <= 0 ? null : (pnlSol / totalInvested) * 100;
    const modeled = curveState(this.simRealSol);
    const liveCurve = !walletManager.simulationMode && this.curve && this.curve.mint === mint ? this.curve : null;
    const curveProgressPct = liveCurve ? liveCurve.progressPct : modeled.progressPct;
    const curveRealSol = liveCurve ? liveCurve.realSol : modeled.realSol;
    const curveComplete = liveCurve ? liveCurve.complete : modeled.complete;
    const curveDestination = liveCurve ? liveCurve.destination : modeled.destination;

    return {
      activeToken: mint,
      stale: false,
      totalTokens: Math.floor(totalTokens),
      totalSolInvested: unknownCost ? null : Number(totalInvested.toFixed(4)),
      currentSolValue: Number(currentSolValue.toFixed(4)),
      pnlSol: pnlSol == null ? null : Number(pnlSol.toFixed(4)),
      pnlPct: pnlPct == null ? null : Number(pnlPct.toFixed(2)),
      curveProgressPct,
      curveRealSol,
      curveComplete,
      curveDestination,
      dexInfo,
      wallets: walletRows
    };
  }

  knownTargets(walletAddresses) {
    if (Array.isArray(walletAddresses) && walletAddresses.length > 0) return walletAddresses;
    if (!walletManager.simulationMode) {
      const loaded = walletManager.walletList().map(wallet => wallet.publicKey.toBase58());
      if (loaded.length) return loaded;
    }
    return Array.from(this.positions.keys());
  }

  async onChainTokenUi(owner, mint) {
    const ownerKey = owner.publicKey ? owner.publicKey.toBase58() : String(owner);
    const balance = await readOwnerTokenBalance(walletManager.connection, ownerKey, mint);
    return balance.ui;
  }

  async fetchConfirmedTransaction(signature) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const tx = await walletManager.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });
      if (tx && tx.meta) return tx;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    return null;
  }

  async confirmedFill(signature, owner, mint) {
    const tx = await this.fetchConfirmedTransaction(signature);
    if (!tx) return null;
    const keys = accountKeysFromTransaction(tx);
    const solDelta = solSpentFromMeta(tx.meta, keys, owner);
    const tokens = tokenChangeFromMeta(tx.meta, owner, mint);
    return { solDelta, ...tokens };
  }

  tradeError(result) {
    if (result.success) return result;
    const lines = [];
    const walk = (rows) => {
      (rows || []).forEach(row => {
        if (row && Array.isArray(row.results)) walk(row.results);
        else if (row && row.status && !/success/i.test(String(row.status))) lines.push(String(row.status));
      });
    };
    walk(result.results);
    if (!result.error) result.error = lines.join('; ') || 'Trade failed';
    return result;
  }

  reserveSession(sol) {
    if (this.sessionSpentSol + sol > config.MAX_SOL_PER_SESSION) {
      throw new ValidationError(
        `Session spend would be ${(this.sessionSpentSol + sol).toFixed(4)} SOL, above the cap of ${config.MAX_SOL_PER_SESSION} SOL`
      );
    }
  }

  async executeBuy({ solAmount, walletAddresses = [] }) {
    const mint = this.activeToken;
    if (!mint) throw new ValidationError('No active token is currently selected');
    const amountPerWallet = requireSolTradeAmount(solAmount);
    const isSim = walletManager.simulationMode;
    const targets = this.knownTargets(walletAddresses);

    const results = [];
    let totalBoughtTokens = 0;
    let totalSpentSol = 0;
    let failures = 0;

    for (const addr of targets) {
      if (this.activeToken !== mint) break;
      const signer = walletManager.resolveSigner(addr);
      if (!signer) {
        failures += 1;
        results.push({ address: addr, solSpent: 0, tokensBought: 0, status: 'Error: unknown wallet' });
        continue;
      }
      try {
        this.reserveSession(amountPerWallet);
      } catch (err) {
        failures += 1;
        results.push({ address: addr, solSpent: 0, tokensBought: 0, status: 'Error: ' + err.message });
        continue;
      }

      if (isSim) {
        const tokensOut = Math.floor(pumpfun.calculateBuyOutput(amountPerWallet, 15));
        const position = this.positions.get(addr) || { tokens: 0, solInvested: 0 };
        position.tokens += tokensOut;
        position.solInvested += amountPerWallet;
        this.positions.set(addr, position);
        this.simRealSol += amountPerWallet;
        const current = walletManager.simulatedBalances.get(addr) || 0;
        walletManager.simulatedBalances.set(addr, Math.max(0, current - amountPerWallet));
        walletManager.save();
        this.sessionSpentSol += amountPerWallet;
        totalBoughtTokens += tokensOut;
        totalSpentSol += amountPerWallet;
        this.noteFill(mint, addr, { side: 'buy', tokensBought: tokensOut, solSpent: amountPerWallet });
        this.broadcast('PUBLIC_TRADE', {
          txType: 'buy',
          solAmount: amountPerWallet,
          tokenAmount: tokensOut,
          traderPublicKey: addr,
          signature: 'sim_' + Date.now().toString(36),
          mint,
          simulated: true,
          own: true,
          label: this.fillLabel('buy', amountPerWallet, addr),
          confirmed: true,
          timestamp: Date.now()
        });
        results.push({
          address: addr,
          solSpent: amountPerWallet,
          tokensBought: tokensOut,
          status: 'Simulated Success'
        });
        continue;
      }

      try {
        const tx = await this.portalFetch({
          publicKey: addr,
          action: 'buy',
          mint,
          denominatedInSol: 'true',
          amount: amountPerWallet,
          slippage: config.SLIPPAGE_PCT,
          priorityFee: config.PRIORITY_FEE_SOL,
          pool: this.tradePool()
        });
        tx.sign([signer]);
        const signature = await sendAndConfirmVersioned(walletManager.connection, tx);
        const settled = await this.confirmedFill(signature, addr, mint);
        const previous = (this.positions.get(addr) || { tokens: 0, solInvested: 0 });
        let postTokens = settled ? settled.postUi : null;
        if (postTokens == null) postTokens = await this.onChainTokenUi(signer, mint);
        const tokensOut = settled ? Math.max(0, settled.delta) : Math.max(0, postTokens - previous.tokens);
        const solSpent = settled && settled.solDelta != null
          ? Math.max(0, settled.solDelta)
          : amountPerWallet + knownTradeFeeSol(config.PRIORITY_FEE_SOL);
        const position = this.positions.get(addr) || { tokens: 0, solInvested: 0, costKnown: true };
        position.tokens = postTokens;
        if (position.costKnown === false) position.solInvested = null;
        else position.solInvested = (Number(position.solInvested) || 0) + solSpent;
        this.positions.set(addr, position);
        this.sessionSpentSol += solSpent;
        totalBoughtTokens += tokensOut;
        totalSpentSol += solSpent;
        walletManager.invalidateLiveBalances();
        walletManager.noteTokenBalance(addr, mint, postTokens);
        this.noteFill(mint, addr, { side: 'buy', tokensBought: tokensOut, solSpent });
        this.ingestExternalTrade({
          txType: 'buy',
          solAmount: solSpent,
          tokenAmount: tokensOut,
          priceSol: tokensOut > 0 ? solSpent / tokensOut : null,
          traderPublicKey: addr,
          signature,
          mint,
          own: true,
          label: this.fillLabel('buy', solSpent, addr),
          simulated: false,
          source: 'wallet'
        });
        results.push({
          address: addr,
          solSpent,
          tokensBought: tokensOut,
          txSignature: signature,
          status: 'Success'
        });
      } catch (err) {
        failures += 1;
        results.push({
          address: addr,
          solSpent: 0,
          tokensBought: 0,
          status: 'Failed: ' + err.message
        });
      }
    }

    const successCount = results.length - failures;
    this.broadcast('BUY_EXECUTED', {
      mint,
      amountPerWallet,
      totalBoughtTokens,
      totalSpentSol: Number(totalSpentSol.toFixed(4)),
      resultsCount: successCount
    });

    return this.tradeError({
      success: failures === 0 && successCount > 0,
      simulation: isSim,
      amountPerWallet,
      totalBoughtTokens,
      totalSpentSol: Number(totalSpentSol.toFixed(4)),
      results
    });
  }

  async executeSell({ pct, walletAddresses = [] }) {
    const mint = this.activeToken;
    if (!mint) throw new ValidationError('No active token is currently selected');
    const sellPct = requireSellPct(pct);
    const fraction = sellPct / 100;
    const isSim = walletManager.simulationMode;
    const targets = this.knownTargets(walletAddresses);

    const results = [];
    let totalSoldTokens = 0;
    let totalReceivedSol = 0;
    let failures = 0;

    for (const addr of targets) {
      if (this.activeToken !== mint) break;
      const signer = walletManager.resolveSigner(addr);
      if (!signer) {
        failures += 1;
        results.push({ address: addr, tokensSold: 0, status: 'Error: unknown wallet' });
        continue;
      }

      if (isSim) {
        const position = this.positions.get(addr);
        if (!position || position.tokens <= 0) {
          failures += 1;
          results.push({ address: addr, tokensSold: 0, status: 'Error: no tokens to sell' });
          continue;
        }
        const tokensToSell = Math.floor(position.tokens * fraction);
        if (tokensToSell <= 0) {
          failures += 1;
          results.push({ address: addr, tokensSold: 0, status: 'Error: sell size rounded to 0' });
          continue;
        }
        const solGained = pumpfun.calculateSellOutput(tokensToSell, 15);
        position.tokens -= tokensToSell;
        this.positions.set(addr, position);
        const currentBal = walletManager.simulatedBalances.get(addr) || 0;
        walletManager.simulatedBalances.set(addr, currentBal + solGained);
        this.simRealSol = Math.max(0, this.simRealSol - solGained);
        walletManager.save();
        totalSoldTokens += tokensToSell;
        totalReceivedSol += solGained;
        this.noteFill(mint, addr, { side: 'sell', tokensSold: tokensToSell, solReceived: solGained });
        this.broadcast('PUBLIC_TRADE', {
          txType: 'sell',
          solAmount: Number(solGained.toFixed(4)),
          tokenAmount: tokensToSell,
          traderPublicKey: addr,
          signature: 'sim_' + Date.now().toString(36),
          mint,
          simulated: true,
          own: true,
          label: this.fillLabel('sell', solGained, addr),
          confirmed: true,
          timestamp: Date.now()
        });
        results.push({
          address: addr,
          tokensSold: tokensToSell,
          solReceived: Number(solGained.toFixed(4)),
          status: 'Simulated Success'
        });
        continue;
      }

      try {
        const uiBalance = await this.onChainTokenUi(signer, mint);
        if (!(uiBalance > 0)) {
          failures += 1;
          results.push({ address: addr, tokensSold: 0, status: noTokensMessage(addr, mint) });
          continue;
        }
        const sellAll = sellPct === 100;
        const tokensToSell = sellAll ? uiBalance : uiBalance * fraction;
        const tx = await this.portalFetch({
          publicKey: addr,
          action: 'sell',
          mint,
          denominatedInSol: 'false',
          amount: sellAll ? '100%' : tokensToSell,
          slippage: config.SLIPPAGE_PCT,
          priorityFee: config.PRIORITY_FEE_SOL,
          pool: this.tradePool()
        });
        tx.sign([signer]);
        const signature = await sendAndConfirmVersioned(walletManager.connection, tx);
        const settled = await this.confirmedFill(signature, addr, mint);
        const postTokens = settled ? settled.postUi : await this.onChainTokenUi(signer, mint);
        const sold = settled ? Math.max(0, -settled.delta) : Math.max(0, uiBalance - postTokens);
        const solReceived = settled && settled.solDelta != null
          ? Math.max(0, -settled.solDelta)
          : Math.max(0, pumpfun.calculateSellOutput(sold || tokensToSell, 15) - knownTradeFeeSol(config.PRIORITY_FEE_SOL));
        const position = this.positions.get(addr) || { tokens: uiBalance, solInvested: 0 };
        position.tokens = postTokens;
        this.positions.set(addr, position);
        totalSoldTokens += sold;
        totalReceivedSol += solReceived;
        walletManager.invalidateLiveBalances();
        walletManager.noteTokenBalance(addr, mint, postTokens);
        this.noteFill(mint, addr, { side: 'sell', tokensSold: sold, solReceived });
        this.ingestExternalTrade({
          txType: 'sell',
          solAmount: solReceived,
          tokenAmount: sold,
          priceSol: sold > 0 ? solReceived / sold : null,
          traderPublicKey: addr,
          signature,
          mint,
          own: true,
          label: this.fillLabel('sell', solReceived, addr),
          simulated: false,
          source: 'wallet'
        });
        results.push({
          address: addr,
          tokensSold: sold,
          solReceived: Number(solReceived.toFixed(4)),
          txSignature: signature,
          status: 'Success'
        });
      } catch (err) {
        failures += 1;
        results.push({
          address: addr,
          tokensSold: 0,
          status: 'Failed: ' + err.message
        });
      }
    }

    const successCount = results.length - failures;
    this.broadcast('SELL_EXECUTED', {
      mint,
      pct: sellPct,
      totalSoldTokens,
      totalReceivedSol: Number(totalReceivedSol.toFixed(4)),
      resultsCount: successCount
    });

    return this.tradeError({
      success: failures === 0 && successCount > 0,
      simulation: isSim,
      pct: sellPct,
      totalSoldTokens,
      totalReceivedSol: Number(totalReceivedSol.toFixed(4)),
      results
    });
  }

  async executeCascadeSell(delayMs = 1200, pct = 100) {
    const mint = this.activeToken;
    if (!mint) throw new ValidationError('No active token is currently selected');
    const sellPct = requireSellPct(pct);
    const delay = Number(delayMs);
    if (!Number.isFinite(delay) || delay < 0 || delay > 60000) {
      throw new ValidationError('Cascade delay must be between 0 and 60000 ms');
    }
    const addrs = walletManager.simulationMode
      ? Array.from(this.positions.keys()).filter(addr => (this.positions.get(addr)?.tokens || 0) > 0)
      : walletManager.walletList().map(wallet => wallet.publicKey.toBase58());
    if (!addrs.length) {
      return this.tradeError({
        success: false,
        error: 'No tokens found to sell.',
        simulation: walletManager.simulationMode,
        executedCount: 0,
        results: []
      });
    }

    this.broadcast('CASCADE_STARTED', { mint, walletsCount: addrs.length, delayMs: delay, pct: sellPct });

    const stepResults = [];
    for (let i = 0; i < addrs.length; i++) {
      if (this.activeToken !== mint) break;
      const addr = addrs[i];
      const res = await this.executeSell({ pct: sellPct, walletAddresses: [addr] });
      stepResults.push(res);
      this.broadcast('CASCADE_STEP', { mint, step: i + 1, total: addrs.length, address: addr });
      if (i < addrs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    this.broadcast('CASCADE_COMPLETED', { mint, totalExecuted: stepResults.length });
    return this.tradeError({
      success: stepResults.length > 0 && stepResults.every(step => step.success),
      simulation: walletManager.simulationMode,
      executedCount: stepResults.length,
      results: stepResults
    });
  }

  walletSol(address) {
    if (walletManager.simulationMode) return walletManager.simBalanceOf(address);
    const values = walletManager.liveBalanceCache && walletManager.liveBalanceCache.values;
    if (!values || values[address] == null || !Number.isFinite(Number(values[address]))) return null;
    return Number(values[address]);
  }

  bumpSubWallets(amount) {
    const reserve = this.bumpLimits ? this.bumpLimits.reserveSol : 0;
    const need = amount + reserve;
    return walletManager.subWallets
      .map(wallet => wallet.publicKey.toBase58())
      .filter(address => {
        const sol = this.walletSol(address);
        return sol != null && sol >= need;
      });
  }

  canBumpBuy() {
    const limits = this.bumpLimits;
    if (!this.isBumping || !limits) return false;
    if ((this.bumpCycles || 0) > limits.maxCycles) return false;
    if ((this.bumpNetSol || 0) + this.bumpSol > limits.sessionBudget + 1e-9) return false;
    if ((this.bumpErrors || 0) >= limits.maxErrors) return false;
    return true;
  }

  bumpSnapshot() {
    return {
      cycles: this.bumpCycles || 0,
      volumeSol: Number((this.bumpVolumeSol || 0).toFixed(4)),
      netSolCost: Number((this.bumpNetSol || 0).toFixed(4)),
      lastAction: this.bumpLastAction || '',
      lastError: this.bumpLastError || '',
      lastTx: this.bumpLastTx || '',
      strategy: this.bumpStrategy ? this.bumpStrategy.name : 'round-trip',
      simulated: walletManager.simulationMode
    };
  }

  noteBumpAction(action) {
    const result = action.result || {};
    const signature = (result.results || []).map(row => row && row.txSignature).find(Boolean);
    if (signature) this.bumpLastTx = signature;
    if (!result.success) {
      this.bumpLastError = result.error || `${action.side} failed`;
      return `${action.side.toUpperCase()} failed`;
    }
    if (action.side === 'buy') {
      this.bumpVolumeSol += this.bumpSol;
      this.bumpNetSol += this.bumpSol;
      return `BUY ${this.bumpSol.toFixed(4)}`;
    }
    const received = Number(result.totalReceivedSol) || 0;
    this.bumpVolumeSol += received;
    this.bumpNetSol -= received;
    return `SELL ${received.toFixed(4)}`;
  }

  bumpStopReason() {
    if (this.curve && this.curve.mint === this.activeToken && this.curve.complete) return 'Coin graduated. Bumper stopped.';
    if (!walletManager.simulationMode) {
      const since = this.chartFeedAt || this.bumpStartedAt || 0;
      const stallMs = (this.bumpLimits && this.bumpLimits.stallSeconds || 30) * 1000;
      if (since && Date.now() - since > stallMs) return 'Chart feed stalled. Bumper stopped.';
    }
    if (this.bumpLimits && (this.bumpNetSol || 0) >= this.bumpLimits.sessionBudget - 1e-9) {
      return 'Session SOL budget reached. Bumper stopped.';
    }
    if (this.bumpLimits && (this.bumpCycles || 0) >= this.bumpLimits.maxCycles) {
      return 'Max cycles reached. Bumper stopped.';
    }
    if (this.bumpLimits && (this.bumpErrors || 0) >= this.bumpLimits.maxErrors) {
      return 'Too many consecutive errors. Bumper stopped.';
    }
    return '';
  }

  async flattenBump() {
    if (!this.bumpStrategy || typeof this.bumpStrategy.closeOpen !== 'function') return [];
    const actions = await this.bumpStrategy.closeOpen(this);
    const notes = actions.map(action => this.noteBumpAction(action));
    if (notes.length) this.bumpLastAction = `Stop · ${notes.join(' · ')}`;
    return actions;
  }

  async runBumpCycle() {
    if (this.bumpBusy || !this.isBumping) return null;
    this.bumpBusy = true;
    const mint = this.activeToken;
    const amount = this.bumpSol;
    const simulated = walletManager.simulationMode;
    try {
      if (!mint) throw new ValidationError('No active token is currently selected');
      if (!this.bumpStrategy) this.bumpStrategy = createRoundTripStrategy(this.bumpLimits || {});
      const early = this.bumpStopReason();
      if (early && (this.bumpCycles || 0) > 0) {
        this.isBumping = false;
        this.clearBumpTimer();
        this.bumpLastError = early;
        this.bumpStopRequested = true;
        const payload = { mint, solAmount: amount, simulated, actions: [], error: early, ...this.bumpSnapshot() };
        this.broadcast('BUMP_TICK', payload);
        return payload;
      }
      this.bumpCycles = (this.bumpCycles || 0) + 1;
      const outcome = await this.bumpStrategy.onCycle({
        engine: this,
        cycle: this.bumpCycles,
        solAmount: amount,
        mint
      });
      const actions = outcome.actions || [];
      const failed = actions.filter(action => !action.result || !action.result.success);
      if (failed.length) this.bumpErrors = (this.bumpErrors || 0) + 1;
      else if (actions.length) this.bumpErrors = 0;
      const notes = actions.map(action => this.noteBumpAction(action));
      this.bumpLastAction = notes.length ? notes.join(' · ') : 'No sub-wallet above the SOL reserve';
      if (!failed.length) this.bumpLastError = '';
      const reason = this.bumpStopReason();
      if (reason) {
        this.isBumping = false;
        this.clearBumpTimer();
        this.bumpLastError = reason;
        this.bumpStopRequested = true;
      }
      const payload = {
        mint,
        solAmount: amount,
        simulated,
        actions,
        error: this.bumpLastError,
        ...this.bumpSnapshot()
      };
      this.broadcast('BUMP_TICK', payload);
      return payload;
    } catch (err) {
      this.bumpErrors = (this.bumpErrors || 0) + 1;
      this.bumpLastAction = 'Cycle failed';
      this.bumpLastError = err.message || 'Volume cycle failed';
      if ((this.bumpErrors || 0) >= (this.bumpLimits && this.bumpLimits.maxErrors || 3)) {
        this.isBumping = false;
        this.clearBumpTimer();
        this.bumpLastError = 'Too many consecutive errors. Bumper stopped.';
        this.bumpStopRequested = true;
      }
      const payload = {
        mint,
        solAmount: amount,
        simulated,
        error: this.bumpLastError,
        actions: [],
        ...this.bumpSnapshot()
      };
      this.broadcast('BUMP_TICK', payload);
      console.warn('[VolumeBumper]', this.bumpLastError);
      return payload;
    } finally {
      this.bumpBusy = false;
      if (this.bumpStopRequested) {
        this.bumpStopRequested = false;
        await this.flattenBump();
        this.broadcast('BUMPER_STOPPED', this.bumpSnapshot());
      }
    }
  }

  clearBumpTimer() {
    if (this.bumpInterval) {
      clearInterval(this.bumpInterval);
      this.bumpInterval = null;
    }
  }

  startVolumeBumper(solAmount, intervalSeconds, options = {}) {
    const amount = requireSolTradeAmount(solAmount);
    const interval = requireBumperInterval(intervalSeconds);
    const limits = readBumpLimits(options, amount);
    if (this.isBumping) return this.bumpSnapshot();
    if (!this.activeToken) throw new ValidationError('No active token is currently selected');
    if (!walletManager.subWallets.length) throw new ValidationError('No sub-wallets are loaded');
    this.isBumping = true;
    this.bumpSol = amount;
    this.bumpLimits = limits;
    this.bumpEveryMs = interval * 1000;
    this.bumpCycles = 0;
    this.bumpVolumeSol = 0;
    this.bumpNetSol = 0;
    this.bumpErrors = 0;
    this.bumpLastTx = '';
    this.bumpLastAction = 'Starting';
    this.bumpLastError = '';
    this.bumpStartedAt = Date.now();
    this.bumpStopRequested = false;
    this.bumpStrategy = options.strategy || createRoundTripStrategy({ ...options, holdMs: limits.holdSeconds * 1000 });
    const simulated = walletManager.simulationMode;
    this.broadcast('BUMPER_STARTED', {
      mint: this.activeToken,
      solAmount: amount,
      intervalSeconds: interval,
      simulated,
      limits,
      ...this.bumpSnapshot()
    });
    const tick = () => {
      this.runBumpCycle().catch(err => console.warn('[VolumeBumper]', err.message));
    };
    tick();
    this.bumpInterval = setInterval(tick, this.bumpEveryMs);
    return this.bumpSnapshot();
  }

  async stopVolumeBumper() {
    const wasRunning = this.isBumping || this.bumpInterval || (this.bumpStrategy && this.bumpStrategy.open && this.bumpStrategy.open.length);
    this.isBumping = false;
    this.clearBumpTimer();
    if (!wasRunning) return this.bumpSnapshot();
    if (this.bumpBusy) {
      this.bumpStopRequested = true;
      this.bumpLastAction = 'Stopping';
      while (this.bumpBusy) await new Promise(resolve => setTimeout(resolve, 15));
      return this.bumpSnapshot();
    }
    this.bumpLastAction = 'Stopped';
    await this.flattenBump();
    this.broadcast('BUMPER_STOPPED', this.bumpSnapshot());
    return this.bumpSnapshot();
  }
}

module.exports = new TradingEngine();
