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
  createTransferInstruction,
  getAccount
} = require('@solana/spl-token');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;
const config = require('./config');

const DATA_FILE = path.join(__dirname, '..', 'data', 'wallets.json');

class WalletManager {
  constructor() {
    this.connection = new Connection(config.HELIUS_RPC_URL, {
      commitment: 'confirmed',
      wsEndpoint: config.HELIUS_WS_URL
    });
    this.masterWallet = null;
    this.subWallets = [];
    this.simulationMode = config.SIMULATION_MODE;
    this.simulatedBalances = new Map(); // address -> sol balance
    this.init();
  }

  setSimulationMode(val) {
    this.simulationMode = Boolean(val);
  }

  init() {
    if (fs.existsSync(DATA_FILE)) {
      try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data.master) {
          this.masterWallet = Keypair.fromSecretKey(bs58.decode(data.master));
        }
        if (Array.isArray(data.subWallets)) {
          this.subWallets = data.subWallets.map(sk => Keypair.fromSecretKey(bs58.decode(sk)));
        }
        if (data.simulatedBalances && typeof data.simulatedBalances === 'object') {
          for (const [addr, bal] of Object.entries(data.simulatedBalances)) {
            this.simulatedBalances.set(addr, Number(bal));
          }
        }
      } catch (err) {
        console.error('Error loading wallets from file:', err);
      }
    }

    // Default generate if not existing
    if (!this.masterWallet) {
      this.masterWallet = Keypair.generate();
    }
    if (this.subWallets.length === 0) {
      this.generateSubWallets(6);
    }

    // Ensure simulation balances exist and persist
    if (this.simulationMode) {
      const masterAddr = this.masterWallet.publicKey.toBase58();
      if (!this.simulatedBalances.has(masterAddr)) {
        this.simulatedBalances.set(masterAddr, 15.0);
      }
      for (const w of this.subWallets) {
        const addr = w.publicKey.toBase58();
        if (!this.simulatedBalances.has(addr)) {
          this.simulatedBalances.set(addr, 0.2); // Default mock allocation so sub-wallets never read 0
        }
      }
    }
    this.save();
  }

  save() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const simBalObj = {};
    for (const [addr, bal] of this.simulatedBalances.entries()) {
      simBalObj[addr] = Number(bal);
    }
    const data = {
      master: bs58.encode(this.masterWallet.secretKey),
      subWallets: this.subWallets.map(w => bs58.encode(w.secretKey)),
      simulatedBalances: simBalObj
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  }

  importMasterKey(keyString) {
    keyString = keyString.trim();
    let secretKey;
    if (keyString.startsWith('[') && keyString.endsWith(']')) {
      secretKey = Uint8Array.from(JSON.parse(keyString));
    } else {
      secretKey = bs58.decode(keyString);
    }
    this.masterWallet = Keypair.fromSecretKey(secretKey);
    this.save();
    return this.masterWallet.publicKey.toBase58();
  }

  generateNewMaster() {
    this.masterWallet = Keypair.generate();
    if (this.simulationMode) {
      this.simulatedBalances.set(this.masterWallet.publicKey.toBase58(), 15.0);
    }
    this.save();
    return this.masterWallet.publicKey.toBase58();
  }

  generateSubWallets(count = 6) {
    const target = Math.max(1, Math.min(count, 24));
    this.subWallets = [];
    for (let i = 0; i < target; i++) {
      const kp = Keypair.generate();
      this.subWallets.push(kp);
      if (this.simulationMode && !this.simulatedBalances.has(kp.publicKey.toBase58())) {
        this.simulatedBalances.set(kp.publicKey.toBase58(), 0.0);
      }
    }
    this.save();
    return this.subWallets.map(w => w.publicKey.toBase58());
  }

  async getMasterInfo() {
    const address = this.masterWallet.publicKey.toBase58();
    let balance = 0;
    if (this.simulationMode) {
      balance = this.simulatedBalances.get(address) || 15.0;
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
      privateKey: bs58.encode(this.masterWallet.secretKey),
      simulation: this.simulationMode
    };
  }

  async getSubWalletsInfo(tokenMint = null) {
    const list = [];
    for (let i = 0; i < this.subWallets.length; i++) {
      const w = this.subWallets[i];
      const address = w.publicKey.toBase58();
      let solBalance = 0;
      let tokenBalance = 0;

      if (this.simulationMode) {
        solBalance = this.simulatedBalances.get(address) || 0.0;
        tokenBalance = 0;
      } else {
        try {
          const lamports = await this.connection.getBalance(w.publicKey);
          solBalance = lamports / LAMPORTS_PER_SOL;
        } catch (e) {
          solBalance = 0;
        }

        if (tokenMint) {
          try {
            const mintPubkey = new PublicKey(tokenMint);
            const ata = await getAssociatedTokenAddress(mintPubkey, w.publicKey);
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
        tokenBalance,
        privateKey: bs58.encode(w.secretKey)
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
      // Generate randomized shares around base
      const baseShare = totalSol / count;
      let rawWeights = [];
      for (let i = 0; i < count; i++) {
        // Jitter between (1 - dev) and (1 + dev)
        const factor = 1 + ((Math.random() * 2 - 1) * (deviationPct / 100));
        rawWeights.push(Math.max(0.01, factor));
      }
      const sum = rawWeights.reduce((a, b) => a + b, 0);
      allocations = rawWeights.map(w => (w / sum) * totalSol);
    }

    if (this.simulationMode) {
      const masterAddr = this.masterWallet.publicKey.toBase58();
      let masterBal = this.simulatedBalances.get(masterAddr) || 15.0;
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

    // LIVE SOL TRANSFER VIA HELIUS RPC
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
      for (const w of this.subWallets) {
        const addr = w.publicKey.toBase58();
        const bal = this.simulatedBalances.get(addr) || 0;
        if (bal > 0) {
          drained += bal;
          this.simulatedBalances.set(addr, 0.0);
        }
      }
      const masterAddr = masterPubkey.toBase58();
      const currentMaster = this.simulatedBalances.get(masterAddr) || 15.0;
      this.simulatedBalances.set(masterAddr, currentMaster + drained);
      this.save();

      return {
        success: true,
        simulation: true,
        drainedSol: Number(drained.toFixed(4)),
        reclaimedCount: this.subWallets.length
      };
    }

    // LIVE DRAIN
    const sigs = [];
    let totalDrained = 0;
    const feeBuffer = 5000; // 0.000005 SOL

    for (const w of this.subWallets) {
      try {
        const balance = await this.connection.getBalance(w.publicKey);
        if (balance > feeBuffer * 2) {
          const drainAmount = balance - feeBuffer;
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: w.publicKey,
              toPubkey: masterPubkey,
              lamports: drainAmount
            })
          );
          const sig = await sendAndConfirmTransaction(this.connection, tx, [w]);
          sigs.push(sig);
          totalDrained += drainAmount / LAMPORTS_PER_SOL;
        }
      } catch (e) {
        console.error(`Failed to drain wallet ${w.publicKey.toBase58()}:`, e.message);
      }
    }

    return {
      success: true,
      simulation: false,
      drainedSol: Number(totalDrained.toFixed(4)),
      signatures: sigs
    };
  }

  // Reclaim SOL Rent from 0-balance token accounts (SPL closeAccount) & claim Pump.fun Creator Rewards
  async reclaimRentAndRewards(mintAddress = null) {
    if (!this.masterWallet) throw new Error('No master wallet configured');
    const isSim = this.simulationMode;
    const masterAddr = this.masterWallet.publicKey.toBase58();
    const allWallets = [this.masterWallet, ...this.subWallets];

    if (isSim) {
      const closedAccounts = allWallets.length;
      const rentPerAccount = 0.00203928;
      const reclaimedRentSol = Number((closedAccounts * rentPerAccount).toFixed(5));
      const creatorRewardSol = 0.5; // Pump.fun graduation / creator reward fee
      const totalReclaimedSol = Number((reclaimedRentSol + creatorRewardSol).toFixed(5));

      const prevBal = this.simulatedBalances.get(masterAddr) || 15.0;
      this.simulatedBalances.set(masterAddr, prevBal + totalReclaimedSol);

      return {
        success: true,
        simulation: true,
        accountsClosed: closedAccounts,
        reclaimedRentSol,
        creatorRewardSol,
        totalReclaimedSol,
        recipient: masterAddr,
        message: `Successfully reclaimed ${reclaimedRentSol} SOL ATA rent across ${closedAccounts} accounts + ${creatorRewardSol} SOL Pump.fun Creator Reward back into Master Dev Wallet!`
      };
    }

    // LIVE ON-CHAIN SPL TOKEN CLOSE ACCOUNT
    const { createCloseAccountInstruction } = require('@solana/spl-token');
    let totalRentLamports = 0;
    let closedCount = 0;
    const signatures = [];

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
      } catch (err) {
        console.warn(`Rent reclaim notice for ${kp.publicKey.toBase58().slice(0, 6)}:`, err.message);
      }
    }

    const reclaimedRentSol = totalRentLamports / LAMPORTS_PER_SOL;
    return {
      success: true,
      simulation: false,
      accountsClosed: closedCount,
      reclaimedRentSol,
      recipient: masterAddr,
      signatures,
      message: `Reclaimed ${reclaimedRentSol.toFixed(5)} SOL from ${closedCount} closed token accounts back into Master Dev Wallet!`
    };
  }

  exportAll() {
    return {
      master: {
        address: this.masterWallet.publicKey.toBase58(),
        secretKey: bs58.encode(this.masterWallet.secretKey)
      },
      subWallets: this.subWallets.map((w, idx) => ({
        index: idx + 1,
        address: w.publicKey.toBase58(),
        secretKey: bs58.encode(w.secretKey)
      }))
    };
  }
}

module.exports = new WalletManager();
