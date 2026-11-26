const SNAPSHOT_MINUTES = [1, 5, 15, 30, 60, 240];
const POLL_URL = 'https://frontend-api.pump.fun/coins?offset=0&limit=40&sort=created_timestamp&order=DESC&includeNsfw=false';

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  return null;
}

function launchedMs(coin) {
  const raw = finite(coin && coin.created_timestamp);
  if (raw == null) return null;
  return raw < 1e12 ? raw * 1000 : raw;
}

function staticRecord(coin, extra = {}) {
  const ms = launchedMs(coin);
  const when = ms == null ? null : new Date(ms);
  return {
    mint: coin && coin.mint ? String(coin.mint) : null,
    name: coin && coin.name != null ? String(coin.name) : null,
    symbol: coin && coin.symbol != null ? String(coin.symbol) : null,
    description: coin && coin.description != null ? String(coin.description) : null,
    socials: {
      twitter: (coin && (coin.twitter || coin.x)) || null,
      telegram: (coin && coin.telegram) || null,
      website: (coin && coin.website) || null
    },
    launchedAt: when ? when.toISOString() : null,
    hourUtc: when ? when.getUTCHours() : null,
    weekdayUtc: when ? when.getUTCDay() : null,
    dev: (coin && coin.creator) || null,
    devHistory: extra.devHistory == null ? null : extra.devHistory,
    safetyScore: finite(extra.safetyScore),
    initialDevBuySol: finite(coin && (coin.initial_buy_sol != null ? coin.initial_buy_sol : coin.dev_buy_sol))
  };
}

function snapshotRecord(mint, atMin, obs = {}) {
  return {
    mint: mint || null,
    atMin,
    capturedAt: obs.capturedAt || new Date().toISOString(),
    mcapUsd: finite(obs.mcapUsd != null ? obs.mcapUsd : obs.usd_market_cap),
    curveProgress: finite(obs.curveProgress != null ? obs.curveProgress : obs.progress),
    graduated: boolOrNull(obs.graduated != null ? obs.graduated : obs.complete),
    buys: finite(obs.buys),
    sells: finite(obs.sells),
    uniqueBuyers: finite(obs.uniqueBuyers),
    holderCount: finite(obs.holderCount),
    top10Pct: finite(obs.top10Pct),
    devHoldPct: finite(obs.devHoldPct),
    devSold: boolOrNull(obs.devSold)
  };
}

async function ingestLaunches({ coins, store, enrich, now = Date.now() }) {
  const state = store.readState();
  const added = [];
  for (const coin of coins || []) {
    if (!coin || !coin.mint || state.mints[coin.mint]) continue;
    const ms = launchedMs(coin);
    let extra = { devHistory: null, safetyScore: null };
    if (enrich) {
      try {
        const got = await enrich(coin);
        extra = {
          devHistory: got && got.devHistory != null ? got.devHistory : null,
          safetyScore: got && got.safetyScore != null ? got.safetyScore : null
        };
      } catch (err) {
        extra = { devHistory: null, safetyScore: null };
      }
    }
    const row = staticRecord(coin, extra);
    store.append('launches.jsonl', row);
    state.mints[coin.mint] = {
      launchedAt: ms,
      snapshots: [],
      addedAt: now
    };
    added.push(row);
  }
  store.writeState(state);
  return added;
}

function dueSnapshots(state, now) {
  const due = [];
  for (const [mint, row] of Object.entries(state.mints || {})) {
    if (row.launchedAt == null) continue;
    const ageMin = (now - row.launchedAt) / 60000;
    const done = new Set(row.snapshots || []);
    for (const minute of SNAPSHOT_MINUTES) {
      if (ageMin + 1e-9 >= minute && !done.has(minute)) due.push({ mint, atMin: minute });
    }
  }
  return due;
}

async function takeDueSnapshots({ store, observe, now = Date.now(), pace }) {
  const state = store.readState();
  const due = dueSnapshots(state, now);
  const written = [];
  for (const item of due) {
    if (pace) await pace();
    let obs = {};
    try {
      obs = observe ? await observe(item.mint, item.atMin) : {};
    } catch (err) {
      obs = {};
    }
    const row = snapshotRecord(item.mint, item.atMin, obs || {});
    store.append('snapshots.jsonl', row);
    const slot = state.mints[item.mint];
    slot.snapshots = (slot.snapshots || []).concat(item.atMin);
    written.push(row);
  }
  store.writeState(state);
  return written;
}

async function backfill({ coins, candlesFor, store, pace }) {
  const saved = [];
  const candleBook = {};
  for (const coin of coins || []) {
    if (pace) await pace();
    if (coin && coin.mint) {
      const state = store.readState();
      if (!state.mints[coin.mint]) {
        store.append('launches.jsonl', staticRecord(coin, {}));
        state.mints[coin.mint] = { launchedAt: launchedMs(coin), snapshots: [], backfilled: true };
        store.writeState(state);
      }
    }
    let candles = null;
    if (candlesFor && coin && coin.mint) {
      try {
        const rows = await candlesFor(coin.mint);
        candles = Array.isArray(rows) && rows.length ? rows : null;
      } catch (err) {
        candles = null;
      }
    }
    if (coin && coin.mint) candleBook[coin.mint] = candles;
    saved.push({ mint: coin && coin.mint, candles: candles ? candles.length : null });
  }
  store.writeJson('backfill-candles.json', candleBook);
  return saved;
}

function createPacer(minIntervalMs) {
  let last = 0;
  return async function pace() {
    const wait = minIntervalMs - (Date.now() - last);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    last = Date.now();
  };
}

async function pollNewCoins(fetchJson) {
  const body = await fetchJson(POLL_URL);
  return Array.isArray(body) ? body : [];
}

module.exports = {
  SNAPSHOT_MINUTES,
  POLL_URL,
  finite,
  staticRecord,
  snapshotRecord,
  ingestLaunches,
  dueSnapshots,
  takeDueSnapshots,
  backfill,
  createPacer,
  pollNewCoins,
  launchedMs
};
