// Pluggable volume-bumper strategies. The engine only asks the active
// strategy what to do on each cycle. round-trip is the one that runs today.
// alternate and hold can be added beside it without changing the timer.

function delayMs(limits, rng) {
  const min = Number(limits.minDelaySeconds);
  const max = Number(limits.maxDelaySeconds);
  const roll = typeof rng === 'function' ? rng() : Math.random();
  const span = Math.max(0, max - min);
  return Math.round((min + (Number.isFinite(roll) ? roll : 0) * span) * 1000);
}

function sellPctFor(engine, row) {
  const bought = Number(row.tokensBought) || 0;
  if (!(bought > 0)) return null;
  const position = engine.positions.get(row.address);
  const held = position ? Number(position.tokens) || 0 : 0;
  if (!(held > 0) || bought >= held * 0.99) return 100;
  return Math.min(100, (bought / held) * 100);
}

async function sellLot(engine, row, fraction = 1) {
  const bought = Number(row.tokensBought) || 0;
  const position = engine.positions.get(row.address);
  const held = position ? Number(position.tokens) || 0 : 0;
  if (row.inflight || !(bought > 0) || held <= 0) {
    if (!row.inflight) row.tokensBought = 0;
    return { success: true, totalReceivedSol: 0, skipped: true, results: [] };
  }
  const portion = fraction >= 0.999 ? 1 : Math.min(1, Math.max(0.25, fraction));
  const sellTokens = bought * portion;
  const pct = sellTokens >= held * 0.99 ? 100 : Math.max(0.01, Math.min(100, (sellTokens / held) * 100));
  row.inflight = true;
  let result;
  try {
    result = await engine.executeSell({
      pct,
      walletAddresses: [row.address],
      fromBumper: true,
      mint: row.mint || engine.bumpMint || engine.activeToken
    });
  } finally {
    row.inflight = false;
  }
  if (result && result.success) {
    row.tokensBought = portion >= 0.999 || pct >= 99.5 ? 0 : Math.max(0, bought - sellTokens);
  }
  return result;
}

function chooseBumpSide(openCount, maxOpen, rng) {
  const open = Math.max(0, Number(openCount) || 0);
  const max = Math.max(1, Number(maxOpen) || 1);
  if (open <= 0) return 'buy';
  if (open >= max) return 'sell';
  const roll = typeof rng === 'function' ? rng() : Math.random();
  return roll < open / max ? 'sell' : 'buy';
}

function sellFraction(rng) {
  const roll = typeof rng === 'function' ? rng() : Math.random();
  return Math.min(1, 0.25 + (Number.isFinite(roll) ? roll : 0) * 0.75);
}

function createRoundTripStrategy(options = {}) {
  const rng = options.rng || Math.random;
  const open = [];
  return {
    name: 'round-trip',
    open,
    async onCycle({ engine, phase = 'buy', solAmount, mint }) {
      const actions = [];
      if (phase === 'sell') {
        const rows = open.splice(0, open.length);
        for (const row of rows) {
          if (engine.activeToken !== mint) break;
          const sell = await sellLot(engine, row);
          actions.push({ side: 'sell', address: row.address, result: sell });
        }
        return { actions };
      }
      if (!engine.isBumping || engine.activeToken !== mint || !engine.canBumpBuy()) return { actions };
      const busy = new Set(open.map(row => row.address));
      const candidates = engine.bumpSubWallets(solAmount).filter(address => !busy.has(address));
      if (!candidates.length) return { actions };
      const address = candidates[Math.floor(rng() * candidates.length)];
      const buy = await engine.executeBuy({ solAmount, walletAddresses: [address] });
      actions.push({ side: 'buy', address, result: buy });
      const bought = buy.success && buy.results && buy.results[0] ? Number(buy.results[0].tokensBought) || 0 : 0;
      if (buy.success && bought > 0) {
        open.push({
          address,
          solSpent: solAmount,
          tokensBought: bought,
          mint
        });
      }
      return { actions };
    },
    nextPhase() {
      return open.length ? 'sell' : 'buy';
    },
    async closeOpen(engine) {
      return closeLots(engine, open);
    }
  };
}

