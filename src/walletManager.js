const fs = require('fs');
const path = require('path');
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  getAccount
} = require('@solana/spl-token');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;
const config = require('./config');

const DEFAULT_DATA_FILE = path.join(__dirname, '..', 'data', 'wallets.json');

class WalletManager {
  constructor(options = {}) {
    this.dataFile = options.dataFile || process.env.WALLETS_FILE || DEFAULT_DATA_FILE;
    const connectionConfig = { commitment: 'confirmed' };
    if (config.HELIUS_WS_URL) connectionConfig.wsEndpoint = config.HELIUS_WS_URL;
    this.connection = options.connection || new Connection(config.HELIUS_RPC_URL, connectionConfig);
    this.masterWallet = null;
    this.subWallets = [];
    this.simulationMode = options.simulationMode !== undefined ? options.simulationMode : config.SIMULATION_MODE;
    this.simulatedBalances = new Map();
    if (!options.skipInit) this.init();
  }

  setSimulationMode(val) {
    if (typeof val !== 'boolean') {
      throw new Error('Simulation mode must be a boolean');
    }
    this.simulationMode = val;
  }

  init() {
    if (fs.existsSync(this.dataFile)) {
      this.loadOrThrow();
    } else {
      this.masterWallet = Keypair.generate();
      this.subWallets = Array.from({ length: 6 }, () => Keypair.generate());
    }
    this.ensureSimBalances();
    this.save();
  }

