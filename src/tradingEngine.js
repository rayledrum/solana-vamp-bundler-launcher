const walletManager = require('./walletManager');
const pumpfun = require('./pumpfun');
const config = require('./config');
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const WebSocket = require('ws');
const {
  requireSolTradeAmount,
  requireSellPct,
  requireBumperInterval,
  ValidationError
} = require('./validation');
const { fetchSingleVersionedTx, sendAndConfirmVersioned } = require('./portalTx');

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
    let socket;
    try {
      socket = new WebSocket(config.PUMPPORTAL_WS);
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
        if (trade && (trade.txType || trade.solAmount)) {
          this.broadcast('PUBLIC_TRADE', {
            txType: (trade.txType || 'buy').toLowerCase(),
            solAmount: parseFloat(trade.solAmount || 0),
            tokenAmount: parseFloat(trade.tokenAmount || 0),
            traderPublicKey: trade.traderPublicKey || trade.user || 'Unknown',
            signature: trade.signature || '',
            marketCapSol: trade.marketCapSol || 0,
            mint,
            timestamp: Date.now()
          });
        }
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
    this.positions.clear();
    initialInvestments.forEach(item => {
      this.positions.set(item.address, {
        tokens: item.tokens,
        solInvested: item.sol
      });
    });
    this.broadcast('TOKEN_TRACKED', { mint, positionsCount: initialInvestments.length });
    this.connectPumpPortal(mint);
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

    const devPos = this.positions.get(master.address) || { tokens: 0, solInvested: 0 };
    totalTokens += devPos.tokens;
    totalInvested += devPos.solInvested;

    const devCurrentVal = pumpfun.calculateSellOutput(devPos.tokens, 15);
    const devPnlSol = devCurrentVal - devPos.solInvested;
    const devPnlPct = devPos.solInvested > 0 ? (devPnlSol / devPos.solInvested) * 100 : 0;

    walletRows.push({
      role: 'Master Dev',
      address: master.address,
      solBalance: master.balance,
      tokens: devPos.tokens,
      solInvested: devPos.solInvested,
      currentValue: Number(devCurrentVal.toFixed(4)),
      pnlSol: Number(devPnlSol.toFixed(4)),
      pnlPct: Number(devPnlPct.toFixed(2))
    });

    for (const wallet of subWallets) {
      const position = this.positions.get(wallet.address) || { tokens: wallet.tokenBalance, solInvested: 0 };
      totalTokens += position.tokens;
      totalInvested += position.solInvested;
      const subVal = pumpfun.calculateSellOutput(position.tokens, 15);
      const subPnl = subVal - position.solInvested;
      const subPct = position.solInvested > 0 ? (subPnl / position.solInvested) * 100 : 0;

      walletRows.push({
        role: `Sub #${wallet.index}`,
        address: wallet.address,
        solBalance: wallet.solBalance,
        tokens: position.tokens,
        solInvested: position.solInvested,
        currentValue: Number(subVal.toFixed(4)),
        pnlSol: Number(subPnl.toFixed(4)),
        pnlPct: Number(subPct.toFixed(2))
      });
    }

    const currentSolValue = pumpfun.calculateSellOutput(totalTokens, 15);
    const pnlSol = currentSolValue - totalInvested;
    const pnlPct = totalInvested > 0 ? (pnlSol / totalInvested) * 100 : 0;
    const curveProgressPct = pumpfun.calculateProgress(15 + totalInvested);

    return {
      activeToken: mint,
      stale: false,
      totalTokens: Math.floor(totalTokens),
      totalSolInvested: Number(totalInvested.toFixed(4)),
      currentSolValue: Number(currentSolValue.toFixed(4)),
      pnlSol: Number(pnlSol.toFixed(4)),
      pnlPct: Number(pnlPct.toFixed(2)),
      curveProgressPct,
      dexInfo,
      wallets: walletRows
    };
  }

  knownTargets(walletAddresses) {
    if (Array.isArray(walletAddresses) && walletAddresses.length > 0) return walletAddresses;
    return Array.from(this.positions.keys());
  }

  async onChainTokenUi(owner, mint) {
    const mintKey = new PublicKey(mint);
    const ata = await getAssociatedTokenAddress(mintKey, owner.publicKey);
    try {
      const balance = await walletManager.connection.getTokenAccountBalance(ata, 'confirmed');
      return Number(balance.value.uiAmount || 0);
    } catch (err) {
      const message = String(err.message || '');
      if (message.includes('could not find') || message.includes('Invalid param')) return 0;
      throw err;
    }
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
        const current = walletManager.simulatedBalances.get(addr) || 0;
        walletManager.simulatedBalances.set(addr, Math.max(0, current - amountPerWallet));
        walletManager.save();
        this.sessionSpentSol += amountPerWallet;
        totalBoughtTokens += tokensOut;
        totalSpentSol += amountPerWallet;
        this.broadcast('PUBLIC_TRADE', {
          txType: 'buy',
          solAmount: amountPerWallet,
          tokenAmount: tokensOut,
          traderPublicKey: addr.slice(0, 4) + '...' + addr.slice(-4),
          signature: 'sim_' + Date.now().toString(36),
          mint,
          simulated: true,
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
        const tx = await fetchSingleVersionedTx({
          publicKey: addr,
          action: 'buy',
          mint,
          denominatedInSol: 'true',
          amount: amountPerWallet,
          slippage: config.SLIPPAGE_PCT,
          priorityFee: config.PRIORITY_FEE_SOL,
          pool: 'pump'
        });
        tx.sign([signer]);
        const signature = await sendAndConfirmVersioned(walletManager.connection, tx);
        let tokensOut = 0;
        try {
          const ui = await this.onChainTokenUi(signer, mint);
          const previous = (this.positions.get(addr) || { tokens: 0 }).tokens;
          tokensOut = Math.max(0, Math.floor(ui - previous));
          const position = this.positions.get(addr) || { tokens: 0, solInvested: 0 };
          position.tokens = ui;
          position.solInvested += amountPerWallet;
          this.positions.set(addr, position);
        } catch (balanceErr) {
          tokensOut = Math.floor(pumpfun.calculateBuyOutput(amountPerWallet, 15));
          const position = this.positions.get(addr) || { tokens: 0, solInvested: 0 };
          position.tokens += tokensOut;
          position.solInvested += amountPerWallet;
          this.positions.set(addr, position);
        }
        this.sessionSpentSol += amountPerWallet;
        totalBoughtTokens += tokensOut;
        totalSpentSol += amountPerWallet;
        this.broadcast('PUBLIC_TRADE', {
          txType: 'buy',
          solAmount: amountPerWallet,
          tokenAmount: tokensOut,
          traderPublicKey: addr.slice(0, 4) + '...' + addr.slice(-4),
          signature,
          mint,
          confirmed: true,
          timestamp: Date.now()
        });
        results.push({
          address: addr,
          solSpent: amountPerWallet,
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

    return {
      success: failures === 0 && successCount > 0,
      simulation: isSim,
      amountPerWallet,
      totalBoughtTokens,
      totalSpentSol: Number(totalSpentSol.toFixed(4)),
      results
    };
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
        walletManager.save();
        totalSoldTokens += tokensToSell;
        totalReceivedSol += solGained;
        this.broadcast('PUBLIC_TRADE', {
          txType: 'sell',
          solAmount: Number(solGained.toFixed(4)),
          tokenAmount: tokensToSell,
          traderPublicKey: addr.slice(0, 4) + '...' + addr.slice(-4),
          signature: 'sim_' + Date.now().toString(36),
          mint,
          simulated: true,
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
          results.push({ address: addr, tokensSold: 0, status: 'Error: no on-chain token balance' });
          continue;
        }
        const sellAll = sellPct === 100;
        const tokensToSell = sellAll ? uiBalance : uiBalance * fraction;
        const tx = await fetchSingleVersionedTx({
          publicKey: addr,
          action: 'sell',
          mint,
          denominatedInSol: 'false',
          amount: sellAll ? '100%' : tokensToSell,
          slippage: config.SLIPPAGE_PCT,
          priorityFee: config.PRIORITY_FEE_SOL,
          pool: 'pump'
        });
        tx.sign([signer]);
        const signature = await sendAndConfirmVersioned(walletManager.connection, tx);
        const remaining = await this.onChainTokenUi(signer, mint);
        const position = this.positions.get(addr) || { tokens: uiBalance, solInvested: 0 };
        const sold = Math.max(0, uiBalance - remaining);
        position.tokens = remaining;
        this.positions.set(addr, position);
        const solGained = pumpfun.calculateSellOutput(sold || tokensToSell, 15);
        totalSoldTokens += sold || tokensToSell;
        totalReceivedSol += solGained;
        this.broadcast('PUBLIC_TRADE', {
          txType: 'sell',
          solAmount: Number(solGained.toFixed(4)),
          tokenAmount: sold || tokensToSell,
          traderPublicKey: addr.slice(0, 4) + '...' + addr.slice(-4),
          signature,
          mint,
          confirmed: true,
          timestamp: Date.now()
        });
        results.push({
          address: addr,
          tokensSold: sold || tokensToSell,
          solReceived: Number(solGained.toFixed(4)),
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

    return {
      success: failures === 0 && successCount > 0,
      simulation: isSim,
      pct: sellPct,
      totalSoldTokens,
      totalReceivedSol: Number(totalReceivedSol.toFixed(4)),
      results
    };
  }

  async executeCascadeSell(delayMs = 1200, pct = 100) {
    const mint = this.activeToken;
    if (!mint) throw new ValidationError('No active token is currently selected');
    const sellPct = requireSellPct(pct);
    const delay = Number(delayMs);
    if (!Number.isFinite(delay) || delay < 0 || delay > 60000) {
      throw new ValidationError('Cascade delay must be between 0 and 60000 ms');
    }
    const addrs = Array.from(this.positions.keys()).filter(addr => (this.positions.get(addr)?.tokens || 0) > 0);

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
    return { success: stepResults.every(step => step.success), executedCount: stepResults.length, results: stepResults };
  }

  startVolumeBumper(solAmount, intervalSeconds) {
    if (!walletManager.simulationMode) {
      throw new ValidationError('Volume bumper is simulation-only. It does not submit trades.');
    }
    const amount = requireSolTradeAmount(solAmount);
    const interval = requireBumperInterval(intervalSeconds);
    if (this.isBumping) return;
    if (!this.activeToken) throw new ValidationError('No active token is currently selected');
    this.isBumping = true;
    this.broadcast('BUMPER_STARTED', {
      mint: this.activeToken,
      solAmount: amount,
      intervalSeconds: interval,
      simulated: true,
      note: 'Simulation only. No transaction is submitted.'
    });

    this.bumpInterval = setInterval(() => {
      try {
        const tickMint = this.activeToken;
        if (!this.isBumping || !tickMint || !walletManager.simulationMode) return;
        const randomSub = walletManager.subWallets[Math.floor(Math.random() * walletManager.subWallets.length)];
        if (!randomSub) return;
        this.broadcast('BUMP_TICK', {
          mint: tickMint,
          wallet: randomSub.publicKey.toBase58().slice(0, 6) + '...',
          solAmount: amount,
          action: 'Simulated micro-buy (no transaction)',
          simulated: true
        });
      } catch (err) {
        console.warn('[VolumeBumper] Tick error:', err.message);
      }
    }, interval * 1000);
  }

  stopVolumeBumper() {
    this.isBumping = false;
    if (this.bumpInterval) {
      clearInterval(this.bumpInterval);
      this.bumpInterval = null;
    }
    this.broadcast('BUMPER_STOPPED', { simulated: true });
  }
}

module.exports = new TradingEngine();