function createRandomStrategy(options = {}) {
  const rng = options.rng || Math.random;
  const maxOpen = Math.max(1, Math.floor(Number(options.maxOpen) || 4));
  const open = [];
  return {
    name: 'random',
    open,
    maxOpen,
    nextPhase() {
      return 'buy';
    },
    async onCycle({ engine, solAmount, mint }) {
      const actions = [];
      const side = chooseBumpSide(open.length, maxOpen, rng);
      if (side === 'sell') {
        const row = open[Math.min(open.length - 1, Math.floor(rng() * open.length))];
        const fraction = sellFraction(rng);
        const sell = await sellLot(engine, row, fraction);
        actions.push({ side: 'sell', address: row.address, pct: fraction, result: sell });
        if (!(row.tokensBought > 0)) {
          const index = open.indexOf(row);
          if (index >= 0) open.splice(index, 1);
        }
        return { actions };
      }
      if (!engine.isBumping || engine.activeToken !== mint || !engine.canBumpBuy()) return { actions };
      const busy = new Set(open.map(row => row.address));
      const candidates = engine.bumpSubWallets(solAmount).filter(address => !busy.has(address));
      if (!candidates.length) return { actions };
      const address = candidates[Math.floor(rng() * candidates.length)];
      const buy = await engine.executeBuy({ solAmount, walletAddresses: [address] });
      actions.push({ side: 'buy', address, result: buy });
      const bought = buy.success && buy.results && buy.results[0] ? Number(buy.results[0].tokensBought) || 0 : 0;
      if (buy.success && bought > 0) {
        open.push({ address, solSpent: solAmount, tokensBought: bought, mint });
      }
      return { actions };
    },
    async closeOpen(engine) {
      return closeLots(engine, open);
    }
  };
}

async function closeLots(engine, open) {
  const actions = [];
  const rows = open.splice(0, open.length);
  for (const row of rows) {
    const sell = await sellLot(engine, row, 1);
    actions.push({ side: 'sell', address: row.address, result: sell });
  }
  return actions;
}

function createVolumeStrategy(options = {}) {
  const name = String(options.strategy || options.strategyName || 'random').toLowerCase();
  if (name === 'round-trip' || name === 'roundtrip') return createRoundTripStrategy(options);
  return createRandomStrategy(options);
}

function readBumpLimits(input = {}, solAmount) {
  const config = require('./config');
  const number = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      const err = new Error('Bumper limit must be a finite number');
      err.statusCode = 400;
      throw err;
    }
    return parsed;
  };
  const maxPerTrade = number(input.maxPerTrade, 0.01);
  const sessionBudget = number(input.sessionBudget, 0.05);
  const maxCycles = Math.floor(number(input.maxCycles, 10));
  const reserveSol = number(input.reserveSol, 0.02);
  const minDelaySeconds = Math.floor(number(input.minDelaySeconds, 3));
  const maxDelaySeconds = Math.floor(number(input.maxDelaySeconds, 10));
  const maxErrors = Math.floor(number(input.maxErrors, 3));
  const stallSeconds = number(input.stallSeconds, 30);
  const maxOpen = Math.floor(number(input.maxOpen, 4));
  const strategyName = String(input.strategy || input.strategyName || 'random').toLowerCase();
  const fail = (message) => {
    const err = new Error(message);
    err.statusCode = 400;
    throw err;
  };
  if (maxPerTrade <= 0 || maxPerTrade > config.MAX_SOL_PER_TRADE) {
    fail(`Per-trade cap must be greater than 0 and at most ${config.MAX_SOL_PER_TRADE} SOL`);
  }
  if (solAmount > maxPerTrade) fail(`Buy size ${solAmount} SOL exceeds the per-trade cap of ${maxPerTrade} SOL`);
  if (sessionBudget <= 0 || sessionBudget > config.MAX_SOL_PER_SESSION) {
    fail(`Session budget must be greater than 0 and at most ${config.MAX_SOL_PER_SESSION} SOL`);
  }
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 200) fail('Max cycles must be an integer from 1 to 200');
  if (reserveSol < 0 || reserveSol > 1) fail('Wallet SOL reserve must be from 0 to 1 SOL');
  if (!Number.isInteger(minDelaySeconds) || minDelaySeconds < 1) fail('Min delay must be an integer of at least 1 second');
  if (!Number.isInteger(maxDelaySeconds) || maxDelaySeconds < minDelaySeconds) fail('Max delay must be an integer greater than or equal to the min delay');
  if (maxDelaySeconds > 300) fail('Max delay must be at most 300 seconds');
  if (!Number.isInteger(maxErrors) || maxErrors < 1 || maxErrors > 20) fail('Max consecutive errors must be an integer from 1 to 20');
  if (stallSeconds < 5 || stallSeconds > 300) fail('Feed stall window must be from 5 to 300 seconds');
  if (!Number.isInteger(maxOpen) || maxOpen < 1 || maxOpen > 24) fail('Max open positions must be an integer from 1 to 24');
  const strategy = strategyName === 'round-trip' || strategyName === 'roundtrip' ? 'round-trip' : 'random';
  if (strategyName !== 'random' && strategyName !== 'round-trip' && strategyName !== 'roundtrip') {
    fail('Strategy must be random or round-trip');
  }
  return {
    maxPerTrade, sessionBudget, maxCycles, reserveSol, minDelaySeconds, maxDelaySeconds,
    maxErrors, stallSeconds, maxOpen, strategy
  };
}

module.exports = {
  createRoundTripStrategy,
  createRandomStrategy,
  createVolumeStrategy,
  chooseBumpSide,
  sellFraction,
  delayMs,
  readBumpLimits,
  sellPctFor
};
