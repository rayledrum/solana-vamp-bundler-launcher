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
- **1-Click Auto-Drain / Sweep:** Sweeps remaining SOL from sub-wallets back to the master wallet. Token balances are not moved; close empty token accounts separately if you want the rent back.
- **Key Export & Backup:** Export all private and public keys as JSON or CSV.

### 4. 📊 Live Trading & Exit Desk
- **Real-Time WebSocket Stream:** Displays live block slots via Helius RPC, transaction landings, and PnL updates.
- **Bonding Curve Progress Tracker:** Progress comes from the bonding curve's real token reserves and the `complete` flag. Graduation is PumpSwap. After graduation the chart follows the PumpSwap pool over Helius, with DexScreener only as a fallback.
- **Cascade Exit:** Staggered auto-selling with configurable delay intervals across sub-wallets to avoid crashing your own chart in a single block.
- **Percentage Dumps:** Sell 25%, 50%, 75%, or 100% across all or individual wallets.
- **Panic Dump All:** Instant emergency exit across 100% of holdings.

### 5. Volume bumper (simulation only)
- Prints a labeled practice tick on a timer. It does not submit buys or sells, in simulation or on mainnet.

---

## 🛠️ Free-Tier Infrastructure

This desk runs on **100% free or free-tier connections**:
- **Helius RPC:** Set `HELIUS_API_KEY` or `HELIUS_RPC_URL` in `.env`. The server does not ship with an API key. Live mode refuses to start without one.
- **Jito Block Engine (Free Public API):** Bundle submission to `https://mainnet.block-engine.jito.wtf/api/v1/bundles` (only pay standard Jito miner tips).
- **DexScreener API (100% Free):** Real-time token pairs and market data.
- **Pump.fun IPFS Gateway (Free):** Decentralized token metadata and logo hosting.

---

## 🏁 Quick Start

### 1. Configure
```bash
cp .env.example .env
```
Set `API_TOKEN` (or leave it blank and copy the token the server prints once). Set `HELIUS_API_KEY` or `HELIUS_RPC_URL` before using the dashboard switch to go live. `LIVE_TRADING` and `SIMULATION_MODE` are ignored.

The master wallet `FLAgPA3VzRhAC8auZAoS4FNeqah4vKuf5CEL49i2SMcy` and the six sub-wallets that were published with the old public build are leaked. Delete `data/wallets.json` if it came from that build, generate fresh wallets, and never fund the leaked ones.

### 2. Launch the Server
```bash
npm start
```
The desk binds to `127.0.0.1` unless `HOST` is set. Every `/api` route and the WebSocket require `Authorization: Bearer <API_TOKEN>`. The page asks for that token once per browser session.

### 3. Testing in Simulation Mode
The launcher always starts in **simulation**, including after a restart. Live mode is not read from `.env` and is not saved. The dashboard switch is the only control: it asks you to confirm because real SOL will be spent, and the server rejects the switch when no Helius RPC is configured or no wallets are loaded. Switching back to simulation does not ask again. Spend is capped by `MAX_SOL_PER_TRADE` (0.1), `MAX_SOL_PER_SESSION` (0.5), and `MAX_JITO_TIP_SOL` (0.01) unless you change `.env`.

