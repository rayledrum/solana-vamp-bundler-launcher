const DEFAULT_LADDER = {
  enabled: false,
  milestones: [
    { mcapUsd: 10000, sellPct: 25 },
    { mcapUsd: 20000, sellPct: 25 },
    { mcapUsd: 30000, sellPct: 25 }
  ],
  moonbagPct: 25,
  stallMinutes: 20,
  stallAboveEntryPct: 0,
  maxCurvePct: 5,
  minSellGapMs: 60_000
};

function freshState() {
  return {
    originalTokens: null,
    entryMcapUsd: null,
    highMcapUsd: null,
    highAt: null,
    soldTokens: 0,
    lastSellAt: 0,
    fired: {},
    stalled: false
  };
}

function clipTokens({ tokens, priceSol, liquiditySol, maxCurvePct }) {
  if (!(tokens > 0) || !(priceSol > 0)) return 0;
  if (!(liquiditySol > 0) || !(maxCurvePct > 0)) return 0;
  const maxSol = liquiditySol * (maxCurvePct / 100);
  const sol = tokens * priceSol;
  if (sol <= maxSol) return tokens;
  return maxSol / priceSol;
}

function planExit({ ladder, state, mcapUsd, liquiditySol, priceSol, positionTokens, now }) {
  const config = { ...DEFAULT_LADDER, ...(ladder || {}) };
  if (!config.enabled) return { action: 'hold', reason: 'disabled', sellTokens: 0 };
  if (!(mcapUsd > 0) || !(positionTokens > 0)) return { action: 'hold', reason: 'no-quote', sellTokens: 0 };
  if (state.originalTokens == null) state.originalTokens = positionTokens;
  if (state.entryMcapUsd == null) state.entryMcapUsd = mcapUsd;
  if (state.highMcapUsd == null || mcapUsd > state.highMcapUsd) {
    state.highMcapUsd = mcapUsd;
    state.highAt = now;
  }
  const moonbag = state.originalTokens * (Number(config.moonbagPct) / 100);
  const spare = Math.max(0, positionTokens - moonbag);
  if (!(spare > 0)) return { action: 'hold', reason: 'moonbag', sellTokens: 0 };
  if (state.lastSellAt && now - state.lastSellAt < config.minSellGapMs) {
    return { action: 'hold', reason: 'rate-limit', sellTokens: 0 };
  }

  let wanted = 0;
  let reason = null;
  let mark = null;
  const milestones = Array.isArray(config.milestones) ? config.milestones : [];
  for (const step of milestones) {
    const key = step.mcapUsd != null ? `usd:${step.mcapUsd}` : `gain:${step.gainPct}`;
    if (!key || state.fired[key]) continue;
    const target = step.mcapUsd != null
      ? Number(step.mcapUsd)
      : state.entryMcapUsd * (1 + Number(step.gainPct || 0) / 100);
    if (!(mcapUsd >= target)) continue;
    wanted = state.originalTokens * (Number(step.sellPct) / 100);
    reason = `scale-out at ${target} mcap`;
    mark = key;
    break;
  }
  const stallFloor = state.entryMcapUsd * (1 + Number(config.stallAboveEntryPct || 0) / 100);
  const stalled = !state.stalled
    && state.highAt
    && now - state.highAt >= Number(config.stallMinutes) * 60_000
    && mcapUsd < stallFloor;
  if (!wanted && stalled) {
    wanted = spare;
    reason = `stall stop: no high for ${config.stallMinutes}m and below entry`;
    mark = 'stall';
  }
  if (!(wanted > 0)) return { action: 'hold', reason: 'waiting', sellTokens: 0 };
  const sized = Math.min(spare, wanted);
  const clipped = clipTokens({
    tokens: sized,
    priceSol,
    liquiditySol,
    maxCurvePct: config.maxCurvePct
  });
  if (!(clipped > 0)) return { action: 'hold', reason: 'liquidity-cap', sellTokens: 0 };
  return {
    action: 'sell',
    reason,
    mark,
    sellTokens: clipped,
    sellPct: Math.min(100, (clipped / positionTokens) * 100)
  };
}

function noteFill(state, plan, now) {
  if (!plan || plan.action !== 'sell') return state;
  state.soldTokens += plan.sellTokens;
  state.lastSellAt = now;
  if (plan.mark === 'stall') state.stalled = true;
  else if (plan.mark) state.fired[plan.mark] = true;
  return state;
}

module.exports = { DEFAULT_LADDER, freshState, clipTokens, planExit, noteFill };
