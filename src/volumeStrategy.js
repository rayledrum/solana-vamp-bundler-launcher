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

async function sellLot(engine, row) {
  const pct = sellPctFor(engine, row);
  if (pct == null) {
    return { success: false, error: 'Cycle buy did not record tokens to sell', results: [] };
  }
  return engine.executeSell({ pct, walletAddresses: [row.address] });
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
          tokensBought: bought
        });
      }
      return { actions };
    },
    async closeOpen(engine) {
      const actions = [];
      const rows = open.splice(0, open.length);
      for (const row of rows) {
        const sell = await sellLot(engine, row);
        actions.push({ side: 'sell', address: row.address, result: sell });
      }
      return actions;
    }
  };
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
  return { maxPerTrade, sessionBudget, maxCycles, reserveSol, minDelaySeconds, maxDelaySeconds, maxErrors, stallSeconds };
}

module.exports = {
  createRoundTripStrategy,
  delayMs,
  readBumpLimits,
  sellPctFor
};