  loadOrThrow() {
    let raw;
    try {
      raw = fs.readFileSync(this.dataFile, 'utf8');
    } catch (err) {
      throw new Error(`Refusing to start: could not read ${this.dataFile}: ${err.message}`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Refusing to start: ${this.dataFile} exists but is not valid JSON (${err.message}). It was not overwritten.`);
    }
    if (!data || typeof data !== 'object' || typeof data.master !== 'string' || !Array.isArray(data.subWallets)) {
      throw new Error(`Refusing to start: ${this.dataFile} is missing master or subWallets. It was not overwritten.`);
    }
    try {
      this.masterWallet = Keypair.fromSecretKey(bs58.decode(data.master));
      this.subWallets = data.subWallets.map(secret => Keypair.fromSecretKey(bs58.decode(secret)));
    } catch (err) {
      throw new Error(`Refusing to start: ${this.dataFile} contains invalid wallet keys (${err.message}). It was not overwritten.`);
    }
    this.simulatedBalances = new Map();
    if (data.simulatedBalances && typeof data.simulatedBalances === 'object') {
      for (const [addr, bal] of Object.entries(data.simulatedBalances)) {
        const amount = Number(bal);
        if (Number.isFinite(amount)) this.simulatedBalances.set(addr, amount);
      }
    }
  }

  ensureSimBalances() {
    if (!this.simulationMode || !this.masterWallet) return;
    const masterAddr = this.masterWallet.publicKey.toBase58();
    if (!this.simulatedBalances.has(masterAddr)) {
      this.simulatedBalances.set(masterAddr, 15.0);
    }
    for (const wallet of this.subWallets) {
      const addr = wallet.publicKey.toBase58();
      if (!this.simulatedBalances.has(addr)) {
        this.simulatedBalances.set(addr, 0.2);
      }
    }
  }

  save() {
    const dir = path.dirname(this.dataFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch (err) { /* ignore */ }
    const backupDir = path.join(dir, 'backups');
    if (fs.existsSync(this.dataFile)) {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `wallets-${stamp}-${process.pid}.json`);
      fs.copyFileSync(this.dataFile, backupPath);
      fs.chmodSync(backupPath, 0o600);
    }
    const simBalObj = {};
    for (const [addr, bal] of this.simulatedBalances.entries()) {
      simBalObj[addr] = Number(bal);
    }
    const data = {
      master: bs58.encode(this.masterWallet.secretKey),
      subWallets: this.subWallets.map(wallet => bs58.encode(wallet.secretKey)),
      simulatedBalances: simBalObj
    };
    const tmp = `${this.dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.dataFile);
    fs.chmodSync(this.dataFile, 0o600);
  }

  async solBalanceOf(keypair) {
    const address = keypair.publicKey.toBase58();
    if (this.simulationMode) {
      return Number(this.simulatedBalances.get(address) || 0);
    }
    const lamports = await this.connection.getBalance(keypair.publicKey, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  }

  async assertReplaceAllowed(wallets, force) {
    if (force === true) return;
    const funded = [];
    for (const wallet of wallets) {
      const balance = await this.solBalanceOf(wallet);
      if (balance > 0) {
        funded.push(`${wallet.publicKey.toBase58()} (${balance} SOL)`);
      }
    }
    if (funded.length) {
      const err = new Error(`Refusing to replace wallets with a nonzero SOL balance: ${funded.join(', ')}. Confirm and pass force=true to override.`);
      err.statusCode = 409;
      throw err;
    }
  }

  async importMasterKey(keyString, force = false) {
    if (this.masterWallet) await this.assertReplaceAllowed([this.masterWallet], force);
    const trimmed = String(keyString || '').trim();
    let secretKey;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      secretKey = Uint8Array.from(JSON.parse(trimmed));
    } else {
      secretKey = bs58.decode(trimmed);
    }
    const next = Keypair.fromSecretKey(secretKey);
    this.masterWallet = next;
    this.save();
    return this.masterWallet.publicKey.toBase58();
  }

  async generateNewMaster(force = false) {
    if (this.masterWallet) await this.assertReplaceAllowed([this.masterWallet], force);
    this.masterWallet = Keypair.generate();
    if (this.simulationMode) {
      this.simulatedBalances.set(this.masterWallet.publicKey.toBase58(), 15.0);
    }
    this.save();
    return this.masterWallet.publicKey.toBase58();
  }

  async generateSubWallets(count = 6, force = false) {
    await this.assertReplaceAllowed(this.subWallets, force);
    const target = Math.max(1, Math.min(Number(count) || 6, 24));
    const next = [];
    for (let i = 0; i < target; i++) {
      const keypair = Keypair.generate();
      next.push(keypair);
      if (this.simulationMode && !this.simulatedBalances.has(keypair.publicKey.toBase58())) {
        this.simulatedBalances.set(keypair.publicKey.toBase58(), 0.2);
      }
    }
    this.subWallets = next;
    this.save();
    return this.subWallets.map(wallet => wallet.publicKey.toBase58());
  }

  resolveSigner(address) {
    if (!address || !this.masterWallet) return null;
    if (this.masterWallet.publicKey.toBase58() === address) return this.masterWallet;
    return this.subWallets.find(wallet => wallet.publicKey.toBase58() === address) || null;
  }

  async getMasterInfo() {
    const address = this.masterWallet.publicKey.toBase58();
    let balance = 0;
    if (this.simulationMode) {
      balance = this.simulatedBalances.get(address);
      if (balance === undefined) balance = 15.0;
    } else {
      try {
        const lamports = await this.connection.getBalance(this.masterWallet.publicKey);
        balance = lamports / LAMPORTS_PER_SOL;
      } catch (err) {
        console.warn('Failed to fetch real master balance, using 0:', err.message);
      }
    }

    return {
      address,
      balance,
      simulation: this.simulationMode
    };
  }

  async getSubWalletsInfo(tokenMint = null) {
    const list = [];
    for (let i = 0; i < this.subWallets.length; i++) {
      const wallet = this.subWallets[i];
      const address = wallet.publicKey.toBase58();
      let solBalance = 0;
      let tokenBalance = 0;

      if (this.simulationMode) {
        solBalance = this.simulatedBalances.get(address) || 0.0;
        tokenBalance = 0;
      } else {
        try {
          const lamports = await this.connection.getBalance(wallet.publicKey);
          solBalance = lamports / LAMPORTS_PER_SOL;
        } catch (e) {
          solBalance = 0;
        }

        if (tokenMint) {
          try {
            const mintPubkey = new PublicKey(tokenMint);
            const ata = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey);
            const acc = await getAccount(this.connection, ata);
            tokenBalance = Number(acc.amount);
          } catch (e) {
            tokenBalance = 0;
          }
        }
      }

      list.push({
        index: i + 1,
        address,
        solBalance,
        tokenBalance
      });
    }

    return list;
  }

  async disperseSol(totalSol, randomize = false, deviationPct = 20) {
    if (!this.masterWallet) throw new Error('No master wallet configured');
    if (this.subWallets.length === 0) throw new Error('No sub-wallets to fund');

    const count = this.subWallets.length;
    let allocations = [];

    if (!randomize) {
      const equalShare = totalSol / count;
      allocations = Array(count).fill(equalShare);
    } else {
      const rawWeights = [];
      for (let i = 0; i < count; i++) {
        const factor = 1 + ((Math.random() * 2 - 1) * (deviationPct / 100));
        rawWeights.push(Math.max(0.01, factor));
      }
      const sum = rawWeights.reduce((a, b) => a + b, 0);
      allocations = rawWeights.map(weight => (weight / sum) * totalSol);
    }

    if (this.simulationMode) {
      const masterAddr = this.masterWallet.publicKey.toBase58();
      const masterBal = this.simulatedBalances.get(masterAddr) || 15.0;
      if (masterBal < totalSol + 0.01) {
        throw new Error(`Insufficient simulated balance. Have ${masterBal.toFixed(3)} SOL, need ${totalSol} SOL`);
      }
      this.simulatedBalances.set(masterAddr, masterBal - totalSol);
      allocations.forEach((sol, idx) => {
        const addr = this.subWallets[idx].publicKey.toBase58();
        const prev = this.simulatedBalances.get(addr) || 0;
        this.simulatedBalances.set(addr, prev + sol);
      });
      this.save();

      return {
        success: true,
        simulation: true,
        txs: ['SIMULATED_DISPERSE_TX_' + Date.now()],
        allocations: allocations.map((sol, i) => ({
          wallet: this.subWallets[i].publicKey.toBase58(),
          sol: Number(sol.toFixed(4))
        }))
      };
    }

    const tx = new Transaction();
    for (let i = 0; i < count; i++) {
      const target = this.subWallets[i].publicKey;
      const lamports = Math.floor(allocations[i] * LAMPORTS_PER_SOL);
      if (lamports > 0) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: this.masterWallet.publicKey,
            toPubkey: target,
            lamports
          })
        );
      }
    }

    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.masterWallet]);
    return {
      success: true,
      simulation: false,
      txSignature: sig,
      allocations: allocations.map((sol, i) => ({
        wallet: this.subWallets[i].publicKey.toBase58(),
        sol: Number(sol.toFixed(4))
      }))
    };
  }

  async drainSol() {
    if (!this.masterWallet) throw new Error('No master wallet configured');
    const masterPubkey = this.masterWallet.publicKey;

    if (this.simulationMode) {
      let drained = 0;
      const results = [];
      for (const wallet of this.subWallets) {
        const addr = wallet.publicKey.toBase58();
        const bal = this.simulatedBalances.get(addr) || 0;
        drained += bal;
        this.simulatedBalances.set(addr, 0.0);
        results.push({ address: addr, success: true, sol: Number(bal.toFixed(4)) });
      }
      const masterAddr = masterPubkey.toBase58();
      const currentMaster = this.simulatedBalances.get(masterAddr) || 15.0;
      this.simulatedBalances.set(masterAddr, currentMaster + drained);
      this.save();

      return {
        success: true,
        simulation: true,
        drainedSol: Number(drained.toFixed(4)),
        reclaimedCount: results.filter(row => row.sol > 0).length,
        results,
        note: 'SOL only. Token balances are not transferred.'
      };
    }

    const results = [];
    let totalDrained = 0;
    const feeBuffer = 5000;

    for (const wallet of this.subWallets) {
      const address = wallet.publicKey.toBase58();
      try {
        const balance = await this.connection.getBalance(wallet.publicKey);
        if (balance <= feeBuffer * 2) {
          results.push({ address, success: true, skipped: true, sol: 0 });
          continue;
        }
        const drainAmount = balance - feeBuffer;
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: masterPubkey,
            lamports: drainAmount
          })
        );
        const sig = await sendAndConfirmTransaction(this.connection, tx, [wallet]);
        const sol = drainAmount / LAMPORTS_PER_SOL;
        totalDrained += sol;
        results.push({ address, success: true, sol: Number(sol.toFixed(6)), signature: sig });
      } catch (err) {
        console.error(`Failed to drain wallet ${address}:`, err.message);
        results.push({ address, success: false, error: err.message });
      }
    }

    const failed = results.filter(row => row.success === false);
    return {
      success: failed.length === 0,
      simulation: false,
      drainedSol: Number(totalDrained.toFixed(4)),
      signatures: results.filter(row => row.signature).map(row => row.signature),
      results,
      failed: failed.length,
      note: 'SOL only. Token balances are not transferred.'
    };
  }

  async reclaimRentAndRewards(mintAddress = null) {
    if (!this.masterWallet) throw new Error('No master wallet configured');
    const isSim = this.simulationMode;
    const masterAddr = this.masterWallet.publicKey.toBase58();
    const allWallets = [this.masterWallet, ...this.subWallets];

    if (isSim) {
      const closedAccounts = allWallets.length;
      const rentPerAccount = 0.00203928;
      const reclaimedRentSol = Number((closedAccounts * rentPerAccount).toFixed(5));
      const creatorRewardSol = 0.5;
      const totalReclaimedSol = Number((reclaimedRentSol + creatorRewardSol).toFixed(5));

      const prevBal = this.simulatedBalances.get(masterAddr) || 15.0;
      this.simulatedBalances.set(masterAddr, prevBal + totalReclaimedSol);
      this.save();

      return {
        success: true,
        simulation: true,
        accountsClosed: closedAccounts,
        reclaimedRentSol,
        creatorRewardSol,
        totalReclaimedSol,
        recipient: masterAddr,
        message: `Simulation only: credited ${reclaimedRentSol} SOL estimated ATA rent across ${closedAccounts} accounts + ${creatorRewardSol} SOL estimated creator reward to the master wallet.`
      };
    }

    const { createCloseAccountInstruction } = require('@solana/spl-token');
    let totalRentLamports = 0;
    let closedCount = 0;
    const signatures = [];
    const results = [];

    for (const kp of allWallets) {
      try {
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
          kp.publicKey,
          { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
        );

        for (const { pubkey, account } of tokenAccounts.value) {
          const parsedInfo = account.data.parsed.info;
          const tokenAmount = parsedInfo.tokenAmount.uiAmount;
          const accountMint = parsedInfo.mint;

          if (tokenAmount === 0 && (!mintAddress || accountMint === mintAddress)) {
            const tx = new Transaction().add(
              createCloseAccountInstruction(
                pubkey,
                this.masterWallet.publicKey,
                kp.publicKey
              )
            );
            const sig = await sendAndConfirmTransaction(this.connection, tx, [kp]);
            signatures.push(sig);
            closedCount++;
            totalRentLamports += 2039280;
          }
        }
        results.push({ address: kp.publicKey.toBase58(), success: true });
      } catch (err) {
        console.warn(`Rent reclaim notice for ${kp.publicKey.toBase58().slice(0, 6)}:`, err.message);
        results.push({ address: kp.publicKey.toBase58(), success: false, error: err.message });
      }
    }

    const reclaimedRentSol = totalRentLamports / LAMPORTS_PER_SOL;
    const failed = results.filter(row => row.success === false);
    return {
      success: failed.length === 0,
      simulation: false,
      accountsClosed: closedCount,
      reclaimedRentSol,
      recipient: masterAddr,
      signatures,
      results,
      message: `Reclaimed ${reclaimedRentSol.toFixed(5)} SOL from ${closedCount} closed token accounts into the master wallet.`
    };
  }

  exportAll() {
    return {
      master: {
        address: this.masterWallet.publicKey.toBase58(),
        secretKey: bs58.encode(this.masterWallet.secretKey)
      },
      subWallets: this.subWallets.map((wallet, idx) => ({
        index: idx + 1,
        address: wallet.publicKey.toBase58(),
        secretKey: bs58.encode(wallet.secretKey)
      }))
    };
  }
}

const singleton = new WalletManager();
singleton.WalletManager = WalletManager;
module.exports = singleton;
