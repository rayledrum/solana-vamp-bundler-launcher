# ⚡ Solana Vamp Launcher, Auto-Launcher & Atomic Jito Bundler Desk

A high-performance, non-custodial Solana memecoin launchpad, vampire cloner, and multi-wallet atomic Jito bundler with real-time Web UI controls, built for the **Pump.fun** bonding curve ecosystem.

---

## 🚀 Key Features

### 1. 🎯 Auto-Launcher & Atomic Jito Bundler
- **Slot 0 Anti-Sniper Protection:** Bundles the token creation transaction, Master Dev buy, and multiple sub-wallet buys simultaneously into an atomic Jito bundle.
- **Single-Block Execution:** Eliminates front-running bots by securing your target supply percentage before any public sniper can trade.
- **Configurable Jito Tips:** Fast (0.002 SOL), Turbo (0.005 SOL), and Ultra (0.010 SOL) miner tip options targeting official Jito tip accounts.
- **Pre-Flight Validation Check:** Simulates account rent, gas balance, compute units, and bundle structure before firing.

### 2. 🧛 Vamp Launcher (Vampire Cloner)
- **Live Trending Scanner:** Scrapes top trending memecoins from DexScreener and Pump.fun in real time using free public APIs.
- **1-Click Narrative Vamp:** Instantly clones token name, symbol, description, and logo with 1 click directly into the Launchpad wizard.
- **Revival 2.0 & Spin-Off Generator:** Automatically creates modified "2.0" or spun narrative variants to capitalize on viral meta trends.
- **Custom CA Inspector:** Paste any Solana contract address (CA) to inspect liquidity, market cap, and socials.

### 3. 💼 Multi-Wallet Bundler Matrix
- **Master Dev Wallet:** Generate a fresh wallet or import an existing private key (Base58 or byte array JSON).
- **Sub-Wallet Generator:** Spin up between 1 and 24 sub-wallets.
- **1-Click Auto-Disperse:** Distributes SOL from the Master wallet across sub-wallets with optional ±20% randomized jitter to evade bot-clustering detection.
- **1-Click Auto-Drain / Sweep:** Sweeps all remaining SOL and tokens from all sub-wallets back to your Master Dev wallet.
- **Key Export & Backup:** Export all private and public keys as JSON or CSV.

### 4. 📊 Live Trading & Exit Desk
- **Real-Time WebSocket Stream:** Displays live block slots via Helius RPC, transaction landings, and PnL updates.
- **Bonding Curve Progress Tracker:** Visual progress bar tracking migration progress toward Raydium graduation (85 SOL threshold).
- **Cascade Exit:** Staggered auto-selling with configurable delay intervals across sub-wallets to avoid crashing your own chart in a single block.
- **Percentage Dumps:** Sell 25%, 50%, 75%, or 100% across all or individual wallets.
- **Panic Dump All:** Instant emergency exit across 100% of holdings.

### 5. 📈 Pump.fun Volume Bumper Bot
- Automatically executes randomized micro-buys and sells from rotating sub-wallets to keep the token active on Pump.fun's "Recently Bumped" front page.

---

## 🛠️ Free-Tier Infrastructure

This desk runs on **100% free or free-tier connections**:
- **Helius RPC (Free Tier):** Pre-configured with your active Helius key for RPC calls and WebSocket slot tracking.
- **Jito Block Engine (Free Public API):** Bundle submission to `https://mainnet.block-engine.jito.wtf/api/v1/bundles` (only pay standard Jito miner tips).
- **DexScreener API (100% Free):** Real-time token pairs and market data.
- **Pump.fun IPFS Gateway (Free):** Decentralized token metadata and logo hosting.

---

## 🏁 Quick Start

### 1. Launch the Server
```bash
cd /Users/Rayledrum/solana-vamp-bundler-launcher
npm start
```

### 2. Open the Web UI
Navigate to:
```
http://localhost:3000
```

### 3. Testing in Simulation Mode
The launcher starts in **SIMULATION MODE** by default with pre-funded mock balances so you can safely test:
1. Generating & dispersing SOL across sub-wallets.
2. Vamping a trending token from DexScreener.
3. Launching an atomic Jito bundle.
4. Monitoring live curve progress and PnL.
5. Testing Cascade Exit and 1-Click Drain.

Toggle to **LIVE MAINNET** using the top-right pill switch whenever you are ready to deploy real transactions!
