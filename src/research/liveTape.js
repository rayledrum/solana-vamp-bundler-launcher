const { readCurveTape } = require('./tradeTape');
const { analyzeEarlyBuys } = require('./snipers');
const { analyzeWash } = require('./wash');
const { analyzeHolderPadding } = require('./holderPadding');
const { analyzeLadderDump } = require('./ladderDump');
const { analyzeMigrationDump } = require('./migrationDump');
const { analyzeKolShadow, analyzeMcRun, analyzeScaleOut, analyzeInstantBond } = require('./tapeFlags');
const { analyzeTopTraders } = require('./topTraders');
const { loadKolList } = require('./distribution');
const { createStore } = require('./store');

function storedTape(mint) {
  try {
    return createStore().readJsonl('tapes.jsonl').filter(row => row && row.mint === mint).pop() || null;
  } catch (err) {
    return null;
  }
}

async function readOnDemandTape({ connection, mint, maxFetches = 150 } = {}) {
  const stored = storedTape(mint);
  if (stored && Array.isArray(stored.trades)) return { tape: stored, source: 'store' };
  if (!connection || typeof connection.getSignaturesForAddress !== 'function' || !mint) {
    return { tape: null, source: 'none' };
  }
  const now = Date.now();
  const tape = await readCurveTape({
    connection,
    mint,
    maxPages: 3,
    maxFetches,
    focusFrom: now - 25 * 60 * 1000,
    focusTo: now
  });
  return { tape, source: tape ? 'chain' : 'failed' };
}

function devFlowFromTape(creator, trades) {
  if (!creator) return { unknown: true, reason: 'Creator was not identified' };
  if (!Array.isArray(trades)) return { unknown: true, reason: 'Creator trades were not read' };
  const buys = trades.filter(row => row && row.wallet === creator && row.side === 'buy').length;
  const sells = trades.filter(row => row && row.wallet === creator && row.side === 'sell').length;
  let status = 'green';
  if (sells > 0 && buys === 0) status = 'red';
  else if (sells > buys) status = 'yellow';
  return { unknown: false, status, reason: `Creator buys ${buys}, sells ${sells}` };
}

function analyzeTape(input = {}) {
  const tape = input.tape;
  if (!tape || !Array.isArray(tape.trades)) return null;
  const trades = tape.trades;
  const mint = input.mint;
  const supply = input.supply != null ? input.supply : tape.supply;
  const creator = input.creator || null;
  const graduated = input.graduated === true || input.graduated === false ? input.graduated : null;
  const early = analyzeEarlyBuys({
    mint,
    trades,
    createTime: tape.createTime,
    createSlot: tape.createSlot,
    supply,
    dev: creator,
    observedUntil: tape.observedUntil
  });
  const snipers = early && early.sameBlockSupplyPct != null
    ? { pct: early.sameBlockSupplyPct, buyers: early.sameBlockCount }
    : { unknown: true, reason: 'First-block buyers were not on the tape' };
  let kol = null;
  try { kol = loadKolList(); } catch (err) { kol = null; }
  return {
    snipers,
    wash: analyzeWash({ mint, trades }),
    holderPadding: analyzeHolderPadding({ mint, transfers: trades, holders: input.holders, supply }),
    ladder: analyzeLadderDump({ mint, dev: creator, trades, supply }),
    migration: analyzeMigrationDump({
      mint,
      graduated,
      graduatedAt: input.graduatedAt,
      trades,
      earlyWallets: early && Array.isArray(early.buys) ? early.buys.map(row => row.wallet) : [],
      coordinatedWallets: [],
      supply
    }),
    kolShadow: analyzeKolShadow({ mint, trades, dev: creator, supply, kolWallets: kol }),
    mcRun: analyzeMcRun({ mint, trades }),
    scaleOut: analyzeScaleOut({ mint, trades, supply }),
    instantBond: analyzeInstantBond({
      mint,
      createTime: tape.createTime,
      graduated,
      graduatedAt: graduated === true ? input.graduatedAt : null,
      snipeBurst: tape.signatures ? { signatures: tape.signatures.listed, failedRatio: tape.signatures.failedRatio } : null
    }),
    topTraders: analyzeTopTraders({
      mint,
      trades,
      createTime: tape.createTime,
      priceSol: input.priceSol
    }),
    devFlow: devFlowFromTape(creator, trades),
    funding: { reason: 'trace not run' },
    createTime: tape.createTime
  };
}

function rememberTape(mint, tape) {
  if (!mint || !tape) return;
  try {
    createStore().append('tapes.jsonl', {
      mint,
      createTime: tape.createTime || null,
      createSlot: tape.createSlot || null,
      supply: tape.supply == null ? null : tape.supply,
      graduated: tape.graduated == null ? null : tape.graduated,
      graduatedAt: tape.graduatedAt == null ? null : tape.graduatedAt,
      signatures: tape.signatures || null,
      trades: tape.trades || []
    });
  } catch (err) {
    // A tape that cannot be stored is still usable for this report.
  }
}

module.exports = {
  storedTape,
  readOnDemandTape,
  analyzeTape,
  devFlowFromTape,
  rememberTape
};
