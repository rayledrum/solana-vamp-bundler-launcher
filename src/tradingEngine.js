const walletManager = require('./walletManager');
const pumpfun = require('./pumpfun');
const config = require('./config');
const axios = require('axios');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;
const { Transaction, Keypair } = require('@solana/web3.js');

class TradingEngine {
  constructor() {
    this.activeToken = null; // currently tracked token mint
    this.positions = new Map(); // address -> { tokens, solInvested }
    this.isBumping = false;
    this.bumpInterval = null;
    this.wsBroadcaster = null;
  }

  setBroadcaster(fn) {
    this.wsBroadcaster = fn;
  }

  broadcast(type, payload) {
    if (this.wsBroadcaster) {
      this.wsBroadcaster({ type, payload, timestamp: Date.now() });
    }
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
  }

  // Get aggregated positions and live PnL for the mint that was active
  // when the read started. If the tracked mint changes mid-flight, the
  // result is flagged stale so the client does not draw it on the new coin.
  async getLiveStats() {
    const mint = this.activeToken;
    if (!mint) {
      return {
        activeToken: null,
        stale: false,
        totalTokens: 0,
        totalSolInvested: 0,
        currentSolValue: 0,
        pnlSol: 0,
        pnlPct: 0,
        curveProgressPct: 0,
        wallets: []
      };
    }

    const isSim = walletManager.simulationMode;
    const dexInfo = await pumpfun.getTokenDexInfo(mint);
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

    let totalTokens = 0;
    let totalInvested = 0;
    const walletRows = [];

    // Master Dev Wallet position
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

    // Sub-Wallets positions
    for (const w of subWallets) {
      const p = this.positions.get(w.address) || { tokens: w.tokenBalance, solInvested: 0 };
      totalTokens += p.tokens;
      totalInvested += p.solInvested;
      const subVal = pumpfun.calculateSellOutput(p.tokens, 15);
      const subPnl = subVal - p.solInvested;
      const subPct = p.solInvested > 0 ? (subPnl / p.solInvested) * 100 : 0;

      walletRows.push({
        role: `Sub #${w.index}`,
        address: w.address,
        solBalance: w.solBalance,
        tokens: p.tokens,
        solInvested: p.solInvested,
        currentValue: Number(subVal.toFixed(4)),
        pnlSol: Number(subPnl.toFixed(4)),
        pnlPct: Number(subPct.toFixed(2))
      });
    }

    // Estimate current sell value in SOL
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

  // Execute Manual Buy on specific or all wallets
  async executeBuy({ solAmount = 0.1, walletAddresses = [] }) {
    const mint = this.activeToken;
    if (!mint) throw new Error('No active token is currently selected');
    const isSim = walletManager.simulationMode;
    const amountPerWallet = Math.max(0.001, parseFloat(solAmount || '0.1'));

    const targets = walletAddresses.length > 0 
      ? walletAddresses 
      : Array.from(this.positions.keys());

    const results = [];
    let totalBoughtTokens = 0;
    let totalSpentSol = 0;

    for (const addr of targets) {
      if (this.activeToken !== mint) break;
      const tokensOut = pumpfun.calculateBuyOutput(amountPerWallet, 15);
      totalBoughtTokens += tokensOut;
      totalSpentSol += amountPerWallet;

      const pos = this.positions.get(addr) || { tokens: 0, solInvested: 0 };
      pos.tokens += Math.floor(tokensOut);
      pos.solInvested += amountPerWallet;
      this.positions.set(addr, pos);

      if (isSim) {
        const curBal = walletManager.simulatedBalances.get(addr) || 0;
        walletManager.simulatedBalances.set(addr, Math.max(0, curBal - amountPerWallet));
        results.push({
          address: addr,
          solSpent: amountPerWallet,
          tokensBought: Math.floor(tokensOut),
          status: 'Simulated Success'
        });
      } else {
        // LIVE BUY via PumpPortal
        try {
          const signerKp = addr === walletManager.masterWallet.publicKey.toBase58()
            ? walletManager.masterWallet
            : walletManager.subWallets.find(w => w.publicKey.toBase58() === addr);

          if (signerKp) {
            const buyRes = await axios.post(`${config.PUMPPORTAL_API}/trade-local`, {
              publicKey: addr,
              action: 'buy',
              mint,
              denominatedInSol: 'true',
              amount: amountPerWallet,
              slippage: 15,
              priorityFee: 0.0002,
              pool: 'pump'
            });

            const txBuf = Buffer.from(buyRes.data, 'base64');
            const tx = Transaction.from(txBuf);
            tx.sign(signerKp);

            const sig = await walletManager.connection.sendRawTransaction(tx.serialize());
            results.push({
              address: addr,
              solSpent: amountPerWallet,
              tokensBought: Math.floor(tokensOut),
              txSignature: sig,
              status: 'Success'
            });
          }
        } catch (err) {
          results.push({
            address: addr,
            solSpent: 0,
            status: 'Failed: ' + err.message
          });
        }
      }
    }

    this.broadcast('BUY_EXECUTED', {
      mint,
      amountPerWallet,
      totalBoughtTokens: Math.floor(totalBoughtTokens),
      totalSpentSol: Number(totalSpentSol.toFixed(4)),
      resultsCount: results.length
    });

    return {
      success: true,
      simulation: isSim,
      amountPerWallet,
      totalBoughtTokens: Math.floor(totalBoughtTokens),
      totalSpentSol: Number(totalSpentSol.toFixed(4)),
      results
    };
  }

  // Execute Percentage Sell across all or specified sub-wallets
  async executeSell({ pct = 100, walletAddresses = [] }) {
    const mint = this.activeToken;
    if (!mint) throw new Error('No active token is currently selected');
    const isSim = walletManager.simulationMode;
    const sellPct = Math.min(100, Math.max(1, pct)) / 100;

    const targets = walletAddresses.length > 0 
      ? walletAddresses 
      : Array.from(this.positions.keys());

    const results = [];
    let totalSoldTokens = 0;
    let totalReceivedSol = 0;

    for (const addr of targets) {
      if (this.activeToken !== mint) break;
      const pos = this.positions.get(addr);
      if (!pos || pos.tokens <= 0) continue;

      const tokensToSell = Math.floor(pos.tokens * sellPct);
      if (tokensToSell <= 0) continue;

      const solGained = pumpfun.calculateSellOutput(tokensToSell, 15);
      totalSoldTokens += tokensToSell;
      totalReceivedSol += solGained;

      // Update position
      pos.tokens -= tokensToSell;
      this.positions.set(addr, pos);

      if (isSim) {
        const currentBal = walletManager.simulatedBalances.get(addr) || 0;
        walletManager.simulatedBalances.set(addr, currentBal + solGained);
        results.push({
          address: addr,
          tokensSold: tokensToSell,
          solReceived: Number(solGained.toFixed(4)),
          status: 'Simulated Success'
        });
      } else {
        // LIVE SELL via PumpPortal / Jito
        try {
          const signerKp = addr === walletManager.masterWallet.publicKey.toBase58()
            ? walletManager.masterWallet
            : walletManager.subWallets.find(w => w.publicKey.toBase58() === addr);

          if (signerKp) {
            const sellRes = await axios.post(`${config.PUMPPORTAL_API}/trade-local`, {
              publicKey: addr,
              action: 'sell',
              mint,
              denominatedInSol: 'false',
              amount: tokensToSell,
              slippage: 20,
              priorityFee: 0.0002,
              pool: 'pump'
            });

            const txBuf = Buffer.from(sellRes.data, 'base64');
            const tx = Transaction.from(txBuf);
            tx.sign(signerKp);

            const sig = await walletManager.connection.sendRawTransaction(tx.serialize());
            results.push({
              address: addr,
              tokensSold: tokensToSell,
              txSignature: sig,
              status: 'Success'
            });
          }
        } catch (err) {
          results.push({
            address: addr,
            tokensSold: 0,
            status: 'Failed: ' + err.message
          });
        }
      }
    }

    this.broadcast('SELL_EXECUTED', {
      mint,
      pct,
      totalSoldTokens,
      totalReceivedSol: Number(totalReceivedSol.toFixed(4)),
      resultsCount: results.length
    });

    return {
      success: true,
      simulation: isSim,
      pct,
      totalSoldTokens,
      totalReceivedSol: Number(totalReceivedSol.toFixed(4)),
      results
    };
  }

  // Cascade Sell: staggered selling across sub-wallets with delays
  async executeCascadeSell(delayMs = 1200, pct = 100) {
    const mint = this.activeToken;
    if (!mint) throw new Error('No active token is currently selected');
    const addrs = Array.from(this.positions.keys()).filter(a => (this.positions.get(a)?.tokens || 0) > 0);
    
    this.broadcast('CASCADE_STARTED', { mint, walletsCount: addrs.length, delayMs, pct });

    const stepResults = [];
    for (let i = 0; i < addrs.length; i++) {
      if (this.activeToken !== mint) break;
      const addr = addrs[i];
      const res = await this.executeSell({ pct, walletAddresses: [addr] });
      stepResults.push(res);
      this.broadcast('CASCADE_STEP', { mint, step: i + 1, total: addrs.length, address: addr });
      if (i < addrs.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    this.broadcast('CASCADE_COMPLETED', { mint, totalExecuted: stepResults.length });
    return { success: true, executedCount: stepResults.length, results: stepResults };
  }

  // Volume Bumper: start micro-trades to keep token bumped on Pump.fun
  startVolumeBumper(solAmount = 0.01, intervalSeconds = 20) {
    if (this.isBumping) return;
    this.isBumping = true;
    this.broadcast('BUMPER_STARTED', { mint: this.activeToken, solAmount, intervalSeconds });

    this.bumpInterval = setInterval(async () => {
      try {
        const tickMint = this.activeToken;
        if (!this.isBumping || !tickMint) return;
        const randomSub = walletManager.subWallets[Math.floor(Math.random() * walletManager.subWallets.length)];
        if (!randomSub) return;

        this.broadcast('BUMP_TICK', {
          mint: tickMint,
          wallet: randomSub.publicKey.toBase58().slice(0, 6) + '...',
          solAmount,
          action: 'Micro Buy'
        });
      } catch (err) {
        console.warn('[VolumeBumper] Tick error:', err.message);
      }
    }, intervalSeconds * 1000);
  }

  stopVolumeBumper() {
    this.isBumping = false;
    if (this.bumpInterval) {
      clearInterval(this.bumpInterval);
      this.bumpInterval = null;
    }
    this.broadcast('BUMPER_STOPPED', {});
  }
}

module.exports = new TradingEngine();
