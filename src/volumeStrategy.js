// Pluggable volume-bumper strategies. The engine only asks the active
// strategy what to do on each cycle. round-trip is the one that runs today.
// alternate and hold can be added beside it without changing the timer.

function holdFor(options, rng) {
  if (Number.isFinite(options.holdMs)) return Math.max(0, options.holdMs);
  if (Number.isInteger(options.holdCycles)) return Math.max(1, options.holdCycles) * 1000;
  const min = Number.isInteger(options.minHoldCycles) ? options.minHoldCycles : 1;
  const max = Number.isInteger(options.maxHoldCycles) ? options.maxHoldCycles : 3;
  const low = Math.max(1, Math.min(min, max));
  const high = Math.max(low, Math.max(min, max));
  return (low + Math.floor(rng() * (high - low + 1))) * 1000;
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
    async onCycle({ engine, cycle, solAmount, mint }) {
      const actions = [];
      const now = Date.now();
      const due = open.filter(row => row.sellAt <= now);
      for (const row of due) {
        if (engine.activeToken !== mint) break;
        const sell = await sellLot(engine, row);
        actions.push({ side: 'sell', address: row.address, result: sell });
        const index = open.indexOf(row);
        if (index >= 0) open.splice(index, 1);
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
          sellAt: Date.now() + holdFor(options, rng),
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
  const maxPerTrade = number(input.maxPerTrade, 0.02);
  const sessionBudget = number(input.sessionBudget, 0.05);
  const maxCycles = Math.floor(number(input.maxCycles, 10));
  const reserveSol = number(input.reserveSol, 0.02);
  const holdSeconds = number(input.holdSeconds, 15);
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
  if (holdSeconds < 0 || holdSeconds > 600) fail('Hold time must be from 0 to 600 seconds');
  if (!Number.isInteger(maxErrors) || maxErrors < 1 || maxErrors > 20) fail('Max consecutive errors must be an integer from 1 to 20');
  if (stallSeconds < 5 || stallSeconds > 300) fail('Feed stall window must be from 5 to 300 seconds');
  return { maxPerTrade, sessionBudget, maxCycles, reserveSol, holdSeconds, maxErrors, stallSeconds };
}

module.exports = {
  createRoundTripStrategy,
  holdFor,
  readBumpLimits,
  sellPctFor
};
