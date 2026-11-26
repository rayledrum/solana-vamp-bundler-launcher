const { createStore } = require('./store');
const { ingestLaunches, takeDueSnapshots, pollNewCoins, createPacer } = require('./collector');
const { analyzeEarlyBuys, updateRegistry } = require('./snipers');
const { analyzeDevExit } = require('./devExit');
const { clusterFunding } = require('./funding');
const fs = require('fs');
const { safetyChecks } = require('../safetyChecks');

async function enrichCoin(coin) {
  if (!coin || !coin.mint) return { devHistory: null, safetyScore: null };
  try {
    const report = await safetyChecks.report(coin.mint);
    const dev = (report.checks || []).find(row => row.id === 'devCoins');
    return {
      safetyScore: report && report.score != null ? report.score : null,
      devHistory: dev && dev.status !== 'unknown' ? dev.reason : null
    };
  } catch (err) {
    return { devHistory: null, safetyScore: null };
  }
}

async function runCollect(options = {}) {
  const store = options.store || createStore(options.dir);
  const fetchJson = options.fetchJson;
  const pace = createPacer(options.minIntervalMs == null ? 400 : options.minIntervalMs);
  const list = options.listCoins || (async () => {
    await pace();
    return pollNewCoins(fetchJson);
  });
  const observe = options.observe || (async (mint) => {
    await pace();
    const coin = await fetchJson(`https://frontend-api.pump.fun/coins/${encodeURIComponent(mint)}`);
    if (!coin || typeof coin !== 'object') return {};
    return {
      mcapUsd: coin.usd_market_cap,
      graduated: coin.complete,
      buys: coin.buys,
      sells: coin.sells,
      uniqueBuyers: coin.unique_buyers,
      holderCount: coin.holder_count,
      top10Pct: coin.top10_pct,
      devHoldPct: coin.dev_hold_pct,
      devSold: coin.dev_sold
    };
  });
  const coins = await list();
  const added = await ingestLaunches({
    coins,
    store,
    enrich: options.enrich || enrichCoin,
    now: options.now || Date.now()
  });
  if (options.earlyTrades) {
    let registry = { wallets: {} };
    const registryFile = store.file('sniper-registry.json');
    if (fs.existsSync(registryFile)) {
      try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch (err) { registry = { wallets: {} }; }
    }
    const analyses = [];
    for (const coin of coins || []) {
      if (!coin || !coin.mint) continue;
      const pack = await options.earlyTrades(coin);
      const analysis = analyzeEarlyBuys({ mint: coin.mint, ...(pack || {}), trades: pack && pack.trades });
      analyses.push(analysis);
      store.append('snipers.jsonl', analysis);
      store.append('dev-exits.jsonl', analyzeDevExit({
        mint: coin.mint,
        dev: pack && pack.dev,
        createTime: pack && pack.createTime,
        supply: pack && pack.supply,
        initialDevTokens: pack && pack.initialDevTokens,
        observedUntil: pack && pack.observedUntil,
        trades: pack && pack.trades,
        snapshots: pack && pack.snapshots
      }));
      store.append('funding-clusters.jsonl', clusterFunding({
        mint: coin.mint,
        dev: pack && pack.dev,
        buyers: analysis.buys,
        fundings: pack && pack.fundings,
        trades: pack && pack.trades
      }));
    }
    updateRegistry(registry, analyses);
    store.writeJson('sniper-registry.json', registry);
  }
  const snaps = await takeDueSnapshots({
    store,
    observe,
    now: options.now || Date.now(),
    pace
  });
  return { added: added.length, snapshots: snaps.length, dir: store.root };
}

async function main() {
  const fetch = global.fetch;
  const fetchJson = async (url) => {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const once = process.argv.includes('--once');
  const rounds = once ? 1 : Number(process.env.COLLECT_ROUNDS || 1);
  for (let i = 0; i < rounds; i += 1) {
    const result = await runCollect({ fetchJson });
    console.log(JSON.stringify(result));
    if (!once && i < rounds - 1) await new Promise(resolve => setTimeout(resolve, 60_000));
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runCollect, enrichCoin };
