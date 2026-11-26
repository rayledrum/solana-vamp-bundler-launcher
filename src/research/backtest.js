function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function passesFilters(coin, filters = {}) {
  if (filters.minSafety != null && !(Number(coin.safetyScore) >= filters.minSafety)) return false;
  if (Array.isArray(filters.hoursUtc) && filters.hoursUtc.length && !filters.hoursUtc.includes(coin.hourUtc)) return false;
  if (filters.minThemeMomentum != null && !(Number(coin.themeMomentum) >= filters.minThemeMomentum)) return false;
  if (filters.theme && !(coin.themes || []).includes(filters.theme)) return false;
  if (filters.maxSameBlockPct != null) {
    const pct = coin.snipers && coin.snipers.sameBlockSupplyPct;
    if (pct == null || pct > filters.maxSameBlockPct) return false;
  }
  return true;
}

function simulatePath(coin, ladder, costs) {
  const snaps = (coin.snapshots || []).slice().sort((a, b) => a.atMin - b.atMin);
  const entry = snaps.find(row => row.mcapUsd > 0);
  if (!entry) return null;
  let remaining = 1;
  const moonbag = (Number(ladder.moonbagPct) || 0) / 100;
  const fired = new Set();
  let high = entry.mcapUsd;
  let highAt = entry.atMin;
  let proceeds = 0;
  const fee = 1 - (Number(costs.feePct) || 0) / 100;
  const slip = 1 - (Number(costs.slippagePct) || 0) / 100;
  const drag = fee * slip;
  for (const snap of snaps) {
    if (!(snap.mcapUsd > 0) || snap.atMin < entry.atMin) continue;
    if (snap.mcapUsd > high) {
      high = snap.mcapUsd;
      highAt = snap.atMin;
    }
    const multiple = snap.mcapUsd / entry.mcapUsd;
    let sell = 0;
    for (const step of ladder.milestones || []) {
      const key = String(step.mcapUsd);
      if (fired.has(key) || !(snap.mcapUsd >= step.mcapUsd)) continue;
      sell += (Number(step.sellPct) || 0) / 100;
      fired.add(key);
    }
    if (ladder.earlyDevSell && !fired.has('early') && snap.atMin >= Number(ladder.earlyDevSell.atMin)) {
      sell += (Number(ladder.earlyDevSell.sellPct) || 0) / 100;
      fired.add('early');
    }
    const stallFloor = entry.mcapUsd * (1 + (Number(ladder.stallAboveEntryPct) || 0) / 100);
    if (!fired.has('stall') && snap.atMin - highAt >= (Number(ladder.stallMinutes) || 0) && snap.mcapUsd < stallFloor) {
      sell = Math.max(sell, Math.max(0, remaining - moonbag));
      fired.add('stall');
    }
    const room = Math.max(0, remaining - moonbag);
    const portion = Math.min(room, sell);
    if (portion > 0) {
      proceeds += portion * multiple * drag;
      remaining -= portion;
    }
  }
  const last = snaps.filter(row => row.mcapUsd > 0).pop();
  const endMultiple = last ? last.mcapUsd / entry.mcapUsd : 1;
  proceeds += remaining * endMultiple * drag;
  const pnl = proceeds - 1;
  return { mint: coin.mint, pnl, entryMcapUsd: entry.mcapUsd, endMcapUsd: last ? last.mcapUsd : null };
}

function bucket(pnl) {
  if (pnl <= -0.5) return '<= -50%';
  if (pnl < 0) return '-50% to 0';
  if (pnl < 0.5) return '0 to 50%';
  if (pnl < 2) return '50% to 200%';
  return '> 200%';
}

function runBacktest({ coins, filters, ladder, feePct = 1, slippagePct = 1 }) {
  const considered = [];
  let skipped = 0;
  for (const coin of coins || []) {
    if (!passesFilters(coin, filters)) {
      skipped += 1;
      continue;
    }
    const path = simulatePath(coin, ladder || {}, { feePct, slippagePct });
    if (path) considered.push(path);
  }
  const pnls = considered.map(row => row.pnl);
  const hits = pnls.filter(value => value > 0).length;
  const distribution = {};
  pnls.forEach(value => {
    const name = bucket(value);
    distribution[name] = (distribution[name] || 0) + 1;
  });
  const avg = pnls.length ? pnls.reduce((sum, value) => sum + value, 0) / pnls.length : null;
  return {
    trades: considered.length,
    skipped,
    hitRate: considered.length ? hits / considered.length : null,
    avgPnl: avg,
    medianPnl: median(pnls),
    distribution,
    feePct,
    slippagePct,
    paths: considered
  };
}

function formatReport(result) {
  const pct = (value) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
  const lines = [
    `Trades: ${result.trades}`,
    `Skipped by filters: ${result.skipped}`,
    `Hit rate: ${pct(result.hitRate)}`,
    `Average PnL: ${pct(result.avgPnl)}`,
    `Median PnL: ${pct(result.medianPnl)}`,
    `Fees ${result.feePct}% and slippage ${result.slippagePct}% applied on each exit`,
    'Distribution:'
  ];
  Object.entries(result.distribution).forEach(([name, count]) => lines.push(`  ${name}: ${count}`));
  return lines.join('\n');
}

function main() {
  const fs = require('fs');
  const path = require('path');
  const file = process.argv[2] || path.join(__dirname, '..', '..', 'test', 'fixtures', 'research-sample.json');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = runBacktest(input);
  console.log(formatReport(result));
}

if (require.main === module) {
  main();
}

function compareLadders(coins, ladders, costs = {}) {
  return (ladders || []).map(ladder => ({
    name: ladder.name || 'ladder',
    ...runBacktest({ coins, filters: {}, ladder, feePct: costs.feePct, slippagePct: costs.slippagePct })
  }));
}

module.exports = { runBacktest, formatReport, passesFilters, median, compareLadders };
