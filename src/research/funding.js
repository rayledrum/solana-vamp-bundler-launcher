const CEX_WALLETS = {
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'Binance'
};

const WINDOW_MS = 10 * 60 * 1000;
const AMOUNT_BAND = 0.03;

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function cexName(address, extra) {
  if (!address) return null;
  if (extra && extra[address]) return extra[address];
  return CEX_WALLETS[address] || null;
}

function amountsClose(left, right) {
  if (left == null || right == null) return false;
  const hi = Math.max(left, right);
  if (!(hi > 0)) return false;
  if (Math.abs(left - right) / hi <= AMOUNT_BAND) return true;
  return Math.round(left * 100) === Math.round(right * 100);
}

function emptyFunding(mint) {
  return {
    mint: mint || null,
    fundings: null,
    clusters: null,
    clusterCount: null,
    largestClusterSupplyPct: null,
    devLinkedClusterSupplyPct: null,
    nonDevClusterSupplyPct: null
  };
}

function eventOf(wallet, events, hops) {
  return events.get(wallet) || hops.get(wallet) || null;
}

function resolveRoot(wallet, events, hops, seen = new Set()) {
  const row = eventOf(wallet, events, hops);
  if (!row || !row.funder) return { root: null, cex: row && row.cex || null };
  if (seen.has(wallet)) return { root: row.cex ? null : row.funder, cex: row.cex || null };
  seen.add(wallet);
  if (row.cex) return { root: null, cex: row.cex };
  const parent = eventOf(row.funder, events, hops);
  if (parent && parent.funder) {
    if (parent.cex || cexName(parent.funder)) return { root: row.funder, cex: null };
    const above = resolveRoot(row.funder, events, hops, seen);
    if (above.root) return above;
  }
  return { root: row.funder, cex: null };
}

function isCluster(rows) {
  if (rows.length < 2) return false;
  const amounts = rows.map(row => row.amount).filter(value => value != null);
  const times = rows.map(row => row.time).filter(value => value != null);
  const mid = amounts.slice().sort((a, b) => a - b)[Math.floor(amounts.length / 2)];
  const similar = amounts.length === rows.length && amounts.every(value => amountsClose(value, mid));
  const tight = times.length === rows.length && Math.max(...times) - Math.min(...times) <= WINDOW_MS;
  return similar || tight;
}

function clusterFunding(input = {}) {
  if (!Array.isArray(input.buyers) || !Array.isArray(input.fundings)) return emptyFunding(input.mint);
  const buyers = input.buyers.filter(row => row && row.wallet);
  const events = new Map();
  const hops = new Map();
  input.fundings.forEach(row => {
    if (!row || !row.wallet) return;
    const record = {
      wallet: row.wallet,
      funder: row.funder || null,
      amount: finite(row.amount),
      time: finite(row.time),
      cex: row.cex ? (typeof row.cex === 'string' ? row.cex : cexName(row.funder, input.cexWallets) || 'CEX') : cexName(row.funder, input.cexWallets),
      traced: row.traced !== false
    };
    if (buyers.some(buyer => buyer.wallet === row.wallet)) events.set(row.wallet, record);
    else hops.set(row.wallet, record);
  });
  if (buyers.some(buyer => !events.has(buyer.wallet) || events.get(buyer.wallet).traced === false)) {
    return emptyFunding(input.mint);
  }
  const resolved = buyers.map(buyer => {
    const event = events.get(buyer.wallet);
    const root = resolveRoot(buyer.wallet, events, hops);
    return {
      wallet: buyer.wallet,
      funder: event.funder,
      amount: event.amount,
      time: event.time,
      cex: event.cex || root.cex,
      root: root.cex ? null : root.root,
      supplyPct: finite(buyer.supplyPct)
    };
  });
  const groups = new Map();
  resolved.forEach(row => {
    if (!row.root || row.cex) return;
    const list = groups.get(row.root) || [];
    list.push(row);
    groups.set(row.root, list);
  });
  const dev = input.dev || null;
  const clusters = [];
  for (const [root, rows] of groups) {
    if (!isCluster(rows)) continue;
    const supplyKnown = rows.every(row => row.supplyPct != null);
    const supplyPct = supplyKnown ? rows.reduce((sum, row) => sum + row.supplyPct, 0) : null;
    const devLinked = root === dev || rows.some(row => row.funder === dev);
    const sells = Array.isArray(input.trades)
      ? rows.map(row => {
        const sell = input.trades.find(trade => trade && trade.side === 'sell' && trade.wallet === row.wallet);
        return { wallet: row.wallet, soldAt: sell ? finite(sell.time) : null };
      })
      : null;
    clusters.push({
      funder: root,
      wallets: rows.map(row => row.wallet),
      walletCount: rows.length,
      supplyPct,
      devLinked,
      sellTimes: sells
    });
  }
  const withSupply = clusters.filter(row => row.supplyPct != null);
  const largest = withSupply.reduce((best, row) => (best == null || row.supplyPct > best.supplyPct ? row : best), null);
  const devSupply = clusters.filter(row => row.devLinked && row.supplyPct != null).reduce((sum, row) => sum + row.supplyPct, 0);
  const otherSupply = clusters.filter(row => !row.devLinked && row.supplyPct != null).reduce((sum, row) => sum + row.supplyPct, 0);
  return {
    mint: input.mint || null,
    fundings: resolved.map(row => ({
      wallet: row.wallet,
      funder: row.funder,
      amount: row.amount,
      time: row.time,
      cex: row.cex
    })),
    clusters,
    clusterCount: clusters.length,
    largestClusterSupplyPct: clusters.length ? (largest ? largest.supplyPct : null) : 0,
    devLinkedClusterSupplyPct: clusters.some(row => row.devLinked) ? (clusters.filter(row => row.devLinked).every(row => row.supplyPct != null) ? devSupply : null) : 0,
    nonDevClusterSupplyPct: clusters.some(row => !row.devLinked) ? (clusters.filter(row => !row.devLinked).every(row => row.supplyPct != null) ? otherSupply : null) : 0
  };
}

