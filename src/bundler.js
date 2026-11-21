const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;
const axios = require('axios');
const config = require('./config');
const pumpfun = require('./pumpfun');
const walletManager = require('./walletManager');

class BundlerService {
  constructor() {
    this.connection = walletManager.connection;
  }

  // Pick a random official Jito Tip Account
  getRandomTipAccount() {
    const list = config.JITO_TIP_ACCOUNTS;
    const choice = list[Math.floor(Math.random() * list.length)];
    return new PublicKey(choice);
  }

  // Pre-flight check: simulate balances and execution
  async preflightCheck({ devSolBuy, subWalletBuys, jitoTipSol }) {
    const devInfo = await walletManager.getMasterInfo();
    const subWallets = await walletManager.getSubWalletsInfo();

    const issues = [];
    const neededDevSol = devSolBuy + jitoTipSol + 0.04; // 0.04 SOL for mint account creation & rent
    if (devInfo.balance < neededDevSol) {
      issues.push(`Master Dev wallet has ${devInfo.balance.toFixed(3)} SOL, needs ${neededDevSol.toFixed(3)} SOL (Buy + Rent + Jito Tip)`);
    }

    let totalSubSol = 0;
    subWalletBuys.forEach((amount, i) => {
      totalSubSol += amount;
      const w = subWallets[i];
      if (w && w.solBalance < amount + 0.005) {
        issues.push(`Sub-wallet #${i + 1} (${w.address.slice(0, 6)}...) has ${w.solBalance.toFixed(3)} SOL, needs ${(amount + 0.005).toFixed(3)} SOL`);
      }
    });

    const totalBundleSol = devSolBuy + totalSubSol;
    const estimatedTokens = pumpfun.calculateBuyOutput(totalBundleSol, 0);
    const supplyPct = ((estimatedTokens / 1000000000) * 100).toFixed(2);

    return {
      passed: issues.length === 0,
      issues,
      devSolBuy,
      totalSubSol,
      totalBundleSol,
      jitoTipSol,
      estimatedTokens: Math.floor(estimatedTokens),
      supplyPct: Number(supplyPct),
      simulation: walletManager.simulationMode
    };
  }

