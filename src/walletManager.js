const fs = require('fs');
const path = require('path');
const {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const { readMintTokenBalances } = require('./tokenAccounts');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;
const config = require('./config');
const { rpc } = require('./rpc');

const DEFAULT_DATA_FILE = path.join(__dirname, '..', 'data', 'wallets.json');

class WalletManager {
  constructor(options = {}) {
    this.dataFile = options.dataFile || process.env.WALLETS_FILE || DEFAULT_DATA_FILE;
    this.connection = options.connection || rpc.connection;
    this.masterWallet = null;
    this.subWallets = [];
    this.simulationMode = options.simulationMode !== undefined ? options.simulationMode : config.SIMULATION_MODE;
    this.simulatedBalances = new Map();
    this.simPositions = {};
    this.liveBalanceCache = null;
    this.liveBalanceTtlMs = options.liveBalanceTtlMs || 5000;
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
    this.simPositions = data.simPositions && typeof data.simPositions === 'object' ? data.simPositions : {};
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
      const rounded = this.roundSol(bal);
      this.simulatedBalances.set(addr, rounded);
      simBalObj[addr] = rounded;
    }
    const data = {
      master: bs58.encode(this.masterWallet.secretKey),
      subWallets: this.subWallets.map(wallet => bs58.encode(wallet.secretKey)),
      simulatedBalances: simBalObj,
      simPositions: this.simPositions || {}
    };
    const tmp = `${this.dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.dataFile);
    fs.chmodSync(this.dataFile, 0o600);
  }

  roundSol(sol) {
    const amount = Number(sol);
    if (!Number.isFinite(amount)) return 0;
    return Math.round(amount * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
  }

  setSimSol(address, sol) {
    this.simulatedBalances.set(address, this.roundSol(Math.max(0, Number(sol) || 0)));
  }

  noteSimPositions(mint, entry) {
    if (!mint) return;
    if (!this.simPositions || typeof this.simPositions !== 'object') this.simPositions = {};
    this.simPositions[mint] = entry || { positions: {}, books: {} };
  }

  invalidateLiveBalances() {
    this.liveBalanceCache = null;
  }

  noteLiveSol(address, sol) {
    const key = this.walletList().map(wallet => wallet.publicKey.toBase58()).join('|');
    if (!this.liveBalanceCache || this.liveBalanceCache.key !== key || !this.liveBalanceCache.values) {
      this.liveBalanceCache = { at: Date.now(), key, values: {}, error: null };
    }
    this.liveBalanceCache.values[address] = sol;
    this.liveBalanceCache.at = Date.now();
    this.liveBalanceCache.error = null;
  }

  noteTokenBalance(address, mint, amount) {
    if (!this.tokenNotes) this.tokenNotes = new Map();
    this.tokenNotes.set(`${address}:${mint}`, { amount: Number(amount) || 0, at: Date.now() });
  }

  tokenBalanceOf(address, mint) {
    if (!this.tokenNotes) return null;
    const row = this.tokenNotes.get(`${address}:${mint}`);
    if (!row || Date.now() - row.at > 30000) return null;
    return row.amount;
  }

  walletList() {
    return [this.masterWallet, ...this.subWallets].filter(Boolean);
  }

  // One confirmed RPC read for every loaded wallet. A missing account is 0 SOL.
  // A failed or timed-out RPC leaves live balances null instead of inventing them.
  async readLiveSolMap(force = false) {
    const wallets = this.walletList();
    const key = wallets.map(wallet => wallet.publicKey.toBase58()).join('|');
    const now = Date.now();
    const cache = this.liveBalanceCache;
    const ttl = this.simulationMode ? Math.max(this.liveBalanceTtlMs, 60000) : this.liveBalanceTtlMs;
    if (!force && cache && cache.key === key && (now - cache.at) < ttl) {
      return cache;
    }
    try {
      const infos = await Promise.race([
        this.connection.getMultipleAccountsInfo(wallets.map(wallet => wallet.publicKey), 'confirmed'),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('RPC balance read timed out')), 8000);
        })
      ]);
      if (!Array.isArray(infos)) throw new Error('RPC balance read returned an unexpected result');
      const values = {};
      wallets.forEach((wallet, index) => {
        const info = infos[index];
        const lamports = info && Number.isFinite(info.lamports) ? info.lamports : 0;
        values[wallet.publicKey.toBase58()] = lamports / LAMPORTS_PER_SOL;
      });
      this.liveBalanceCache = { at: now, key, values, error: null };
    } catch (err) {
      this.liveBalanceCache = { at: now, key, values: null, error: err.message || 'RPC balance read failed' };
    }
    return this.liveBalanceCache;
  }

  simBalanceOf(address) {
    if (this.simulatedBalances.has(address)) return Number(this.simulatedBalances.get(address));
    if (this.simulationMode && this.masterWallet && address === this.masterWallet.publicKey.toBase58()) return 15;
    return 0;
  }

  balanceFields(address, liveMap) {
    const simBalance = this.simBalanceOf(address);
    let liveBalance = null;
    let liveError = null;
    if (!liveMap || liveMap.error || !liveMap.values || !Object.prototype.hasOwnProperty.call(liveMap.values, address)) {
      liveError = (liveMap && liveMap.error) || 'Live balance unavailable';
    } else {
      liveBalance = liveMap.values[address];
    }
    return {
      simBalance,
      liveBalance,
      liveError,
      balance: this.simulationMode ? simBalance : liveBalance
    };
  }

  async balanceBook() {
    const liveMap = await this.readLiveSolMap();
    const rows = this.walletList().map(wallet => ({
      address: wallet.publicKey.toBase58(),
      ...this.balanceFields(wallet.publicKey.toBase58(), liveMap)
    }));
    const simBalance = rows.reduce((sum, row) => sum + row.simBalance, 0);
    const liveKnown = rows.length > 0 && rows.every(row => row.liveBalance != null && Number.isFinite(row.liveBalance));
    const liveBalance = liveKnown ? rows.reduce((sum, row) => sum + row.liveBalance, 0) : null;
    return {
      rows,
      totals: {
        simBalance,
        liveBalance,
        liveError: liveKnown ? null : ((liveMap && liveMap.error) || 'Live balance unavailable'),
        balance: this.simulationMode ? simBalance : liveBalance
      }
    };
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
    const book = await this.balanceBook();
    const master = book.rows[0] || this.balanceFields(this.masterWallet.publicKey.toBase58(), { error: 'No master wallet' });
    return {
      address: master.address,
      balance: master.balance,
      simBalance: master.simBalance,
      liveBalance: master.liveBalance,
      liveError: master.liveError,
      simulation: this.simulationMode,
      totals: book.totals
    };
  }

  async getSubWalletsInfo(tokenMint = null) {
    const book = await this.balanceBook();
    const byAddress = new Map(book.rows.map(row => [row.address, row]));
    const missing = [];
    if (!this.simulationMode && tokenMint) {
      for (const wallet of this.subWallets) {
        const address = wallet.publicKey.toBase58();
        if (this.tokenBalanceOf(address, tokenMint) == null) missing.push(address);
      }
    }
    let fetched = new Map();
    if (missing.length) {
      try {
        fetched = await readMintTokenBalances(this.connection, missing, tokenMint);
      } catch (err) {
        fetched = new Map();
      }
    }
    const list = [];
    for (let i = 0; i < this.subWallets.length; i++) {
      const wallet = this.subWallets[i];
      const address = wallet.publicKey.toBase58();
      const fields = byAddress.get(address) || this.balanceFields(address, { error: 'Live balance unavailable' });
      let tokenBalance = 0;

      if (!this.simulationMode && tokenMint) {
        const noted = this.tokenBalanceOf(address, tokenMint);
        if (noted != null) {
          tokenBalance = noted;
        } else {
          const balance = fetched.get(address);
          tokenBalance = balance ? balance.ui : 0;
        }
      }

      list.push({
        index: i + 1,
        address,
        solBalance: fields.balance,
        simBalance: fields.simBalance,
        liveBalance: fields.liveBalance,
        liveError: fields.liveError,
        balance: fields.balance,
        tokenBalance
      });
    }
    list.totals = book.totals;
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
    this.invalidateLiveBalances();
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
    this.invalidateLiveBalances();
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
