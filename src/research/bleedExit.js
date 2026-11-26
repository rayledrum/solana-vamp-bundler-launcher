const { createStore } = require('./store');
const { linkSerialDevs } = require('./serialDev');
const { labelNonMigrators } = require('./nonMigrator');
const config = require('../config');

const DEFAULT_RISE_PCT = 50;
const DEFAULT_DRAWDOWN_PCT = 50;
const DEFAULT_SECOND_PUMP_USD = 100_000;
const DEFAULT_FLOOR_USD = 50_000;
const DEFAULT_SLICES = [50, 25, 25];

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function variation(values) {
  if (!values || values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (!(mean > 0)) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function equivalentUsd(point, solPriceUsd) {
  if (!point) return null;
  const usd = finite(point.mcapUsd);
  if (usd != null) return usd;
  const sol = finite(point.mcapSol);
  const price = finite(solPriceUsd);
  if (sol != null && price != null) return sol * price;
  return null;
}

function seriesValue(point) {
  const usd = finite(point && point.mcapUsd);
  if (usd != null) return usd;
  return finite(point && point.mcapSol);
}

function trackPumps(series, options = {}) {
  if (!Array.isArray(series)) {
    return { pumps: null, peakMcapUsd: null, aboveSecondPumpThreshold: null, armAfterPump: null, armed: null };
  }
  const minRise = finite(options.minRisePct) == null ? DEFAULT_RISE_PCT : finite(options.minRisePct);
  const minDrawdown = finite(options.minDrawdownPct) == null ? DEFAULT_DRAWDOWN_PCT : finite(options.minDrawdownPct);
  const minDipMs = finite(options.minDipDurationMs) == null ? 0 : finite(options.minDipDurationMs);
  const threshold = finite(options.secondPumpMcapUsd) == null ? DEFAULT_SECOND_PUMP_USD : finite(options.secondPumpMcapUsd);
  const minPump2 = finite(options.minPump2McapUsd) == null ? threshold : finite(options.minPump2McapUsd);
  const solPriceUsd = finite(options.solPriceUsd);
  const useUsd = series.some(row => finite(row && row.mcapUsd) != null);
  const points = series.map(row => ({
    time: finite(row && (row.time != null ? row.time : row.atMin)),
    value: useUsd ? finite(row && row.mcapUsd) : seriesValue(row),
    usd: equivalentUsd(row, solPriceUsd)
  })).filter(row => row.time != null && row.value != null).sort((a, b) => a.time - b.time);
  const usdValues = points.map(row => row.usd).filter(value => value != null);
  const aboveSecondPumpThreshold = usdValues.length ? Math.max(...usdValues) >= threshold : null;
  const armAfterPump = aboveSecondPumpThreshold === true ? 2 : aboveSecondPumpThreshold === false ? 1 : null;
  if (!points.length) {
    return { pumps: [], peakMcapUsd: null, aboveSecondPumpThreshold, armAfterPump, armed: false, secondPumpMcapUsd: threshold };
  }
  const pumps = [];
  let trough = points[0].value;
  let rising = false;
  let high = null;
  let highAt = null;
  let highUsd = null;
  let dipAt = null;
  points.forEach(point => {
    if (!rising) {
      if (point.value < trough) trough = point.value;
      if (trough > 0 && ((point.value - trough) / trough) * 100 >= minRise) {
        rising = true;
        high = point.value;
        highAt = point.time;
        highUsd = point.usd;
        dipAt = null;
      }
      return;
    }
    if (point.value >= high) {
      high = point.value;
      highAt = point.time;
      highUsd = point.usd;
      dipAt = null;
      return;
    }
    const drawdownPct = high > 0 ? ((high - point.value) / high) * 100 : 0;
    if (drawdownPct < minDrawdown) {
      dipAt = null;
      return;
    }
    if (dipAt == null) dipAt = point.time;
    if (point.time - dipAt < minDipMs) return;
    const major = pumps.some(pump => pump.peakMcapUsd != null && pump.peakMcapUsd >= threshold) || (highUsd != null && highUsd >= threshold);
    const wiggle = pumps.length >= 1 && major && highUsd != null && highUsd < minPump2;
    if (!wiggle) {
      pumps.push({
        number: pumps.length + 1,
        peakAt: highAt,
        peakValue: high,
        peakMcapUsd: highUsd,
        drawdownPct
      });
    }
    rising = false;
    trough = point.value;
    high = null;
    dipAt = null;
  });
  const armed = armAfterPump == null ? null : pumps.some(pump => pump.number >= armAfterPump);
  return {
    pumps,
    rising,
    activePump: rising ? pumps.length + 1 : null,
    peakMcapUsd: usdValues.length ? Math.max(...usdValues) : null,
    aboveSecondPumpThreshold,
    armAfterPump,
    armed,
    secondPumpMcapUsd: threshold
  };
}

function emptyBleed(mint) {
  return {
    mint: mint || null,
    flagged: null,
    bleedStart: null,
    soldSol: null,
    soldSupplyPct: null,
    buyAbsorptionRatio: null,
    mcapFromPeak: null
  };
}

function analyzeBleed(input = {}) {
  if (!Array.isArray(input.trades) || input.armed == null || finite(input.peakAt) == null) return emptyBleed(input.mint);
  if (input.armed === false) {
    return { ...emptyBleed(input.mint), flagged: false };
  }
  if (!Array.isArray(input.linkedWallets)) return emptyBleed(input.mint);
  const linked = new Set(input.linkedWallets);
  const after = input.trades.filter(row => row && finite(row.time) != null && row.time >= input.peakAt);
  const sells = after.filter(row => row.side === 'sell' && linked.has(row.wallet));
  const buys = after.filter(row => row.side === 'buy' && !linked.has(row.wallet));
  if (sells.length < 3) {
    return { ...emptyBleed(input.mint), flagged: false, buyAbsorptionRatio: sells.length ? buys.length / sells.length : null };
  }
  const ordered = sells.slice().sort((a, b) => a.time - b.time);
  if (ordered.some(row => finite(row.sol) == null)) return { ...emptyBleed(input.mint), flagged: null };
  const gaps = ordered.slice(1).map((row, index) => row.time - ordered[index].time);
  const sizeCv = variation(ordered.map(row => row.sol));
  const gapCv = variation(gaps);
  const steady = sizeCv != null && sizeCv <= 0.25 && gapCv != null && gapCv <= 0.35 && gaps.every(gap => gap >= 1000);
  const absorbing = buys.length >= ordered.length;
  const supply = finite(input.supply);
  const tokensKnown = supply != null && supply > 0 && ordered.every(row => finite(row.tokens) != null);
  const peak = finite(input.peakMcapUsd);
  const now = finite(input.mcapUsd);
  return {
    mint: input.mint || null,
    flagged: Boolean(steady && absorbing),
    bleedStart: ordered[0].time,
    soldSol: ordered.reduce((sum, row) => sum + row.sol, 0),
    soldSupplyPct: tokensKnown ? (ordered.reduce((sum, row) => sum + row.tokens, 0) / supply) * 100 : null,
    buyAbsorptionRatio: buys.length / ordered.length,
    mcapFromPeak: peak != null && peak > 0 && now != null ? now / peak : null
  };
}

function buildExitAlert(input = {}) {
  const pumps = input.pumps || null;
  const bleed = input.bleed || null;
  const shadow = input.kolShadow || null;
  const nonMigrator = input.nonMigrator || null;
  if (!pumps && !bleed && !shadow && !nonMigrator) return { action: null, reasons: null, armAfterPump: null };
  const reasons = [];
  if (pumps && pumps.armed === true && bleed && bleed.flagged === true) {
    reasons.push(`slow bleed after pump ${pumps.armAfterPump}`);
  }
  if (shadow && finite(shadow.shadowCount) != null && shadow.shadowCount > 0) {
    reasons.push('KOL shadow sells');
  }
  const progress = finite(input.curveProgress);
  const progressLine = finite(input.progressThreshold) == null ? 90 : finite(input.progressThreshold);
  if (nonMigrator && nonMigrator.nonMigrator === true && progress != null && progress >= progressLine && input.graduated === false) {
    reasons.push('non-migrator dev near the migration line');
  }
  if (!reasons.length && pumps && pumps.armed == null && !(nonMigrator && nonMigrator.nonMigrator === true)) {
    return { action: null, reasons: null, armAfterPump: pumps.armAfterPump };
  }
  return {
    action: reasons.length ? 'sell' : 'hold',
    reasons,
    armAfterPump: pumps ? pumps.armAfterPump : null,
    floorUsd: finite(input.floorUsd) == null ? DEFAULT_FLOOR_USD : finite(input.floorUsd)
  };
}

function planBleedExit({ alert, state, mcapUsd, mcapSol, solPriceUsd, floorUsd, positionTokens, slices, now, minSliceGapMs, minSliceDrawdownPct, linkedSells }) {
  const book = state || { step: 0, originalTokens: null };
  const floor = finite(floorUsd) == null ? DEFAULT_FLOOR_USD : finite(floorUsd);
  const planSlices = Array.isArray(slices) && slices.length ? slices : DEFAULT_SLICES;
  if (!alert || alert.action !== 'sell') {
    return { action: 'hold', sellPct: 0, reason: 'no-alert', state: book, nextStep: book.step };
  }
  const usd = equivalentUsd({ mcapUsd, mcapSol }, solPriceUsd);
  if (usd == null) return { action: 'hold', sellPct: 0, reason: 'floor-unknown', state: book, nextStep: book.step };
  if (!(positionTokens > 0)) return { action: 'hold', sellPct: 0, reason: 'no-position', state: book, nextStep: book.step };
  if (book.originalTokens == null) book.originalTokens = positionTokens;
  if (usd <= floor) {
    return { action: 'sell', sellPct: 100, reason: 'market cap is at the exit floor', state: book, nextStep: planSlices.length };
  }
  if (book.step >= planSlices.length) {
    return { action: 'hold', sellPct: 0, reason: 'slices-done', state: book, nextStep: book.step };
  }
  if (book.step > 0) {
    const gap = finite(minSliceGapMs) == null ? 60_000 : finite(minSliceGapMs);
    const drawdown = finite(minSliceDrawdownPct) == null ? 10 : finite(minSliceDrawdownPct);
    const waited = book.lastSellAt != null && finite(now) != null && now - book.lastSellAt >= gap;
    const deeper = book.lastMcapUsd > 0 && usd <= book.lastMcapUsd * (1 - drawdown / 100);
    const moreSells = finite(linkedSells) != null && finite(book.linkedSells) != null && linkedSells > book.linkedSells;
    if (!waited && !deeper && !moreSells) {
      return { action: 'hold', sellPct: 0, reason: 'slice-wait', state: book, nextStep: book.step };
    }
  }
  const portion = book.originalTokens * (planSlices[book.step] / 100);
  const sellPct = Math.min(100, (portion / positionTokens) * 100);
  return {
    action: 'sell',
    sellPct,
    reason: (alert.reasons || []).join('; '),
    state: book,
    nextStep: book.step + 1
  };
}

function entryDecision(input = {}) {
  const pumps = input.pumps || null;
  const bleed = input.bleed || null;
  const shadow = input.kolShadow || null;
  const serial = input.serial || null;
  const nonMigrator = input.nonMigrator || null;
  if (!pumps && !bleed && !shadow && !serial && !nonMigrator) return { action: 'allow', sizeMultiplier: 1, reasons: [] };
  const reasons = [];
  let action = 'allow';
  if (pumps && pumps.armed === true && bleed && bleed.flagged === true) {
    action = 'skip';
    reasons.push('bleed after the armed pump');
  }
  const transferred = shadow && finite(shadow.shadowCount) > 0 && Array.isArray(shadow.reasons) && shadow.reasons.includes('bare token transfer');
  if (transferred) {
    action = 'skip';
    reasons.push('KOL buy with transferred shadow supply');
  }
  const priors = serial && serial.linkedPriorCoins;
  if (Array.isArray(priors) && priors.some(row => row && row.bleed === true)) {
    if (action !== 'skip') action = 'reduce';
    reasons.push('serial dev prior used this exit profile');
  }
  const progress = finite(input.curveProgress);
  const progressLine = finite(input.progressThreshold) == null ? 90 : finite(input.progressThreshold);
  if (nonMigrator && nonMigrator.nonMigrator === true && progress != null && progress >= progressLine && input.graduated === false) {
    action = 'skip';
    reasons.push('non-migrator dev near the migration line');
  }
  return { action, sizeMultiplier: action === 'skip' ? 0 : action === 'reduce' ? 0.5 : 1, reasons };
}

function applyEntryGate(isSim, gate, amount) {
  if (!isSim || !gate || gate.action === 'allow' || gate.action == null) return { amount, action: 'allow', reasons: [] };
  if (gate.action === 'skip') {
    return { amount, action: 'skip', reasons: gate.reasons || [] };
  }
  if (gate.action === 'reduce' && finite(gate.sizeMultiplier) > 0 && gate.sizeMultiplier < 1) {
    return { amount: amount * gate.sizeMultiplier, action: 'reduce', reasons: gate.reasons || [] };
  }
  return { amount, action: 'allow', reasons: [] };
}

function assessMint(mint, store, injected) {
  const extra = injected && typeof injected === 'object' ? injected : {};
  const root = store && typeof store.readJsonl === 'function' ? store : createStore();
  let snapshots = Array.isArray(extra.snapshots) ? extra.snapshots : null;
  let shadow = extra.kolShadow || null;
  let serial = extra.serial || null;
  let observations = Array.isArray(extra.observations) ? extra.observations : null;
  if (!Array.isArray(extra.snapshots) || shadow == null || serial == null || observations == null) {
    try {
      if (!Array.isArray(extra.snapshots)) snapshots = root.readJsonl('snapshots.jsonl').filter(row => row && row.mint === mint);
      if (shadow == null) shadow = root.readJsonl('kol-shadows.jsonl').filter(row => row && row.mint === mint).pop() || null;
      if (serial == null) {
        const linked = linkSerialDevs(root.readJsonl('serial-devs.jsonl'));
        serial = linked ? linked.filter(row => row && row.mint === mint).pop() || null : null;
      }
      if (observations == null) observations = root.readJsonl('non-migrators.jsonl');
    } catch (err) {
      if (!Array.isArray(snapshots)) snapshots = [];
      if (observations == null) observations = [];
    }
  }
  snapshots = Array.isArray(snapshots) ? snapshots : [];
  const pumps = trackPumps(snapshots.map(row => ({
    time: row.time != null ? row.time : row.atMin,
    mcapUsd: row.mcapUsd,
    mcapSol: row.mcapSol
  })), {
    minRisePct: config.PUMP_MIN_RISE_PCT,
    minDrawdownPct: config.PUMP_MIN_DRAWDOWN_PCT,
    minDipDurationMs: config.PUMP_MIN_DIP_MS,
    secondPumpMcapUsd: config.SECOND_PUMP_MCAP_USD
  });
  const peak = pumps.pumps && pumps.armAfterPump ? pumps.pumps.find(row => row.number >= pumps.armAfterPump) : null;
  let tape = extra.tape || null;
  if (!tape) {
    try { tape = root.readJsonl('tapes.jsonl').filter(row => row && row.mint === mint).pop() || null; } catch (err) { tape = null; }
  }
  const trades = Array.isArray(extra.trades) ? extra.trades : (tape && Array.isArray(tape.trades) ? tape.trades : null);
  const linkedWallets = trades ? [...new Set([serial && serial.dev, ...(serial && serial.linkedDevs || [])].filter(Boolean))] : null;
  const bleed = trades ? analyzeBleed({
    mint,
    armed: pumps.armed,
    peakAt: peak && peak.peakAt,
    trades,
    linkedWallets,
    supply: tape.supply,
    peakMcapUsd: peak && peak.peakMcapUsd,
    mcapUsd: snapshots.reduce((best, row) => finite(row && row.mcapUsd) != null ? row.mcapUsd : best, null)
  }) : {
    mint,
    flagged: null,
    bleedStart: null,
    soldSol: null,
    soldSupplyPct: null,
    buyAbsorptionRatio: null,
    mcapFromPeak: null,
    reason: config.HELIUS_CONFIGURED ? 'Tape was not stored for this mint' : 'no tape: set HELIUS_API_KEY'
  };
  const mcRun = trades ? require('./tapeFlags').analyzeMcRun({ mint, trades }) : null;
  const scaleOut = trades ? require('./tapeFlags').analyzeScaleOut({ mint, trades, supply: tape && tape.supply }) : null;
  const instantBond = tape ? require('./tapeFlags').analyzeInstantBond({
    mint,
    createTime: tape.createTime,
    graduatedAt: tape.graduatedAt,
    graduated: tape.graduated,
    snipeBurst: tape.signatures ? { signatures: tape.signatures.listed, failedRatio: tape.signatures.failedRatio } : null
  }) : null;
  const latest = snapshots[snapshots.length - 1] || null;
  const nonMigrator = labelNonMigrators({
    mint,
    dev: serial && serial.dev,
    linkedDevs: serial && serial.linkedDevs,
    coins: observations
  });
  const exitAlert = buildExitAlert({
    pumps,
    bleed,
    kolShadow: shadow,
    nonMigrator,
    curveProgress: latest && latest.curveProgress,
    graduated: latest ? latest.graduated : null,
    progressThreshold: config.NEAR_MIGRATION_PCT,
    floorUsd: config.BLEED_FLOOR_MCAP_USD
  });
  return {
    pumps,
    bleed,
    kolShadow: shadow,
    serial,
    nonMigrator,
    curveProgress: latest && finite(latest.curveProgress),
    graduated: latest ? latest.graduated : null,
    mcRun,
    scaleOut,
    instantBond,
    exitAlert
  };
}

function pickExitPoint(coin, bleed) {
  const snaps = (coin.snapshots || []).filter(row => finite(row.time != null ? row.time : row.atMin) != null);
  if (!snaps.length || !bleed || finite(bleed.bleedStart) == null) return null;
  return snaps.find(row => (row.time != null ? row.time : row.atMin) >= bleed.bleedStart) || null;
}

function compareBleedStrategy(coins, options = {}) {
  const floorUsd = finite(options.floorUsd) == null ? DEFAULT_FLOOR_USD : finite(options.floorUsd);
  const secondPumpMcapUsd = finite(options.secondPumpMcapUsd) == null ? DEFAULT_SECOND_PUMP_USD : finite(options.secondPumpMcapUsd);
  const exits = [];
  (coins || []).forEach(coin => {
    if (!coin || !Array.isArray(coin.snapshots)) return;
    const pumps = trackPumps(coin.snapshots, {
      minRisePct: options.minRisePct,
      minDrawdownPct: options.minDrawdownPct,
      secondPumpMcapUsd,
      solPriceUsd: options.solPriceUsd
    });
    if (!pumps || pumps.armed == null) return;
    const peak = (pumps.pumps || []).find(row => row.number >= pumps.armAfterPump);
    const last = coin.snapshots[coin.snapshots.length - 1];
    const bleed = analyzeBleed({
      mint: coin.mint,
      trades: coin.trades,
      armed: pumps.armed,
      peakAt: peak && peak.peakAt,
      linkedWallets: coin.linkedWallets,
      supply: coin.supply,
      peakMcapUsd: peak && peak.peakMcapUsd,
      mcapUsd: last && last.mcapUsd
    });
    const alert = buildExitAlert({ pumps, bleed, kolShadow: coin.kolShadow, floorUsd });
    if (!alert || alert.action !== 'sell') return;
    const point = pickExitPoint(coin, bleed);
    const exitMcapUsd = point ? equivalentUsd(point, options.solPriceUsd) : null;
    exits.push({
      mint: coin.mint,
      exitMcapUsd,
      beforeFloor: exitMcapUsd == null ? null : exitMcapUsd > floorUsd,
      armAfterPump: pumps.armAfterPump
    });
  });
  const known = exits.filter(row => row.exitMcapUsd != null);
  const decided = exits.filter(row => row.beforeFloor != null);
  return {
    secondPumpMcapUsd,
    floorUsd,
    trades: exits.length,
    avgExitMcap: known.length ? known.reduce((sum, row) => sum + row.exitMcapUsd, 0) / known.length : null,
    pctExitedBeforeFloor: decided.length ? decided.filter(row => row.beforeFloor).length / decided.length : null,
    exits
  };
}

module.exports = {
  trackPumps,
  analyzeBleed,
  buildExitAlert,
  planBleedExit,
  entryDecision,
  applyEntryGate,
  assessMint,
  compareBleedStrategy,
  equivalentUsd,
  DEFAULT_SLICES,
  DEFAULT_SECOND_PUMP_USD,
  DEFAULT_FLOOR_USD
};
