const { trackPumps, planBleedExit } = require('./bleedExit');

const DEFAULT_KOL_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SOL = 0.02;
const DEFAULT_STOP_PCT = 25;
const DEFAULT_MAX_HOLD_MS = 30 * 60 * 1000;
const DEFAULT_DEV_EXIT_MS = 2 * 60 * 1000;
const SLICES = [50, 25, 25];

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function mcapUsd(point, solPriceUsd) {
  if (!point) return null;
  const usd = finite(point.mcapUsd);
  if (usd != null) return usd;
  const sol = finite(point.mcapSol);
  const price = finite(solPriceUsd);
  if (sol != null && price != null) return sol * price;
  return null;
}

function earlyPump(series, options = {}) {
  if (!Array.isArray(series)) return { early: null, activePump: null, above: null };
  const pumps = trackPumps(series, options);
  if (!pumps || pumps.aboveSecondPumpThreshold == null || pumps.rising == null) {
    return { early: null, activePump: pumps && pumps.activePump, above: pumps && pumps.aboveSecondPumpThreshold };
  }
  const early = pumps.aboveSecondPumpThreshold
    ? pumps.rising === true && pumps.activePump === 2
    : pumps.rising === true && pumps.activePump === 1;
  return { early, activePump: pumps.activePump, above: pumps.aboveSecondPumpThreshold, pumps };
}

function clusterStillHolding(input) {
  if (!Array.isArray(input.clusterWallets) || !input.clusterWallets.length) return null;
  if (!Array.isArray(input.trades)) return null;
  const cluster = new Set(input.clusterWallets);
  const sold = input.trades.some(row => row && row.side === 'sell' && cluster.has(row.wallet));
  return !sold;
}

function kolStillIn(input, now) {
  if (!Array.isArray(input.kolWallets) || !Array.isArray(input.trades) || finite(now) == null) return null;
  const windowMs = finite(input.kolWindowMs) == null ? DEFAULT_KOL_WINDOW_MS : finite(input.kolWindowMs);
  const kols = new Set(input.kolWallets);
  const buys = input.trades.filter(row => row && row.side === 'buy' && kols.has(row.wallet) && finite(row.time) != null && now - row.time <= windowMs && now >= row.time);
  if (!buys.length) return false;
  const shadows = new Set((input.shadowWallets || []).map(row => typeof row === 'string' ? row : row && row.wallet).filter(Boolean));
  if (!Array.isArray(input.shadowWallets)) return null;
  const firstBuy = Math.min(...buys.map(row => row.time));
  const shadowSold = input.trades.some(row => row && row.side === 'sell' && shadows.has(row.wallet) && finite(row.time) != null && row.time >= firstBuy);
  return !shadowSold;
}

function bleedClear(bleed) {
  if (!bleed || bleed.flagged == null) return null;
  return bleed.flagged === false;
}

function awayFromMigrationLine(input) {
  if (!input.nonMigrator || input.nonMigrator.nonMigrator == null || finite(input.curveProgress) == null || input.graduated == null) {
    return null;
  }
  const line = finite(input.progressThreshold) == null ? 90 : finite(input.progressThreshold);
  const near = input.nonMigrator.nonMigrator === true && input.graduated === false && input.curveProgress >= line;
  return !near;
}

function vetoesFor(input) {
  const vetoes = [];
  const devMs = finite(input.instantDevExitMs) == null ? DEFAULT_DEV_EXIT_MS : finite(input.instantDevExitMs);
  if (input.devExit && finite(input.devExit.timeToFirstSellMs) != null && input.devExit.timeToFirstSellMs <= devMs) {
    vetoes.push('instant dev exit');
  }
  const priors = input.serial && input.serial.linkedPriorCoins;
  if (Array.isArray(priors) && priors.some(row => row && (row.rugged === true || row.earlyRug === true))) {
    vetoes.push('early-rug serial dev');
  }
  if (input.vetoInstantBond !== false && input.bonding && input.bonding.flagged === true) {
    vetoes.push('near-instant bonding');
  }
  const blocked = vetoes.length > 0;
  const devUnknown = input.devExit == null;
  const serialUnknown = !input.serial || input.serial.linkedPriorCoins == null;
  const bondUnknown = input.vetoInstantBond !== false && (!input.bonding || input.bonding.flagged == null);
  return { vetoes, blocked, unknown: !blocked && (devUnknown || serialUnknown || bondUnknown) };
}

