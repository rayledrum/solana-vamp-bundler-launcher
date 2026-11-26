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

### 5. Volume bumper
- Round trip or Random (the default). Random holds several open lots and waits a random time between the min and max delay before each buy or partial sell.
- Live mode sends capped Pump.fun trades, and PumpSwap trades (`pump-amm`) after the coin graduates. Simulation does not send transactions. It prices fills from the tracked coin's bonding-curve reserves, or the PumpSwap pool reserves once the curve is complete.
- The bumper keeps running on a graduated coin that has a pool. It stops when that pool is missing, the session budget or cycle cap is hit, or the live chart feed stalls.
- Stop, a 100% sell, cascade, panic, or a change of active mint sells the open lots in that same request.

### 6. Research (simulation only)
Quality launches are meant to scale out into real demand, not dump a thin curve. The research tools do not send live trades.

- `npm run collect` polls recent Pump.fun launches and appends `data/research/launches.jsonl`. It is resumable (`data/research/state.json`) and rate-limited. Snapshots at 1, 5, 15, 30, 60, and 240 minutes land in `snapshots.jsonl` when a later run sees that the mint is old enough. Missing fields stay `null`.
- Pass early trades into the collector to write `snipers.jsonl` and `sniper-registry.json`: first 50 buys or the first 60 seconds, block offset from create, SOL size, supply share, shared funder, and whether that wallet sold. Per-coin features include same-block supply, SOL in the first 10s and 60s, how many of those snipers still hold at 5/15/60 minutes, sell pressure versus later organic buys, and wallets that snipe more than one launch. Those features replace the safety panel's unknown sniper row when the share is actually known.
- The same trade tape writes `dev-exits.jsonl`: each dev sell with time, share of the dev bag, and market cap; time to the first dev sell; whether the dev fully exited; and dev-linked wallets (funded by the dev, the same funder, or a bundle cluster) with their combined hold. Organic buy rate and unique buyers are compared in equal windows before and after that first sell, and market cap after it is listed from snapshots. Missing tape or bag size stays `null`. The safety panel shows the linked hold when it is known. The backtester compares coins whose dev sold in the first 10 minutes with coins the dev had not fully exited, and it can replay selling the first X% of the visible dev bag at launch plus N minutes against a later ladder.
- Funding traces for those early buyers, when a tape or RPC read supplies them, go in `funding-clusters.jsonl`. Each row keeps the funder, SOL amount, and time from the prior 24 hours. Wallets that received near-identical amounts (within 3% or the same rounded value) or were funded inside 10 minutes, from the same funder or a chain of funders, form a cluster. Known CEX hot wallets are labeled and are not merged into one cluster. Per coin: cluster count, wallets in each cluster, combined supply share, whether the cluster is dev-linked, and when those wallets sold. If a buyer's funding was not read, the cluster stats stay null. The safety panel turns red or yellow from the largest cluster's supply share. The backtester separates coins with a large dev-linked cluster from coins with a large cluster that is not the dev. Set `COLLECT_FUNDING=1` only when `HELIUS_RPC_URL` or `HELIUS_API_KEY` is set; the tracer is rate-limited and cached. The default collect does not call RPC for funding.
- `npm run backfill` stores recent coins and Pump.fun candles when the candle API returns them (`backfill-candles.json`). A failed candle fetch is `null`, not a made-up series.
- `GET /api/research/meta` ranks name and description themes for coins that graduated or climbed in the last 1h, 6h, and 24h. An external trend source can be plugged in later. Nothing calls X.
- `npm run backtest` replays `test/fixtures/research-sample.json` (or a collected file path) and prints hit rate, average and median PnL after about 1% fees and 1% slippage, plus a distribution. Filters include safety score, launch hour, theme momentum, and same-block sniper share.
- The exit ladder (10k / 20k / 30k USD scale-out, moonbag, stall stop, and a cap on how much of curve liquidity one sell may take) runs only in simulation, only on coins this desk launched, and is off until enabled. Live mode rejects the setting.

```bash
npm run collect
npm run collect -- --watch
npm run backfill
npm run backtest
```

Coin lists and per-mint reads use `PUMP_API_BASE` (default `https://frontend-api-v3.pump.fun`) and fall back to the older frontend hosts on HTTP 403 or 5xx. `--watch` logs a failed poll, including the host, and retries with backoff up to 5 minutes instead of exiting. One mint failing does not stop the rest of the pass.

`npm run collect` reads the bonding-curve history for each new mint (Helius when `HELIUS_RPC_URL` or `HELIUS_API_KEY` is set, otherwise the public RPC more slowly), writes the sniper and dev-exit tapes, and traces funding when Helius is present. `COLLECT_FUNDING=0` turns funding traces off. `--watch` keeps polling about every 45 seconds (`COLLECT_INTERVAL_MS` overrides that) and logs how many launches, snapshots, tapes, and funding traces were added. Parsed transactions are cached in `tx-cache.jsonl` and a mint is not fetched again after a successful read. A failed RPC read stays unrecorded so the next pass can retry. The same tape scores warmed or cadence-funded early wallets, token transfers from the dev, wash volume, dust-holder padding, ladder sells, post-migration dumps, KOL shadow sells, same-timestamp market-cap runs, scale-outs into a rising chart, and create-to-graduation under 60 seconds. A dev whose earlier coins stall near `NEAR_MIGRATION_PCT` (default 90) or dump on PumpSwap right after a forced graduation is labeled a non-migrator through the serial-dev link. Sim skips a buy near that line and can sell. Live only shows the flag. `FARM_RIDE_ENABLED` defaults off. When it is on, simulation can buy a small size while a bundle or KOL is still holding and sell on the first farmer sell, a bleed, a stop, or the hold limit. Live only shows whether the coin is eligible. Top traders are ranked from the bonding-curve and PumpSwap tape by realized plus unrealized PnL and by SOL in and out. There is no public DexScreener top-traders feed, so that tab is not scraped. A coin whose peak stays below `SECOND_PUMP_MCAP_USD` (default $100k) arms the sim bleed exit after pump 1. A coin that trades through that level waits for pump 2. The sim ladder sells before `BLEED_FLOOR_MCAP_USD` (default $50k). Live shows the alert and does not sell. Fresh dev wallets that share a treasury or metadata are linked for the blacklist. A linked blacklisted dev blocks later buys and does not sell an open position. A user-editable `data/research/kol-wallets.json` list starts empty.

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

