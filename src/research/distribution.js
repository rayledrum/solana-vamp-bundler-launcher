const fs = require('fs');
const path = require('path');

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function emptyDistribution(mint) {
  return {
    mint: mint || null,
    recipients: null,
    recipientCount: null,
    supplyPct: null,
    kolRecipients: null,
    sells: null,
    peakMcapUsd: null,
    dumpAt: null,
    campaign: null
  };
}

function loadKolList(file) {
  const target = file || path.join(__dirname, '..', '..', 'data', 'research', 'kol-wallets.json');
  try {
    if (!fs.existsSync(target)) return [];
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return Array.isArray(parsed) ? parsed.map(row => (typeof row === 'string' ? row : row && row.wallet)).filter(Boolean) : [];
  } catch (err) {
    return [];
  }
}

function isLargeTrader(recipient, kol, registry) {
  if (!recipient) return null;
  if (kol && kol.has(recipient.wallet)) return true;
  const balance = finite(recipient.solBalance);
  const trades = finite(recipient.tradeCount);
  const seen = registry && registry[recipient.wallet] && Array.isArray(registry[recipient.wallet].mints)
    ? registry[recipient.wallet].mints.length
    : null;
  if (balance == null && trades == null && seen == null && !(kol && kol.has(recipient.wallet))) return null;
  return (balance != null && balance >= 50) || (trades != null && trades >= 100) || (seen != null && seen >= 5);
}

function analyzeDistribution(input = {}) {
  if (!Array.isArray(input.transfers)) return emptyDistribution(input.mint);
  const dev = input.dev || null;
  const linked = new Set(input.linked || []);
  if (dev) linked.add(dev);
  const supply = finite(input.supply);
  const createTime = finite(input.createTime);
  const kol = new Set(input.kolWallets || []);
  const registry = input.registry && input.registry.wallets ? input.registry.wallets : {};
  const sent = input.transfers.filter(row => {
    if (!row || row.side === 'buy' || row.side === 'sell') return false;
    if (!row.to || !row.from) return false;
    if (linked.size && !linked.has(row.from)) return false;
    const at = finite(row.time);
    if (createTime != null && at != null && (at < createTime || at - createTime > 6 * 60 * 60 * 1000)) return false;
    return true;
  });
  const byRecipient = new Map();
  sent.forEach(row => {
    const tokens = finite(row.tokens);
    const current = byRecipient.get(row.to) || { wallet: row.to, tokens: 0, known: true, solBalance: finite(row.solBalance), tradeCount: finite(row.tradeCount) };
    if (tokens == null) current.known = false;
    else current.tokens += tokens;
    byRecipient.set(row.to, current);
  });
  const recipients = [...byRecipient.values()].map(row => {
    const large = isLargeTrader(row, kol, registry);
    return {
      wallet: row.wallet,
      tokens: row.known ? row.tokens : null,
      supplyPct: supply != null && supply > 0 && row.known ? (row.tokens / supply) * 100 : null,
      largeTrader: large
    };
  });
  const supplyPct = recipients.every(row => row.supplyPct != null)
    ? recipients.reduce((sum, row) => sum + row.supplyPct, 0)
    : null;
  const sells = Array.isArray(input.trades)
    ? recipients.map(row => {
      const sell = input.trades.find(trade => trade && trade.side === 'sell' && trade.wallet === row.wallet);
      return { wallet: row.wallet, soldAt: sell ? finite(sell.time) : null, mcapUsd: sell ? finite(sell.mcapUsd) : null };
    })
    : null;
  let peakMcapUsd = null;
  let dumpAt = null;
  if (Array.isArray(input.snapshots) && input.snapshots.some(row => finite(row.mcapUsd) != null)) {
    const known = input.snapshots.filter(row => finite(row.mcapUsd) != null);
    peakMcapUsd = known.reduce((max, row) => Math.max(max, row.mcapUsd), 0);
    const peakIndex = known.findIndex(row => row.mcapUsd === peakMcapUsd);
    const after = known.slice(peakIndex + 1).find(row => row.mcapUsd <= peakMcapUsd * 0.5);
    dumpAt = after ? finite(after.time != null ? after.time : after.atMin) : null;
  }
  return {
    mint: input.mint || null,
    dev,
    recipients,
    recipientCount: recipients.length,
    supplyPct,
    kolRecipients: recipients.some(row => row.largeTrader == null) ? null : recipients.filter(row => row.largeTrader).length,
    sells,
    peakMcapUsd,
    dumpAt,
    campaign: null
  };
}

function markCampaigns(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byDev = new Map();
  list.forEach(row => {
    if (!row || !row.dev || row.recipientCount == null) return;
    const bucket = byDev.get(row.dev) || [];
    bucket.push(row);
    byDev.set(row.dev, bucket);
  });
  const campaigns = new Set();
  for (const [dev, coins] of byDev) {
    if (coins.length >= 10) {
      campaigns.add(dev);
      continue;
    }
    if (coins.length < 2) continue;
    const sets = coins.map(coin => new Set((coin.recipients || []).map(item => item.wallet)));
    let overlap = 0;
    sets[0].forEach(wallet => {
      if (sets.slice(1).every(set => set.has(wallet))) overlap += 1;
    });
    if (overlap >= 5) campaigns.add(dev);
  }
  return list.map(row => ({ ...row, campaign: row && row.dev ? campaigns.has(row.dev) : null }));
}

module.exports = { analyzeDistribution, markCampaigns, loadKolList };