function scoreFarmEntry(input = {}) {
  const reasons = [];
  const holding = clusterStillHolding(input);
  const kol = kolStillIn(input, input.now);
  const phase = earlyPump(input.series, {
    secondPumpMcapUsd: input.secondPumpMcapUsd,
    solPriceUsd: input.solPriceUsd,
    minRisePct: input.minRisePct,
    minDrawdownPct: input.minDrawdownPct
  });
  const bleedOk = bleedClear(input.bleed);
  const lineOk = awayFromMigrationLine(input);
  const veto = vetoesFor(input);
  if (holding === true) reasons.push('bundle cluster has not started selling');
  if (holding === false) reasons.push('bundle cluster already sold');
  if (kol === true) reasons.push('KOL buy is fresh and shadows have not sold');
  if (kol === false) reasons.push('no fresh KOL buy without shadow sells');
  if (phase.early === true) reasons.push(phase.above ? 'pump 2 is still rising' : 'pump 1 is still rising');
  if (phase.early === false) reasons.push('pump is no longer early');
  if (bleedOk === false) reasons.push('bleed is active');
  if (bleedOk === true) reasons.push('no bleed');
  if (lineOk === false) reasons.push('non-migrator dev near the migration line');
  if (lineOk === true) reasons.push('not a non-migrator at the migration line');
  reasons.push(...veto.vetoes);
  const farmSignal = holding === true || kol === true;
  const farmBlocked = holding === false || (kol === false && holding !== true);
  const known = farmSignal && !farmBlocked && phase.early === true && bleedOk === true && lineOk === true && !veto.blocked && !veto.unknown;
  const rejected = farmBlocked || phase.early === false || bleedOk === false || lineOk === false || veto.blocked;
  let eligible = known ? true : rejected ? false : null;
  const maxSol = finite(input.maxSol) == null ? DEFAULT_MAX_SOL : finite(input.maxSol);
  const remaining = finite(input.sessionRemaining);
  let sizeSol = null;
  if (eligible === true && remaining != null) {
    if (remaining <= 0) {
      eligible = false;
      sizeSol = 0;
      reasons.push('session cap is already used');
    } else {
      sizeSol = Math.min(maxSol, remaining);
    }
  }
  return {
    eligible,
    reasons,
    sizeSol,
    checks: { holding, kol, early: phase.early, bleedOk, lineOk, vetoes: veto.vetoes }
  };
}

function hardFarmExit(input) {
  const reasons = [];
  const entry = finite(input.entryMcapUsd);
  const nowMcap = mcapUsd(input, input.solPriceUsd);
  const stopPct = finite(input.stopLossPct) == null ? DEFAULT_STOP_PCT : finite(input.stopLossPct);
  if (entry != null && nowMcap != null && nowMcap <= entry * (1 - stopPct / 100)) reasons.push('stop loss');
  const enteredAt = finite(input.enteredAt);
  const now = finite(input.now);
  const maxHold = finite(input.maxHoldMs) == null ? DEFAULT_MAX_HOLD_MS : finite(input.maxHoldMs);
  if (enteredAt != null && now != null && now - enteredAt >= maxHold) reasons.push('max hold time');
  if (input.clusterSold === true) reasons.push('first cluster sell');
  if (input.shadowSold === true) reasons.push('first shadow sell');
  if (input.bleed && input.bleed.flagged === true) reasons.push('bleed start');
  const line = finite(input.progressThreshold) == null ? 90 : finite(input.progressThreshold);
  if (input.nonMigrator && input.nonMigrator.nonMigrator === true && finite(input.curveProgress) != null && input.curveProgress >= line && input.graduated === false) {
    reasons.push('non-migrator approaching the migration line');
  }
  return reasons;
}

