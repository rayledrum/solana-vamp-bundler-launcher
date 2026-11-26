const { createStore } = require('./store');
const { ingestLaunches, takeDueSnapshots, pollNewCoins, createPacer } = require('./collector');
const { analyzeEarlyBuys, updateRegistry } = require('./snipers');
const { analyzeDevExit } = require('./devExit');
const { clusterFunding, traceFunding } = require('./funding');
const { readCurveTape, researchRpc, fundingDefaultOn } = require('./tradeTape');
const { scoreCoordination } = require('./coordination');
const { analyzeDistribution } = require('./distribution');
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
      appendBehavior(store, {
        mint: coin.mint,
        dev: pack && pack.dev,
        createTime: pack && pack.createTime,
        supply: pack && pack.supply,
        analysis,
        trades: pack && pack.trades,
        fundings: pack && pack.fundings,
        snapshots: pack && pack.snapshots
      });
    }
    updateRegistry(registry, analyses);
    store.writeJson('sniper-registry.json', registry);
  }
  const tapeResult = await fillTapes({
    store,
    coins,
    readTape: options.readTape,
    traceFunding: options.traceFunding,
    pace,
    funding: options.funding !== false && (options.traceFunding || options.connection)
  });
  const snaps = await takeDueSnapshots({
    store,
    observe,
    now: options.now || Date.now(),
    pace
  });
  return {
    added: added.length,
    snapshots: snaps.length,
    tapes: tapeResult.tapes,
    funding: tapeResult.funding,
    tracked: Object.keys(store.readState().mints || {}).length,
    dir: store.root
  };
}

function appendBehavior(store, input) {
  const buyers = Array.isArray(input.analysis && input.analysis.buys)
    ? input.analysis.buys.map(buy => {
      const trade = (input.trades || []).find(row => row && row.wallet === buy.wallet && row.side !== 'sell' && row.side !== 'transfer');
      return {
        wallet: buy.wallet,
        supplyPct: buy.supplyPct,
        time: trade && trade.time,
        slot: trade && trade.slot,
        ancestor: buy.funder || (trade && trade.ancestor) || null,
        hopDepth: trade && trade.hopDepth,
        priorTxCount: trade && trade.priorTxCount,
        priorTrades: trade && trade.priorTrades,
        priorityFee: trade && trade.priorityFee,
        computeUnitPrice: trade && trade.computeUnitPrice,
        jitoTip: trade && trade.jitoTip,
        programOrder: trade && trade.programOrder
      };
    })
    : null;
  store.append('coordination.jsonl', scoreCoordination({
    mint: input.mint,
    dev: input.dev,
    createTime: input.createTime,
    buyers,
    fundings: input.fundings,
    registry: input.registry
  }));
  const linked = (input.fundings || []).filter(row => row && (row.funder === input.dev || row.bundleCluster)).map(row => row.wallet);
  store.append('distributions.jsonl', analyzeDistribution({
    mint: input.mint,
    dev: input.dev,
    linked,
    supply: input.supply,
    createTime: input.createTime,
    transfers: input.trades,
    trades: input.trades,
    snapshots: input.snapshots,
    registry: input.registry
  }));
}

function loadTxCache(store) {
  const cache = new Map();
  store.readJsonl('tx-cache.jsonl').forEach(row => {
    if (row && row.signature) cache.set(row.signature, Array.isArray(row.trades) ? row.trades : []);
  });
  return cache;
}