function compareFundingClusters(paths, { bigPct = 15 } = {}) {
  const pack = (values) => ({
    n: values.length,
    hitRate: values.length ? values.filter(value => value > 0).length / values.length : null,
    avgPnl: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  });
  const dev = [];
  const other = [];
  for (const row of paths || []) {
    const funding = row && row.funding;
    if (!funding || funding.largestClusterSupplyPct == null || row.pnl == null) continue;
    if (funding.largestClusterSupplyPct < bigPct) continue;
    if (funding.devLinked) dev.push(row.pnl);
    else other.push(row.pnl);
  }
  return { devCluster: pack(dev), otherCluster: pack(other) };
}

async function traceFunding({ connection, buyers, before, pace, cache, cexWallets }) {
  if (!connection || !Array.isArray(buyers)) return null;
  const memory = cache || new Map();
  const fundings = [];
  for (const buyer of buyers) {
    if (!buyer || !buyer.wallet) continue;
    const cached = memory.get(buyer.wallet);
    if (cached) {
      fundings.push(cached);
      continue;
    }
    if (pace) await pace();
    let record = { wallet: buyer.wallet, funder: null, amount: null, time: null, cex: null, traced: false };
    try {
      const key = buyer.wallet;
      const signatures = await connection.getSignaturesForAddress(key, { limit: 25 });
      const newest = (signatures || []).find(row => {
        const at = finite(row.blockTime);
        return at != null && (before == null || at * 1000 <= before) && (before == null || before - at * 1000 <= 24 * 60 * 60 * 1000);
      });
      if (newest && newest.signature && connection.getParsedTransaction) {
        if (pace) await pace();
        const tx = await connection.getParsedTransaction(newest.signature, { maxSupportedTransactionVersion: 0 });
        const instructions = tx && tx.transaction && tx.transaction.message && tx.transaction.message.instructions || [];
        const transfer = instructions.find(item => {
          const info = item && item.parsed && item.parsed.info;
          return item && item.parsed && item.parsed.type === 'transfer' && info && info.destination === key;
        });
        if (transfer) {
          const info = transfer.parsed.info;
          const lamports = finite(info.lamports);
          record = {
            wallet: key,
            funder: info.source || null,
            amount: lamports == null ? null : lamports / 1e9,
            time: finite(newest.blockTime) == null ? null : newest.blockTime * 1000,
            cex: cexName(info.source, cexWallets),
            traced: true
          };
        } else {
          record.traced = true;
        }
      } else {
        record.traced = true;
      }
    } catch (err) {
      record.traced = false;
    }
    memory.set(buyer.wallet, record);
    fundings.push(record);
  }
  return fundings;
}

module.exports = {
  CEX_WALLETS,
  clusterFunding,
  compareFundingClusters,
  traceFunding
};