function planFarmExit(input = {}) {
  const hard = hardFarmExit(input);
  if (hard.length) return { action: 'sell', sellPct: 100, hard: true, reasons: hard };
  const ladder = (input.ladderDump && input.ladderDump.flagged === true)
    || (input.scaleOut && input.scaleOut.flagged === true);
  if (!ladder) {
    const unknown = input.ladderDump == null && input.scaleOut == null && input.clusterSold == null && input.bleed == null;
    return { action: unknown ? null : 'hold', sellPct: 0, hard: false, reasons: [] };
  }
  const planned = planBleedExit({
    alert: { action: 'sell', reasons: [input.ladderDump && input.ladderDump.flagged ? 'ladder dump' : 'scale-out into a rising chart'] },
    state: input.state || { step: 0, originalTokens: null },
    mcapUsd: input.mcapUsd != null ? input.mcapUsd : input.entryMcapUsd,
    mcapSol: input.mcapSol,
    solPriceUsd: input.solPriceUsd,
    floorUsd: input.floorUsd,
    positionTokens: input.positionTokens,
    slices: SLICES
  });
  return { action: planned.action, sellPct: planned.sellPct, hard: false, reasons: [planned.reason], state: planned.state, nextStep: planned.nextStep };
}

function holdStats(coin, solPriceUsd) {
  const snaps = (coin.snapshots || []).filter(row => mcapUsd(row, solPriceUsd) != null);
  if (snaps.length < 2) return null;
  const entry = mcapUsd(snaps[0], solPriceUsd);
  const exit = mcapUsd(snaps[snaps.length - 1], solPriceUsd);
  if (!(entry > 0) || exit == null) return null;
  const trough = Math.min(...snaps.map(row => mcapUsd(row, solPriceUsd)));
  return { pnl: exit / entry - 1, entryMcap: entry, exitMcap: exit, drawdown: trough / entry - 1, beforeClusterSell: null };
}

function firstClusterSellAt(coin) {
  if (finite(coin.firstClusterSellAt) != null) return coin.firstClusterSellAt;
  if (!Array.isArray(coin.trades) || !Array.isArray(coin.clusterWallets)) return null;
  const cluster = new Set(coin.clusterWallets);
  const sells = coin.trades.filter(row => row && row.side === 'sell' && cluster.has(row.wallet) && finite(row.time) != null);
  if (!sells.length) return null;
  return Math.min(...sells.map(row => row.time));
}

function contextAt(coin, prefix, now, options) {
  const at = finite(now.time != null ? now.time : now.atMin);
  const trades = Array.isArray(coin.trades) ? coin.trades.filter(row => finite(row.time) == null || row.time <= at) : null;
  return {
    ...options,
    series: prefix,
    trades,
    clusterWallets: coin.clusterWallets,
    kolWallets: coin.kolWallets,
    shadowWallets: coin.shadowWallets,
    bleed: coin.bleed || { flagged: false },
    nonMigrator: coin.nonMigrator,
    curveProgress: now.curveProgress != null ? now.curveProgress : coin.curveProgress,
    graduated: now.graduated != null ? now.graduated : coin.graduated,
    devExit: coin.devExit,
    serial: coin.serial,
    bonding: coin.bonding,
    now: at,
    sessionRemaining: options.sessionRemaining == null ? options.maxSol || DEFAULT_MAX_SOL : options.sessionRemaining,
    maxSol: options.maxSol
  };
}