async function fillTapes({ store, coins, readTape, traceFunding: trace, pace, funding }) {
  const state = store.readState();
  const byMint = new Map((coins || []).filter(coin => coin && coin.mint).map(coin => [coin.mint, coin]));
  store.readJsonl('launches.jsonl').forEach(row => {
    if (row && row.mint && !byMint.has(row.mint)) byMint.set(row.mint, row);
  });
  let registry = { wallets: {} };
  const registryFile = store.file('sniper-registry.json');
  if (fs.existsSync(registryFile)) {
    try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch (err) { registry = { wallets: {} }; }
  }
  const analyses = [];
  let tapes = 0;
  let fundingCount = 0;
  for (const [mint, slot] of Object.entries(state.mints || {})) {
    if (slot.tape) continue;
    const launch = byMint.get(mint) || {};
    let pack = null;
    try {
      pack = readTape ? await readTape(mint, launch) : null;
    } catch (err) {
      pack = null;
    }
    if (!pack || !Array.isArray(pack.trades)) continue;
    const dev = launch.dev || launch.creator || pack.dev || null;
    let analysis = analyzeEarlyBuys({
      mint,
      createSlot: pack.createSlot,
      createTime: pack.createTime,
      supply: pack.supply,
      dev,
      observedUntil: pack.observedUntil,
      trades: pack.trades
    });
    let fundings = null;
    if (funding && trace && analysis.buys && analysis.buys.length) {
      try {
        fundings = await trace(analysis.buys, pack.createTime);
        if (Array.isArray(fundings)) fundingCount += 1;
      } catch (err) {
        fundings = null;
      }
    }
    const trades = pack.trades.map(row => {
      const fund = Array.isArray(fundings) ? fundings.find(item => item && item.wallet === row.wallet && item.traced !== false) : null;
      return fund ? { ...row, funder: fund.funder || null } : row;
    });
    if (fundings) {
      analysis = analyzeEarlyBuys({
        mint,
        createSlot: pack.createSlot,
        createTime: pack.createTime,
        supply: pack.supply,
        dev,
        observedUntil: pack.observedUntil,
        trades
      });
    }
    analyses.push(analysis);
    store.append('snipers.jsonl', analysis);
    store.append('dev-exits.jsonl', analyzeDevExit({
      mint,
      dev,
      createTime: pack.createTime,
      supply: pack.supply,
      initialDevTokens: pack.initialDevTokens,
      observedUntil: pack.observedUntil,
      trades,
      snapshots: pack.snapshots
    }));
    store.append('funding-clusters.jsonl', clusterFunding({
      mint,
      dev,
      buyers: analysis.buys,
      fundings,
      trades
    }));
    appendBehavior(store, {
      mint,
      dev,
      createTime: pack.createTime,
      supply: pack.supply,
      analysis,
      trades,
      fundings,
      snapshots: pack.snapshots,
      registry
    });
    slot.tape = true;
    tapes += 1;
  }
  if (analyses.length) {
    updateRegistry(registry, analyses);
    store.writeJson('sniper-registry.json', registry);
  }
  store.writeState(state);
  return { tapes, funding: fundingCount };
}

async function main() {
  const fetch = global.fetch;
  const fetchJson = async (url) => {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const watch = process.argv.includes('--watch');
  const once = !watch;
  const interval = Number(process.env.COLLECT_INTERVAL_MS || 45000);
  const rpc = researchRpc();
  const pace = createPacer(rpc.minIntervalMs);
  const cache = loadTxCache(createStore());
  const funding = fundingDefaultOn();
  const readTape = (mint) => readCurveTape({
    connection: rpc.connection,
    mint,
    pace,
    cache
  });
  const trace = funding
    ? (buyers, before) => traceFunding({ connection: rpc.connection, buyers, before, pace })
    : null;
  console.log(`[collect] ${watch ? 'watching' : 'once'} via ${rpc.helius ? 'Helius' : 'public RPC'} every ${interval}ms; funding ${funding ? 'on' : 'off'}`);
  for (;;) {
    const result = await runCollect({ fetchJson, readTape, traceFunding: trace, funding, pace });
    const fresh = loadTxCache(createStore());
    cache.forEach((trades, signature) => {
      if (!fresh.has(signature)) createStore().append('tx-cache.jsonl', { signature, trades });
    });
    console.log(`[collect] +${result.added} launches, +${result.snapshots} snapshots, ${result.tapes} tapes, ${result.funding} funding traces, ${result.tracked} mints tracked`);
    if (once) break;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runCollect, enrichCoin };
