const {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const config = require('./config');
const pumpfun = require('./pumpfun');
const walletManager = require('./walletManager');
const { ValidationError, planBundleChunks, requireLaunchAmounts } = require('./validation');
const {
  fetchBundleVersionedTxs,
  fetchSingleVersionedTx,
  sendBundle,
  pollBundleUntilSettled
} = require('./portalTx');

class BundlerService {
  constructor() {
    this.connection = walletManager.connection;
    this.wsBroadcaster = null;
  }

  setBroadcaster(fn) {
    this.wsBroadcaster = fn;
  }

  getRandomTipAccount() {
    const list = config.JITO_TIP_ACCOUNTS;
    const choice = list[Math.floor(Math.random() * list.length)];
    return new PublicKey(choice);
  }

  async preflightCheck({ devSolBuy, subWalletBuys, jitoTipSol }) {
    const devInfo = await walletManager.getMasterInfo();
    const subWallets = await walletManager.getSubWalletsInfo();

    const issues = [];
    const neededDevSol = devSolBuy + jitoTipSol + 0.04;
    if (devInfo.balance == null || !Number.isFinite(Number(devInfo.balance))) {
      issues.push(`Master balance unavailable${devInfo.liveError ? `: ${devInfo.liveError}` : ''}`);
    } else if (devInfo.balance < neededDevSol) {
      issues.push(`Master Dev wallet has ${devInfo.balance.toFixed(3)} SOL, needs ${neededDevSol.toFixed(3)} SOL (Buy + Rent + Jito Tip)`);
    }

    let totalSubSol = 0;
    subWalletBuys.forEach((amount, i) => {
      totalSubSol += amount;
      const wallet = subWallets[i];
      if (amount > 0 && !wallet) {
        issues.push(`Sub-wallet #${i + 1} does not exist for a ${amount} SOL buy`);
      }
      if (wallet && (wallet.solBalance == null || !Number.isFinite(Number(wallet.solBalance)))) {
        issues.push(`Sub-wallet #${i + 1} balance unavailable${wallet.liveError ? `: ${wallet.liveError}` : ''}`);
      } else if (wallet && wallet.solBalance < amount + (amount > 0 ? 0.005 : 0)) {
        issues.push(`Sub-wallet #${i + 1} (${wallet.address.slice(0, 6)}...) has ${wallet.solBalance.toFixed(3)} SOL, needs ${(amount + 0.005).toFixed(3)} SOL`);
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

  tradeBody({ publicKey, action, mint, amount, metadata }) {
    const body = {
      publicKey,
      action,
      mint,
      denominatedInSol: 'true',
      amount,
      slippage: config.SLIPPAGE_PCT,
      priorityFee: config.PRIORITY_FEE_SOL,
      pool: 'pump'
    };
    if (action === 'create') body.tokenMetadata = metadata;
    return body;
  }

  async buildTipTransaction(lamports) {
    const tipAccount = this.getRandomTipAccount();
    const latest = await this.connection.getLatestBlockhash('confirmed');
    const tipTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: walletManager.masterWallet.publicKey,
        toPubkey: tipAccount,
        lamports
      })
    );
    tipTx.recentBlockhash = latest.blockhash;
    tipTx.feePayer = walletManager.masterWallet.publicKey;
    tipTx.sign(walletManager.masterWallet);
    return {
      tipAccount: tipAccount.toBase58(),
      encoded: Buffer.from(tipTx.serialize()).toString('base64')
    };
  }

  async buildChunkTransactions(descs) {
    const errors = [];
    let txs = null;
    try {
      txs = await fetchBundleVersionedTxs(descs.map(desc => desc.body));
    } catch (bundleErr) {
      txs = [];
      for (const desc of descs) {
        try {
          txs.push(await fetchSingleVersionedTx(desc.body));
        } catch (err) {
          errors.push({
            wallet: desc.publicKey,
            action: desc.action,
            index: desc.walletIndex,
            error: err.message
          });
        }
      }
      if (errors.length) {
        const error = new Error(
          `Failed to build ${errors.length} bundle transaction(s): ` +
          errors.map(item => `${item.action} ${item.wallet}: ${item.error}`).join('; ') +
          `. Bundle request error: ${bundleErr.message}`
        );
        error.details = errors;
        error.statusCode = 502;
        throw error;
      }
    }

    descs.forEach((desc, index) => {
      const signers = desc.action === 'create'
        ? [desc.mintKeypair, desc.keypair]
        : [desc.keypair];
      txs[index].sign(signers);
    });
    return txs.map(tx => Buffer.from(tx.serialize()).toString('base64'));
  }

  async submitChunk(descs, jitoTipSol, label) {
    const encodedUsers = await this.buildChunkTransactions(descs);
    const perBundleTip = jitoTipSol;
    const tip = await this.buildTipTransaction(Math.floor(perBundleTip * LAMPORTS_PER_SOL));
    const encoded = encodedUsers.concat(tip.encoded);
    if (encoded.length > config.JITO_MAX_TXS) {
      throw new Error(`Refusing to submit a Jito bundle of ${encoded.length} transactions (max ${config.JITO_MAX_TXS})`);
    }
    const bundleId = await sendBundle(encoded);
    const settled = await pollBundleUntilSettled(bundleId);
    if (!settled.landed) {
      const error = new Error(`Jito bundle ${bundleId} (${label}) did not land: ${settled.status}`);
      error.statusCode = 502;
      error.bundleId = bundleId;
      throw error;
    }
    return {
      bundleId,
      status: 'Landed',
      label,
      txCount: encoded.length,
      tipAccount: tip.tipAccount,
      slot: settled.details && settled.details.slot,
      wallets: descs.map(desc => ({
        action: desc.action,
        walletIndex: desc.walletIndex,
        publicKey: desc.publicKey,
        sol: desc.sol
      }))
    };
  }

  describeBuys({ mintAddress, mintKeypair, tokenName, tokenSymbol, tokenMetadataUri, devSolBuy, subWalletBuys }) {
    const metadata = { name: tokenName, symbol: tokenSymbol, uri: tokenMetadataUri || '' };
    const descs = [{
      action: 'create',
      publicKey: walletManager.masterWallet.publicKey.toBase58(),
      keypair: walletManager.masterWallet,
      mintKeypair,
      walletIndex: 0,
      sol: devSolBuy,
      body: this.tradeBody({
        publicKey: walletManager.masterWallet.publicKey.toBase58(),
        action: 'create',
        mint: mintAddress,
        amount: devSolBuy,
        metadata
      })
    }];
    const subErrors = [];
    for (let i = 0; i < subWalletBuys.length; i++) {
      const buyAmount = subWalletBuys[i];
      if (!(buyAmount > 0)) continue;
      const buyer = walletManager.subWallets[i];
      if (!buyer) {
        subErrors.push({ walletIndex: i + 1, error: 'Sub-wallet does not exist' });
        continue;
      }
      descs.push({
        action: 'buy',
        publicKey: buyer.publicKey.toBase58(),
        keypair: buyer,
        walletIndex: i + 1,
        sol: buyAmount,
        body: this.tradeBody({
          publicKey: buyer.publicKey.toBase58(),
          action: 'buy',
          mint: mintAddress,
          amount: buyAmount
        })
      });
    }
    if (subErrors.length) {
      const error = new Error('Sub-wallet bundle setup failed: ' + subErrors.map(item => `#${item.walletIndex} ${item.error}`).join('; '));
      error.details = subErrors;
      error.statusCode = 400;
      throw error;
    }
    return descs;
  }

  async launchBundle({
    tokenName,
    tokenSymbol,
    tokenDescription,
    tokenMetadataUri,
    devSolBuy = 0.05,
    subWalletBuys = [],
    jitoTipSol = config.DEFAULT_JITO_TIP,
    subWalletDelaySec = 0
  }) {
    const amounts = requireLaunchAmounts({ devSolBuy, subWalletBuys, jitoTipSol });
    devSolBuy = amounts.devSolBuy;
    subWalletBuys = amounts.subWalletBuys;
    jitoTipSol = amounts.jitoTipSol;

    const check = await this.preflightCheck({ devSolBuy, subWalletBuys, jitoTipSol });
    if (!check.passed) {
      const error = new ValidationError(`Preflight failed: ${check.issues.join('; ')}`);
      error.issues = check.issues;
      throw error;
    }

    const isSim = walletManager.simulationMode;
    const mintKeypair = Keypair.generate();
    const mintAddress = mintKeypair.publicKey.toBase58();
    const delaySec = Math.max(0, Math.min(10, parseFloat(subWalletDelaySec || '0') || 0));

    console.log(`[Bundler] Preparing launch bundle for ${tokenSymbol} (${mintAddress}) | subWalletDelay: ${delaySec}s...`);

    if (isSim) {
      const devInfo = await walletManager.getMasterInfo();
      const devAddr = devInfo.address;

      let currentCurveSol = 0;
      const devTokens = pumpfun.calculateBuyOutput(devSolBuy, currentCurveSol);
      currentCurveSol += devSolBuy;

      const totalDevSpend = devSolBuy + jitoTipSol + 0.02;
      walletManager.simulatedBalances.set(devAddr, Math.max(0, (devInfo.balance - totalDevSpend)));

      const firstBlockSlot = 471866000 + Math.floor(Math.random() * 50);

      if (delaySec > 0) {
        if (this.wsBroadcaster) {
          this.wsBroadcaster({
            type: 'LAUNCH_STEP_DEV',
            payload: {
              mint: mintAddress,
              tokenSymbol,
              devSolBuy,
              devTokens: Math.floor(devTokens),
              slot: firstBlockSlot,
              delaySec,
              message: `Simulation: dev buy prepared. Sub-wallets wait ${delaySec}s. No transaction was sent.`
            }
          });
        }
        await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
      }

      const subWalletAllocations = [];
      subWalletBuys.forEach((buySol, idx) => {
        if (buySol <= 0) return;
        const tokens = pumpfun.calculateBuyOutput(buySol, currentCurveSol);
        currentCurveSol += buySol;
        subWalletAllocations.push({
          walletIndex: idx + 1,
          solSpent: buySol,
          tokensBought: Math.floor(tokens),
          landed: true
        });
      });

      subWalletBuys.forEach((buySol, idx) => {
        const wallet = walletManager.subWallets[idx];
        if (wallet) {
          const prev = walletManager.simulatedBalances.get(wallet.publicKey.toBase58()) || 0;
          walletManager.simulatedBalances.set(wallet.publicKey.toBase58(), Math.max(0, prev - buySol));
        }
      });
      walletManager.save();

      const simulatedBundleId = 'jito_sim_' + Buffer.from(mintKeypair.publicKey.toBytes()).toString('hex').slice(0, 32);

      return {
        success: true,
        simulation: true,
        bundleId: simulatedBundleId,
        bundles: [{ bundleId: simulatedBundleId, status: 'Landed', txCount: 1 }],
        mint: mintAddress,
        slot: firstBlockSlot + (delaySec > 0 ? Math.ceil(delaySec * 2.5) : 0),
        jitoTipSol,
        subWalletDelaySec: delaySec,
        devBuy: {
          sol: devSolBuy,
          tokens: Math.floor(devTokens)
        },
        subWallets: subWalletAllocations,
        totalTokensSniped: Math.floor(devTokens + subWalletAllocations.reduce((sum, row) => sum + row.tokensBought, 0)),
        curveSol: Number(currentCurveSol.toFixed(4)),
        bondingProgressPct: pumpfun.calculateProgress(currentCurveSol),
        tokenDescription: tokenDescription || ''
      };
    }

    const descs = this.describeBuys({
      mintAddress,
      mintKeypair,
      tokenName,
      tokenSymbol,
      tokenMetadataUri,
      devSolBuy,
      subWalletBuys
    });

    const chunkDescriptors = (list) => {
      if (!list.length) return [];
      return planBundleChunks(list.length).map(chunk => list.slice(chunk.start, chunk.start + chunk.userCount));
    };
    const planned = delaySec > 0
      ? [descs.slice(0, 1)].concat(chunkDescriptors(descs.slice(1)))
      : chunkDescriptors(descs);

    const bundles = [];
    const subErrors = [];
    try {
      for (let i = 0; i < planned.length; i++) {
        if (i === 1 && delaySec > 0) {
          if (this.wsBroadcaster) {
            this.wsBroadcaster({
              type: 'LAUNCH_STEP_DEV',
              payload: {
                mint: mintAddress,
                tokenSymbol,
                devSolBuy,
                delaySec,
                bundleId: bundles[0] && bundles[0].bundleId,
                message: `Dev bundle landed. Waiting ${delaySec}s before sub-wallet bundles.`
              }
            });
          }
          await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
        }
        const landed = await this.submitChunk(planned[i], jitoTipSol, `chunk-${i + 1}`);
        bundles.push(landed);
      }
    } catch (err) {
      console.error('[Bundler] Error sending Jito bundle:', err.message);
      const wrapped = new Error(`Jito bundle submission failed: ${err.message}`);
      wrapped.statusCode = err.statusCode || 502;
      wrapped.bundles = bundles;
      wrapped.mint = mintAddress;
      wrapped.subWalletErrors = err.details || subErrors;
      throw wrapped;
    }

    let currentCurveSol = 0;
    const devTokens = Math.floor(pumpfun.calculateBuyOutput(devSolBuy, currentCurveSol));
    currentCurveSol += devSolBuy;
    const subWalletAllocations = [];
    for (const desc of descs) {
      if (desc.action !== 'buy') continue;
      const tokens = Math.floor(pumpfun.calculateBuyOutput(desc.sol, currentCurveSol));
      currentCurveSol += desc.sol;
      subWalletAllocations.push({
        walletIndex: desc.walletIndex,
        solSpent: desc.sol,
        tokensBought: tokens,
        landed: true
      });
    }

    return {
      success: true,
      simulation: false,
      bundleId: bundles[0] && bundles[0].bundleId,
      bundles,
      mint: mintAddress,
      slot: bundles.map(bundle => bundle.slot).find(slot => slot != null) || null,
      jitoTipSol,
      subWalletDelaySec: delaySec,
      tipAccount: bundles[0] && bundles[0].tipAccount,
      txCount: bundles.reduce((sum, bundle) => sum + bundle.txCount, 0),
      devBuy: { sol: devSolBuy, tokens: devTokens, estimated: true },
      subWallets: subWalletAllocations,
      atomic: planned.length === 1,
      subWalletErrors: []
    };
  }

  async checkBundleStatus(bundleId) {
    if (walletManager.simulationMode || String(bundleId || '').startsWith('jito_sim_')) {
      return { status: 'Landed', slot: 471866100, confirmations: 'max' };
    }
    return pollBundleUntilSettled(bundleId);
  }
}

module.exports = new BundlerService();