function simulateRide(coin, options) {
  const snaps = coin.snapshots || [];
  let entry = null;
  let trough = null;
  for (let index = 0; index < snaps.length; index += 1) {
    const now = snaps[index];
    const at = finite(now.time != null ? now.time : now.atMin);
    const price = mcapUsd(now, options.solPriceUsd);
    if (!entry) {
      const decision = scoreFarmEntry(contextAt(coin, snaps.slice(0, index + 1), now, options));
      if (decision.eligible === true && price != null) {
        entry = { time: at, mcap: price };
        trough = price;
      }
      continue;
    }
    if (price != null) trough = Math.min(trough, price);
    const clusterSell = firstClusterSellAt({ ...coin, trades: (coin.trades || []).filter(row => finite(row.time) != null && row.time <= at) });
    const exit = planFarmExit({
      entryMcapUsd: entry.mcap,
      mcapUsd: price,
      enteredAt: entry.time,
      now: at,
      clusterSold: clusterSell != null,
      shadowSold: false,
      bleed: coin.bleed,
      ladderDump: coin.ladderDump,
      scaleOut: coin.scaleOut,
      nonMigrator: coin.nonMigrator,
      curveProgress: now.curveProgress != null ? now.curveProgress : coin.curveProgress,
      graduated: now.graduated != null ? now.graduated : coin.graduated,
      positionTokens: 1,
      floorUsd: options.floorUsd || 1,
      solPriceUsd: options.solPriceUsd,
      stopLossPct: options.stopLossPct,
      maxHoldMs: options.maxHoldMs
    });
    if (exit.action === 'sell' && price != null) {
      const firstSell = firstClusterSellAt(coin);
      return {
        pnl: price / entry.mcap - 1,
        entryMcap: entry.mcap,
        exitMcap: price,
        drawdown: trough / entry.mcap - 1,
        beforeClusterSell: firstSell == null ? null : at < firstSell,
        reasons: exit.reasons
      };
    }
  }
  return null;
}

function simulateAvoid(coin, options) {
  if (!Array.isArray(coin.clusterWallets) || !Array.isArray(coin.kolWallets)) return null;
  const farmed = coin.clusterWallets.length > 0 || coin.kolWallets.length > 0;
  if (farmed) return null;
  return holdStats(coin, options.solPriceUsd);
}

function summarize(trades) {
  if (!trades.length) {
    return { trades: 0, winRate: null, avgPnl: null, avgEntryMcap: null, avgExitMcap: null, pctExitsBeforeClusterSell: null, worstDrawdown: null };
  }
  const pnls = trades.map(row => row.pnl).filter(value => value != null);
  const entries = trades.map(row => row.entryMcap).filter(value => value != null);
  const exits = trades.map(row => row.exitMcap).filter(value => value != null);
  const before = trades.filter(row => row.beforeClusterSell != null);
  const draws = trades.map(row => row.drawdown).filter(value => value != null);
  const avg = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    trades: trades.length,
    winRate: pnls.length ? pnls.filter(value => value > 0).length / pnls.length : null,
    avgPnl: pnls.length ? avg(pnls) : null,
    avgEntryMcap: entries.length ? avg(entries) : null,
    avgExitMcap: exits.length ? avg(exits) : null,
    pctExitsBeforeClusterSell: before.length ? before.filter(row => row.beforeClusterSell).length / before.length : null,
    worstDrawdown: draws.length ? Math.min(...draws) : null
  };
}

function compareFarmStrategies(coins, options = {}) {
  const ride = [];
  const avoid = [];
  const baseline = [];
  (coins || []).forEach(coin => {
    if (!coin || !Array.isArray(coin.snapshots)) return;
    const held = holdStats(coin, options.solPriceUsd);
    if (held) baseline.push(held);
    const ridden = simulateRide(coin, options);
    if (ridden) ride.push(ridden);
    const skipped = simulateAvoid(coin, options);
    if (skipped) avoid.push(skipped);
  });
  return {
    ride: summarize(ride),
    avoid: summarize(avoid),
    baseline: summarize(baseline)
  };
}

module.exports = {
  scoreFarmEntry,
  planFarmExit,
  compareFarmStrategies,
  earlyPump,
  DEFAULT_MAX_SOL,
  DEFAULT_KOL_WINDOW_MS,
  SLICES
};