  // Execute the atomic Jito Launch Bundle
  async launchBundle({
    tokenName,
    tokenSymbol,
    tokenDescription,
    tokenMetadataUri,
    devSolBuy = 0.5,
    subWalletBuys = [],
    jitoTipSol = 0.003
  }) {
    const isSim = walletManager.simulationMode;
    const mintKeypair = Keypair.generate();
    const mintAddress = mintKeypair.publicKey.toBase58();

    console.log(`[Bundler] Preparing atomic launch bundle for ${tokenSymbol} (${mintAddress})...`);

    // In simulation mode: execute comprehensive simulation
    if (isSim) {
      const devInfo = await walletManager.getMasterInfo();
      const devAddr = devInfo.address;
      
      // Calculate token yields
      let currentCurveSol = 0;
      const devTokens = pumpfun.calculateBuyOutput(devSolBuy, currentCurveSol);
      currentCurveSol += devSolBuy;

      const subWalletAllocations = [];
      subWalletBuys.forEach((buySol, idx) => {
        const tokens = pumpfun.calculateBuyOutput(buySol, currentCurveSol);
        currentCurveSol += buySol;
        subWalletAllocations.push({
          walletIndex: idx + 1,
          solSpent: buySol,
          tokensBought: Math.floor(tokens)
        });
      });

      // Update simulated balances
      const totalDevSpend = devSolBuy + jitoTipSol + 0.02;
      walletManager.simulatedBalances.set(devAddr, Math.max(0, (devInfo.balance - totalDevSpend)));

      subWalletBuys.forEach((buySol, idx) => {
        const w = walletManager.subWallets[idx];
        if (w) {
          const prev = walletManager.simulatedBalances.get(w.publicKey.toBase58()) || 0;
          walletManager.simulatedBalances.set(w.publicKey.toBase58(), Math.max(0, prev - buySol));
        }
      });

      const simulatedBundleId = 'jito_sim_' + Buffer.from(mintKeypair.publicKey.toBytes()).toString('hex').slice(0, 32);

      return {
        success: true,
        simulation: true,
        bundleId: simulatedBundleId,
        mint: mintAddress,
        slot: 471866000 + Math.floor(Math.random() * 50),
        jitoTipSol,
        devBuy: {
          sol: devSolBuy,
          tokens: Math.floor(devTokens)
        },
        subWallets: subWalletAllocations,
        totalTokensSniped: Math.floor(devTokens + subWalletAllocations.reduce((a, b) => a + b.tokensBought, 0)),
        curveSol: Number(currentCurveSol.toFixed(4)),
        bondingProgressPct: pumpfun.calculateProgress(currentCurveSol)
      };
    }

    // LIVE JITO BUNDLE EXECUTION
    try {
      const tipAccount = this.getRandomTipAccount();
      const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');

      // 1. Create Token & Dev Buy Transaction via PumpPortal API or direct instruction
      // PumpPortal /api/trade-local provides ready-to-sign serialized instructions for Pump.fun
      const createResponse = await axios.post(`${config.PUMPPORTAL_API}/trade-local`, {
        publicKey: walletManager.masterWallet.publicKey.toBase58(),
        action: 'create',
        tokenMetadata: {
          name: tokenName,
          symbol: tokenSymbol,
          uri: tokenMetadataUri
        },
        mint: mintAddress,
        denominatedInSol: 'true',
        amount: devSolBuy,
        slippage: 15,
        priorityFee: 0.0005,
        pool: 'pump'
      });

      const createTxBuf = Buffer.from(createResponse.data, 'base64');
      const createTx = Transaction.from(createTxBuf);
      createTx.sign(walletManager.masterWallet, mintKeypair);

      const serializedTxs = [bs58.encode(createTx.serialize())];

      // 2. Add Sub-Wallet Buy Transactions
      for (let i = 0; i < subWalletBuys.length; i++) {
        const buyAmount = subWalletBuys[i];
        if (buyAmount <= 0) continue;
        const buyer = walletManager.subWallets[i];
        if (!buyer) continue;

        const buyRes = await axios.post(`${config.PUMPPORTAL_API}/trade-local`, {
          publicKey: buyer.publicKey.toBase58(),
          action: 'buy',
          mint: mintAddress,
          denominatedInSol: 'true',
          amount: buyAmount,
          slippage: 20,
          priorityFee: 0.0001,
          pool: 'pump'
        });

        const buyTxBuf = Buffer.from(buyRes.data, 'base64');
        const buyTx = Transaction.from(buyTxBuf);
        buyTx.sign(buyer);
        serializedTxs.push(bs58.encode(buyTx.serialize()));
      }

      // 3. Jito Tip Transaction (atomic block inclusion guarantee)
      const tipTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: walletManager.masterWallet.publicKey,
          toPubkey: tipAccount,
          lamports: Math.floor(jitoTipSol * LAMPORTS_PER_SOL)
        })
      );
      tipTx.recentBlockhash = latestBlockhash.blockhash;
      tipTx.feePayer = walletManager.masterWallet.publicKey;
      tipTx.sign(walletManager.masterWallet);
      serializedTxs.push(bs58.encode(tipTx.serialize()));

      // 4. Send bundle to Jito Block Engine
      const bundlePayload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [serializedTxs]
      };

      const jitoRes = await axios.post(config.JITO_BLOCK_ENGINE_URL, bundlePayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      const bundleId = jitoRes.data.result;

      return {
        success: true,
        simulation: false,
        bundleId,
        mint: mintAddress,
        jitoTipSol,
        tipAccount: tipAccount.toBase58(),
        txCount: serializedTxs.length
      };
    } catch (err) {
      console.error('[Bundler] Error sending Jito bundle:', err.response?.data || err.message);
      throw new Error(`Jito bundle submission failed: ${err.response?.data?.message || err.message}`);
    }
  }

  // Check bundle status on Jito
  async checkBundleStatus(bundleId) {
    if (walletManager.simulationMode || bundleId.startsWith('jito_sim_')) {
      return { status: 'Landed', slot: 471866100, confirmations: 'max' };
    }
    try {
      const res = await axios.post(config.JITO_BLOCK_ENGINE_URL, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getBundleStatuses',
        params: [[bundleId]]
      });
      return res.data.result?.value?.[0] || { status: 'Pending' };
    } catch (e) {
      return { status: 'Unknown', error: e.message };
    }
  }
}

module.exports = new BundlerService();
